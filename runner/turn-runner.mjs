import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const runId = process.env.HARNESS_RUN_ID || process.env.RUN_ID;
const controlApi = (process.env.HARNESS_CONTROL_API_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const internalToken = process.env.HARNESS_INTERNAL_TOKEN || "";
const turnTimeoutMs = Number(process.env.HARNESS_TURN_TIMEOUT_MS || 600_000);

if (!runId || !controlApi) {
  console.error("HARNESS_RUN_ID and HARNESS_CONTROL_API_URL are required");
  process.exit(2);
}

if (!internalToken) {
  console.error("HARNESS_INTERNAL_TOKEN is required so the runner can authenticate to the control API");
  process.exit(2);
}

function authHeaders(extra = {}) {
  return {
    authorization: `Bearer ${internalToken}`,
    ...extra
  };
}

async function getJson(apiPath) {
  const res = await fetch(`${controlApi}${apiPath}`, { headers: authHeaders() });
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function postJson(apiPath, body) {
  const res = await fetch(`${controlApi}${apiPath}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function buildPrompt(work) {
  const agent = work.agent || {};
  const identity = [
    agent.name ? `Agent name: ${agent.name}` : "",
    agent.handle ? `Slack handle: @${agent.handle}` : "",
    agent.description ? `Description: ${agent.description}` : "",
    agent.instructions ? `Instructions:\n${agent.instructions}` : ""
  ].filter(Boolean).join("\n");
  const memory = work.memory ? `Conversation so far:\n${work.memory}\n\n` : "";
  const skills = Array.isArray(work.agent?.skills) && work.agent.skills.length
    ? `Allowed skills: ${work.agent.skills.join(", ")}\n`
    : "";
  const mcp = Array.isArray(work.agent?.mcpServers) && work.agent.mcpServers.length
    ? `Allowed MCP servers: ${work.agent.mcpServers.join(", ")}\n`
    : "";
  const preamble = identity ? `${identity}\n\n` : "";
  return `${preamble}${skills}${mcp}${memory}User: ${work.content}`;
}

function redact(text) {
  return String(text || "")
    .replace(/\b(?:xoxb|xoxp|xapp)-[a-zA-Z0-9-]+/g, "slack-token-redacted")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-redacted")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer redacted");
}

function emitRunEvent(type, text) {
  return postJson(`/api/internal/runs/${encodeURIComponent(runId)}/events`, {
    type,
    text
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function looksLikeHermesFailure(text) {
  return /^API call failed\b/i.test(String(text || "").trim());
}

async function writeHermesConfig(env, model) {
  const home = env.HERMES_HOME || path.join(env.HOME || process.cwd(), ".hermes");
  await mkdir(home, { recursive: true });
  const config = [
    "model:",
    `  default: ${yamlString(model)}`,
    "  provider: custom",
    `  base_url: ${yamlString(env.OPENAI_BASE_URL || "")}`,
    `  api_key: ${yamlString(env.OPENAI_API_KEY || "")}`,
    "agent:",
    "  max_turns: 90",
    "display:",
    "  streaming: false",
    "  final_response_markdown: raw",
    ""
  ].join("\n");
  await writeFile(path.join(home, "config.yaml"), config, { mode: 0o600 });
  return home;
}

async function runHermes(prompt, work) {
  const env = { ...process.env };
  const model = work.agent?.model || process.env.HERMES_INFERENCE_MODEL;
  if (process.env.TFY_GATEWAY_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.TFY_GATEWAY_API_KEY;
  if (process.env.TFY_GATEWAY_BASE_URL && !env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.TFY_GATEWAY_BASE_URL;
  if (model) env.HERMES_INFERENCE_MODEL = model;
  env.HERMES_YOLO_MODE = "1";
  env.HERMES_ACCEPT_HOOKS = "1";
  const hermesHome = await writeHermesConfig(env, model);

  const args = ["-z", prompt];
  if (model) args.push("--model", model);
  if (env.OPENAI_BASE_URL) args.push("--provider", "custom");
  const toolsets = (work.agent?.mcpServers || []).filter((entry) => !/^https?:\/\//i.test(String(entry)));
  if (toolsets.length) args.push("--toolsets", toolsets.join(","));

  return new Promise((resolve, reject) => {
    emitRunEvent("runner_diagnostic", JSON.stringify({
      phase: "start",
      model: model || null,
      promptChars: prompt.length,
      mcpServerCount: Array.isArray(work.agent?.mcpServers) ? work.agent.mcpServers.length : 0,
      toolsets,
      openaiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
      openaiApiKeyConfigured: Boolean(env.OPENAI_API_KEY),
      hermesHomeConfigured: Boolean(hermesHome)
    }));
    const child = spawn("hermes", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5_000).unref();
    }, turnTimeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      emitRunEvent("stdout_delta", text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      emitRunEvent("stderr_delta", redact(text));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`hermes turn exceeded HARNESS_TURN_TIMEOUT_MS=${turnTimeoutMs}ms`));
      const exitDiagnostic = emitRunEvent("runner_diagnostic", JSON.stringify({
        phase: "exit",
        code,
        stdoutChars: stdout.length,
        stdoutTrimmedChars: stdout.trim().length,
        stderrChars: stderr.length
      }));
      exitDiagnostic.finally(() => {
        if (code === 0) {
          const result = stdout.trim();
          if (!result) return reject(new Error(`hermes exited 0 with empty stdout; stderr chars=${stderr.length}`));
          if (looksLikeHermesFailure(result)) return reject(new Error(result));
          return resolve(result);
        }
        reject(new Error(`hermes exited ${code}: ${stderr || stdout}`));
      });
    });
  });
}

try {
  const work = await getJson(`/api/internal/runs/${encodeURIComponent(runId)}/work-item`);
  const result = await runHermes(buildPrompt(work), work);
  await postJson(`/api/internal/runs/${encodeURIComponent(runId)}/complete`, {
    status: "completed",
    result
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  try {
    await postJson(`/api/internal/runs/${encodeURIComponent(runId)}/complete`, {
      status: "failed",
      error: message
    });
  } catch (postError) {
    console.error(postError instanceof Error ? postError.message : String(postError));
  }
  process.exit(1);
}
