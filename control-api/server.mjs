import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  return {
    id: defaultAgentId,
    name: "Hermes Agent",
    model: HERMES_MODEL,
    workspaceFqn: TFY_WORKSPACE_FQN,
    skills: DEFAULT_SKILLS,
    mcpServers: DEFAULT_MCP_SERVERS,
    secretRefs: DEFAULT_SECRET_REFS,
    createdAt: now(),
    updatedAt: now()
  };
}

function applyDefaultAgentConfig(state) {
  state.agents ||= {};
  const current = state.agents[defaultAgentId] || defaultAgent();
  state.agents[defaultAgentId] = {
    ...current,
    name: current.name || "Hermes Agent",
    model: HERMES_MODEL,
    workspaceFqn: TFY_WORKSPACE_FQN,
    skills: DEFAULT_SKILLS,
    mcpServers: DEFAULT_MCP_SERVERS,
    secretRefs: DEFAULT_SECRET_REFS,
    updatedAt: now()
  };
  state.sessions ||= {};
  state.runs ||= {};
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

function sessionMemory(session) {
  return (session.messages || [])
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const state = await loadState();

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, stateRoot: STATE_ROOT });
    }

    if (req.method === "GET" && url.pathname === "/api/agents") {
      return send(res, 200, { agents: Object.values(state.agents) });
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
      session.messages.push({ role: "user", content, createdAt: now() });
      session.updatedAt = now();
      const runId = id("run");
      state.runs[runId] = {
        id: runId,
        sessionId: session.id,
        agentId: session.agentId,
        status: "queued",
        content,
        createdAt: now(),
        updatedAt: now()
      };
      await saveState(state);
      const trigger = await triggerJob(runId);
      state.runs[runId].status = trigger ? "running" : "queued";
      state.runs[runId].trigger = trigger;
      state.runs[runId].updatedAt = now();
      await saveState(state);
      return send(res, 202, { run: state.runs[runId] });
    }

    const workMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/work-item$/);
    if (workMatch && req.method === "GET") {
      const run = state.runs[workMatch[1]];
      if (!run) return send(res, 404, { error: "run not found" });
      const agent = state.agents[run.agentId];
      const session = state.sessions[run.sessionId];
      return send(res, 200, { run, agent, session, content: run.content, memory: sessionMemory(session) });
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
      return sendText(res, 200, "Hermes Agent control API\n", "text/plain");
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
