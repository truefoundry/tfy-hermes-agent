import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT || 8787);
const STATE_ROOT = process.env.HARNESS_STATE_DIR || "/data/state";
const TFY_BASE_URL = (process.env.TFY_BASE_URL || process.env.TFY_HOST || "").replace(/\/+$/, "");
const TFY_PLATFORM_API_KEY = process.env.TFY_PLATFORM_API_KEY || process.env.TFY_API_KEY || "";
const TFY_GATEWAY_API_KEY = process.env.TFY_GATEWAY_API_KEY || "";
const TFY_WORKSPACE_FQN = process.env.TFY_WORKSPACE_FQN || "";
const HERMES_MODEL = process.env.HERMES_INFERENCE_MODEL || process.env.HARNESS_MODEL || "openai-main/gpt-5.5";
const HERMES_JOB_APPLICATION_NAME = process.env.HERMES_JOB_APPLICATION_NAME || "hermes-turn-runner";
const SKILLS_REGISTRY_URL = process.env.HERMES_SKILLS_REGISTRY_URL || "";
const OPENAI_SYNC_TIMEOUT_MS = Number(process.env.HERMES_OPENAI_SYNC_TIMEOUT_MS || 120000);
const OPENAI_POLL_INTERVAL_MS = Number(process.env.HERMES_OPENAI_POLL_INTERVAL_MS || 1000);
const OPENAI_API_KEY = process.env.HERMES_OPENAI_API_KEY || "";
const HARNESS_INTERNAL_TOKEN = process.env.HARNESS_INTERNAL_TOKEN || "";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.HARNESS_API_URL || "").replace(/\/+$/, "");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";
const SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || "";
const SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || "";
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || "";
const SLACK_OAUTH_STATE_SECRET = process.env.SLACK_OAUTH_STATE_SECRET || "";
const SLACK_OAUTH_ENABLED = ["1", "true", "yes"].includes(String(process.env.HERMES_SLACK_OAUTH_ENABLED || "").toLowerCase())
  && Boolean(SLACK_CLIENT_ID && SLACK_CLIENT_SECRET && SLACK_OAUTH_STATE_SECRET);
