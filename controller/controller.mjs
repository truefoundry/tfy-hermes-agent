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
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { openDb, sessionDbPath, now } from "./db.mjs";
import { publish, subscribe } from "./pubsub.mjs";
import { signRunToken, verifyAndExtract } from "./tokens.mjs";
import { startReconciler } from "./reconciler.mjs";
import {
  openAIId,
  responseObject as buildResponseObject,
  chatCompletionObject as buildChatCompletionObject,
  chatCompletionChunk as buildChatCompletionChunk
} from "./openai-adapter.mjs";

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

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------

function listFromEnv(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function handleFromString(value) {
  const handle = String(value || "")
    .trim()
    .replace(/^[@#/]+/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) {
    throw new Error("agent handle must be 2-32 chars and use lowercase letters, numbers, underscores, or hyphens");
  }
  return handle;
}

function newRunId() {
  return `run_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function isRunTerminal(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return "";
  return Buffer.concat(chunks).toString("utf8");
}

async function json(req) {
  const body = await rawBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendOpenAIError(res, status, message, type = "invalid_request_error", param = null, code = null) {
  return send(res, status, { error: { message, type, param, code } });
}

function bearerToken(req) {
  const header = String(req.headers["authorization"] || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Agent / channel guards
// ---------------------------------------------------------------------------

function normalizeSlackChannelIds(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean)));
}

function normalizeSlackUserIds(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean)));
}

function slackChannelAccess(agent, channel) {
  const allowed = normalizeSlackChannelIds(agent?.slackAllowedChannelIds || []);
  if (!allowed.length) return { allowed: true, reason: null };
  return {
    allowed: allowed.includes(String(channel || "").toUpperCase()),
    reason: "access_policy"
  };
}

function agentCanRespondToSlackUser(agent, userId) {
  const allowed = normalizeSlackUserIds(agent?.slackAllowedUserIds || []);
  if (!allowed.length) return true;
  return allowed.includes(String(userId || "").toUpperCase());
}

function agentLabel(agent) {
  return `@${agent?.handle || defaultAgentHandle}`;
}

function parseMessageHandle(text) {
  const cleaned = cleanSlackText(text);
  const match = cleaned.match(/^(?:agent:|use\s+)?[@#/]([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?:\s+|$)([\s\S]*)$/);
  if (!match) return { handle: null, text: cleaned };
  return { handle: handleFromString(match[1]), text: match[2].trim() };
}

function cleanSlackText(text) {
  return String(text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<!subteam\^[^>]+>/g, "")
    .trim();
}

function slackTitle(text) {
  const cleaned = cleanSlackText(text).replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 80) : "Hermes conversation";
}

// ---------------------------------------------------------------------------
// SQLite-backed accessors
// ---------------------------------------------------------------------------

const db = openDb(STATE_ROOT);

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

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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

const stmts = {
  upsertAgent: db.prepare(`
    INSERT INTO agents (id, handle, name, model, instructions, workspace_fqn,
                        slack_team_id, skills, mcp_servers,
                        slack_allowed_channels, slack_allowed_users,
                        created_at, updated_at)
    VALUES (@id, @handle, @name, @model, @instructions, @workspace_fqn,
            @slack_team_id, @skills, @mcp_servers,
            @slack_allowed_channels, @slack_allowed_users,
            @created_at, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      handle = excluded.handle,
      name = excluded.name,
      model = excluded.model,
      instructions = excluded.instructions,
      workspace_fqn = excluded.workspace_fqn,
      slack_team_id = excluded.slack_team_id,
      skills = excluded.skills,
      mcp_servers = excluded.mcp_servers,
      slack_allowed_channels = excluded.slack_allowed_channels,
      slack_allowed_users = excluded.slack_allowed_users,
      updated_at = excluded.updated_at
  `),
  getAgentById: db.prepare("SELECT * FROM agents WHERE id = ?"),
  getAgentByHandle: db.prepare("SELECT * FROM agents WHERE handle = ?"),
  insertRun: db.prepare(`
    INSERT INTO runs (id, hermes_session_id, status, slack_channel,
                      slack_message_ts, openai_kind, openai_id,
                      created_at, updated_at)
    VALUES (@id, @hermes_session_id, @status, @slack_channel,
            @slack_message_ts, @openai_kind, @openai_id,
            @created_at, @updated_at)
  `),
  setRunDispatched: db.prepare(
    "UPDATE runs SET status = ?, trigger = ?, updated_at = ? WHERE id = ?"
  ),
  setRunFailed: db.prepare(
    "UPDATE runs SET status = 'failed', error = ?, trigger = ?, updated_at = ? WHERE id = ?"
  ),
  setRunStatus: db.prepare(
    "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?"
  ),
  completeRun: db.prepare(`
    UPDATE runs
       SET status = ?,
           result = ?,
           error = ?,
           updated_at = ?
     WHERE id = ?
  `),
  setRunMessageTs: db.prepare(
    "UPDATE runs SET slack_message_ts = ?, updated_at = ? WHERE id = ?"
  ),
  getRunById: db.prepare("SELECT * FROM runs WHERE id = ?"),
  getRunByOpenAIId: db.prepare("SELECT * FROM runs WHERE openai_id = ? ORDER BY created_at DESC LIMIT 1"),
  selectResumeRuns: db.prepare(`
    SELECT * FROM runs
     WHERE status IN ('dispatched','running')
       AND slack_message_ts IS NOT NULL
  `),
  insertRunEvent: db.prepare(`
    INSERT INTO run_events (run_id, type, payload, created_at)
    VALUES (?, ?, ?, ?)
  `),
  selectRunEvents: db.prepare(
    "SELECT id, type, payload, created_at FROM run_events WHERE run_id = ? ORDER BY id ASC"
  ),
  selectRunEventsAfter: db.prepare(
    "SELECT id, type, payload, created_at FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC"
  ),
  getSlackThread: db.prepare(
    "SELECT * FROM slack_threads WHERE team_id = ? AND channel = ? AND thread_ts = ?"
  ),
  insertSlackThread: db.prepare(`
    INSERT INTO slack_threads (team_id, channel, thread_ts, hermes_session_id, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(team_id, channel, thread_ts) DO NOTHING
  `),
  claimSlackEvent: db.prepare(`
    INSERT INTO slack_seen_events (event_id, seen_at)
    VALUES (?, ?)
    ON CONFLICT(event_id) DO NOTHING
  `),
  claimSlackMessage: db.prepare(`
    INSERT INTO slack_seen_messages (key, seen_at)
    VALUES (?, ?)
    ON CONFLICT(key) DO NOTHING
  `),
  insertSlackFeedback: db.prepare(`
    INSERT INTO slack_feedback (run_id, value, slack_user_id, channel_id, message_ts, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
};

function ensureDefaultAgent() {
  const ts = now();
  const existing = stmts.getAgentById.get(defaultAgentId);
  const handle = defaultAgentHandle;
  const skills = JSON.stringify(defaultAgentSkills.length
    ? defaultAgentSkills
    : safeJsonArray(existing?.skills));
  const mcp = JSON.stringify(defaultAgentMcpServers.length
    ? defaultAgentMcpServers
    : safeJsonArray(existing?.mcp_servers));
  stmts.upsertAgent.run({
    id: defaultAgentId,
    handle,
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
    const normalized = handleFromString(handle);
    return rowToAgent(stmts.getAgentByHandle.get(normalized));
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
  const r = stmts.claimSlackEvent.run(eventId, now());
  return r.changes > 0;
}

function slackMessageClaimKey({ teamId, channel, ts, userId }) {
  return [teamId || "unknown-team", channel, ts, userId || "unknown-user"].join(":");
}

function claimSlackMessage({ teamId, channel, ts, userId }) {
  if (!channel || !ts) return true;
  const r = stmts.claimSlackMessage.run(slackMessageClaimKey({ teamId, channel, ts, userId }), now());
  return r.changes > 0;
}

// ---------------------------------------------------------------------------
// Slack helpers
// ---------------------------------------------------------------------------

function verifySlackRequest(req, body) {
  if (!SLACK_SIGNING_SECRET) return false;
  const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
  const signature = String(req.headers["x-slack-signature"] || "");
  if (!timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const eb = Buffer.from(expected);
  const sb = Buffer.from(signature);
  return eb.length === sb.length && timingSafeEqual(eb, sb);
}

async function slackToken() {
  return SLACK_BOT_TOKEN;
}

async function slackApi(method, body) {
  const token = await slackToken();
  if (!token) throw new Error("Slack bot token is required for Slack integration");
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok || !payload.ok) {
    throw new Error(`Slack ${method} failed: ${payload.error || res.status}`);
  }
  return payload;
}

function slackMarkdownChunk(text) {
  return { type: "markdown_text", text };
}

async function setSlackStatus({ channel, threadTs, status = SLACK_STATUS_TEXT }) {
  return slackApi("assistant.threads.setStatus", {
    channel_id: channel,
    thread_ts: threadTs,
    status,
    loading_messages: slackLoadingMessages
  });
}

async function clearSlackStatus({ channel, threadTs }) {
  return slackApi("assistant.threads.setStatus", {
    channel_id: channel,
    thread_ts: threadTs,
    status: ""
  });
}

async function startSlackStream({ channel, threadTs, teamId, userId, agent }) {
  return slackApi("chat.startStream", {
    channel,
    thread_ts: threadTs,
    recipient_team_id: teamId,
    recipient_user_id: userId,
    task_display_mode: "plan",
    chunks: [{
      type: "task_update",
      id: "hermes_turn",
      title: `Run ${agentLabel(agent)}`,
      status: "in_progress"
    }]
  });
}

async function appendSlackStream({ channel, ts, markdownText = "", chunks = null }) {
  const body = { channel, ts };
  const allChunks = [];
  if (markdownText) allChunks.push(slackMarkdownChunk(markdownText));
  if (chunks) allChunks.push(...chunks);
  if (allChunks.length) body.chunks = allChunks;
  return slackApi("chat.appendStream", body);
}

async function stopSlackStream({ channel, ts, markdownText = "", chunks = null, blocks = [] }) {
  const body = { channel, ts };
  const allChunks = [];
  if (markdownText) allChunks.push(slackMarkdownChunk(markdownText));
  if (chunks) allChunks.push(...chunks);
  if (allChunks.length) body.chunks = allChunks;
  if (blocks.length) body.blocks = blocks;
  return slackApi("chat.stopStream", body);
}

async function postSlackMessage({ channel, threadTs, text, blocks = null }) {
  const body = { channel, thread_ts: threadTs, text };
  if (blocks) body.blocks = blocks;
  return slackApi("chat.postMessage", body);
}

function slackPrompt({ text, context, agent }) {
  const contextLines = [];
  if (agent?.handle) contextLines.push(`Selected Hermes agent: ${agentLabel(agent)} (${agent.name || agent.id})`);
  if (context?.channel_id) contextLines.push(`Active Slack channel: ${context.channel_id}`);
  if (context?.team_id) contextLines.push(`Slack team: ${context.team_id}`);
  const contextText = contextLines.length ? `Slack context:\n${contextLines.join("\n")}\n\n` : "";
  return `${contextText}${text}`;
}

function slackFeedbackBlocks(runId) {
  return [
    {
      type: "context_actions",
      elements: [{
        type: "feedback_buttons",
        action_id: `hermes_feedback:${runId}`,
        positive_button: {
          text: { type: "plain_text", text: "Good" },
          value: `good:${runId}`,
          accessibility_label: "Mark this Hermes response as good"
        },
        negative_button: {
          text: { type: "plain_text", text: "Bad" },
          value: `bad:${runId}`,
          accessibility_label: "Mark this Hermes response as bad"
        }
      }]
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "Generated by Hermes. Review before acting." }]
    }
  ];
}

function chunkText(text, size = 3500) {
  const chunks = [];
  let remaining = String(text || "");
  while (remaining.length > size) {
    let splitAt = remaining.lastIndexOf("\n\n", size);
    if (splitAt < size * 0.5) splitAt = remaining.lastIndexOf(" ", size);
    if (splitAt < size * 0.5) splitAt = size;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function slackTaskDetails(lines) {
  return `\n${lines.filter(Boolean).join("\n")}`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return "n/a";
  const safeMs = Math.max(0, ms);
  if (safeMs < 1000) return `${Math.round(safeMs)}ms`;
  const seconds = safeMs / 1000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
}

function formatToolArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const keys = Object.keys(args).filter((key) => args[key] !== undefined).slice(0, 4);
  if (!keys.length) return "";
  const parts = keys.map((key) => {
    const value = args[key];
    if (value === null) return key;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return `${key}: ${String(value).slice(0, 80)}`;
    }
    if (Array.isArray(value)) return `${key}: ${value.length} items`;
    if (typeof value === "object") return `${key}: ${Object.keys(value).length} fields`;
    return key;
  });
  return ` (${parts.join(", ")})`;
}

function formatObserverProgress(payload) {
  if (!payload || typeof payload !== "object") return null;
  const duration = Number.isFinite(Number(payload.duration_ms))
    ? ` in ${formatDurationMs(Number(payload.duration_ms))}`
    : "";
  switch (payload.kind) {
    case "model_request_start":
      return `Model request started${payload.model ? `: ${payload.model}` : ""}`;
    case "model_request_complete": {
      const tools = Number(payload.assistant_tool_call_count || 0);
      const suffix = tools ? `, ${tools} tool call${tools === 1 ? "" : "s"} planned` : "";
      return `Model request finished${duration}${suffix}`;
    }
    case "model_request_error":
      return `Model request failed${duration}: ${payload.error_message || payload.reason || "unknown error"}`;
    case "tool_start":
      return `Calling tool: ${payload.tool_name || "unknown"}${formatToolArgs(payload.args)}`;
    case "tool_complete": {
      const status = payload.status || "done";
      const error = payload.error_message ? `: ${payload.error_message}` : "";
      return `Tool finished: ${payload.tool_name || "unknown"} (${status})${duration}${error}`;
    }
    case "subagent_start":
      return `Subagent started${payload.child_role ? `: ${payload.child_role}` : ""}${payload.child_goal ? ` - ${payload.child_goal}` : ""}`;
    case "subagent_stop":
      return `Subagent finished${payload.child_role ? `: ${payload.child_role}` : ""}${duration}`;
    default:
      return null;
  }
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

function responseObject(run) {
  return buildResponseObject(run, { model: HERMES_MODEL });
}

function chatCompletionObject(run) {
  return buildChatCompletionObject(run, { model: HERMES_MODEL });
}

function chatCompletionChunk(run, options = {}) {
  return buildChatCompletionChunk(run, { model: HERMES_MODEL, ...options });
}

function containsRawSecret(value) {
  if (value == null) return false;
  if (typeof value === "string") return RAW_SECRET_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsRawSecret);
  if (typeof value === "object") return Object.values(value).some(containsRawSecret);
  return false;
}

function rejectRawSecretsInPayload(payload) {
  if (containsRawSecret(payload)) {
    const error = new Error("payload contains raw secret-shaped value; use tfy-secret:// references stored in the agent SecretGroup");
    error.statusCode = 400;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// SSE plumbing
// ---------------------------------------------------------------------------

function writeSse(res, data, event = null) {
  if (res.writableEnded || res.destroyed) return;
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function startSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  const ctx = { aborted: false, keepAliveTimer: null };
  const onClose = () => {
    ctx.aborted = true;
    if (ctx.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
  };
  req.on("close", onClose);
  res.on("close", onClose);
  if (SSE_KEEPALIVE_MS > 0) {
    ctx.keepAliveTimer = setInterval(() => {
      if (ctx.aborted || res.writableEnded || res.destroyed) {
        if (ctx.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
        return;
      }
      res.write(": ping\n\n");
    }, SSE_KEEPALIVE_MS);
    ctx.keepAliveTimer.unref?.();
  }
  return ctx;
}

function endSse(res, ctx) {
  if (ctx?.keepAliveTimer) clearInterval(ctx.keepAliveTimer);
  if (!res.writableEnded) res.end();
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

function buildWorkPayload({ run, agent, content }) {
  return {
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

  const work = buildWorkPayload({ run, agent, content });
  const workB64 = Buffer.from(JSON.stringify(work), "utf8").toString("base64");

  const env = [
    `HARNESS_WORK_B64=${shellQuote(workB64)}`,
    `HARNESS_CALLBACK_TOKEN=${shellQuote(callbackToken)}`,
    `HARNESS_RUN_ID=${shellQuote(run.id)}`,
    `HARNESS_CONTROLLER_URL=${shellQuote(PUBLIC_BASE_URL)}`
  ].join(" ");
  const command = `sh -lc ${shellQuote(`${env} node executor/executor.mjs`)}`;

  const payload = {
    deploymentId,
    input: { command },
    metadata: { job_run_name_alias: run.id }
  };
  const res = await fetch(`${TFY_HOST}/api/svc/v1/jobs/trigger`, {
    method: "POST",
    headers: { authorization: `Bearer ${TFY_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`job trigger failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function reTriggerJob(runId) {
  // Used by the reconciler: look up the run row, re-trigger with a fresh
  // callback token. Idempotent via job_run_name_alias=run_id.
  const run = rowToRun(stmts.getRunById.get(runId));
  if (!run) throw new Error(`run ${runId} not found for re-trigger`);
  const agent = loadDefaultAgent();
  if (!agent) throw new Error("default agent missing");
  const token = signRunToken({
    runId: run.id,
    secret: RUN_TOKEN_SECRET,
    expSeconds: RUN_TOKEN_TTL_SECONDS
  });
  return triggerJob({ run, agent, content: "", callbackToken: token });
}

function createRun({
  hermesSessionId,
  openaiKind,
  openaiId,
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
    openai_id: openaiId,
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

function waitForTerminal({ runId, timeoutMs, isAborted = () => false }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsub = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
      resolve(result);
    }

    // Check current state up front.
    const initial = rowToRun(stmts.getRunById.get(runId));
    if (!initial) return finish({ run: null, timedOut: false, aborted: false });
    if (isRunTerminal(initial.status)) return finish({ run: initial, timedOut: false, aborted: false });

    unsub = subscribe(runId, (event) => {
      if (isAborted()) return finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: false, aborted: true });
      if (event?.type === "complete") {
        return finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: false, aborted: false });
      }
    });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: true, aborted: false });
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function streamRunText({ runId, timeoutMs, onDelta, isAborted = () => false }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsub = null;
    let lastEventId = 0;
    let streamedText = "";

    function feedRow(row) {
      if (row.type !== "stdout_delta") return;
      try {
        const data = JSON.parse(row.payload);
        const text = typeof data?.text === "string" ? data.text : "";
        if (text) {
          streamedText += text;
          Promise.resolve(onDelta(text)).catch(() => {});
        }
      } catch {
        // ignore malformed payloads
      }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
      resolve({ streamedText, ...result });
    }

    function handleTerminal() {
      const run = rowToRun(stmts.getRunById.get(runId));
      // Backfill any rows we haven't seen.
      lastEventId = backfillEvents(runId, lastEventId, feedRow);
      if (run?.status === "completed") {
        const finalText = String(run.result || "");
        if (finalText && finalText.startsWith(streamedText)) {
          const remainder = finalText.slice(streamedText.length);
          if (remainder) {
            streamedText += remainder;
            Promise.resolve(onDelta(remainder)).catch(() => {});
          }
        } else if (finalText && !streamedText) {
          streamedText = finalText;
          Promise.resolve(onDelta(finalText)).catch(() => {});
        }
      }
      finish({ run, timedOut: false, aborted: false });
    }

    const initial = rowToRun(stmts.getRunById.get(runId));
    if (!initial) return finish({ run: null, timedOut: false, aborted: false });

    unsub = subscribe(runId, (event) => {
      if (isAborted()) return finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: false, aborted: true });
      if (event?.type === "event") {
        lastEventId = backfillEvents(runId, lastEventId, feedRow);
        return;
      }
      if (event?.type === "complete") return handleTerminal();
    });

    // Backfill in case events landed before subscribe.
    lastEventId = backfillEvents(runId, lastEventId, feedRow);

    if (isRunTerminal(initial.status)) return handleTerminal();

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: true, aborted: false });
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

function streamRunToSlack({ runId, channel, ts, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let unsub = null;
    let lastEventId = 0;
    let streamedText = "";
    let progressCount = 0;

    function feedRow(row) {
      try {
        const payload = JSON.parse(row.payload);
        if (row.type === "stdout_delta") {
          const text = typeof payload?.text === "string" ? payload.text : "";
          if (text) {
            streamedText += text;
            for (const piece of chunkText(text)) {
              appendSlackStream({ channel, ts, markdownText: piece }).catch((error) => {
                console.error(`appendSlackStream failed: ${error instanceof Error ? error.message : String(error)}`);
              });
            }
          }
        } else if (row.type === "hermes_observer") {
          const line = formatObserverProgress(payload);
          if (line) {
            progressCount += 1;
            appendSlackStream({
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
        }
      } catch {
        // ignore malformed payloads
      }
    }

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (unsub) unsub();
      resolve({ streamedText, progressCount, ...result });
    }

    unsub = subscribe(runId, (event) => {
      if (event?.type === "event") {
        lastEventId = backfillEvents(runId, lastEventId, feedRow);
        return;
      }
      if (event?.type === "complete") {
        lastEventId = backfillEvents(runId, lastEventId, feedRow);
        finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: false });
      }
    });

    lastEventId = backfillEvents(runId, lastEventId, feedRow);
    const initial = rowToRun(stmts.getRunById.get(runId));
    if (!initial) return finish({ run: null, timedOut: false });
    if (isRunTerminal(initial.status)) return finish({ run: initial, timedOut: false });

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        finish({ run: rowToRun(stmts.getRunById.get(runId)), timedOut: true });
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

// ---------------------------------------------------------------------------
// Slack event handling
// ---------------------------------------------------------------------------

async function handleAssistantThreadStarted(payload) {
  const thread = payload.event?.assistant_thread;
  if (!thread?.channel_id || !thread?.thread_ts) return;
  const teamId = payload.team_id || thread.context?.team_id || null;
  const agent = loadDefaultAgent();
  if (!agent) return;
  if (!agentCanRespondToSlackUser(agent, thread.user_id)) return;
  if (!slackChannelAccess(agent, thread.channel_id).allowed) return;
  ensureSessionForSlackThread({ teamId, channel: thread.channel_id, threadTs: thread.thread_ts });
  await slackApi("assistant.threads.setSuggestedPrompts", {
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
  if (!agent) return;
  if (!agentCanRespondToSlackUser(agent, thread.user_id)) return;
  if (!slackChannelAccess(agent, thread.channel_id).allowed) return;
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
  const channelType = event.channel_type || "";
  const isDirectMessage = channelType === "im" || channel.startsWith("D");
  const isBotMention = event.type === "app_mention";
  const shouldRespond = Boolean(route.handle || isBotMention || isDirectMessage);

  if (!shouldRespond) return;

  const defaultAgent = loadDefaultAgent();
  if (!text) {
    await postSlackMessage({
      channel,
      threadTs,
      text: `What should ${agentLabel(defaultAgent)} work on? Send a request in this thread or message the app directly.`
    });
    return;
  }
  const claimed = claimSlackMessage({ teamId, channel, ts: event.ts, userId: event.user });
  if (!claimed) return;

  let agent = defaultAgent;
  if (route.handle) {
    const target = loadAgentByHandle(route.handle);
    if (!target) {
      await postSlackMessage({
        channel,
        threadTs,
        text: `This Slack app is configured for ${agentLabel(defaultAgent)}. Use the Slack app for ${agentLabel({ handle: route.handle })} if you want that agent.`
      });
      return;
    }
    agent = target;
  }
  if (!agentCanRespondToSlackUser(agent, event.user)) return;
  if (!slackChannelAccess(agent, channel).allowed) return;

  const hermesSessionId = ensureSessionForSlackThread({ teamId, channel, threadTs });

  let stream = null;
  try {
    await slackApi("assistant.threads.setTitle", {
      channel_id: channel,
      thread_ts: threadTs,
      title: `${agentLabel(agent)} ${slackTitle(text)}`.slice(0, 80)
    }).catch(() => {});
    await setSlackStatus({ channel, threadTs });
    stream = await startSlackStream({ channel, threadTs, teamId, userId: event.user, agent });

    const run = createRun({
      hermesSessionId,
      openaiKind: "slack",
      openaiId: null,
      slackChannel: channel,
      slackMessageTs: stream.ts
    });

    const prompt = slackPrompt({
      text,
      context: { channel_id: channel, team_id: teamId },
      agent
    });

    const dispatched = await dispatchRun({ run, agent, content: prompt });

    await appendSlackStream({
      channel,
      ts: stream.ts,
      chunks: [{
        type: "task_update",
        id: "hermes_turn",
        title: `Run ${agentLabel(agent)}`,
        status: dispatched.run.status === "failed" ? "error" : "in_progress",
        details: slackTaskDetails([
          "Request received",
          "Slack stream opened",
          dispatched.run.status === "failed"
            ? `Failed to dispatch: ${dispatched.run.error || ""}`.slice(0, 256)
            : "Executor job queued"
        ])
      }]
    });

    if (dispatched.run.status === "failed") {
      await stopSlackStream({
        channel,
        ts: stream.ts,
        markdownText: `I couldn't finish that request: ${dispatched.run.error || "executor dispatch failed"}`,
        blocks: slackFeedbackBlocks(run.id)
      });
      await clearSlackStatus({ channel, threadTs }).catch(() => {});
      return;
    }

    const streamed = await streamRunToSlack({
      runId: run.id,
      channel,
      ts: stream.ts,
      timeoutMs: SLACK_RUN_TIMEOUT_MS
    });

    if (!streamed.run || streamed.run.status !== "completed") {
      const errorMessage = streamed.run?.error
        || (streamed.timedOut
          ? "Hermes did not finish before the Slack response timeout."
          : "Hermes run failed");
      await appendSlackStream({
        channel,
        ts: stream.ts,
        chunks: [{
          type: "task_update",
          id: "hermes_turn",
          title: `Run ${agentLabel(agent)}`,
          status: "error",
          details: slackTaskDetails([`Failed: ${errorMessage.slice(0, 256)}`])
        }]
      });
      await stopSlackStream({
        channel,
        ts: stream.ts,
        markdownText: `I couldn't finish that request: ${errorMessage}`,
        blocks: slackFeedbackBlocks(run.id)
      });
      await clearSlackStatus({ channel, threadTs }).catch(() => {});
      return;
    }

    const output = String(streamed.run.result || "").trim() || "Hermes finished, but returned no text.";
    const alreadyStreamed = streamed.streamedText.trim();
    const finalRemainder = alreadyStreamed && output.startsWith(alreadyStreamed)
      ? output.slice(alreadyStreamed.length).trimStart()
      : alreadyStreamed ? "" : output;
    for (const chunk of chunkText(finalRemainder)) {
      await appendSlackStream({ channel, ts: stream.ts, markdownText: chunk });
      if (SLACK_STREAM_CHUNK_DELAY_MS > 0) await sleep(SLACK_STREAM_CHUNK_DELAY_MS);
    }
    await appendSlackStream({
      channel,
      ts: stream.ts,
      chunks: [{
        type: "task_update",
        id: "hermes_turn",
        title: `Run ${agentLabel(agent)}`,
        status: "complete",
        details: streamed.progressCount
          ? slackTaskDetails(["Completed"])
          : slackTaskDetails(["Completed; no Hermes tool events emitted"])
      }]
    });
    await stopSlackStream({
      channel,
      ts: stream.ts,
      blocks: slackFeedbackBlocks(streamed.run.id)
    });
    await clearSlackStatus({ channel, threadTs }).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stream?.ts) {
      await stopSlackStream({
        channel,
        ts: stream.ts,
        markdownText: `I couldn't finish that request: ${message}`
      }).catch(() => {});
    } else {
      await postSlackMessage({
        channel,
        threadTs,
        text: `I couldn't finish that request: ${message}`
      }).catch(() => {});
    }
    await clearSlackStatus({ channel, threadTs }).catch(() => {});
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
  const ctx = startSse(req, res);
  let sequenceNumber = 0;
  const responseId = run.openai_id || openAIId("resp", run.id);
  const itemId = openAIId("msg", run.id);
  const created = { ...responseObject(run), status: "in_progress", output: [], output_text: "" };

  writeSse(res, { type: "response.created", sequence_number: sequenceNumber++, response: created }, "response.created");
  writeSse(res, { type: "response.in_progress", sequence_number: sequenceNumber++, response: created }, "response.in_progress");
  writeSse(res, {
    type: "response.output_item.added",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    output_index: 0,
    item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] }
  }, "response.output_item.added");
  writeSse(res, {
    type: "response.content_part.added",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  }, "response.content_part.added");

  const streamed = await streamRunText({
    runId: run.id,
    timeoutMs: OPENAI_SYNC_TIMEOUT_MS,
    isAborted: () => ctx.aborted,
    onDelta: async (delta) => {
      writeSse(res, {
        type: "response.output_text.delta",
        sequence_number: sequenceNumber++,
        response_id: responseId,
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta
      }, "response.output_text.delta");
    }
  });

  if (streamed.aborted) return endSse(res, ctx);

  if (!streamed.run || streamed.run.status !== "completed") {
    writeSse(res, {
      type: "error",
      sequence_number: sequenceNumber++,
      error: {
        type: "server_error",
        message: streamed.run?.error || "Hermes run did not complete before the streaming timeout"
      }
    }, "error");
    return endSse(res, ctx);
  }

  const finalText = String(streamed.run.result || "");
  writeSse(res, {
    type: "response.output_text.done",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: finalText
  }, "response.output_text.done");
  writeSse(res, {
    type: "response.content_part.done",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: finalText, annotations: [] }
  }, "response.content_part.done");
  writeSse(res, {
    type: "response.output_item.done",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: finalText, annotations: [] }]
    }
  }, "response.output_item.done");
  writeSse(res, {
    type: "response.completed",
    sequence_number: sequenceNumber++,
    response: responseObject(streamed.run)
  }, "response.completed");
  endSse(res, ctx);
}

async function streamChatCompletion(req, res, run, { includeUsage = false } = {}) {
  const ctx = startSse(req, res);
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
  const dir = join(STATE_ROOT, "sessions");
  await mkdir(dir, { recursive: true });
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

function resumeInFlightSlackStreams() {
  const rows = stmts.selectResumeRuns.all();
  for (const row of rows) {
    const run = rowToRun(row);
    if (!run.slack_channel || !run.slack_message_ts) continue;
    console.log(`[hermes] resuming Slack stream for ${run.id}`);
    streamRunToSlack({
      runId: run.id,
      channel: run.slack_channel,
      ts: run.slack_message_ts,
      timeoutMs: SLACK_RUN_TIMEOUT_MS
    }).then(async (streamed) => {
      if (!streamed.run) return;
      try {
        if (streamed.run.status === "completed") {
          const output = String(streamed.run.result || "").trim() || "Hermes finished, but returned no text.";
          const alreadyStreamed = streamed.streamedText.trim();
          const remainder = alreadyStreamed && output.startsWith(alreadyStreamed)
            ? output.slice(alreadyStreamed.length).trimStart()
            : alreadyStreamed ? "" : output;
          for (const chunk of chunkText(remainder)) {
            await appendSlackStream({ channel: run.slack_channel, ts: run.slack_message_ts, markdownText: chunk });
          }
          await stopSlackStream({
            channel: run.slack_channel,
            ts: run.slack_message_ts,
            blocks: slackFeedbackBlocks(run.id)
          });
        } else if (streamed.run.status === "failed") {
          await stopSlackStream({
            channel: run.slack_channel,
            ts: run.slack_message_ts,
            markdownText: `I couldn't finish that request: ${streamed.run.error || "run failed"}`,
            blocks: slackFeedbackBlocks(run.id)
          });
        }
      } catch (error) {
        console.error(`[hermes] resume Slack stream failed for ${run.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }).catch((error) => {
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

async function handle(req, res) {
  if (shuttingDown) return send(res, 503, { error: "server is shutting down" });
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, stateRoot: STATE_ROOT });
    }

    if (req.method === "GET" && url.pathname === "/slack/health") {
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

    if (req.method === "POST" && url.pathname === "/slack/events") {
      const body = await rawBody(req);
      if (!verifySlackRequest(req, body)) return send(res, 401, { error: "invalid Slack signature" });
      let payload;
      try { payload = body ? JSON.parse(body) : {}; }
      catch { return send(res, 400, { error: "invalid JSON body" }); }
      if (payload.type === "url_verification") return send(res, 200, { challenge: payload.challenge });
      if (!(await slackToken())) return send(res, 503, { error: "Slack bot token is not configured" });
      processSlackEvent(payload).catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
      });
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/slack/interactions") {
      const body = await rawBody(req);
      if (!verifySlackRequest(req, body)) return send(res, 401, { error: "invalid Slack signature" });
      handleSlackInteraction(body).catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
      });
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!requireOpenAIAuth(req, res)) return;
      return send(res, 200, { object: "list", data: [{ id: HERMES_MODEL, object: "model" }] });
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (!requireOpenAIAuth(req, res)) return;
      const [ok, body] = await readJsonOrError(req, res);
      if (!ok) return;
      try { rejectRawSecretsInPayload(body); } catch (error) {
        return sendOpenAIError(res, error.statusCode || 400, error.message);
      }
      let content;
      try { content = responsePrompt(body); }
      catch (error) { return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error)); }

      let hermesSessionId = randomUUID();
      if (body.previous_response_id) {
        const priorRun = rowToRun(stmts.getRunByOpenAIId.get(body.previous_response_id));
        if (priorRun?.hermes_session_id) hermesSessionId = priorRun.hermes_session_id;
      }

      const runId = newRunId();
      const responseId = openAIId("resp", runId);
      const ts = now();
      stmts.insertRun.run({
        id: runId,
        hermes_session_id: hermesSessionId,
        status: "queued",
        slack_channel: null,
        slack_message_ts: null,
        openai_kind: "response",
        openai_id: responseId,
        created_at: ts,
        updated_at: ts
      });
      const run = getRunOrThrow(runId);
      const agent = loadDefaultAgent();
      const dispatched = await dispatchRun({ run, agent, content });

      if (body.stream) return streamResponseObject(req, res, dispatched.run);
      if (body.background) return send(res, 200, responseObject(dispatched.run));

      const aborted = { value: false };
      req.on("close", () => { aborted.value = true; });
      const waited = await waitForTerminal({
        runId: run.id,
        timeoutMs: OPENAI_SYNC_TIMEOUT_MS,
        isAborted: () => aborted.value
      });
      if (aborted.value) return;
      if (!waited.run) return sendOpenAIError(res, 404, "response not found", "invalid_request_error");
      if (waited.run.status === "failed") {
        return sendOpenAIError(res, 500, waited.run.error || "Hermes run failed", "server_error");
      }
      if (waited.run.status !== "completed") {
        return sendOpenAIError(res, 504, "Hermes run did not complete before the synchronous OpenAI adapter timeout", "server_error");
      }
      return send(res, 200, responseObject(waited.run));
    }

    const responseMatch = url.pathname.match(/^\/v1\/responses\/([^/]+)$/);
    if (responseMatch && req.method === "GET") {
      if (!requireOpenAIAuth(req, res)) return;
      const run = rowToRun(stmts.getRunByOpenAIId.get(responseMatch[1]));
      return run ? send(res, 200, responseObject(run)) : sendOpenAIError(res, 404, "response not found", "invalid_request_error");
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!requireOpenAIAuth(req, res)) return;
      const [ok, body] = await readJsonOrError(req, res);
      if (!ok) return;
      try { rejectRawSecretsInPayload(body); } catch (error) {
        return sendOpenAIError(res, error.statusCode || 400, error.message);
      }
      let content;
      try { content = promptFromMessages(body.messages); }
      catch (error) { return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error)); }

      const runId = newRunId();
      const completionId = openAIId("chatcmpl", runId);
      const ts = now();
      stmts.insertRun.run({
        id: runId,
        hermes_session_id: randomUUID(),
        status: "queued",
        slack_channel: null,
        slack_message_ts: null,
        openai_kind: "chat.completion",
        openai_id: completionId,
        created_at: ts,
        updated_at: ts
      });
      const run = getRunOrThrow(runId);
      const agent = loadDefaultAgent();
      const dispatched = await dispatchRun({ run, agent, content });

      if (body.stream) {
        return streamChatCompletion(req, res, dispatched.run, {
          includeUsage: Boolean(body.stream_options?.include_usage)
        });
      }

      const aborted = { value: false };
      req.on("close", () => { aborted.value = true; });
      const waited = await waitForTerminal({
        runId: run.id,
        timeoutMs: OPENAI_SYNC_TIMEOUT_MS,
        isAborted: () => aborted.value
      });
      if (aborted.value) return;
      if (!waited.run) return sendOpenAIError(res, 404, "chat completion not found", "invalid_request_error");
      if (waited.run.status === "failed") {
        return sendOpenAIError(res, 500, waited.run.error || "Hermes run failed", "server_error");
      }
      if (waited.run.status !== "completed") {
        return sendOpenAIError(res, 504, "Hermes run did not complete before the synchronous OpenAI adapter timeout", "server_error");
      }
      return send(res, 200, chatCompletionObject(waited.run));
    }

    const chatCompletionMatch = url.pathname.match(/^\/v1\/chat\/completions\/([^/]+)$/);
    if (chatCompletionMatch && req.method === "GET") {
      if (!requireOpenAIAuth(req, res)) return;
      const run = rowToRun(stmts.getRunByOpenAIId.get(chatCompletionMatch[1]));
      return run ? send(res, 200, chatCompletionObject(run)) : sendOpenAIError(res, 404, "chat completion not found", "invalid_request_error");
    }

    const internalEventsMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/events$/);
    if (internalEventsMatch && req.method === "POST") {
      const runId = internalEventsMatch[1];
      if (!requireRunToken(req, res, runId)) return;
      const body = await json(req);
      const run = rowToRun(stmts.getRunById.get(runId));
      if (!run) return send(res, 404, { error: "run not found" });
      const payload = JSON.stringify(body || {});
      const insert = stmts.insertRunEvent.run(runId, body?.type || "event", payload, now());
      // Bump run status to 'running' on first event arrival if still dispatched.
      if (run.status === "dispatched") stmts.setRunStatus.run("running", now(), runId);
      publish(runId, { type: "event", id: insert.lastInsertRowid });
      return send(res, 200, { ok: true });
    }

    const internalCompleteMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/complete$/);
    if (internalCompleteMatch && req.method === "POST") {
      const runId = internalCompleteMatch[1];
      if (!requireRunToken(req, res, runId)) return;
      const body = await json(req);
      const run = rowToRun(stmts.getRunById.get(runId));
      if (!run) return send(res, 404, { error: "run not found" });
      const status = body?.status || "completed";
      stmts.completeRun.run(status, body?.result || "", body?.error || null, now(), runId);
      publish(runId, { type: "complete", status, error: body?.error || null });
      return send(res, 200, { run: rowToRun(stmts.getRunById.get(runId)) });
    }

    const internalGetDbMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/session-db$/);
    if (internalGetDbMatch && req.method === "GET") {
      const runId = internalGetDbMatch[1];
      if (!requireRunToken(req, res, runId)) return;
      const run = rowToRun(stmts.getRunById.get(runId));
      if (!run) return send(res, 404, { error: "run not found" });
      return streamSessionDb(req, res, run.hermes_session_id);
    }
    if (internalGetDbMatch && req.method === "POST") {
      const runId = internalGetDbMatch[1];
      if (!requireRunToken(req, res, runId)) return;
      const run = rowToRun(stmts.getRunById.get(runId));
      if (!run) return send(res, 404, { error: "run not found" });
      return receiveSessionDb(req, res, run.hermes_session_id);
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      const run = rowToRun(stmts.getRunById.get(runMatch[1]));
      return run ? send(res, 200, { run }) : send(res, 404, { error: "run not found" });
    }

    if (req.method === "GET" && url.pathname === "/") {
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
