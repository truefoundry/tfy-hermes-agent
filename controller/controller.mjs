// Hermes wrapper controller.
//
// HTTP service in front of a single Hermes agent. Speaks Slack and the
// OpenAI-compatible APIs to clients; dispatches per-turn TrueFoundry jobs
// (executor) and shuttles the per-thread session DB between this pod's
// RWO PVC and the ephemeral executor container. See DESIGN.md for the
// full picture.

import { createServer } from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";

import { openDb, prepareStatements, sessionDbPath, now } from "./db.mjs";
import { publish, subscribe } from "./pubsub.mjs";
import { signRunToken, verifyAndExtract } from "./tokens.mjs";
import { startReconciler } from "./reconciler.mjs";
import {
  openAIId,
  responseObject as buildResponseObject,
  chatCompletionObject as buildChatCompletionObject,
  chatCompletionChunk as buildChatCompletionChunk
} from "./openai-adapter.mjs";
import {
  agentCanRespondToSlackUser,
  agentLabel,
  chunkText,
  createSlackClient,
  formatObserverProgress,
  handleFromString,
  listFromEnv,
  normalizeSlackChannelIds,
  normalizeSlackUserIds,
  parseMessageHandle,
  slackChannelAccess,
  slackFeedbackBlocks,
  slackMessageClaimKey,
  slackPrompt,
  slackTaskDetails,
  slackTitle
} from "./slack.mjs";
import { writeSse, startSse, endSse } from "./sse.mjs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787);
const STATE_ROOT = process.env.STATE_ROOT || "/data";
const TFY_HOST = (process.env.TFY_HOST || "").replace(/\/+$/, "");
const TFY_API_KEY = process.env.TFY_API_KEY || "";
const TFY_WORKSPACE_FQN = process.env.TFY_WORKSPACE_FQN || "";
const HERMES_MODEL = process.env.HERMES_MODEL || "openai-main/gpt-5.5";
const HERMES_EXECUTOR_NAME = process.env.HERMES_EXECUTOR_NAME || "hermes-executor";
const OPENAI_API_KEY = process.env.HERMES_OPENAI_API_KEY || "";
const RUN_TOKEN_SECRET = process.env.HERMES_RUN_TOKEN_SECRET || "";
const RUN_TOKEN_TTL_SECONDS = Number(process.env.HERMES_RUN_TOKEN_TTL_SECONDS || 3 * 60 * 60);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_STATUS_TEXT = process.env.HERMES_SLACK_STATUS_TEXT || "is thinking...";
const SLACK_RUN_TIMEOUT_MS = Number(process.env.HERMES_SLACK_RUN_TIMEOUT_MS || 600_000);
const SLACK_STREAM_CHUNK_DELAY_MS = Number(process.env.HERMES_SLACK_STREAM_CHUNK_DELAY_MS || 120);
const OPENAI_SYNC_TIMEOUT_MS = Number(process.env.HERMES_OPENAI_SYNC_TIMEOUT_MS || 600_000);
const SSE_KEEPALIVE_MS = Number(process.env.HERMES_SSE_KEEPALIVE_MS || 15000);
const MAX_SESSION_DB_BYTES = Number(process.env.HERMES_MAX_SESSION_DB_BYTES || 50 * 1024 * 1024);