const SLACK_RUN_TIMEOUT_MS = Number(process.env.HERMES_SLACK_RUN_TIMEOUT_MS || OPENAI_SYNC_TIMEOUT_MS);
const SLACK_STREAM_CHUNK_DELAY_MS = Number(process.env.HERMES_SLACK_STREAM_CHUNK_DELAY_MS || 120);
const SLACK_STATUS_TEXT = process.env.HERMES_SLACK_STATUS_TEXT || "is thinking...";
const SLACK_DRY_RUN = ["1", "true", "yes"].includes(String(process.env.HERMES_SLACK_DRY_RUN || "").toLowerCase());
const SLACK_CREATE_USERGROUPS = ["1", "true", "yes"].includes(String(process.env.HERMES_SLACK_CREATE_USERGROUPS || "false").toLowerCase());
const SLACK_REQUIRE_CHANNEL_DEPLOYMENT = ["1", "true", "yes"].includes(String(process.env.HERMES_SLACK_REQUIRE_CHANNEL_DEPLOYMENT || "false").toLowerCase());
const LOCAL_RUN_RESULT = process.env.HERMES_LOCAL_RUN_RESULT || "";
const MAX_RUNS = Number(process.env.HERMES_MAX_RUNS || 2000);
const MAX_SESSIONS = Number(process.env.HERMES_MAX_SESSIONS || 2000);
const MAX_SLACK_CALLS = Number(process.env.HERMES_MAX_SLACK_CALLS || 500);
const SSE_KEEPALIVE_MS = Number(process.env.HERMES_SSE_KEEPALIVE_MS || 15000);
const RAW_SECRET_PATTERN = /\b(?:xoxb-[a-z0-9-]{10,}|xoxp-[a-z0-9-]{10,}|xapp-[a-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

const stateFile = path.join(STATE_ROOT, "state.json");
const defaultAgentId = "agt_hermes";
const defaultAgentHandle = handleFromString(process.env.HERMES_AGENT_HANDLE || process.env.HERMES_SLACK_HANDLE || "hermes");
const defaultAgentName = process.env.HERMES_AGENT_NAME || "Hermes Agent";
const defaultAgentDescription = process.env.HERMES_AGENT_DESCRIPTION || "";
const defaultAgentInstructions = process.env.HERMES_AGENT_INSTRUCTIONS || "";
const defaultAgentSkills = listFromEnv(process.env.HERMES_AGENT_SKILLS);
const defaultAgentMcpServers = listFromEnv(process.env.HERMES_AGENT_MCP_SERVERS);
const defaultAgentSecretRefs = listFromEnv(process.env.HERMES_AGENT_SECRET_REFS);

const slackLoadingMessages = (process.env.HERMES_SLACK_LOADING_MESSAGES || [
  "Reading the thread",
  "Planning the next step",
  "Running Hermes",
  "Preparing the reply"
].join("|")).split("|").map((message) => message.trim()).filter(Boolean).slice(0, 10);

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function listFromEnv(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function defaultAgentRecord(existing = {}) {
  return {
    ...existing,
    id: defaultAgentId,
    name: defaultAgentName,
    handle: defaultAgentHandle,
    description: defaultAgentDescription || existing.description || "",
    instructions: defaultAgentInstructions || existing.instructions || "",
    model: HERMES_MODEL,
    workspaceFqn: TFY_WORKSPACE_FQN,
    skills: defaultAgentSkills.length ? defaultAgentSkills : Array.isArray(existing.skills) ? existing.skills : [],
    mcpServers: defaultAgentMcpServers.length ? defaultAgentMcpServers : Array.isArray(existing.mcpServers) ? existing.mcpServers : [],
    secretRefs: defaultAgentSecretRefs.length ? defaultAgentSecretRefs : Array.isArray(existing.secretRefs) ? existing.secretRefs : [],
    createdAt: existing.createdAt || now(),
    updatedAt: existing.updatedAt || now()
  };
}

function normalizeState(state) {
  state.agents ||= {};
  state.agents[defaultAgentId] = defaultAgentRecord(state.agents[defaultAgentId]);
  state.sessions ||= {};
  state.runs ||= {};
  state.slack ||= {};
  state.slack.threads ||= {};
  state.slack.events ||= {};
  state.slack.feedback ||= {};
  state.slack.userAgents ||= {};
  state.slack.usergroups ||= {};
  state.slack.installations ||= {};
  state.slack.calls ||= [];
  for (const agent of Object.values(state.agents)) {
    if (agent.slackUsergroupId) state.slack.usergroups[agent.slackUsergroupId] = agent.id;
  }
  return state;
}

async function loadState() {
  await mkdir(STATE_ROOT, { recursive: true });
  try {
    return normalizeState(JSON.parse(await readFile(stateFile, "utf8")));
  } catch {
    return normalizeState({
      agents: {
        [defaultAgentId]: defaultAgentRecord()
      },
      sessions: {},
      runs: {},
      slack: {
        threads: {},
        events: {},
        feedback: {},
        userAgents: {},
        usergroups: {},
        installations: {},
        calls: []
      }
    });
  }
}

function pruneState(state) {
  const runEntries = Object.entries(state.runs || {});
  if (runEntries.length > MAX_RUNS) {
    runEntries.sort((a, b) => new Date(b[1].updatedAt || b[1].createdAt || 0) - new Date(a[1].updatedAt || a[1].createdAt || 0));
    state.runs = Object.fromEntries(runEntries.slice(0, MAX_RUNS));
  }
  const sessionEntries = Object.entries(state.sessions || {});
  if (sessionEntries.length > MAX_SESSIONS) {
    sessionEntries.sort((a, b) => new Date(b[1].updatedAt || b[1].createdAt || 0) - new Date(a[1].updatedAt || a[1].createdAt || 0));
    state.sessions = Object.fromEntries(sessionEntries.slice(0, MAX_SESSIONS));
  }
  if (Array.isArray(state.slack?.calls) && state.slack.calls.length > MAX_SLACK_CALLS) {
    state.slack.calls = state.slack.calls.slice(-MAX_SLACK_CALLS);
  }
  return state;
}

let stateWriteChain = Promise.resolve();

async function saveState(state) {
  pruneState(state);
  await mkdir(STATE_ROOT, { recursive: true });
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  const tmpFile = `${stateFile}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  const write = stateWriteChain.then(async () => {
    await writeFile(tmpFile, payload);
    await rename(tmpFile, stateFile);
  });
  stateWriteChain = write.catch(() => {});
  return write;
}

let mutationQueue = Promise.resolve();

function withState(mutator) {
  const next = mutationQueue.then(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await saveState(state);
    return result;
  });
  mutationQueue = next.catch(() => {});
  return next;
}

async function json(req) {
  const body = await rawBody(req);
  if (!body) return {};
  return JSON.parse(body);
}

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return "";
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendOpenAIError(res, status, message, type = "invalid_request_error", param = null, code = null) {
  return send(res, status, {
    error: {
      message,
      type,
      param,
      code
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifySlackRequest(req, body) {
  if (!SLACK_SIGNING_SECRET) return false;
  const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
  const signature = String(req.headers["x-slack-signature"] || "");
  if (!timestamp || !signature) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;

  const expected = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  return expectedBuffer.length === signatureBuffer.length && timingSafeEqual(expectedBuffer, signatureBuffer);
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

function agentByHandle(state, handle) {
  const normalized = handleFromString(handle);
  return Object.values(state.agents).find((agent) => agent.handle === normalized) || null;
}

function agentBySlackUsergroup(state, usergroupId, fallbackHandle = null) {
  const agentId = state.slack.usergroups?.[usergroupId];
  if (agentId && state.agents[agentId]) return state.agents[agentId];
  const byId = Object.values(state.agents).find((agent) => agent.slackUsergroupId === usergroupId);
  if (byId) return byId;
  if (fallbackHandle) {
    try {
      return agentByHandle(state, fallbackHandle);
    } catch {
      return null;
    }
  }
  return null;
}

function agentLabel(agent) {
  return `@${agent?.handle || defaultAgentHandle}`;
}

function parseMessageHandle(text) {
  const cleaned = cleanSlackText(text);
  const match = cleaned.match(/^(?:agent:|use\s+)?[@#/]([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?:\s+|$)([\s\S]*)$/);
  if (!match) return { handle: null, text: cleaned };
  return {
    handle: handleFromString(match[1]),
    text: match[2].trim()
  };
}

function slackUsergroupMentions(text) {
  return Array.from(String(text || "").matchAll(/<!subteam\^([A-Z0-9]+)(?:\|@?([^>]+))?>/g))
    .map((match) => ({
      id: match[1],
      handle: safeHandle(match[2])
    }));
}

function safeHandle(value) {
  if (!value) return null;
  try {
    return handleFromString(value);
  } catch {
    return null;
  }
}

function parseMessageRoute(state, text) {
  const mentions = slackUsergroupMentions(text);
  for (const mention of mentions) {
    const agent = agentBySlackUsergroup(state, mention.id, mention.handle);
    if (agent) {
      return {
        agent,
        handle: agent.handle,
        text: cleanSlackText(text),
        source: "slack_usergroup"
      };
    }
  }

  const parsed = parseMessageHandle(text);
  return {
    agent: null,
    handle: parsed.handle,
    text: parsed.text,
    source: parsed.handle ? "typed_handle" : null,
    unknownUsergroupMentioned: mentions.length > 0
  };
}

function createAgentRecord({ handle, name, description, instructions, model, createdBy }) {
  const normalized = handleFromString(handle);
  return {
    id: id("agt"),
    name: name || `${normalized} agent`,
    handle: normalized,
    description: description || "",
    instructions: instructions || "",
    model: model || HERMES_MODEL,
    workspaceFqn: TFY_WORKSPACE_FQN,
    skills: [],
    mcpServers: [],
    secretRefs: [],
    createdBy: createdBy || null,
    createdAt: now(),
    updatedAt: now()
  };
}

function normalizeSlackChannelIds(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function normalizeSlackUserIds(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)));
}

function deployAgentToSlackChannels(agent, channelIds) {
  const existing = normalizeSlackChannelIds(agent.slackChannelIds || []);
  const next = normalizeSlackChannelIds([...existing, ...normalizeSlackChannelIds(channelIds)]);
  return {
    ...agent,
    slackChannelIds: next,
    updatedAt: now()
  };
}

function agentCanRespondInSlackChannel(agent, channel, { isDirectMessage = false } = {}) {
  if (isDirectMessage || !SLACK_REQUIRE_CHANNEL_DEPLOYMENT) return true;
  const channelIds = normalizeSlackChannelIds(agent?.slackChannelIds || []);
  return channelIds.includes(channel);
}

function formatAgentList(state) {
  const agents = Object.values(state.agents)
    .sort((a, b) => String(a.handle || "").localeCompare(String(b.handle || "")));
  if (!agents.length) return "No Hermes agents exist yet.";
  return agents.map((agent) => {
    const channels = normalizeSlackChannelIds(agent.slackChannelIds || []);
    const channelText = channels.length ? ` - channels: ${channels.join(", ")}` : " - not deployed";
    return `${agentLabel(agent)} - ${agent.name || agent.id}${SLACK_REQUIRE_CHANNEL_DEPLOYMENT ? channelText : ""}`;
  }).join("\n");
}

async function slackToken({ teamId = null } = {}) {
  if (teamId) {
    const state = await loadState();
    const token = state.slack.installations?.[teamId]?.botToken;
    if (token) return token;
  }
  return SLACK_BOT_TOKEN;
}

async function slackApi(method, body, options = {}) {
  if (SLACK_DRY_RUN) {
    const ts = `${Math.floor(Date.now() / 1000)}.${String(Date.now() % 1000).padStart(6, "0")}`;
    const usergroupId = `S${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const payload = {
      ok: true,
      channel: body.channel || body.channel_id,
      ts,
      usergroup: method.startsWith("usergroups.") ? {
        id: body.usergroup || usergroupId,
        team_id: body.team_id || "TDRYRUN",
        is_usergroup: true,
        name: body.name || body.handle || "Hermes Agent",
        handle: body.handle || "hermes",
        description: body.description || "",
        user_count: 0
      } : undefined,
      message: method === "chat.stopStream" ? { type: "message", text: body.markdown_text || "", ts } : undefined
    };
    await withState((state) => {
      state.slack.calls.push({ method, body, response: payload, createdAt: now() });
    });
    return payload;
  }
  const token = await slackToken(options);
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

function slackOAuthStateToken(nonce) {
  if (!SLACK_OAUTH_STATE_SECRET) throw new Error("SLACK_OAUTH_STATE_SECRET is required for Slack OAuth");
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = `${nonce}.${issuedAt}`;
  const signature = createHmac("sha256", SLACK_OAUTH_STATE_SECRET).update(payload).digest("hex");
  return `${payload}.${signature}`;
}

function verifySlackOAuthState(value, maxAgeSeconds = 600) {
  if (!SLACK_OAUTH_STATE_SECRET || !value) return false;
  const parts = String(value).split(".");
  if (parts.length !== 3) return false;
  const [nonce, issuedAtRaw, signature] = parts;
  if (!nonce || !signature) return false;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - issuedAt) > maxAgeSeconds) return false;
  const expected = createHmac("sha256", SLACK_OAUTH_STATE_SECRET).update(`${nonce}.${issuedAtRaw}`).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  return expectedBuf.length === signatureBuf.length && timingSafeEqual(expectedBuf, signatureBuf);
}

async function exchangeSlackOAuthCode(code) {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required for Slack OAuth");
  }
  const form = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    code
  });
  if (SLACK_REDIRECT_URI) form.set("redirect_uri", SLACK_REDIRECT_URI);
  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok || !payload.ok) {
    throw new Error(`Slack OAuth failed: ${payload.error || res.status}`);
  }
  return payload;
}

function storeSlackInstallation(state, payload) {
  const teamId = payload.team?.id || payload.authed_user?.team_id;
  if (!teamId || !payload.access_token) {
    throw new Error("Slack OAuth response did not include a team id and bot token");
  }
  state.slack.installations[teamId] = {
    teamId,
    teamName: payload.team?.name || null,
    enterpriseId: payload.enterprise?.id || null,
    enterpriseName: payload.enterprise?.name || null,
    botToken: payload.access_token,
    botUserId: payload.bot_user_id || null,
    appId: payload.app_id || null,
    scope: payload.scope || null,
    tokenType: payload.token_type || "bot",
    installedAt: now(),
    updatedAt: now()
  };
  return state.slack.installations[teamId];
}

async function syncSlackDryRunCalls(state) {
  if (!SLACK_DRY_RUN) return state;
  try {
    const latest = JSON.parse(await readFile(stateFile, "utf8"));
    state.slack.calls = latest.slack?.calls || state.slack.calls || [];
  } catch {
    state.slack.calls ||= [];
  }
  return state;
}

function slackThreadKey({ teamId, channel, threadTs }) {
  return [teamId || "unknown-team", channel, threadTs].join(":");
}

