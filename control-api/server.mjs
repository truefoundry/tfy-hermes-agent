import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSlackBridge, ensureSlackState, normalizeSlackAgentConfig, parseSlackConfig } from "./slack-bridge.mjs";

const PORT = Number(process.env.PORT || 8787);
const STATE_ROOT = process.env.HARNESS_STATE_DIR || "/data/state";
const TFY_BASE_URL = (process.env.TFY_BASE_URL || process.env.TFY_HOST || "").replace(/\/+$/, "");
const TFY_API_KEY = process.env.TFY_API_KEY || process.env.TFY_GATEWAY_API_KEY || "";
const TFY_WORKSPACE_FQN = process.env.TFY_WORKSPACE_FQN || "";
const HERMES_MODEL = process.env.HERMES_INFERENCE_MODEL || process.env.HARNESS_MODEL || "openai-main/gpt-5.5";
const HERMES_JOB_APPLICATION_NAME = process.env.HERMES_JOB_APPLICATION_NAME || "hermes-turn-runner";
const SKILLS_REGISTRY_URL = process.env.HERMES_SKILLS_REGISTRY_URL || "";
const DEFAULT_SKILLS = parseJsonArrayEnv("HERMES_DEFAULT_SKILLS");
const DEFAULT_MCP_SERVERS = parseJsonArrayEnv("HERMES_DEFAULT_MCP_SERVERS");
const DEFAULT_SECRET_REFS = parseJsonArrayEnv("HERMES_DEFAULT_SECRET_REFS");
const SLACK_CONFIG = parseSlackConfig();
const OPENAI_SYNC_TIMEOUT_MS = Number(process.env.HERMES_OPENAI_SYNC_TIMEOUT_MS || 120000);
const OPENAI_POLL_INTERVAL_MS = Number(process.env.HERMES_OPENAI_POLL_INTERVAL_MS || 1000);