const RAW_SECRET_PATTERN =
  /\b(?:xoxb-[a-z0-9-]{10,}|xoxp-[a-z0-9-]{10,}|xapp-[a-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const defaultAgentId = "agt_hermes";
const defaultAgentHandle = handleFromString(process.env.HERMES_AGENT_HANDLE || "hermes");
const defaultAgentName = process.env.HERMES_AGENT_NAME || "Hermes Agent";
const defaultAgentDescription = process.env.HERMES_AGENT_DESCRIPTION || "";
const defaultAgentInstructions = process.env.HERMES_AGENT_INSTRUCTIONS || "";
const defaultAgentSkills = listFromEnv(process.env.HERMES_AGENT_SKILLS);
const defaultAgentMcpServers = listFromEnv(process.env.HERMES_AGENT_MCP_SERVERS);
const defaultAgentSlackAllowedChannelIds = normalizeSlackChannelIds(listFromEnv(process.env.HERMES_SLACK_ALLOWED_CHANNELS));
const defaultAgentSlackAllowedUserIds = normalizeSlackUserIds(listFromEnv(process.env.HERMES_SLACK_ALLOWED_USERS));

const slackLoadingMessages = (process.env.HERMES_SLACK_LOADING_MESSAGES || [
  "Reading the thread",
  "Planning the next step",
  "Running Hermes",
  "Preparing the reply"
].join("|")).split("|").map((message) => message.trim()).filter(Boolean).slice(0, 10);

const slack = createSlackClient({
  botToken: SLACK_BOT_TOKEN,
  signingSecret: SLACK_SIGNING_SECRET,
  statusText: SLACK_STATUS_TEXT,
  loadingMessages: slackLoadingMessages
});

let shuttingDown = false;

// ---------------------------------------------------------------------------
// HTTP primitives
// ---------------------------------------------------------------------------

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

async function json(req) {
  const body = await rawBody(req);
  return body ? JSON.parse(body) : {};
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendOpenAIError(res, status, message, type = "invalid_request_error", param = null, code = null) {
  return send(res, status, { error: { message, type, param, code } });
}

function bearerToken(req) {
  const match = String(req.headers["authorization"] || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function newRunId() {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function isRunTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const agentSlackLabel = (agent) => agentLabel(agent, defaultAgentHandle);

// Compute what hasn't yet been streamed to Slack. If the final result starts
// with everything already emitted, return only the suffix; if the streamer
// emitted nothing, fall back to the whole final string.
function finalSlackRemainder(streamedText, finalResult) {
  const output = String(finalResult || "").trim() || "Hermes finished, but returned no text.";
  const alreadyStreamed = String(streamedText || "").trim();
  if (!alreadyStreamed) return output;
  if (output.startsWith(alreadyStreamed)) return output.slice(alreadyStreamed.length).trimStart();
  return "";
}

// ---------------------------------------------------------------------------
// SQLite-backed accessors
// ---------------------------------------------------------------------------

const db = openDb(STATE_ROOT);

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToAgent(row) {
  if (!row) return null;
  return {
    id: row.id,
    handle: row.handle,
    name: row.name,
    model: row.model,
    instructions: row.instructions || "",
    workspaceFqn: row.workspace_fqn,
    slackTeamId: row.slack_team_id || null,
    description: defaultAgentDescription, // not persisted; carried from env
    skills: safeJsonArray(row.skills),
    mcpServers: safeJsonArray(row.mcp_servers),
    slackAllowedChannelIds: safeJsonArray(row.slack_allowed_channels),
    slackAllowedUserIds: safeJsonArray(row.slack_allowed_users),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToRun(row) {
  if (!row) return null;
  let trigger = null;
  if (row.trigger) {
    try { trigger = JSON.parse(row.trigger); } catch { trigger = row.trigger; }
  }
  return {
    id: row.id,
    hermes_session_id: row.hermes_session_id,
    status: row.status,
    result: row.result,
    error: row.error,
    slack_channel: row.slack_channel,
    slack_message_ts: row.slack_message_ts,
    openai_kind: row.openai_kind,
    openai_id: row.openai_id,
    trigger,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

const stmts = prepareStatements(db);

function ensureDefaultAgent() {
  const ts = now();
  const existing = stmts.getAgentById.get(defaultAgentId);
  const skills = JSON.stringify(defaultAgentSkills.length
    ? defaultAgentSkills
    : safeJsonArray(existing?.skills));
  const mcp = JSON.stringify(defaultAgentMcpServers.length
    ? defaultAgentMcpServers
    : safeJsonArray(existing?.mcp_servers));
  stmts.upsertAgent.run({
    id: defaultAgentId,
    handle: defaultAgentHandle,
    name: defaultAgentName,
    model: HERMES_MODEL,
    instructions: defaultAgentInstructions || existing?.instructions || "",
    workspace_fqn: TFY_WORKSPACE_FQN,
    slack_team_id: existing?.slack_team_id || null,
    skills,
    mcp_servers: mcp,
    slack_allowed_channels: JSON.stringify(defaultAgentSlackAllowedChannelIds),
    slack_allowed_users: JSON.stringify(defaultAgentSlackAllowedUserIds),
    created_at: existing?.created_at || ts,
    updated_at: ts
  });
}

function loadDefaultAgent() {
  return rowToAgent(stmts.getAgentById.get(defaultAgentId));
}

function loadAgentByHandle(handle) {
  try {
    return rowToAgent(stmts.getAgentByHandle.get(handleFromString(handle)));
  } catch {
    return null;
  }
}

function ensureSessionForSlackThread({ teamId, channel, threadTs }) {
  const team = teamId || "unknown-team";
  const existing = stmts.getSlackThread.get(team, channel, threadTs);
  if (existing?.hermes_session_id) return existing.hermes_session_id;
  const sessionId = randomUUID();
  stmts.insertSlackThread.run(team, channel, threadTs, sessionId, now());
  // ON CONFLICT means another race might have won; re-read to be safe.
  const fresh = stmts.getSlackThread.get(team, channel, threadTs);
  return fresh?.hermes_session_id || sessionId;
}

function claimSlackEvent(eventId) {
  if (!eventId) return true;
  return stmts.claimSlackEvent.run(eventId, now()).changes > 0;
}

function claimSlackMessage(parts) {
  if (!parts.channel || !parts.ts) return true;
  return stmts.claimSlackMessage.run(slackMessageClaimKey(parts), now()).changes > 0;
}

// ---------------------------------------------------------------------------
// OpenAI request parsing
// ---------------------------------------------------------------------------

function textFromContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string") {
        return part.text;
      }
      if (typeof part.text === "string" && !part.type) return part.text;
      throw new Error(`unsupported non-text content part: ${part.type || "unknown"}`);
    }).filter(Boolean).join("\n");
  }
  if (typeof content === "object" && typeof content.text === "string") return content.text;
  throw new Error("unsupported non-text content");
}

function promptFromMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("messages must be a non-empty array");
  }
  return messages.map((message) => {
    if (!message || typeof message !== "object") throw new Error("messages must contain objects");
    const role = String(message.role || "user").toUpperCase();
    return `${role}: ${textFromContent(message.content)}`;
  }).join("\n\n");
}

function promptFromResponseInput(input) {
  if (typeof input === "string") return input;
  if (!Array.isArray(input) || !input.length) {
    throw new Error("input must be a non-empty string or array");
  }
  return input.map((item) => {
    if (typeof item === "string") return `USER: ${item}`;
    if (!item || typeof item !== "object") return "";
    const role = String(item.role || (item.type === "message" ? "assistant" : "user")).toUpperCase();
    return `${role}: ${textFromContent(item.content ?? item.text)}`;
  }).filter(Boolean).join("\n\n");
}

function responsePrompt(body) {
  const parts = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    parts.push(`INSTRUCTIONS:\n${body.instructions.trim()}`);
  }
  parts.push(promptFromResponseInput(body.input));
  return parts.join("\n\n");
}

const responseObject = (run) => buildResponseObject(run, { model: HERMES_MODEL });
const chatCompletionObject = (run) => buildChatCompletionObject(run, { model: HERMES_MODEL });
const chatCompletionChunk = (run, options = {}) =>
  buildChatCompletionChunk(run, { model: HERMES_MODEL, ...options });

function containsRawSecret(value) {
  if (value == null) return false;
  if (typeof value === "string") return RAW_SECRET_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsRawSecret);
  if (typeof value === "object") return Object.values(value).some(containsRawSecret);
  return false;
}

function rejectRawSecretsInPayload(payload) {
  if (!containsRawSecret(payload)) return;
  const error = new Error("payload contains raw secret-shaped value; use tfy-secret:// references stored in the agent SecretGroup");
  error.statusCode = 400;
  throw error;
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

function getRunOrThrow(runId) {
  const run = rowToRun(stmts.getRunById.get(runId));
  if (!run) {
    const err = new Error("run not found");
    err.statusCode = 404;
    throw err;
  }
  return run;
}

async function tfyGet(apiPath) {
  if (!TFY_HOST || !TFY_API_KEY) {
    throw new Error("TFY_HOST and TFY_API_KEY are required for TrueFoundry control-plane calls");
  }
  const res = await fetch(`${TFY_HOST}${apiPath}`, {
    headers: { authorization: `Bearer ${TFY_API_KEY}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TrueFoundry ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function triggerJob({ run, agent, content, callbackToken }) {
  if (process.env.HERMES_SKIP_EXECUTOR_DISPATCH === "1") {
    return { skipped: true };
  }
  if (!TFY_HOST || !TFY_API_KEY || !TFY_WORKSPACE_FQN) {
    throw new Error("TFY_HOST, TFY_API_KEY, and TFY_WORKSPACE_FQN are required to dispatch the executor job");
  }
  if (!PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL must be set so the executor can call back");
  }
  const apps = await tfyGet(`/api/svc/v1/apps?workspace_fqn=${encodeURIComponent(TFY_WORKSPACE_FQN)}&limit=200`);
  const job = (Array.isArray(apps.data) ? apps.data : []).find((app) => app.name === HERMES_EXECUTOR_NAME);
  const deploymentId = job?.deployment?.id || job?.activeDeploymentId;
  if (!deploymentId) throw new Error(`active deployment not found for job ${HERMES_EXECUTOR_NAME}`);

  const work = {
    run_id: run.id,
    hermes_session_id: run.hermes_session_id,
    content,
    agent: {
      id: agent.id,
      handle: agent.handle,
      name: agent.name,
      description: agent.description || "",
      instructions: agent.instructions || "",
      model: agent.model || HERMES_MODEL,
      skills: agent.skills || [],
      mcpServers: agent.mcpServers || []
    },
    callback_url: PUBLIC_BASE_URL,
    controller_event_url: `${PUBLIC_BASE_URL}/api/internal/runs/${run.id}/events`
  };
  const workB64 = Buffer.from(JSON.stringify(work), "utf8").toString("base64");

  const env = [
    `HARNESS_WORK_B64=${shellQuote(workB64)}`,
    `HARNESS_CALLBACK_TOKEN=${shellQuote(callbackToken)}`
  ].join(" ");
  const command = `sh -lc ${shellQuote(`${env} node executor/executor.mjs`)}`;

  const res = await fetch(`${TFY_HOST}/api/svc/v1/jobs/trigger`, {
    method: "POST",
    headers: { authorization: `Bearer ${TFY_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      deploymentId,
      input: { command },
      metadata: { job_run_name_alias: run.id }
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`job trigger failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

// Used by the reconciler: look up the run row, re-trigger with a fresh
// callback token. Idempotent via job_run_name_alias=run_id.
async function reTriggerJob(runId) {
  const run = rowToRun(stmts.getRunById.get(runId));
  if (!run) throw new Error(`run ${runId} not found for re-trigger`);
  const agent = loadDefaultAgent();
  if (!agent) throw new Error("default agent missing");
  const token = signRunToken({ runId: run.id, secret: RUN_TOKEN_SECRET, expSeconds: RUN_TOKEN_TTL_SECONDS });
  return triggerJob({ run, agent, content: "", callbackToken: token });
}

// If `openaiIdFor` is provided it receives the freshly minted runId so the
// openai_id can be derived from it (resp_… / chatcmpl_…). Otherwise pass a
// literal `openaiId` or leave it null for Slack runs.
function createRun({
  hermesSessionId,
  openaiKind,
  openaiId = null,
  openaiIdFor = null,
  slackChannel = null,
  slackMessageTs = null
}) {
  const runId = newRunId();
  const ts = now();
  stmts.insertRun.run({
    id: runId,
    hermes_session_id: hermesSessionId,
    status: "queued",
    slack_channel: slackChannel,
    slack_message_ts: slackMessageTs,
    openai_kind: openaiKind,
    openai_id: openaiIdFor ? openaiIdFor(runId) : openaiId,
    created_at: ts,
    updated_at: ts
  });
  return getRunOrThrow(runId);
}

async function dispatchRun({ run, agent, content }) {
  const callbackToken = signRunToken({
    runId: run.id,
    secret: RUN_TOKEN_SECRET,
    expSeconds: RUN_TOKEN_TTL_SECONDS
  });
  try {
    const trigger = await triggerJob({ run, agent, content, callbackToken });
    stmts.setRunDispatched.run("dispatched", JSON.stringify(trigger), now(), run.id);
    return { run: getRunOrThrow(run.id), token: callbackToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stmts.setRunFailed.run(message, JSON.stringify({ error: message }), now(), run.id);
    // Publish a synthetic terminal event so SSE/Slack subscribers unwind.
    publish(run.id, { type: "complete", status: "failed", error: message });
    return { run: getRunOrThrow(run.id), token: callbackToken };
  }
}

// ---------------------------------------------------------------------------
// Pub/sub run streaming
// ---------------------------------------------------------------------------

function backfillEvents(runId, lastEventId, handler) {
  const rows = lastEventId
    ? stmts.selectRunEventsAfter.all(runId, lastEventId)
    : stmts.selectRunEvents.all(runId);
  let maxId = lastEventId || 0;
  for (const row of rows) {
    handler({ id: row.id, type: row.type, payload: row.payload, created_at: row.created_at });
    if (row.id > maxId) maxId = row.id;
  }
  return maxId;
}

const reloadRun = (runId) => rowToRun(stmts.getRunById.get(runId));

// Shared subscribe-until-terminal loop. `onRow` (if provided) receives every
// run_event row (live + backfilled). Resolves with {run, timedOut, aborted}.
function subscribeRunUntilTerminal({ runId, timeoutMs, isAborted = () => false, onRow = null }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsub = null;
    let lastEventId = 0;

    const drain = () => {
      if (onRow) lastEventId = backfillEvents(runId, lastEventId, onRow);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
      resolve(result);
    };

    const initial = reloadRun(runId);
    if (!initial) return finish({ run: null, timedOut: false, aborted: false });

    unsub = subscribe(runId, (event) => {
      if (isAborted()) return finish({ run: reloadRun(runId), timedOut: false, aborted: true });
      if (event?.type === "event") return drain();
      if (event?.type === "complete") {
        drain();
        finish({ run: reloadRun(runId), timedOut: false, aborted: false });
      }
    });

    drain();
    if (isRunTerminal(initial.status)) {
      drain();
      return finish({ run: reloadRun(runId), timedOut: false, aborted: false });
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ run: reloadRun(runId), timedOut: true, aborted: false });
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

const waitForTerminal = (opts) => subscribeRunUntilTerminal(opts);

function streamRunText({ runId, timeoutMs, onDelta, isAborted = () => false }) {
  let streamedText = "";
  const emit = (text) => {
    if (!text) return;
    streamedText += text;
    Promise.resolve(onDelta(text)).catch(() => {});
  };
  const onRow = (row) => {
    if (row.type !== "stdout_delta") return;
    try {
      const data = JSON.parse(row.payload);
      if (typeof data?.text === "string") emit(data.text);
    } catch { /* ignore malformed payloads */ }
  };
  return subscribeRunUntilTerminal({ runId, timeoutMs, isAborted, onRow }).then((res) => {
    // On clean completion, flush any final-result remainder that wasn't streamed.
    if (res.run?.status === "completed") {
      const finalText = String(res.run.result || "");
      if (finalText && finalText.startsWith(streamedText)) emit(finalText.slice(streamedText.length));
      else if (finalText && !streamedText) emit(finalText);
    }
    return { streamedText, ...res };
  });
}

function streamRunToSlack({ runId, channel, ts, timeoutMs }) {
  let streamedText = "";
  let progressCount = 0;
  const onRow = (row) => {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { return; }
    if (row.type === "stdout_delta") {
      const text = typeof payload?.text === "string" ? payload.text : "";
      if (!text) return;
      streamedText += text;
      for (const piece of chunkText(text)) {
        slack.appendStream({ channel, ts, markdownText: piece }).catch((error) => {
          console.error(`appendSlackStream failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } else if (row.type === "hermes_observer") {
      const line = formatObserverProgress(payload);
      if (!line) return;
      progressCount += 1;
      slack.appendStream({
        channel,
        ts,
        chunks: [{
          type: "task_update",
          id: "hermes_turn",
          title: "Hermes activity",
          status: "in_progress",
          details: slackTaskDetails([line])
        }]
      }).catch((error) => {
        console.error(`appendSlackStream progress failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  };
  return subscribeRunUntilTerminal({ runId, timeoutMs, onRow }).then((res) => ({
    streamedText, progressCount, ...res
  }));
}

// ---------------------------------------------------------------------------
// Slack event handling
// ---------------------------------------------------------------------------

function slackGateAgent(agent, { channel, userId }) {
  if (!agent) return false;
  if (!agentCanRespondToSlackUser(agent, userId)) return false;
  if (!slackChannelAccess(agent, channel).allowed) return false;
  return true;
}

async function handleAssistantThreadStarted(payload) {
  const thread = payload.event?.assistant_thread;
  if (!thread?.channel_id || !thread?.thread_ts) return;
  const agent = loadDefaultAgent();
  if (!slackGateAgent(agent, { channel: thread.channel_id, userId: thread.user_id })) return;
  ensureSessionForSlackThread({
    teamId: payload.team_id || thread.context?.team_id || null,
    channel: thread.channel_id,
    threadTs: thread.thread_ts
  });
  await slack.api("assistant.threads.setSuggestedPrompts", {
    channel_id: thread.channel_id,
    thread_ts: thread.thread_ts,
    prompts: [
      { title: "Summarize this thread", message: "Summarize the current Slack context and suggest next steps." },
      { title: "Plan an implementation", message: "Turn this request into a concise implementation plan." },
      { title: "Review recent context", message: "Review the visible context and call out risks or missing information." }
    ]
  });
}

async function handleAssistantThreadContextChanged(payload) {
  const thread = payload.event?.assistant_thread;
  if (!thread?.channel_id || !thread?.thread_ts) return;
  const agent = loadDefaultAgent();
  if (!slackGateAgent(agent, { channel: thread.channel_id, userId: thread.user_id })) return;
  ensureSessionForSlackThread({
    teamId: payload.team_id || thread.context?.team_id,
    channel: thread.channel_id,
    threadTs: thread.thread_ts
  });
}

async function handleSlackUserMessage(payload) {
  const event = payload.event || {};
  if (event.bot_id || event.subtype || !event.channel || !event.user) return;
  const teamId = payload.team_id || event.team;
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const route = parseMessageHandle(event.text);
  const text = route.text;
  const isDirectMessage = event.channel_type === "im" || channel.startsWith("D");
  const isBotMention = event.type === "app_mention";

  if (!route.handle && !isBotMention && !isDirectMessage) return;

  const defaultAgent = loadDefaultAgent();
  if (!text) {
    await slack.postMessage({
      channel,
      threadTs,
      text: `What should ${agentSlackLabel(defaultAgent)} work on? Send a request in this thread or message the app directly.`
    });
    return;
  }
  if (!claimSlackMessage({ teamId, channel, ts: event.ts, userId: event.user })) return;

  let agent = defaultAgent;
  if (route.handle) {
    const target = loadAgentByHandle(route.handle);
    if (!target) {
      await slack.postMessage({
        channel,
        threadTs,
        text: `This Slack app is configured for ${agentSlackLabel(defaultAgent)}. Use the Slack app for ${agentSlackLabel({ handle: route.handle })} if you want that agent.`
      });
      return;
    }
    agent = target;
  }
  if (!slackGateAgent(agent, { channel, userId: event.user })) return;

  const hermesSessionId = ensureSessionForSlackThread({ teamId, channel, threadTs });
  const label = agentSlackLabel(agent);
  const taskUpdate = (status, details) => ({
    type: "task_update", id: "hermes_turn", title: `Run ${label}`, status,
    details: slackTaskDetails(details)
  });

  let stream = null;
  try {
    await slack.api("assistant.threads.setTitle", {
      channel_id: channel,
      thread_ts: threadTs,
      title: `${label} ${slackTitle(text)}`.slice(0, 80)
    }).catch(() => {});
    await slack.setStatus({ channel, threadTs });
    stream = await slack.startStream({
      channel, threadTs, teamId, userId: event.user, agent, fallbackHandle: defaultAgentHandle
    });
    const ts = stream.ts;
    const closeWith = async ({ markdownText, blocks }) => {
      await slack.stopStream({ channel, ts, markdownText, blocks });
      await slack.clearStatus({ channel, threadTs }).catch(() => {});
    };

    const run = createRun({
      hermesSessionId,
      openaiKind: "slack",
      openaiId: null,
      slackChannel: channel,
      slackMessageTs: ts
    });

    const prompt = slackPrompt({
      text,
      context: { channel_id: channel, team_id: teamId },
      agent,
      fallbackHandle: defaultAgentHandle
    });

    const dispatched = await dispatchRun({ run, agent, content: prompt });
    const dispatchFailed = dispatched.run.status === "failed";

    await slack.appendStream({
      channel, ts,
      chunks: [taskUpdate(dispatchFailed ? "error" : "in_progress", [
        "Request received",
        "Slack stream opened",
        dispatchFailed
          ? `Failed to dispatch: ${dispatched.run.error || ""}`.slice(0, 256)
          : "Executor job queued"
      ])]
    });

    if (dispatchFailed) {
      return closeWith({
        markdownText: `I couldn't finish that request: ${dispatched.run.error || "executor dispatch failed"}`,
        blocks: slackFeedbackBlocks(run.id)
      });
    }

    const streamed = await streamRunToSlack({ runId: run.id, channel, ts, timeoutMs: SLACK_RUN_TIMEOUT_MS });

    if (!streamed.run || streamed.run.status !== "completed") {
      const errorMessage = streamed.run?.error
        || (streamed.timedOut
          ? "Hermes did not finish before the Slack response timeout."
          : "Hermes run failed");
      await slack.appendStream({
        channel, ts,
        chunks: [taskUpdate("error", [`Failed: ${errorMessage.slice(0, 256)}`])]
      });
      return closeWith({
        markdownText: `I couldn't finish that request: ${errorMessage}`,
        blocks: slackFeedbackBlocks(run.id)
      });
    }

    for (const chunk of chunkText(finalSlackRemainder(streamed.streamedText, streamed.run.result))) {
      await slack.appendStream({ channel, ts, markdownText: chunk });
      if (SLACK_STREAM_CHUNK_DELAY_MS > 0) await sleep(SLACK_STREAM_CHUNK_DELAY_MS);
    }
    await slack.appendStream({
      channel, ts,
      chunks: [taskUpdate("complete", [streamed.progressCount
        ? "Completed"
        : "Completed; no Hermes tool events emitted"])]
    });
    return closeWith({ blocks: slackFeedbackBlocks(streamed.run.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const markdownText = `I couldn't finish that request: ${message}`;
    if (stream?.ts) {
      await slack.stopStream({ channel, ts: stream.ts, markdownText }).catch(() => {});
    } else {
      await slack.postMessage({ channel, threadTs, text: markdownText }).catch(() => {});
    }
    await slack.clearStatus({ channel, threadTs }).catch(() => {});
  }
}

async function processSlackEvent(payload) {
  if (!claimSlackEvent(payload.event_id)) return;

  const timeoutMs = SLACK_RUN_TIMEOUT_MS + 30_000;
  const work = (async () => {
    switch (payload.event?.type) {
      case "assistant_thread_started":
        await handleAssistantThreadStarted(payload);
        break;
      case "assistant_thread_context_changed":
        await handleAssistantThreadContextChanged(payload);
        break;
      case "message":
      case "app_mention":
        await handleSlackUserMessage(payload);
        break;
      default:
        break;
    }
  })();

  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`slack event handler exceeded ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    await Promise.race([work, watchdog]);
  } finally {
    clearTimeout(timer);
  }
}

async function handleSlackInteraction(body) {
  const form = new URLSearchParams(body);
  const payload = JSON.parse(form.get("payload") || "{}");
  const action = payload.actions?.[0];
  if (!action?.action_id?.startsWith("hermes_feedback:")) return;
  const [, runId] = action.action_id.split(":");
  const value = String(action.value || "").split(":")[0] || "unknown";
  stmts.insertSlackFeedback.run(
    runId,
    value,
    payload.user?.id || null,
    payload.channel?.id || null,
    payload.message?.ts || null,
    now()
  );
}

// ---------------------------------------------------------------------------
// SSE streaming for /v1/*
// ---------------------------------------------------------------------------

async function streamResponseObject(req, res, run) {
  const ctx = startSse(req, res, SSE_KEEPALIVE_MS);
  let seq = 0;
  const responseId = run.openai_id || openAIId("resp", run.id);
  const itemId = openAIId("msg", run.id);
  const created = { ...responseObject(run), status: "in_progress", output: [], output_text: "" };

  // Each Responses-API SSE frame shares an event-name == data.type and is
  // sequence-numbered. This helper centralizes both.
  const emit = (type, data) => writeSse(res, { type, sequence_number: seq++, ...data }, type);

  emit("response.created", { response: created });
  emit("response.in_progress", { response: created });
  emit("response.output_item.added", {
    response_id: responseId,
    output_index: 0,
    item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] }
  });
  emit("response.content_part.added", {
    response_id: responseId, item_id: itemId, output_index: 0, content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  });

  const streamed = await streamRunText({
    runId: run.id,
    timeoutMs: OPENAI_SYNC_TIMEOUT_MS,
    isAborted: () => ctx.aborted,
    onDelta: async (delta) => emit("response.output_text.delta", {
      response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta
    })
  });

  if (streamed.aborted) return endSse(res, ctx);

  if (!streamed.run || streamed.run.status !== "completed") {
    emit("error", {
      error: {
        type: "server_error",
        message: streamed.run?.error || "Hermes run did not complete before the streaming timeout"
      }
    });
    return endSse(res, ctx);
  }

  const finalText = String(streamed.run.result || "");
  emit("response.output_text.done", {
    response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, text: finalText
  });
  emit("response.content_part.done", {
    response_id: responseId, item_id: itemId, output_index: 0, content_index: 0,
    part: { type: "output_text", text: finalText, annotations: [] }
  });
  emit("response.output_item.done", {
    response_id: responseId, output_index: 0,
    item: {
      id: itemId, type: "message", status: "completed", role: "assistant",
      content: [{ type: "output_text", text: finalText, annotations: [] }]
    }
  });
  emit("response.completed", { response: responseObject(streamed.run) });
  endSse(res, ctx);
}

async function streamChatCompletion(req, res, run, { includeUsage = false } = {}) {
  const ctx = startSse(req, res, SSE_KEEPALIVE_MS);
  writeSse(res, chatCompletionChunk(run, { delta: { role: "assistant", content: "" } }));
  const streamed = await streamRunText({
    runId: run.id,
    timeoutMs: OPENAI_SYNC_TIMEOUT_MS,
    isAborted: () => ctx.aborted,
    onDelta: async (delta) => {
      writeSse(res, chatCompletionChunk(run, { delta: { content: delta } }));
    }
  });

  if (streamed.aborted) return endSse(res, ctx);

  if (!streamed.run || streamed.run.status !== "completed") {
    writeSse(res, {
      error: {
        message: streamed.run?.error || "Hermes run did not complete before the streaming timeout",
        type: "server_error"
      }
    });
    writeSse(res, "[DONE]");
    return endSse(res, ctx);
  }

  writeSse(res, chatCompletionChunk(streamed.run, { delta: {}, finishReason: "stop" }));
  if (includeUsage) writeSse(res, chatCompletionChunk(streamed.run, { usage: null }));
  writeSse(res, "[DONE]");
  endSse(res, ctx);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function requireOpenAIAuth(req, res) {
  if (!OPENAI_API_KEY) return true; // assertStartupConfig already enforces presence
  const provided = bearerToken(req);
  if (!provided) {
    sendOpenAIError(res, 401, "missing bearer token", "authentication_error");
    return false;
  }
  const expected = Buffer.from(OPENAI_API_KEY);
  const got = Buffer.from(provided);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    sendOpenAIError(res, 401, "invalid bearer token", "authentication_error");
    return false;
  }
  return true;
}

function requireRunToken(req, res, runId) {
  const token = bearerToken(req);
  if (!token) {
    send(res, 401, { error: "missing bearer token" });
    return false;
  }
  const result = verifyAndExtract({ token, secret: RUN_TOKEN_SECRET });
  if (!result.ok) {
    send(res, 401, { error: `invalid bearer token (${result.reason})` });
    return false;
  }
  // Timing-safe comparison of token-bound runId against URL :id.
  const expected = Buffer.from(String(runId), "utf8");
  const got = Buffer.from(String(result.runId), "utf8");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    send(res, 401, { error: "token does not match run id" });
    return false;
  }
  return true;
}

function requireInternalRun(req, res, runId) {
  if (!requireRunToken(req, res, runId)) return null;
  const run = rowToRun(stmts.getRunById.get(runId));
  if (!run) {
    send(res, 404, { error: "run not found" });
    return null;
  }
  return run;
}

// ---------------------------------------------------------------------------
// Internal session-DB transfer
// ---------------------------------------------------------------------------

async function streamSessionDb(req, res, hermesSessionId) {
  const filepath = sessionDbPath(STATE_ROOT, hermesSessionId);
  let stats;
  try {
    stats = await stat(filepath);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, { error: "session db not found" });
    throw error;
  }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(stats.size)
  });
  await pipeline(createReadStream(filepath), res);
}

async function receiveSessionDb(req, res, hermesSessionId) {
  const rawContentLength = req.headers["content-length"];
  if (rawContentLength === undefined) {
    return send(res, 411, { error: "content-length header is required" });
  }
  const contentLength = Number(rawContentLength);
  if (!Number.isInteger(contentLength) || contentLength < 0) {
    return send(res, 400, { error: "content-length header is invalid" });
  }
  if (contentLength > MAX_SESSION_DB_BYTES) {
    return send(res, 413, { error: `session db exceeds limit (${MAX_SESSION_DB_BYTES} bytes)` });
  }
  await mkdir(join(STATE_ROOT, "sessions"), { recursive: true });
  const finalPath = sessionDbPath(STATE_ROOT, hermesSessionId);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  let received = 0;
  let aborted = false;

  const writable = createWriteStream(tmpPath, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > MAX_SESSION_DB_BYTES) {
          aborted = true;
          writable.destroy();
          req.destroy();
          reject(Object.assign(new Error("session db exceeds limit"), { statusCode: 413 }));
        }
      });
      req.on("error", reject);
      writable.on("error", reject);
      writable.on("finish", resolve);
      req.pipe(writable);
    });
    if (aborted) return;
    await rename(tmpPath, finalPath);
    return send(res, 200, { ok: true, bytes: received });
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    if (error.statusCode === 413) return send(res, 413, { error: error.message });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Resume in-flight Slack streams after controller restart
// ---------------------------------------------------------------------------

async function finishResumedSlackStream(run, streamed) {
  if (!streamed.run) return;
  const channel = run.slack_channel;
  const ts = run.slack_message_ts;
  const blocks = slackFeedbackBlocks(run.id);
  if (streamed.run.status === "completed") {
    for (const chunk of chunkText(finalSlackRemainder(streamed.streamedText, streamed.run.result))) {
      await slack.appendStream({ channel, ts, markdownText: chunk });
    }
    await slack.stopStream({ channel, ts, blocks });
  } else if (streamed.run.status === "failed") {
    await slack.stopStream({
      channel, ts, blocks,
      markdownText: `I couldn't finish that request: ${streamed.run.error || "run failed"}`
    });
  }
}

function resumeInFlightSlackStreams() {
  for (const row of stmts.selectResumeRuns.all()) {
    const run = rowToRun(row);
    if (!run.slack_channel || !run.slack_message_ts) continue;
    console.log(`[hermes] resuming Slack stream for ${run.id}`);
    streamRunToSlack({
      runId: run.id,
      channel: run.slack_channel,
      ts: run.slack_message_ts,
      timeoutMs: SLACK_RUN_TIMEOUT_MS
    }).then((streamed) => finishResumedSlackStream(run, streamed).catch((error) => {
      console.error(`[hermes] resume Slack stream failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    })).catch((error) => {
      console.error(`[hermes] resume Slack stream errored for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

// ---------------------------------------------------------------------------
// HTTP request handling
// ---------------------------------------------------------------------------

async function readJsonOrError(req, res) {
  try {
    return [true, await json(req)];
  } catch (error) {
    sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error));
    return [false, null];
  }
}

// One-shot synchronous wait for terminal status, used by both /v1/responses
// and /v1/chat/completions non-streaming paths. Returns whether the response
// has already been written; if false, caller should send the success payload.
async function awaitTerminalForSync(req, res, run, notFoundLabel) {
  const aborted = { value: false };
  req.on("close", () => { aborted.value = true; });
  const waited = await waitForTerminal({
    runId: run.id,
    timeoutMs: OPENAI_SYNC_TIMEOUT_MS,
    isAborted: () => aborted.value
  });
  if (aborted.value) return { handled: true };
  if (!waited.run) { sendOpenAIError(res, 404, `${notFoundLabel} not found`, "invalid_request_error"); return { handled: true }; }
  if (waited.run.status === "failed") {
    sendOpenAIError(res, 500, waited.run.error || "Hermes run failed", "server_error");
    return { handled: true };
  }
  if (waited.run.status !== "completed") {
    sendOpenAIError(res, 504, "Hermes run did not complete before the synchronous OpenAI adapter timeout", "server_error");
    return { handled: true };
  }
  return { handled: false, run: waited.run };
}

async function handleResponses(req, res) {
  if (!requireOpenAIAuth(req, res)) return;
  const [ok, body] = await readJsonOrError(req, res);
  if (!ok) return;
  try { rejectRawSecretsInPayload(body); }
  catch (error) { return sendOpenAIError(res, error.statusCode || 400, error.message); }

  let content;
  try { content = responsePrompt(body); }
  catch (error) { return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error)); }

  let hermesSessionId = randomUUID();
  if (body.previous_response_id) {
    const priorRun = rowToRun(stmts.getRunByOpenAIId.get(body.previous_response_id));
    if (priorRun?.hermes_session_id) hermesSessionId = priorRun.hermes_session_id;
  }

  const run = createRun({
    hermesSessionId,
    openaiKind: "response",
    openaiIdFor: (runId) => openAIId("resp", runId)
  });
  const dispatched = await dispatchRun({ run, agent: loadDefaultAgent(), content });

  if (body.stream) return streamResponseObject(req, res, dispatched.run);
  if (body.background) return send(res, 200, responseObject(dispatched.run));

  const result = await awaitTerminalForSync(req, res, dispatched.run, "response");
  if (result.handled) return;
  return send(res, 200, responseObject(result.run));
}

async function handleChatCompletions(req, res) {
  if (!requireOpenAIAuth(req, res)) return;
  const [ok, body] = await readJsonOrError(req, res);
  if (!ok) return;
  try { rejectRawSecretsInPayload(body); }
  catch (error) { return sendOpenAIError(res, error.statusCode || 400, error.message); }

  let content;
  try { content = promptFromMessages(body.messages); }
  catch (error) { return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error)); }

  const run = createRun({
    hermesSessionId: randomUUID(),
    openaiKind: "chat.completion",
    openaiIdFor: (runId) => openAIId("chatcmpl", runId)
  });
  const dispatched = await dispatchRun({ run, agent: loadDefaultAgent(), content });

  if (body.stream) {
    return streamChatCompletion(req, res, dispatched.run, {
      includeUsage: Boolean(body.stream_options?.include_usage)
    });
  }

  const result = await awaitTerminalForSync(req, res, dispatched.run, "chat completion");
  if (result.handled) return;
  return send(res, 200, chatCompletionObject(result.run));
}

async function handleSlackEvents(req, res) {
  const body = await rawBody(req);
  if (!slack.verifyRequest(req, body)) return send(res, 401, { error: "invalid Slack signature" });
  let payload;
  try { payload = body ? JSON.parse(body) : {}; }
  catch { return send(res, 400, { error: "invalid JSON body" }); }
  if (payload.type === "url_verification") return send(res, 200, { challenge: payload.challenge });
  if (!slack.hasBotToken) return send(res, 503, { error: "Slack bot token is not configured" });
  processSlackEvent(payload).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
  });
  return send(res, 200, { ok: true });
}

async function handleSlackInteractions(req, res) {
  const body = await rawBody(req);
  if (!slack.verifyRequest(req, body)) return send(res, 401, { error: "invalid Slack signature" });
  handleSlackInteraction(body).catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
  });
  return send(res, 200, { ok: true });
}

async function handle(req, res) {
  if (shuttingDown) return send(res, 503, { error: "server is shutting down" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method;
  const path = url.pathname;

  try {
    if (method === "GET" && path === "/api/health") {
      return send(res, 200, { ok: true, stateRoot: STATE_ROOT });
    }

    if (method === "GET" && path === "/slack/health") {
      return send(res, 200, {
        ok: true,
        slack: {
          botTokenConfigured: Boolean(SLACK_BOT_TOKEN),
          signingSecretConfigured: Boolean(SLACK_SIGNING_SECRET),
          allowedChannels: defaultAgentSlackAllowedChannelIds,
          allowedUsers: defaultAgentSlackAllowedUserIds
        }
      });
    }

    if (method === "POST" && path === "/slack/events") return handleSlackEvents(req, res);
    if (method === "POST" && path === "/slack/interactions") return handleSlackInteractions(req, res);

    if (method === "GET" && path === "/v1/models") {
      if (!requireOpenAIAuth(req, res)) return;
      return send(res, 200, { object: "list", data: [{ id: HERMES_MODEL, object: "model" }] });
    }

    if (method === "POST" && path === "/v1/responses") return handleResponses(req, res);
    if (method === "POST" && path === "/v1/chat/completions") return handleChatCompletions(req, res);

    const responseMatch = path.match(/^\/v1\/responses\/([^/]+)$/);
    if (responseMatch && method === "GET") {
      if (!requireOpenAIAuth(req, res)) return;
      const run = rowToRun(stmts.getRunByOpenAIId.get(responseMatch[1]));
      return run
        ? send(res, 200, responseObject(run))
        : sendOpenAIError(res, 404, "response not found", "invalid_request_error");
    }

    const chatCompletionMatch = path.match(/^\/v1\/chat\/completions\/([^/]+)$/);
    if (chatCompletionMatch && method === "GET") {
      if (!requireOpenAIAuth(req, res)) return;
      const run = rowToRun(stmts.getRunByOpenAIId.get(chatCompletionMatch[1]));
      return run
        ? send(res, 200, chatCompletionObject(run))
        : sendOpenAIError(res, 404, "chat completion not found", "invalid_request_error");
    }

    const internalEventsMatch = path.match(/^\/api\/internal\/runs\/([^/]+)\/events$/);
    if (internalEventsMatch && method === "POST") {
      const runId = internalEventsMatch[1];
      const run = requireInternalRun(req, res, runId);
      if (!run) return;
      const body = await json(req);
      const payload = JSON.stringify(body || {});
      const insert = stmts.insertRunEvent.run(runId, body?.type || "event", payload, now());
      // Bump run status to 'running' on first event arrival if still dispatched.
      if (run.status === "dispatched") stmts.setRunStatus.run("running", now(), runId);
      publish(runId, { type: "event", id: insert.lastInsertRowid });
      return send(res, 200, { ok: true });
    }

    const internalCompleteMatch = path.match(/^\/api\/internal\/runs\/([^/]+)\/complete$/);
    if (internalCompleteMatch && method === "POST") {
      const runId = internalCompleteMatch[1];
      if (!requireInternalRun(req, res, runId)) return;
      const body = await json(req);
      const status = body?.status || "completed";
      stmts.completeRun.run(status, body?.result || "", body?.error || null, now(), runId);
      publish(runId, { type: "complete", status, error: body?.error || null });
      return send(res, 200, { run: rowToRun(stmts.getRunById.get(runId)) });
    }

    const internalDbMatch = path.match(/^\/api\/internal\/runs\/([^/]+)\/session-db$/);
    if (internalDbMatch && (method === "GET" || method === "POST")) {
      const runId = internalDbMatch[1];
      const run = requireInternalRun(req, res, runId);
      if (!run) return;
      return method === "GET"
        ? streamSessionDb(req, res, run.hermes_session_id)
        : receiveSessionDb(req, res, run.hermes_session_id);
    }

    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") {
      const run = rowToRun(stmts.getRunById.get(runMatch[1]));
      return run ? send(res, 200, { run }) : send(res, 404, { error: "run not found" });
    }

    if (method === "GET" && path === "/") {
      return send(res, 200, {
        name: "Hermes Agent API",
        defaultApi: "openai-compatible",
        endpoints: {
          models: "/v1/models",
          responses: "/v1/responses",
          chatCompletions: "/v1/chat/completions",
          health: "/api/health"
        }
      });
    }

    return send(res, 404, { error: "Not found." });
  } catch (error) {
    return send(res, error?.statusCode || 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function assertStartupConfig() {
  const missing = [];
  if (!OPENAI_API_KEY) missing.push("HERMES_OPENAI_API_KEY");
  if (!RUN_TOKEN_SECRET) missing.push("HERMES_RUN_TOKEN_SECRET");
  if (missing.length) {
    console.error(`[hermes] startup failure: missing required env (${missing.join(", ")})`);
    throw new Error(`missing required env: ${missing.join(", ")}`);
  }
  if (!PUBLIC_BASE_URL) {
    console.warn("[hermes] PUBLIC_BASE_URL is not set; executor cannot reach this controller");
  }
  if (SLACK_BOT_TOKEN && !SLACK_SIGNING_SECRET) {
    console.warn("[hermes] SLACK_BOT_TOKEN is set but SLACK_SIGNING_SECRET is missing; Slack requests will be rejected");
  }
}

assertStartupConfig();
ensureDefaultAgent();

const stopReconciler = startReconciler(db, {
  tfyGet: TFY_HOST && TFY_API_KEY ? tfyGet : null,
  tfyTriggerJob: TFY_HOST && TFY_API_KEY && TFY_WORKSPACE_FQN ? reTriggerJob : null
});

const httpServer = createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error?.statusCode || 500, { error: error.message }));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`hermes controller listening on :${PORT}`);
  try { resumeInFlightSlackStreams(); } catch (error) {
    console.error(`[hermes] resume scan failed: ${error instanceof Error ? error.message : String(error)}`);
  }
});

function shutdown(signal) {
  console.log(`[hermes] received ${signal}, shutting down`);
  shuttingDown = true;
  try { stopReconciler(); } catch {}
  httpServer.close(() => {});
  try { db.close(); } catch {}
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