function ensureSlackThreadSession(state, { teamId, userId, channel, threadTs, context = null, agentId = defaultAgentId }) {
  const key = slackThreadKey({ teamId, channel, threadTs });
  let thread = state.slack.threads[key];
  if (!thread || !state.sessions[thread.sessionId]) {
    const sessionId = id("ses");
    state.sessions[sessionId] = {
      id: sessionId,
      agentId,
      userId: userId || "slack",
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    thread = {
      sessionId,
      teamId,
      userId,
      channel,
      threadTs,
      agentId,
      context,
      createdAt: now(),
      updatedAt: now()
    };
    state.slack.threads[key] = thread;
  } else {
    thread.userId ||= userId;
    if (agentId && agentId !== thread.agentId) {
      thread.agentId = agentId;
      state.sessions[thread.sessionId].agentId = agentId;
    }
    if (context) thread.context = context;
    thread.updatedAt = now();
  }
  return { thread, session: state.sessions[thread.sessionId] };
}

function pruneSlackEvents(events) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [eventId, seenAt] of Object.entries(events)) {
    if (new Date(seenAt).getTime() < cutoff) delete events[eventId];
  }
}

async function claimSlackEvent(eventId) {
  if (!eventId) return true;
  return withState((state) => {
    if (state.slack.events[eventId]) return false;
    state.slack.events[eventId] = now();
    pruneSlackEvents(state.slack.events);
    return true;
  });
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

function slackFeedbackBlocks(runId) {
  return [
    {
      type: "context_actions",
      elements: [
        {
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
        }
      ]
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Generated by Hermes. Review before acting."
        }
      ]
    }
  ];
}

async function setSlackStatus({ channel, threadTs, status = SLACK_STATUS_TEXT, teamId = null }) {
  return slackApi("assistant.threads.setStatus", {
    channel_id: channel,
    thread_ts: threadTs,
    status,
    loading_messages: slackLoadingMessages
  }, { teamId });
}

async function clearSlackStatus({ channel, threadTs, teamId = null }) {
  return slackApi("assistant.threads.setStatus", {
    channel_id: channel,
    thread_ts: threadTs,
    status: ""
  }, { teamId });
}

async function startSlackStream({ channel, threadTs, teamId, userId, agent }) {
  return slackApi("chat.startStream", {
    channel,
    thread_ts: threadTs,
    recipient_team_id: teamId,
    recipient_user_id: userId,
    task_display_mode: "plan",
    chunks: [
      {
        type: "task_update",
        id: "hermes_turn",
        title: `Run ${agentLabel(agent)}`,
        status: "in_progress",
        details: "Working through the request"
      }
    ]
  }, { teamId });
}

async function appendSlackStream({ channel, ts, markdownText, chunks = null, teamId = null }) {
  const body = { channel, ts };
  if (markdownText) body.markdown_text = markdownText;
  if (chunks) body.chunks = chunks;
  return slackApi("chat.appendStream", body, { teamId });
}

async function stopSlackStream({ channel, ts, markdownText = "", blocks = [], teamId = null }) {
  return slackApi("chat.stopStream", {
    channel,
    ts,
    markdown_text: markdownText,
    blocks
  }, { teamId });
}

async function postSlackMessage({ channel, threadTs, text, blocks = null, teamId = null }) {
  const body = {
    channel,
    thread_ts: threadTs,
    text
  };
  if (blocks) body.blocks = blocks;
  return slackApi("chat.postMessage", body, { teamId });
}

async function createSlackUsergroupForAgent(agent, { teamId = null } = {}) {
  if (!SLACK_CREATE_USERGROUPS) return null;
  if (!SLACK_DRY_RUN && !(await slackToken({ teamId }))) {
    throw new Error("Slack bot token is required to create Slack agent handles");
  }
  const body = {
    name: agent.name || `${agent.handle} agent`,
    handle: agent.handle,
    description: `Hermes agent handle for ${agent.name || agent.handle}`
  };
  if (teamId) body.team_id = teamId;
  const response = await slackApi("usergroups.create", body, { teamId });
  if (!response.usergroup?.id) {
    throw new Error("Slack did not return a user group for the new agent handle");
  }
  return response.usergroup;
}

async function setSlackUsergroupUsers({ usergroupId, userIds, teamId = null }) {
  const users = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!usergroupId || !users.length) return null;
  const body = {
    usergroup: usergroupId,
    users: users.join(",")
  };
  if (teamId) body.team_id = teamId;
  return slackApi("usergroups.users.update", body, { teamId });
}

async function provisionSlackAgentHandle(state, agent, { teamId = null, memberUserIds = [] } = {}) {
  const usergroup = await createSlackUsergroupForAgent(agent, { teamId });
  await syncSlackDryRunCalls(state);
  const desiredMemberIds = normalizeSlackUserIds([...(agent.slackUserIds || []), ...memberUserIds]);
  let savedAgent = attachSlackUsergroup(state, { ...agent, slackUserIds: desiredMemberIds }, usergroup, { teamId });
  try {
    await setSlackUsergroupUsers({
      usergroupId: usergroup.id,
      userIds: desiredMemberIds,
      teamId: usergroup.team_id || teamId
    });
    await syncSlackDryRunCalls(state);
    savedAgent = {
      ...savedAgent,
      slackUserIds: desiredMemberIds,
      slackUsergroupMemberSyncError: null,
      updatedAt: now()
    };
    state.agents[savedAgent.id] = savedAgent;
  } catch (error) {
    savedAgent.slackUsergroupMemberSyncError = error instanceof Error ? error.message : String(error);
    state.agents[savedAgent.id] = savedAgent;
  }
  return savedAgent;
}

async function reconcileSlackAgentMembers(state, agent, { teamId = null } = {}) {
  const desiredMemberIds = normalizeSlackUserIds(agent.slackUserIds || []);
  if (!agent.slackUsergroupId || !desiredMemberIds.length) return agent;
  let updated = { ...agent };
  try {
    await setSlackUsergroupUsers({
      usergroupId: agent.slackUsergroupId,
      userIds: desiredMemberIds,
      teamId: teamId || agent.slackTeamId || null
    });
    await syncSlackDryRunCalls(state);
    updated = {
      ...updated,
      slackUsergroupMemberSyncError: null,
      updatedAt: now()
    };
  } catch (error) {
    updated = {
      ...updated,
      slackUsergroupMemberSyncError: error instanceof Error ? error.message : String(error),
      updatedAt: now()
    };
  }
  state.agents[updated.id] = updated;
  return updated;
}

function attachSlackUsergroup(state, agent, usergroup, { teamId = null } = {}) {
  if (!usergroup) return agent;
  const updated = {
    ...agent,
    slackUsergroupId: usergroup.id,
    slackTeamId: usergroup.team_id || teamId || agent.slackTeamId || null,
    slackHandle: usergroup.handle || agent.handle,
    updatedAt: now()
  };
  state.agents[agent.id] = updated;
  state.slack.usergroups[usergroup.id] = agent.id;
  return updated;
}

function slackPrompt({ text, context, agent }) {
  const contextLines = [];
  if (agent?.handle) contextLines.push(`Selected Hermes agent: ${agentLabel(agent)} (${agent.name || agent.id})`);
  if (context?.channel_id) contextLines.push(`Active Slack channel: ${context.channel_id}`);
  if (context?.team_id) contextLines.push(`Slack team: ${context.team_id}`);
  const contextText = contextLines.length ? `Slack context:\n${contextLines.join("\n")}\n\n` : "";
  return `${contextText}${text}`;
}

async function handleAssistantThreadStarted(payload) {
  const thread = payload.event?.assistant_thread;
  if (!thread?.channel_id || !thread?.thread_ts) return;
  const teamId = payload.team_id || thread.context?.team_id || null;
  await withState((state) => {
    ensureSlackThreadSession(state, {
      teamId,
      userId: thread.user_id,
      channel: thread.channel_id,
      threadTs: thread.thread_ts,
      context: thread.context || null
    });
  });
  await slackApi("assistant.threads.setSuggestedPrompts", {
    channel_id: thread.channel_id,
    thread_ts: thread.thread_ts,
    prompts: [
      {
        title: "Summarize this thread",
        message: "Summarize the current Slack context and suggest next steps."
      },
      {
        title: "Plan an implementation",
        message: "Turn this request into a concise implementation plan."
      },
      {
        title: "Review recent context",
        message: "Review the visible context and call out risks or missing information."
      }
    ]
  }, { teamId });
}

async function handleAssistantThreadContextChanged(payload) {
  const thread = payload.event?.assistant_thread;
  if (!thread?.channel_id || !thread?.thread_ts) return;
  await withState((state) => {
    ensureSlackThreadSession(state, {
      teamId: payload.team_id || thread.context?.team_id,
      userId: thread.user_id,
      channel: thread.channel_id,
      threadTs: thread.thread_ts,
      context: thread.context || null
    });
  });
}