const stateFile = path.join(STATE_ROOT, "state.json");
const defaultAgentId = "agt_hermes";

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function parseJsonArrayEnv(name) {
  const raw = process.env[name];
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  } catch {
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function defaultAgent() {
  const slack = normalizeSlackAgentConfig(SLACK_CONFIG);
  return {
    id: defaultAgentId,
    name: "Hermes Agent",
    model: HERMES_MODEL,
    workspaceFqn: TFY_WORKSPACE_FQN,
    skills: DEFAULT_SKILLS,
    mcpServers: DEFAULT_MCP_SERVERS,
    secretRefs: DEFAULT_SECRET_REFS,
    slack,
    createdAt: now(),
    updatedAt: now()
  };
}

function applyDefaultAgentConfig(state) {
  state.agents ||= {};
  const current = state.agents[defaultAgentId] || defaultAgent();
  const slack = normalizeSlackAgentConfig(SLACK_CONFIG);
  state.agents[defaultAgentId] = {
    ...current,
    name: current.name || "Hermes Agent",
    model: HERMES_MODEL,
    workspaceFqn: TFY_WORKSPACE_FQN,
    skills: DEFAULT_SKILLS,
    mcpServers: DEFAULT_MCP_SERVERS,
    secretRefs: DEFAULT_SECRET_REFS,
    slack,
    updatedAt: now()
  };
  state.sessions ||= {};
  state.runs ||= {};
  ensureSlackState(state);
  return state;
}

async function loadState() {
  await mkdir(STATE_ROOT, { recursive: true });
  try {
    return applyDefaultAgentConfig(JSON.parse(await readFile(stateFile, "utf8")));
  } catch {
    return applyDefaultAgentConfig({
      agents: {
        [defaultAgentId]: defaultAgent()
      },
      sessions: {},
      runs: {}
    });
  }
}

async function saveState(state) {
  await mkdir(STATE_ROOT, { recursive: true });
  await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function json(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendText(res, status, body, contentType = "text/plain") {
  res.writeHead(status, { "content-type": contentType });
  res.end(body);
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

function requireTfySecretRefs(refs) {
  for (const ref of refs || []) {
    if (typeof ref !== "string" || !ref.startsWith("tfy-secret://")) {
      throw new Error(`secret reference must use tfy-secret://: ${ref}`);
    }
  }
}

async function tfyGet(apiPath) {
  if (!TFY_BASE_URL || !TFY_API_KEY) {
    throw new Error("TFY_BASE_URL/TFY_API_KEY are required");
  }
  const res = await fetch(`${TFY_BASE_URL}${apiPath}`, {
    headers: { authorization: `Bearer ${TFY_API_KEY}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TrueFoundry ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
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
    headers: TFY_API_KEY ? { authorization: `Bearer ${TFY_API_KEY}` } : {}
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
    const unknown = patch.mcpServers
      .filter((server) => !isMcpGatewayUrl(server) || !visibleNames.has(mcpServerNameFromUrl(server)));
    if (unknown.length) throw new Error(`MCP servers not visible through TrueFoundry MCP Gateway: ${unknown.join(", ")}`);
  }
}

function isMcpGatewayUrl(value) {
  return /^(https?:\/\/.*|\$\{gateway_base_url\}|)\/mcp\/[^/]+\/server\/?$/.test(String(value));
}

function mcpServerNameFromUrl(value) {
  const match = String(value).match(/\/mcp\/([^/]+)\/server\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function triggerJob(runId) {
  if (!TFY_BASE_URL || !TFY_API_KEY || !TFY_WORKSPACE_FQN) return null;
  const apps = await tfyGet(`/api/svc/v1/apps?workspace_fqn=${encodeURIComponent(TFY_WORKSPACE_FQN)}&limit=200`);
  const job = (Array.isArray(apps.data) ? apps.data : []).find((app) => app.name === HERMES_JOB_APPLICATION_NAME);
  const deploymentId = job?.deployment?.id || job?.activeDeploymentId;
  if (!deploymentId) throw new Error(`active deployment not found for job ${HERMES_JOB_APPLICATION_NAME}`);
  const controlUrl = process.env.PUBLIC_BASE_URL || process.env.HARNESS_API_URL || `http://localhost:${PORT}`;
  const command = [
    `HARNESS_RUN_ID=${shellQuote(runId)}`,
    `HARNESS_CONTROL_API_URL=${shellQuote(controlUrl)}`,
    "node runner/turn-runner.mjs"
  ].join(" ");
  const payload = {
    deploymentId,
    input: {
      command: `sh -lc ${shellQuote(command)}`
    },
    metadata: {
      job_run_name_alias: runId
    }
  };
  const res = await fetch(`${TFY_BASE_URL}/api/svc/v1/jobs/trigger`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TFY_API_KEY}`,
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createdUnix(run) {
  const value = new Date(run?.createdAt || now()).getTime();
  return Number.isNaN(value) ? Math.floor(Date.now() / 1000) : Math.floor(value / 1000);
}

function openAIId(prefix, runId) {
  return `${prefix}_${String(runId).replace(/^run_/, "")}`;
}

function runIdFromOpenAIId(value) {
  const idValue = String(value || "");
  if (idValue.startsWith("resp_")) return `run_${idValue.slice(5)}`;
  if (idValue.startsWith("chatcmpl_")) return `run_${idValue.slice(9)}`;
  return idValue;
}

async function createRun({ agentId = defaultAgentId, userId = "default", sessionId = null, content, source = {}, openai = null }) {
  const state = await loadState();
  let session = sessionId ? state.sessions[sessionId] : null;
  if (!session) {
    sessionId = id("ses");
    session = {
      id: sessionId,
      agentId,
      userId,
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    state.sessions[sessionId] = session;
  }

  const message = String(content || "");
  const inputMessage = { id: id("msg"), role: "user", content: message, source, createdAt: now() };
  session.messages.push(inputMessage);
  session.updatedAt = now();
  const runId = id("run");
  const openAI = openai ? { ...openai } : null;
  if (openAI?.kind === "response" && !openAI.responseId) {
    openAI.responseId = openAIId("resp", runId);
  }
  if (openAI?.kind === "chat.completion" && !openAI.chatCompletionId) {
    openAI.chatCompletionId = openAIId("chatcmpl", runId);
  }
  state.runs[runId] = {
    id: runId,
    sessionId: session.id,
    agentId: session.agentId,
    status: "queued",
    content: message,
    inputMessageId: inputMessage.id,
    source,
    openai: openAI,
    createdAt: now(),
    updatedAt: now()
  };
  await saveState(state);
  const trigger = await triggerJob(runId);
  const nextState = await loadState();
  if (nextState.runs[runId]) {
    nextState.runs[runId].status = trigger ? "running" : "queued";
    nextState.runs[runId].trigger = trigger;
    nextState.runs[runId].updatedAt = now();
    await saveState(nextState);
    return nextState.runs[runId];
  }
  return { id: runId, status: trigger ? "running" : "queued", trigger };
}

async function enqueueSessionMessage(sessionId, content, source = {}) {
  const state = await loadState();
  if (!state.sessions[sessionId]) throw new Error("session not found");
  return createRun({ sessionId, content, source });
}

async function waitForRun(runId, timeoutMs = Number(process.env.SLACK_RUN_TIMEOUT_SECONDS || 240) * 1000, pollIntervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await loadState();
    const run = state.runs[runId];
    if (!run) throw new Error(`run not found: ${runId}`);
    if (["completed", "failed"].includes(run.status)) return { run };
    await sleep(pollIntervalMs);
  }
  return {
    run: {
      id: runId,
      status: "failed",
      error: `timed out waiting for run after ${Math.round(timeoutMs / 1000)}s`
    }
  };
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
      if (part.type === "image_url" || part.type === "input_image" || part.type === "input_file") {
        throw new Error(`unsupported non-text content part: ${part.type}`);
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
    metadata: run.openai?.metadata || {}
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
        content: run.status === "completed" ? String(run.result || "") : "",
        refusal: null,
        annotations: []
      },
      logprobs: null,
      finish_reason: run.status === "completed" ? "stop" : null
    }],
    usage: null
  };
}

const slackBridge = createSlackBridge({
  config: SLACK_CONFIG,
  loadState,
  saveState,
  send,
  sendText,
  defaultAgentId,
  now,
  id,
  enqueueSessionMessage,
  waitForRun,
  publicBaseUrl(req) {
    const host = req.headers.host || "";
    return process.env.PUBLIC_BASE_URL || process.env.HARNESS_API_URL || (host ? `http://${host}` : "");
  }
});

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const state = await loadState();

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, stateRoot: STATE_ROOT });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return send(res, 200, { object: "list", data: [{ id: HERMES_MODEL, object: "model" }] });
    }

    if (req.method === "POST" && url.pathname === "/v1/responses") {
      const body = await json(req);
      if (body.stream) {
        return sendOpenAIError(res, 400, "streaming is not supported by this Hermes OpenAI-compatible adapter yet", "invalid_request_error", "stream");
      }
      let content;
      try {
        content = responsePrompt(body);
      } catch (error) {
        return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error));
      }
      const previousRun = body.previous_response_id ? state.runs[runIdFromOpenAIId(body.previous_response_id)] : null;
      const run = await createRun({
        agentId: body.agent || defaultAgentId,
        userId: body.user || "openai-sdk",
        sessionId: previousRun?.sessionId || null,
        content,
        source: { type: "openai.responses" },
        openai: {
          kind: "response",
          model: body.model || HERMES_MODEL,
          instructions: body.instructions || null,
          metadata: body.metadata || {}
        }
      });
      if (body.background) return send(res, 200, responseObject(run));

      const waited = await waitForRun(run.id, OPENAI_SYNC_TIMEOUT_MS, OPENAI_POLL_INTERVAL_MS);
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
      const run = state.runs[runIdFromOpenAIId(responseMatch[1])];
      return run ? send(res, 200, responseObject(run)) : sendOpenAIError(res, 404, "response not found", "invalid_request_error");
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await json(req);
      if (body.stream) {
        return sendOpenAIError(res, 400, "streaming is not supported by this Hermes OpenAI-compatible adapter yet", "invalid_request_error", "stream");
      }
      let content;
      try {
        content = promptFromMessages(body.messages);
      } catch (error) {
        return sendOpenAIError(res, 400, error instanceof Error ? error.message : String(error));
      }
      const run = await createRun({
        agentId: body.agent || defaultAgentId,
        userId: body.user || "openai-sdk",
        content,
        source: { type: "openai.chat.completions" },
        openai: {
          kind: "chat.completion",
          model: body.model || HERMES_MODEL,
          metadata: body.metadata || {}
        }
      });

      const waited = await waitForRun(run.id, OPENAI_SYNC_TIMEOUT_MS, OPENAI_POLL_INTERVAL_MS);
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
      const run = state.runs[runIdFromOpenAIId(chatCompletionMatch[1])];
      return run ? send(res, 200, chatCompletionObject(run)) : sendOpenAIError(res, 404, "chat completion not found", "invalid_request_error");
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      return send(res, 200, { agents: Object.values(state.agents) });
    }

    if (req.method === "GET" && url.pathname === "/api/slack/status") {
      return slackBridge.status(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/slack/manifest") {
      return slackBridge.manifest(req, res);
    }

    if (req.method === "POST" && url.pathname === "/slack/events") {
      return slackBridge.events(req, res);
    }

    const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch && req.method === "GET") {
      const agent = state.agents[agentMatch[1]];
      return agent ? send(res, 200, { agent }) : send(res, 404, { error: "agent not found" });
    }

    if (agentMatch && req.method === "PATCH") {
      const agent = state.agents[agentMatch[1]];
      if (!agent) return send(res, 404, { error: "agent not found" });
      const patch = await json(req);
      await validateAgentPatch(patch);
      state.agents[agent.id] = { ...agent, ...patch, id: agent.id, updatedAt: now() };
      await saveState(state);
      return send(res, 200, { agent: state.agents[agent.id] });
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
      const sessionId = id("ses");
      const agentId = body.agentId || defaultAgentId;
      state.sessions[sessionId] = {
        id: sessionId,
        agentId,
        userId: body.userId || "default",
        title: body.title || "",
        source: body.source || {},
        messages: [],
        createdAt: now(),
        updatedAt: now()
      };
      await saveState(state);
      return send(res, 201, { session: state.sessions[sessionId] });
    }

    const sessionMessageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
    if (sessionMessageMatch && req.method === "POST") {
      const session = state.sessions[sessionMessageMatch[1]];
      if (!session) return send(res, 404, { error: "session not found" });
      const body = await json(req);
      const content = String(body.content || body.message || "");
      const run = await enqueueSessionMessage(session.id, content, body.source || {});
      return send(res, 202, { run });
    }

    const workMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/work-item$/);
    if (workMatch && req.method === "GET") {
      const run = state.runs[workMatch[1]];
      if (!run) return send(res, 404, { error: "run not found" });
      const agent = state.agents[run.agentId];
      const session = state.sessions[run.sessionId];
      return send(res, 200, { run, agent, session, content: run.content, memory: sessionMemory(session, run.inputMessageId) });
    }

    const completeMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/complete$/);
    if (completeMatch && req.method === "POST") {
      const run = state.runs[completeMatch[1]];
      if (!run) return send(res, 404, { error: "run not found" });
      const body = await json(req);
      run.status = body.status || "completed";
      run.result = body.result || "";
      run.error = body.error || null;
      run.updatedAt = now();
      const session = state.sessions[run.sessionId];
      if (session && run.status === "completed") {
        session.messages.push({ role: "assistant", content: run.result, createdAt: now() });
        session.updatedAt = now();
      }
      await saveState(state);
      return send(res, 200, { run });
    }

    const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === "GET") {
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
          health: "/api/health",
          slackStatus: "/api/slack/status",
          slackEvents: "/slack/events"
        }
      });
    }

    return send(res, 404, { error: "Not found." });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

createServer((req, res) => {
  handle(req, res).catch((error) => send(res, 500, { error: error.message }));
}).listen(PORT, "0.0.0.0", () => {
  console.log(`hermes control API listening on :${PORT}`);
});