async function handleSlackUserMessage(payload) {
  const event = payload.event || {};
  if (event.bot_id || event.subtype || !event.channel || !event.user) return;
  const teamId = payload.team_id || event.team;
  const state = await loadState();
  const installation = teamId ? state.slack.installations?.[teamId] : null;
  if (installation?.botUserId && event.user === installation.botUserId) return;
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;
  const route = parseMessageRoute(state, event.text);
  const text = route.text;
  const existingThread = state.slack.threads[slackThreadKey({ teamId, channel, threadTs })];
  const channelType = event.channel_type || "";
  const isDirectMessage = channelType === "im" || channel.startsWith("D");
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  const isBotMention = event.type === "app_mention";
  const shouldRespond = Boolean(route.handle || isBotMention || isDirectMessage || (existingThread && isThreadReply));

  if (!shouldRespond || route.unknownUsergroupMentioned) return;
  if (!text) {
    await postSlackMessage({
      channel,
      threadTs,
      teamId,
      text: `What should ${agentLabel(state.agents[defaultAgentId])} work on? Send a request in this thread or message the app directly.`
    });
    return;
  }

  const userDefaultAgentId = state.slack.userAgents[event.user] || null;
  let agent = null;
  if (route.agent) {
    agent = route.agent;
  } else if (route.handle) {
    agent = agentByHandle(state, route.handle);
    if (!agent) {
      await postSlackMessage({
        channel,
        threadTs,
        teamId,
        text: `This Slack app is configured for ${agentLabel(state.agents[defaultAgentId])}. Use the Slack app for ${agentLabel({ handle: route.handle })} if you want that agent.`
      });
      return;
    }
  } else if (existingThread?.agentId && state.agents[existingThread.agentId]) {
    agent = state.agents[existingThread.agentId];
  } else if (userDefaultAgentId && state.agents[userDefaultAgentId]) {
    agent = state.agents[userDefaultAgentId];
  } else {
    agent = state.agents[defaultAgentId];
  }

  if (!agentCanRespondInSlackChannel(agent, channel, { isDirectMessage })) {
    await postSlackMessage({
      channel,
      threadTs,
      teamId,
      text: `${agentLabel(agent)} is not deployed to this channel. Run \`/hermes-agent deploy ${agent.handle}\` from this channel first.`
    });
    return;
  }

  const thread = await withState((mutableState) => {
    const { thread: t } = ensureSlackThreadSession(mutableState, {
      teamId,
      userId: event.user,
      channel,
      threadTs,
      agentId: agent.id
    });
    return { ...t };
  });

  let stream = null;
  try {
    await slackApi("assistant.threads.setTitle", {
      channel_id: channel,
      thread_ts: threadTs,
      title: `${agentLabel(agent)} ${slackTitle(text)}`.slice(0, 80)
    }, { teamId }).catch(() => {});
    await setSlackStatus({ channel, threadTs, teamId });
    stream = await startSlackStream({ channel, threadTs, teamId, userId: event.user, agent });

    const { run } = await createRun({
      sessionId: thread.sessionId,
      agentId: agent.id,
      userId: event.user,
      content: slackPrompt({ text, context: thread.context || null, agent }),
      openai: {
        kind: "slack",
        model: HERMES_MODEL,
        metadata: {
          hermes_agent_id: agent.id,
          hermes_agent_handle: agent.handle,
          slack_team_id: teamId || null,
          slack_channel_id: channel,
          slack_thread_ts: threadTs,
          slack_user_id: event.user
        }
      }
    });

    await appendSlackStream({
      channel,
      ts: stream.ts,
      teamId,
      chunks: [
        {
          type: "task_update",
          id: "hermes_turn",
          title: `Run ${agentLabel(agent)}`,
          status: "in_progress",
          details: `Started run ${run.id}`
        }
      ]
    });

    const streamed = await streamRunToSlack({ runId: run.id, channel, ts: stream.ts, teamId });
    if (!streamed.run || streamed.run.status !== "completed") {
      const errorMessage = streamed.run?.error || "Hermes did not finish before the Slack response timeout.";
      await appendSlackStream({
        channel,
        ts: stream.ts,
        teamId,
        chunks: [
          {
            type: "task_update",
            id: "hermes_turn",
            title: `Run ${agentLabel(agent)}`,
            status: "error",
            details: errorMessage.slice(0, 256)
          }
        ]
      });
      await stopSlackStream({
        channel,
        ts: stream.ts,
        teamId,
        markdownText: `I couldn't finish that request: ${errorMessage}`,
        blocks: slackFeedbackBlocks(run.id)
      });
      await clearSlackStatus({ channel, threadTs, teamId }).catch(() => {});
      return;
    }

    const output = String(streamed.run.result || "").trim() || "Hermes finished, but returned no text.";
    await appendSlackStream({
      channel,
      ts: stream.ts,
      teamId,
      chunks: [
        {
          type: "task_update",
          id: "hermes_turn",
          title: `Run ${agentLabel(agent)}`,
          status: "complete",
          details: "Response ready"
        }
      ]
    });
    const alreadyStreamed = streamed.streamedText.trim();
    const finalRemainder = alreadyStreamed && output.startsWith(alreadyStreamed)
      ? output.slice(alreadyStreamed.length).trimStart()
      : alreadyStreamed ? "" : output;
    for (const chunk of chunkText(finalRemainder)) {
      await appendSlackStream({ channel, ts: stream.ts, markdownText: chunk, teamId });
      if (SLACK_STREAM_CHUNK_DELAY_MS > 0) await sleep(SLACK_STREAM_CHUNK_DELAY_MS);
    }
    await stopSlackStream({
      channel,
      ts: stream.ts,
      teamId,
      blocks: slackFeedbackBlocks(streamed.run.id)
    });
    await clearSlackStatus({ channel, threadTs, teamId }).catch(() => {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (stream?.ts) {
      await stopSlackStream({
        channel,
        ts: stream.ts,
        teamId,
        markdownText: `I couldn't finish that request: ${message}`
      }).catch(() => {});
    } else {
      await postSlackMessage({
        channel,
        threadTs,
        teamId,
        text: `I couldn't finish that request: ${message}`
      }).catch(() => {});
    }
    await clearSlackStatus({ channel, threadTs, teamId }).catch(() => {});
  }
}

async function processSlackEvent(payload) {
  const claimed = await claimSlackEvent(payload.event_id);
  if (!claimed) return;

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
  await withState((state) => {
    state.slack.feedback[id("fb")] = {
      runId,
      value: action.value || null,
      userId: payload.user?.id || null,
      channelId: payload.channel?.id || null,
      messageTs: payload.message?.ts || null,
      createdAt: now()
    };
  });
}

async function postSlackResponseUrl(responseUrl, message) {
  if (!responseUrl) return;
  try {
    await fetch(responseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message)
    });
  } catch (error) {
    console.error(`response_url POST failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runSlackCommand(form) {
  const text = String(form.get("text") || "").trim();
  const userId = form.get("user_id") || "slack";
  const teamId = form.get("team_id") || null;
  const channelId = form.get("channel_id") || null;
  const [rawAction = "help", rawHandle = "", ...rest] = text.split(/\s+/);
  const action = rawAction.toLowerCase();

  if (action === "list") {
    const state = await loadState();
    return {
      response_type: "ephemeral",
      text: `Known Hermes agents:\n${formatAgentList(state)}`
    };
  }

  if (action === "create") {
    if (!SLACK_CREATE_USERGROUPS) {
      return {
        response_type: "ephemeral",
        text: `This deployment is one Slack app per Hermes agent. Create another agent by deploying a new hermes.yaml and Slack app instead.`
      };
    }
    let handle;
    try {
      handle = handleFromString(rawHandle);
    } catch (error) {
      return { response_type: "ephemeral", text: error instanceof Error ? error.message : String(error) };
    }
    const conflict = await loadState().then((s) => agentByHandle(s, handle));
    if (conflict) {
      return {
        response_type: "ephemeral",
        text: `${agentLabel({ handle })} already exists. Use \`/hermes-agent use ${handle}\` or choose another handle.`
      };
    }
    const baseAgent = createAgentRecord({
      handle,
      name: rest.join(" ").trim() || `${handle} agent`,
      createdBy: userId
    });
    let savedAgent = channelId ? deployAgentToSlackChannels(baseAgent, [channelId]) : baseAgent;
    let provisionError = null;
    if (SLACK_CREATE_USERGROUPS) {
      try {
        const provisionState = await loadState();
        provisionState.agents[savedAgent.id] = savedAgent;
        savedAgent = await provisionSlackAgentHandle(provisionState, savedAgent, { teamId, memberUserIds: [userId] });
        await withState((state) => {
          state.agents[savedAgent.id] = savedAgent;
          state.slack.userAgents[userId] = savedAgent.id;
        });
      } catch (error) {
        provisionError = error instanceof Error ? error.message : String(error);
      }
    } else {
      await withState((state) => {
        state.agents[savedAgent.id] = savedAgent;
        state.slack.userAgents[userId] = savedAgent.id;
      });
    }
    if (provisionError) {
      return {
        response_type: "ephemeral",
        text: `I couldn't create the Slack handle ${agentLabel(savedAgent)}: ${provisionError}`
      };
    }
    const memberWarning = savedAgent.slackUsergroupMemberSyncError
      ? `\nSlack handle was created, but member sync needs attention: ${savedAgent.slackUsergroupMemberSyncError}`
      : "";
    return {
      response_type: "ephemeral",
      text: `Created ${agentLabel(savedAgent)} and set it as your default agent. Mention ${agentLabel(savedAgent)} in Slack to talk to it.${memberWarning}`
    };
  }

  if (action === "use") {
    const result = await withState((state) => {
      let agent = null;
      try {
        agent = agentByHandle(state, rawHandle);
      } catch {
        agent = null;
      }
      if (!agent) {
        return {
          response_type: "ephemeral",
          text: `I don't know ${rawHandle || "that handle"}.\n\nKnown agents:\n${formatAgentList(state)}`
        };
      }
      state.slack.userAgents[userId] = agent.id;
      return {
        response_type: "ephemeral",
        text: `Your default Hermes agent is now ${agentLabel(agent)}. Existing threads keep their current agent unless you prefix a new message with another handle.`
      };
    });
    return result;
  }

  if (action === "deploy") {
    return withState((state) => {
      let agent = null;
      if (!rawHandle) {
        agent = state.agents[defaultAgentId];
      } else {
        try {
          agent = agentByHandle(state, rawHandle);
        } catch {
          agent = null;
        }
      }
      if (!agent) {
        return {
          response_type: "ephemeral",
          text: `I don't know ${rawHandle || "that handle"}.\n\nKnown agents:\n${formatAgentList(state)}`
        };
      }
      const channels = normalizeSlackChannelIds(rest.length ? rest : [channelId]);
      if (!channels.length) {
        return {
          response_type: "ephemeral",
          text: `Tell me which channel to deploy ${agentLabel(agent)} to, or run this command from the target channel.`
        };
      }
      const updated = deployAgentToSlackChannels(agent, channels);
      state.agents[agent.id] = updated;
      return {
        response_type: "ephemeral",
        text: `${agentLabel(updated)} is deployed to ${updated.slackChannelIds.join(", ")}.`
      };
    });
  }

  const state = await loadState();
  return {
    response_type: "ephemeral",
    text: [
      `This Slack app is configured for ${agentLabel(state.agents[defaultAgentId])}.`,
      `Mention ${agentLabel(state.agents[defaultAgentId])} in a channel where the app is installed, or message the app directly.`,
      "`/hermes-agent list`",
      "`/hermes-agent deploy` records the current channel only if channel deployment gating is enabled."
    ].join("\n")
  };
}

async function handleSlackCommand(body) {
  const form = new URLSearchParams(body);
  const responseUrl = form.get("response_url") || "";
  runSlackCommand(form)
    .then((message) => postSlackResponseUrl(responseUrl, message))
    .catch((error) => {
      console.error(`slack command handler failed: ${error instanceof Error ? error.message : String(error)}`);
      return postSlackResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: `I hit an error running that command: ${error instanceof Error ? error.message : String(error)}`
      });
    });
}

function createdUnix(run) {
  const value = new Date(run?.createdAt || now()).getTime();
  return Number.isNaN(value) ? Math.floor(Date.now() / 1000) : Math.floor(value / 1000);
}

function openAIId(prefix, runId) {
  return `${prefix}_${String(runId).replace(/^run_/, "")}`;
}

function runIdFromOpenAIId(value) {
  const id = String(value || "");
  if (id.startsWith("resp_")) return `run_${id.slice(5)}`;
  if (id.startsWith("chatcmpl_")) return `run_${id.slice(9)}`;
  return id;
}

function requireTfySecretRefs(refs) {
  for (const ref of refs || []) {
    if (typeof ref !== "string" || !ref.startsWith("tfy-secret://")) {
      throw new Error(`secret reference must use tfy-secret://: ${ref}`);
    }
  }
}

async function tfyGet(apiPath) {
  if (!TFY_BASE_URL || !TFY_PLATFORM_API_KEY) {
    throw new Error("TFY_BASE_URL and TFY_PLATFORM_API_KEY are required for TrueFoundry control-plane calls");
  }
  const res = await fetch(`${TFY_BASE_URL}${apiPath}`, {
    headers: { authorization: `Bearer ${TFY_PLATFORM_API_KEY}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TrueFoundry ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function bearerToken(req) {
  const header = String(req.headers["authorization"] || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function requireInternalAuth(req, res) {
  if (!HARNESS_INTERNAL_TOKEN) {
    send(res, 503, { error: "HARNESS_INTERNAL_TOKEN is not configured on the control API" });
    return false;
  }
  const provided = bearerToken(req);
  if (!provided) {
    send(res, 401, { error: "missing bearer token" });
    return false;
  }
  const expected = Buffer.from(HARNESS_INTERNAL_TOKEN);
  const got = Buffer.from(provided);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    send(res, 401, { error: "invalid bearer token" });
    return false;
  }
  return true;
}

function requireOpenAIAuth(req, res) {
  if (!OPENAI_API_KEY) return true;
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function listGatewayServers() {
  const body = await tfyGet("/api/svc/v1/mcp-servers");
  const rows = Array.isArray(body.data) ? body.data : [];
  return rows.map((row) => {
    const manifest = row.manifest || {};
    const auth = typeof row.authStatus === "string"
      ? row.authStatus
      : row.authStatus?.status || row.auth_status?.status || "unknown";
    const tools = Array.isArray(row.tools)
      ? row.tools
      : Array.isArray(manifest.tool_settings)
        ? manifest.tool_settings.filter((tool) => !tool.disabled).map((tool) => ({ name: tool.name, serverName: row.name }))
        : [];
    return {
      id: row.id,
      name: row.name || manifest.name,
      type: manifest.type || row.type,
      authStatus: auth,
      tools
    };
  }).filter((server) => server.name);
}

async function listSkillsRegistry() {
  if (!SKILLS_REGISTRY_URL) return [];
  const res = await fetch(SKILLS_REGISTRY_URL, {
    headers: TFY_PLATFORM_API_KEY ? { authorization: `Bearer ${TFY_PLATFORM_API_KEY}` } : {}
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`skills registry failed ${res.status}: ${text.slice(0, 500)}`);
  const body = text ? JSON.parse(text) : {};
  return Array.isArray(body.skills) ? body.skills : Array.isArray(body.data) ? body.data : [];
}

async function validateAgentPatch(patch) {
  if (patch.secretRefs) requireTfySecretRefs(patch.secretRefs);

  if (patch.skills) {
    const registry = await listSkillsRegistry();
    const allowed = new Set(registry.map((skill) => String(skill.slug || skill.name || skill.id)));
    const unknown = patch.skills.filter((skill) => !allowed.has(String(skill)));
    if (unknown.length) throw new Error(`skills not found in registry: ${unknown.join(", ")}`);
  }

  if (patch.mcpServers) {
    const visibleServers = await listGatewayServers();
    const visibleNames = new Set(visibleServers.map((server) => server.name));
    const unknown = patch.mcpServers.filter((server) => !visibleNames.has(String(server)));
    if (unknown.length) throw new Error(`MCP servers not visible through TrueFoundry MCP Gateway: ${unknown.join(", ")}`);
  }
}

async function triggerJob(runId) {
  if (!TFY_BASE_URL || !TFY_PLATFORM_API_KEY || !TFY_WORKSPACE_FQN) return null;
  if (!PUBLIC_BASE_URL) {
    throw new Error("PUBLIC_BASE_URL (or HARNESS_API_URL) must be set so the turn-runner can call back");
  }
  if (!HARNESS_INTERNAL_TOKEN) {
    throw new Error("HARNESS_INTERNAL_TOKEN must be set so the turn-runner can authenticate to the control API");
  }
  const apps = await tfyGet(`/api/svc/v1/apps?workspace_fqn=${encodeURIComponent(TFY_WORKSPACE_FQN)}&limit=200`);
  const job = (Array.isArray(apps.data) ? apps.data : []).find((app) => app.name === HERMES_JOB_APPLICATION_NAME);
  const deploymentId = job?.deployment?.id || job?.activeDeploymentId;
  if (!deploymentId) throw new Error(`active deployment not found for job ${HERMES_JOB_APPLICATION_NAME}`);
  const payload = {
    deploymentId,
    input: {
      command: `sh -lc ${shellQuote(`HARNESS_RUN_ID=${shellQuote(runId)} HARNESS_CONTROL_API_URL=${shellQuote(PUBLIC_BASE_URL)} node runner/turn-runner.mjs`)}`
    },
    metadata: {
      job_run_name_alias: runId
    }
  };
  const res = await fetch(`${TFY_BASE_URL}/api/svc/v1/jobs/trigger`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TFY_PLATFORM_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`job trigger failed ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function createRun({ agentId = defaultAgentId, userId = "openai-sdk", sessionId = null, content, openai = null }) {
  const runId = id("run");
  const openAI = openai ? { ...openai } : null;
  if (openAI?.kind === "response" && !openAI.responseId) {
    openAI.responseId = openAIId("resp", runId);
  }
  if (openAI?.kind === "chat.completion" && !openAI.chatCompletionId) {
    openAI.chatCompletionId = openAIId("chatcmpl", runId);
  }

  const queued = await withState((state) => {
    let session = sessionId ? state.sessions[sessionId] : null;
    if (!session) {
      const newSessionId = id("ses");
      session = {
        id: newSessionId,
        agentId,
        userId,
        messages: [],
        createdAt: now(),
        updatedAt: now()
      };
      state.sessions[newSessionId] = session;
    } else if (agentId && session.agentId !== agentId) {
      session.agentId = agentId;
      session.updatedAt = now();
    }
    const inputMessage = { id: id("msg"), role: "user", content, createdAt: now() };
    session.messages.push(inputMessage);
    session.updatedAt = now();
    state.runs[runId] = {
      id: runId,
      sessionId: session.id,
      agentId: session.agentId,
      status: "queued",
      content,
      inputMessageId: inputMessage.id,
      events: [],
      openai: openAI,
      createdAt: now(),
      updatedAt: now()
    };
    return { run: { ...state.runs[runId] }, session: { ...session } };
  });

  if (LOCAL_RUN_RESULT) {
    return withState((state) => {
      const run = state.runs[runId];
      if (!run) return queued;
      run.status = "completed";
      run.result = LOCAL_RUN_RESULT;
      run.trigger = { mode: "local" };
      run.updatedAt = now();
      const session = state.sessions[run.sessionId];
      if (session) {
        session.messages.push({ role: "assistant", content: LOCAL_RUN_RESULT, createdAt: now() });
        session.updatedAt = now();
      }
      return { run: { ...run }, session: session ? { ...session } : queued.session };
    });
  }

  let trigger = null;
  let triggerError = null;
  try {
    trigger = await triggerJob(runId);
  } catch (error) {
    triggerError = error instanceof Error ? error.message : String(error);
  }

  return withState((state) => {
    const run = state.runs[runId];
    if (!run) return queued;
    if (triggerError) {
      run.status = "failed";
      run.error = triggerError;
    } else {
      run.status = trigger ? "running" : "queued";
    }
    run.trigger = trigger;
    run.updatedAt = now();
    return { run: { ...run }, session: state.sessions[run.sessionId] ? { ...state.sessions[run.sessionId] } : queued.session };
  });
}

async function waitForRun(runId, { timeoutMs = OPENAI_SYNC_TIMEOUT_MS, isAborted = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = await loadState();
  let run = state.runs[runId];
  while (run && !isRunTerminal(run.status) && Date.now() < deadline && !isAborted()) {
    await sleep(OPENAI_POLL_INTERVAL_MS);
    state = await loadState();
    run = state.runs[runId];
  }
  return { state, run, aborted: isAborted() };
}

function isRunTerminal(status) {
  return ["completed", "failed", "cancelled"].includes(status);
}

async function streamRunToSlack({ runId, channel, ts, teamId = null, timeoutMs = SLACK_RUN_TIMEOUT_MS, isAborted = () => false }) {
  const deadline = Date.now() + timeoutMs;
  let eventOffset = 0;
  let streamedText = "";
  let state = await loadState();
  let run = state.runs[runId];

  while (run && !isRunTerminal(run.status) && Date.now() < deadline && !isAborted()) {
    const events = Array.isArray(run.events) ? run.events : [];
    const newEvents = events.slice(eventOffset);
    eventOffset = events.length;
    const output = newEvents
      .filter((event) => event.type === "stdout_delta" && event.text)
      .map((event) => event.text)
      .join("");
    if (output) {
      streamedText += output;
      for (const chunk of chunkText(output)) {
        try {
          await appendSlackStream({ channel, ts, markdownText: chunk, teamId });
        } catch (error) {
          console.error(`appendSlackStream failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    await sleep(OPENAI_POLL_INTERVAL_MS);
    state = await loadState();
    run = state.runs[runId];
  }

  if (run && !isAborted()) {
    const events = Array.isArray(run.events) ? run.events : [];
    const newEvents = events.slice(eventOffset);
    const output = newEvents
      .filter((event) => event.type === "stdout_delta" && event.text)
      .map((event) => event.text)
      .join("");
    if (output) {
      streamedText += output;
      for (const chunk of chunkText(output)) {
        try {
          await appendSlackStream({ channel, ts, markdownText: chunk, teamId });
        } catch (error) {
          console.error(`appendSlackStream failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  return { run, streamedText, aborted: isAborted() };
}

async function streamRunText({ runId, timeoutMs = OPENAI_SYNC_TIMEOUT_MS, onDelta, isAborted = () => false }) {
  const deadline = Date.now() + timeoutMs;
  let eventOffset = 0;
  let streamedText = "";
  let state = await loadState();
  let run = state.runs[runId];

  while (run && !isRunTerminal(run.status) && Date.now() < deadline && !isAborted()) {
    const events = Array.isArray(run.events) ? run.events : [];
    const newEvents = events.slice(eventOffset);
    eventOffset = events.length;
    const output = newEvents
      .filter((event) => event.type === "stdout_delta" && event.text)
      .map((event) => event.text)
      .join("");
    if (output) {
      streamedText += output;
      await onDelta(output);
    }
    await sleep(OPENAI_POLL_INTERVAL_MS);
    state = await loadState();
    run = state.runs[runId];
  }

  if (run && !isAborted()) {
    const events = Array.isArray(run.events) ? run.events : [];
    const newEvents = events.slice(eventOffset);
    const output = newEvents
      .filter((event) => event.type === "stdout_delta" && event.text)
      .map((event) => event.text)
      .join("");
    if (output) {
      streamedText += output;
      await onDelta(output);
    }
  }

  if (run?.status === "completed" && !isAborted()) {
    const finalText = String(run.result || "");
    const finalRemainder = streamedText && finalText.startsWith(streamedText)
      ? finalText.slice(streamedText.length)
      : streamedText ? "" : finalText;
    if (finalRemainder) {
      streamedText += finalRemainder;
      await onDelta(finalRemainder);
    }
  }

  return { run, streamedText, aborted: isAborted() };
}

function sessionMemory(session, excludeMessageId = null) {
  return (session.messages || [])
    .filter((message) => !excludeMessageId || message.id !== excludeMessageId)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

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

function responseStatus(run) {
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "failed";
  return "in_progress";
}

function responseObject(run) {
  const responseId = run.openai?.responseId || openAIId("resp", run.id);
  const model = run.openai?.model || HERMES_MODEL;
  const completed = run.status === "completed";
  const failed = run.status === "failed";
  const outputText = completed ? String(run.result || "") : "";
  return {
    id: responseId,
    object: "response",
    created_at: createdUnix(run),
    status: responseStatus(run),
    error: failed ? { message: run.error || "Hermes run failed", type: "server_error" } : null,
    incomplete_details: null,
    instructions: run.openai?.instructions || null,
    model,
    output: completed ? [{
      id: openAIId("msg", run.id),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: outputText,
        annotations: []
      }]
    }] : [],
    output_text: outputText,
    usage: null,
    metadata: run.openai?.metadata || null
  };
}

function chatCompletionObject(run) {
  const completionId = run.openai?.chatCompletionId || openAIId("chatcmpl", run.id);
  const model = run.openai?.model || HERMES_MODEL;
  return {
    id: completionId,
    object: "chat.completion",
    created: createdUnix(run),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: run.status === "completed" ? String(run.result || "") : ""
      },
      logprobs: null,
      finish_reason: run.status === "completed" ? "stop" : null
    }],
    usage: null
  };
}

function chatCompletionChunk(run, { delta = {}, finishReason = null, usage = null } = {}) {
  const completionId = run.openai?.chatCompletionId || openAIId("chatcmpl", run.id);
  const model = run.openai?.model || HERMES_MODEL;
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: createdUnix(run),
    model,
    choices: usage ? [] : [{
      index: 0,
      delta,
      logprobs: null,
      finish_reason: finishReason
    }],
    usage
  };
}

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

async function streamResponseObject(req, res, run) {
  const ctx = startSse(req, res);
  let sequenceNumber = 0;
  const responseId = run.openai?.responseId || openAIId("resp", run.id);
  const itemId = openAIId("msg", run.id);
  const created = {
    ...responseObject(run),
    status: "in_progress",
    output: [],
    output_text: ""
  };
  writeSse(res, {
    type: "response.created",
    sequence_number: sequenceNumber++,
    response: created
  }, "response.created");
  writeSse(res, {
    type: "response.in_progress",
    sequence_number: sequenceNumber++,
    response: created
  }, "response.in_progress");
  writeSse(res, {
    type: "response.output_item.added",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    output_index: 0,
    item: {
      id: itemId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    }
  }, "response.output_item.added");
  writeSse(res, {
    type: "response.content_part.added",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: "",
      annotations: []
    }
  }, "response.content_part.added");

  const streamed = await streamRunText({
    runId: run.id,
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

  if (streamed.aborted) {
    endSse(res, ctx);
    return;
  }

  if (!streamed.run || streamed.run.status !== "completed") {
    writeSse(res, {
      type: "error",
      sequence_number: sequenceNumber++,
      error: {
        type: "server_error",
        message: streamed.run?.error || "Hermes run did not complete before the streaming timeout"
      }
    }, "error");
    endSse(res, ctx);
    return;
  }

  writeSse(res, {
    type: "response.output_text.done",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text: String(streamed.run.result || "")
  }, "response.output_text.done");
  writeSse(res, {
    type: "response.content_part.done",
    sequence_number: sequenceNumber++,
    response_id: responseId,
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: {
      type: "output_text",
      text: String(streamed.run.result || ""),
      annotations: []
    }
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
      content: [{
        type: "output_text",
        text: String(streamed.run.result || ""),
        annotations: []
      }]
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
    isAborted: () => ctx.aborted,
    onDelta: async (delta) => {
      writeSse(res, chatCompletionChunk(run, { delta: { content: delta } }));
    }
  });

  if (streamed.aborted) {
    endSse(res, ctx);
    return;
  }

  if (!streamed.run || streamed.run.status !== "completed") {
    writeSse(res, {
      error: {
        message: streamed.run?.error || "Hermes run did not complete before the streaming timeout",
        type: "server_error"
      }
    });
    writeSse(res, "[DONE]");
    endSse(res, ctx);
    return;
  }

  writeSse(res, chatCompletionChunk(streamed.run, { delta: {}, finishReason: "stop" }));
  if (includeUsage) writeSse(res, chatCompletionChunk(streamed.run, { usage: null }));
  writeSse(res, "[DONE]");
  endSse(res, ctx);
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

async function readJsonOrError(req, res) {
  try {
    return [true, await json(req)];
  } catch (error) {
    sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error));
    return [false, null];
  }
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, stateRoot: STATE_ROOT });
    }

    if (req.method === "GET" && url.pathname === "/slack/health") {
      const state = await loadState();
      return send(res, 200, {
        ok: true,
        slack: {
          botTokenConfigured: Boolean(SLACK_BOT_TOKEN),
          signingSecretConfigured: Boolean(SLACK_SIGNING_SECRET),
          oauthConfigured: SLACK_OAUTH_ENABLED,
          installations: Object.keys(state.slack.installations || {}).length,
          dryRun: SLACK_DRY_RUN,
          createUsergroups: SLACK_CREATE_USERGROUPS,
          requireChannelDeployment: SLACK_REQUIRE_CHANNEL_DEPLOYMENT
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/slack/oauth/install") {
      if (!SLACK_OAUTH_ENABLED) return send(res, 404, { error: "Slack OAuth is not enabled" });
      const nonce = randomUUID();
      const stateToken = slackOAuthStateToken(nonce);
      const params = new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        scope: "app_mentions:read,assistant:write,channels:history,channels:join,channels:read,chat:write,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,team:read,users:read",
        state: stateToken
      });
      if (SLACK_REDIRECT_URI) params.set("redirect_uri", SLACK_REDIRECT_URI);
      const target = `https://slack.com/oauth/v2/authorize?${params.toString()}`;
      res.writeHead(302, { location: target });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/slack/oauth/callback") {
      if (!SLACK_OAUTH_ENABLED) return send(res, 404, { error: "Slack OAuth is not enabled" });
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      const stateParam = url.searchParams.get("state");
      if (error) return send(res, 400, { error });
      if (!code) return send(res, 400, { error: "missing Slack OAuth code" });
      if (!verifySlackOAuthState(stateParam)) return send(res, 400, { error: "invalid or expired OAuth state" });
      const payload = await exchangeSlackOAuthCode(code);
      const installation = await withState((state) => storeSlackInstallation(state, payload));
      return send(res, 200, {
        ok: true,
        teamId: installation.teamId,
        teamName: installation.teamName,
        botUserId: installation.botUserId
      });
    }

    if (req.method === "POST" && url.pathname === "/slack/events") {
      const body = await rawBody(req);
      if (!verifySlackRequest(req, body)) return send(res, 401, { error: "invalid Slack signature" });
      let payload;
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return send(res, 400, { error: "invalid JSON body" });
      }
      if (payload.type === "url_verification") return send(res, 200, { challenge: payload.challenge });
      if (!SLACK_DRY_RUN && !(await slackToken({ teamId: payload.team_id || payload.team?.id || null }))) {
        return send(res, 503, { error: "Slack bot token is not configured for this team" });
      }
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

    if (req.method === "POST" && url.pathname === "/slack/commands") {
      const body = await rawBody(req);
      if (!verifySlackRequest(req, body)) return send(res, 401, { error: "invalid Slack signature" });
      handleSlackCommand(body).catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
      });
      return send(res, 200, { response_type: "ephemeral", text: "Working on it..." });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      if (!requireOpenAIAuth(req, res)) return;
      return send(res, 200, { object: "list", data: [{ id: HERMES_MODEL, object: "model" }] });
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (!requireOpenAIAuth(req, res)) return;
      const [ok, body] = await readJsonOrError(req, res);
      if (!ok) return;
      let content;
      try {
        content = responsePrompt(body);
      } catch (error) {
        return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error));
      }
      let previousSessionId = null;
      if (body.previous_response_id) {
        const snapshot = await loadState();
        previousSessionId = snapshot.runs[runIdFromOpenAIId(body.previous_response_id)]?.sessionId || null;
      }
      const { run } = await createRun({
        agentId: body.agent || defaultAgentId,
        userId: body.user || "openai-sdk",
        sessionId: previousSessionId,
        content,
        openai: {
          kind: "response",
          model: body.model || HERMES_MODEL,
          instructions: body.instructions || null,
          metadata: body.metadata || null
        }
      });
      if (body.stream) return streamResponseObject(req, res, run);
      if (body.background) return send(res, 200, responseObject(run));

      const aborted = { value: false };
      req.on("close", () => { aborted.value = true; });
      const waited = await waitForRun(run.id, { isAborted: () => aborted.value });
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
      const state = await loadState();
      const run = state.runs[runIdFromOpenAIId(responseMatch[1])];
      return run ? send(res, 200, responseObject(run)) : sendOpenAIError(res, 404, "response not found", "invalid_request_error");
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!requireOpenAIAuth(req, res)) return;
      const [ok, body] = await readJsonOrError(req, res);
      if (!ok) return;
      let content;
      try {
        content = promptFromMessages(body.messages);
      } catch (error) {
        return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error));
      }
      const { run } = await createRun({
        agentId: body.agent || defaultAgentId,
        userId: body.user || "openai-sdk",
        content,
        openai: {
          kind: "chat.completion",
          model: body.model || HERMES_MODEL,
          metadata: body.metadata || null
        }
      });
      if (body.stream) {
        return streamChatCompletion(req, res, run, {
          includeUsage: Boolean(body.stream_options?.include_usage)
        });
      }

      const aborted = { value: false };
      req.on("close", () => { aborted.value = true; });
      const waited = await waitForRun(run.id, { isAborted: () => aborted.value });
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
      const state = await loadState();
      const run = state.runs[runIdFromOpenAIId(chatCompletionMatch[1])];
      return run ? send(res, 200, chatCompletionObject(run)) : sendOpenAIError(res, 404, "chat completion not found", "invalid_request_error");
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      const state = await loadState();
      return send(res, 200, { agents: Object.values(state.agents) });
    }

    if (req.method === "POST" && url.pathname === "/api/agents") {
      const body = await json(req);
      try { rejectRawSecretsInPayload(body); } catch (error) {
        return send(res, error.statusCode || 400, { error: error.message });
      }
      let handle;
      try {
        handle = handleFromString(body.handle || body.name);
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      const snapshot = await loadState();
      if (agentByHandle(snapshot, handle)) return send(res, 409, { error: `agent handle already exists: ${handle}` });
      await validateAgentPatch(body);
      const baseAgent = {
        ...createAgentRecord({
          handle,
          name: body.name || `${handle} agent`,
          description: body.description || "",
          instructions: body.instructions || "",
          model: body.model || HERMES_MODEL,
          createdBy: body.createdBy || null
        }),
        skills: Array.isArray(body.skills) ? body.skills : [],
        mcpServers: Array.isArray(body.mcpServers) ? body.mcpServers : [],
        secretRefs: Array.isArray(body.secretRefs) ? body.secretRefs : [],
        slackChannelIds: normalizeSlackChannelIds(body.slackChannelIds || body.channelIds || []),
        slackUserIds: normalizeSlackUserIds(body.slackUserIds || body.userIds || [])
      };
      let savedAgent = await withState((state) => {
        state.agents[baseAgent.id] = baseAgent;
        return baseAgent;
      });
      if (body.createSlackHandle !== false && SLACK_CREATE_USERGROUPS) {
        try {
          const provisionState = await loadState();
          provisionState.agents[savedAgent.id] = savedAgent;
          savedAgent = await provisionSlackAgentHandle(provisionState, savedAgent, {
            teamId: body.slackTeamId || body.teamId || null,
            memberUserIds: savedAgent.slackUserIds
          });
          await withState((state) => { state.agents[savedAgent.id] = savedAgent; });
        } catch (error) {
          return send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      return send(res, 201, { agent: savedAgent });
    }

    const agentHandleMatch = url.pathname.match(/^\/api\/agents\/by-handle\/([^/]+)$/);
    if (agentHandleMatch && req.method === "GET") {
      const state = await loadState();
      let agent = null;
      try {
        agent = agentByHandle(state, agentHandleMatch[1]);
      } catch {
        agent = null;
      }
      return agent ? send(res, 200, { agent }) : send(res, 404, { error: "agent not found" });
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && req.method === "GET") {
      const state = await loadState();
      const agent = state.agents[agentMatch[1]];
      return agent ? send(res, 200, { agent }) : send(res, 404, { error: "agent not found" });
    }

    if (agentMatch && req.method === "PATCH") {
      const patch = await json(req);
      try { rejectRawSecretsInPayload(patch); } catch (error) {
        return send(res, error.statusCode || 400, { error: error.message });
      }
      const createSlackHandle = patch.createSlackHandle;
      const slackTeamId = patch.slackTeamId || patch.teamId || null;
      if (patch.channelIds && !patch.slackChannelIds) patch.slackChannelIds = patch.channelIds;
      if (patch.userIds && !patch.slackUserIds) patch.slackUserIds = patch.userIds;
      if (patch.slackChannelIds) patch.slackChannelIds = normalizeSlackChannelIds(patch.slackChannelIds);
      if (patch.slackUserIds) patch.slackUserIds = normalizeSlackUserIds(patch.slackUserIds);
      delete patch.createSlackHandle;
      delete patch.teamId;
      delete patch.channelIds;
      delete patch.userIds;
      await validateAgentPatch(patch);
      if (patch.handle) patch.handle = handleFromString(patch.handle);

      let updatedAgent;
      try {
        updatedAgent = await withState((state) => {
          const agent = state.agents[agentMatch[1]];
          if (!agent) throw Object.assign(new Error("agent not found"), { statusCode: 404 });
          if (patch.handle) {
            const existing = agentByHandle(state, patch.handle);
            if (existing && existing.id !== agent.id) {
              throw Object.assign(new Error(`agent handle already exists: ${patch.handle}`), { statusCode: 409 });
            }
          }
          const merged = { ...agent, ...patch, id: agent.id, updatedAt: now() };
          state.agents[agent.id] = merged;
          return merged;
        });
      } catch (error) {
        return send(res, error.statusCode || 400, { error: error.message });
      }

      const effectiveTeamId = slackTeamId || updatedAgent.slackTeamId || null;
      if (createSlackHandle === true && SLACK_CREATE_USERGROUPS && !updatedAgent.slackUsergroupId) {
        try {
          const provisionState = await loadState();
          provisionState.agents[updatedAgent.id] = updatedAgent;
          updatedAgent = await provisionSlackAgentHandle(provisionState, updatedAgent, {
            teamId: effectiveTeamId,
            memberUserIds: patch.slackUserIds || []
          });
          await withState((state) => { state.agents[updatedAgent.id] = updatedAgent; });
        } catch (error) {
          return send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      } else if (patch.slackUserIds) {
        const reconcileState = await loadState();
        reconcileState.agents[updatedAgent.id] = updatedAgent;
        updatedAgent = await reconcileSlackAgentMembers(reconcileState, updatedAgent, { teamId: effectiveTeamId });
        await withState((state) => { state.agents[updatedAgent.id] = updatedAgent; });
      }
      return send(res, 200, { agent: updatedAgent });
    }

    if (req.method === "GET" && url.pathname === "/api/mcp/tools") {
      const servers = await listGatewayServers();
      return send(res, 200, { servers, tools: servers.flatMap((server) => server.tools || []) });
    }

    if (req.method === "GET" && url.pathname === "/api/skills/registry") {
      return send(res, 200, { skills: await listSkillsRegistry() });
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await json(req);
      try { rejectRawSecretsInPayload(body); } catch (error) {
        return send(res, error.statusCode || 400, { error: error.message });
      }
      const session = await withState((state) => {
        const sessionId = id("ses");
        state.sessions[sessionId] = {
          id: sessionId,
          agentId: body.agentId || defaultAgentId,
          userId: body.userId || "default",
          messages: [],
          createdAt: now(),
          updatedAt: now()
        };
        return state.sessions[sessionId];
      });
      return send(res, 201, { session });
    }

    const sessionMessageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (sessionMessageMatch && req.method === "POST") {
      const body = await json(req);
      try { rejectRawSecretsInPayload(body); } catch (error) {
        return send(res, error.statusCode || 400, { error: error.message });
      }
      const snapshot = await loadState();
      const session = snapshot.sessions[sessionMessageMatch[1]];
      if (!session) return send(res, 404, { error: "session not found" });
      const content = String(body.content || body.message || "");
      const { run } = await createRun({ sessionId: session.id, content });
      return send(res, 202, { run });
    }

    const workMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/work-item$/);
    if (workMatch && req.method === "GET") {
      if (!requireInternalAuth(req, res)) return;
      const state = await loadState();
      const run = state.runs[workMatch[1]];
      if (!run) return send(res, 404, { error: "run not found" });
      const agent = state.agents[run.agentId];
      const session = state.sessions[run.sessionId];
      return send(res, 200, { run, agent, session, content: run.content, memory: sessionMemory(session, run.inputMessageId) });
    }

    const completeMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/complete$/);
    if (completeMatch && req.method === "POST") {
      if (!requireInternalAuth(req, res)) return;
      const body = await json(req);
      try {
        const run = await withState((state) => {
          const r = state.runs[completeMatch[1]];
          if (!r) throw Object.assign(new Error("run not found"), { statusCode: 404 });
          r.status = body.status || "completed";
          r.result = body.result || "";
          r.error = body.error || null;
          r.updatedAt = now();
          const session = state.sessions[r.sessionId];
          if (session && r.status === "completed") {
            session.messages.push({ role: "assistant", content: r.result, createdAt: now() });
            session.updatedAt = now();
          }
          return { ...r };
        });
        return send(res, 200, { run });
      } catch (error) {
        return send(res, error.statusCode || 500, { error: error.message });
      }
    }

    const eventMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/events$/);
    if (eventMatch && req.method === "POST") {
      if (!requireInternalAuth(req, res)) return;
      const body = await json(req);
      try {
        await withState((state) => {
          const run = state.runs[eventMatch[1]];
          if (!run) throw Object.assign(new Error("run not found"), { statusCode: 404 });
          run.events ||= [];
          run.events.push({
            id: id("evt"),
            type: body.type || "event",
            text: body.text || "",
            createdAt: now()
          });
          run.updatedAt = now();
        });
        return send(res, 200, { ok: true });
      } catch (error) {
        return send(res, error.statusCode || 500, { error: error.message });
      }
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
      const state = await loadState();
      const run = state.runs[runMatch[1]];
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

function assertStartupConfig() {
  if (!HARNESS_INTERNAL_TOKEN) {
    console.warn("[hermes] HARNESS_INTERNAL_TOKEN is not set; turn-runner callbacks will be rejected and job dispatch will fail");
  }
  if (!PUBLIC_BASE_URL) {
    console.warn("[hermes] PUBLIC_BASE_URL is not set; turn-runner cannot reach this control API");
  }
  if (!OPENAI_API_KEY) {
    console.warn("[hermes] HERMES_OPENAI_API_KEY is not set; /v1/* endpoints are unauthenticated. Front this service with a gateway or set the env.");
  }
  if (SLACK_BOT_TOKEN && !SLACK_SIGNING_SECRET) {
    console.warn("[hermes] SLACK_BOT_TOKEN is set but SLACK_SIGNING_SECRET is missing; Slack requests will be rejected");
  }
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error?.statusCode || 500, { error: error.message }));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  assertStartupConfig();
  console.log(`hermes control API listening on :${PORT}`);
});

function shutdown(signal) {
  console.log(`[hermes] received ${signal}, draining state writes`);
  shuttingDown = true;
  httpServer.close(() => {});
  stateWriteChain.finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
