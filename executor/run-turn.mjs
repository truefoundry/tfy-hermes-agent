import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as tarExtract } from "tar";

const errMsg = (e) => e instanceof Error ? e.message : String(e);

function turnContext(work, callbackToken) {
  const runId = work?.run_id;
  const hermesSessionId = work?.hermes_session_id;
  const callbackBase = String(work?.callback_url || "").replace(/\/+$/, "");
  if (!runId || !hermesSessionId || !callbackToken || !callbackBase) {
    throw new Error("work payload missing run_id, hermes_session_id, callback_url or callback token");
  }
  const eventsPath = `/api/internal/runs/${encodeURIComponent(runId)}/events`;
  const sessionDbPath = `/api/internal/runs/${encodeURIComponent(runId)}/session-db`;
  const completePath = `/api/internal/runs/${encodeURIComponent(runId)}/complete`;
  return {
    runId,
    hermesSessionId,
    callbackToken,
    callbackBase,
    eventsPath,
    sessionDbPath,
    completePath,
    authHeaders: (extra = {}) => ({ authorization: `Bearer ${callbackToken}`, ...extra })
  };
}

async function postJson(ctx, apiPath, body) {
  const res = await fetch(`${ctx.callbackBase}${apiPath}`, {
    method: "POST",
    headers: ctx.authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function redact(text, secrets = []) {
  let out = String(text || "")
    .replace(/\b(?:xoxb|xoxp|xapp)-[a-zA-Z0-9-]+/g, "slack-token-redacted")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-redacted")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer redacted");
  for (const secret of secrets) {
    if (secret && secret.length >= 12) {
      out = out.replace(new RegExp(String(secret).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "redacted");
    }
  }
  return out;
}

function emitRunEvent(ctx, type, text) {
  return postJson(ctx, ctx.eventsPath, { type, text }).catch((error) => console.error(errMsg(error)));
}

const yamlString = (v) => JSON.stringify(String(v || ""));

function mcpServerNameFromUrl(value, index) {
  try {
    const parts = new URL(value).pathname.split("/").filter(Boolean);
    const raw = parts.length >= 2 && parts.at(-1) === "server" ? parts.at(-2) : parts.at(-1);
    const name = String(raw || `remote-${index + 1}`)
      .toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return name || `remote-${index + 1}`;
  } catch {
    return `remote-${index + 1}`;
  }
}

function dedupedMcpNames(servers) {
  const seen = new Map();
  return (servers || []).map((entry, index) => {
    const value = String(entry || "").trim();
    if (!value) return { url: "", name: "" };
    if (!/^https?:\/\//i.test(value)) return { url: "", name: value };
    const baseName = mcpServerNameFromUrl(value, index);
    const count = seen.get(baseName) || 0;
    seen.set(baseName, count + 1);
    return { url: value, name: count ? `${baseName}-${count + 1}` : baseName };
  });
}

function mcpConfigLines(servers) {
  const entries = dedupedMcpNames(servers).filter((e) => e.url);
  if (!entries.length) return [];
  const lines = ["mcp_servers:"];
  for (const { url, name } of entries) {
    lines.push(`  ${name}:`, `    url: ${yamlString(url)}`, "    headers:",
      "      Authorization: \"Bearer ${TFY_API_KEY}\"");
  }
  return lines;
}

const mcpToolsetNames = (servers) => dedupedMcpNames(servers).map((e) => e.name).filter(Boolean);

function buildManifestSystemPrompt(work) {
  const agent = work.agent || {};
  const bullets = (values) => (values || [])
    .map((v) => String(v || "").trim()).filter(Boolean).map((v) => `- ${v}`).join("\n");
  const instructions = String(agent.instructions || "").trim();
  const list = (label, values) =>
    Array.isArray(values) && values.length ? `${label}:\n${bullets(values)}` : "";
  const blocks = [
    "Additional instructions from hermes.yaml:",
    agent.name && `Agent name: ${agent.name}`,
    agent.handle && `Slack handle: @${agent.handle}`,
    agent.description && `Description: ${agent.description}`,
    instructions && `Instructions:\n${instructions}`,
    list("Configured skill FQNs", agent.skills),
    list("Configured MCP servers", agent.mcpServers)
  ].filter(Boolean);
  return `${blocks.join("\n\n")}\n`;
}

function skillNameFromFqn(fqn, fallback) {
  const match = String(fqn || "").match(/^agent-skill:[^/]+\/[^/]+\/([^:]+):(\d+)$/i);
  const raw = match ? match[1] : fallback || "skill";
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
}

function isUnsafeTarPath(entry) {
  const value = String(entry || "");
  if (!value) return true;
  if (path.isAbsolute(value)) return true;
  return value.split(/[\\/]+/).some((segment) => segment === "..");
}

async function downloadSessionDb(ctx, hermesHome) {
  const dbPath = path.join(hermesHome, "state.db");
  const res = await fetch(`${ctx.callbackBase}${ctx.sessionDbPath}`, { headers: ctx.authHeaders() });
  if (res.status === 404) return { downloaded: false, bytes: 0, path: dbPath };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`session-db download failed ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("session-db response had no body");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dbPath, { mode: 0o600 }));
  const info = await stat(dbPath);
  return { downloaded: true, bytes: info.size, path: dbPath };
}

async function uploadSessionDb(ctx, hermesHome) {
  const dbPath = path.join(hermesHome, "state.db");
  if (!existsSync(dbPath)) {
    console.error(`session-db upload skipped: ${dbPath} does not exist`);
    return { uploaded: false, bytes: 0 };
  }
  const info = await stat(dbPath);
  const res = await fetch(`${ctx.callbackBase}${ctx.sessionDbPath}`, {
    method: "POST",
    headers: ctx.authHeaders({
      "content-type": "application/octet-stream",
      "content-length": String(info.size)
    }),
    body: Readable.toWeb(createReadStream(dbPath)),
    duplex: "half"
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`session-db upload failed ${res.status}: ${text.slice(0, 500)}`);
  }
  return { uploaded: true, bytes: info.size };
}

async function installAgentSkills(ctx, env, skills) {
  const fqns = (skills || []).map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!fqns.length) return [];
  const serviceApi = (env.TFY_HOST || "").replace(/\/+$/, "");
  const token = env.TFY_API_KEY || "";
  if (!serviceApi || !token) {
    throw new Error("TFY_HOST and TFY_API_KEY are required to install Hermes skills");
  }

  const res = await fetch(`${serviceApi}/api/ml/v1/x/agent-skill-versions/presigned-urls`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ agent_skill_version_fqns: fqns })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`skill tar URL fetch failed ${res.status}: ${text.slice(0, 500)}`);
  const body = text ? JSON.parse(text) : {};
  const items = Array.isArray(body.data) ? body.data : [];
  const returned = new Set(items.map((item) => item.fqn));
  const missing = fqns.filter((fqn) => !returned.has(fqn));
  if (missing.length) throw new Error(`skill tar URLs missing for: ${missing.join(", ")}`);

  const skillsRoot = path.join(env.HERMES_HOME || path.join(env.HOME || process.cwd(), ".hermes"), "skills", "truefoundry");
  await mkdir(skillsRoot, { recursive: true });
  const installed = [];
  for (const item of items) {
    const name = skillNameFromFqn(item.fqn, item.name);
    const dest = path.join(skillsRoot, name);
    const tarPath = path.join(tmpdir(), `${ctx.runId}-${name}.tar`);
    const tarRes = await fetch(item.presigned_url);
    if (!tarRes.ok) throw new Error(`skill tar download failed for ${item.fqn}: ${tarRes.status}`);
    await writeFile(tarPath, Buffer.from(await tarRes.arrayBuffer()), { mode: 0o600 });

    const entries = [];
    await tar.list({ file: tarPath, strict: true, onentry: (entry) => { entries.push(entry.path); } });
    for (const entry of entries) {
      if (isUnsafeTarPath(entry)) throw new Error(`skill tar for ${item.fqn} contains unsafe path: ${entry}`);
    }

    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await tarExtract({
      file: tarPath, cwd: dest, strict: true,
      filter: (entryPath) => !isUnsafeTarPath(entryPath)
    });
    await rm(tarPath, { force: true });
    installed.push({ fqn: item.fqn, name });
  }
  return installed;
}

async function writeHermesObserverPlugin(home) {
  const pluginDir = path.join(home, "plugins", "tfy_slack_observer");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "plugin.yaml"), [
    "name: tfy_slack_observer",
    "version: 0.1.0",
    "description: Emits sanitized Hermes observer events back to the TrueFoundry Hermes controller.",
    "hooks:",
    "  - pre_api_request",
    "  - post_api_request",
    "  - api_request_error",
    "  - pre_tool_call",
    "  - post_tool_call",
    "  - subagent_start",
    "  - subagent_stop",
    ""
  ].join("\n"), { mode: 0o600 });
  await writeFile(path.join(pluginDir, "__init__.py"), String.raw`
import json, os, re, time, urllib.request

_SENSITIVE = re.compile(r"(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private)", re.I)
_EVENT_URL = (os.environ.get("HARNESS_EVENT_URL") or "").rstrip("/")
_TOKEN = os.environ.get("HARNESS_CALLBACK_TOKEN") or ""

def _short(value, limit=180):
    text = str(value)
    text = re.sub(r"\b(?:xoxb|xoxp|xapp)-[A-Za-z0-9-]+", "slack-token-redacted", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{20,}", "sk-redacted", text)
    text = re.sub(r"Bearer\s+[A-Za-z0-9._-]+", "Bearer redacted", text, flags=re.I)
    return text if len(text) <= limit else text[: limit - 1] + "..."

def _compact(value, depth=0):
    if depth > 2:
        return "..."
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return _short(value)
    if isinstance(value, (list, tuple)):
        preview = [_compact(item, depth + 1) for item in list(value)[:5]]
        if len(value) > 5:
            preview.append(f"+{len(value) - 5} more")
        return preview
    if isinstance(value, dict):
        out = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 8:
                out["+more"] = len(value) - 8
                break
            key_text = str(key)
            out[key_text] = "[redacted]" if _SENSITIVE.search(key_text) else _compact(item, depth + 1)
        return out
    return _short(value)

def _emit(kind, **payload):
    if not (_EVENT_URL and _TOKEN):
        return
    text = json.dumps({"kind": kind, "created_at": time.time(), **payload}, separators=(",", ":"), default=str)
    req = urllib.request.Request(
        _EVENT_URL,
        data=json.dumps({"type": "hermes_observer", "text": text}).encode("utf-8"),
        headers={"authorization": f"Bearer {_TOKEN}", "content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass

def _ms(value):
    try:
        return float(value) * 1000
    except (TypeError, ValueError):
        return None

def on_pre_api_request(**kw):
    _emit("model_request_start", model=kw.get("model"), provider=kw.get("provider"),
          tool_count=kw.get("tool_count"), message_count=kw.get("message_count"),
          api_call_count=kw.get("api_call_count"))

def on_post_api_request(**kw):
    _emit("model_request_complete", model=kw.get("model") or kw.get("response_model"),
          finish_reason=kw.get("finish_reason"), duration_ms=_ms(kw.get("api_duration")),
          assistant_tool_call_count=kw.get("assistant_tool_call_count"),
          usage=_compact(kw.get("usage")))

def on_api_request_error(**kw):
    err = kw.get("error") if isinstance(kw.get("error"), dict) else {}
    _emit("model_request_error", model=kw.get("model"), duration_ms=_ms(kw.get("api_duration")),
          reason=kw.get("reason"), error_type=err.get("type") or kw.get("error_type"),
          error_message=_short(err.get("message") or kw.get("error_message") or ""))

def on_pre_tool_call(**kw):
    _emit("tool_start", tool_name=kw.get("tool_name"), args=_compact(kw.get("args") or {}))

def on_post_tool_call(**kw):
    _emit("tool_complete", tool_name=kw.get("tool_name"), status=kw.get("status"),
          duration_ms=kw.get("duration_ms"), error_type=kw.get("error_type"),
          error_message=_short(kw.get("error_message") or ""))

def on_subagent_start(**kw):
    _emit("subagent_start", child_role=kw.get("child_role"),
          child_goal=_short(kw.get("child_goal") or ""))

def on_subagent_stop(**kw):
    _emit("subagent_stop", child_role=kw.get("child_role"), status=kw.get("status"),
          duration_ms=kw.get("duration_ms"),
          child_summary=_short(kw.get("child_summary") or ""))

_HOOKS = [
    ("pre_api_request", on_pre_api_request),
    ("post_api_request", on_post_api_request),
    ("api_request_error", on_api_request_error),
    ("pre_tool_call", on_pre_tool_call),
    ("post_tool_call", on_post_tool_call),
    ("subagent_start", on_subagent_start),
    ("subagent_stop", on_subagent_stop),
]

def register(ctx):
    for name, fn in _HOOKS:
        ctx.register_hook(name, fn)
`, { mode: 0o600 });
}

function terminalConfigLines(env) {
  if (env.HERMES_TERMINAL_BACKEND !== "daytona") return [];
  return [
    "terminal:",
    "  backend: daytona",
    ""
  ];
}

async function writeHermesConfig(env, model, work) {
  const home = env.HERMES_HOME || path.join(env.HOME || process.cwd(), ".hermes");
  await mkdir(home, { recursive: true });
  await writeHermesObserverPlugin(home);
  const manifestSystemPrompt = buildManifestSystemPrompt(work);
  env.HERMES_EPHEMERAL_SYSTEM_PROMPT = manifestSystemPrompt;
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
    "plugins:",
    "  enabled:",
    "    - tfy_slack_observer",
    ...terminalConfigLines(env),
    ...mcpConfigLines(work.agent?.mcpServers),
    ""
  ].join("\n");
  await writeFile(path.join(home, "config.yaml"), config, { mode: 0o600 });
  return { home, manifestSystemPrompt };
}

async function runHermes(ctx, work, secrets) {
  const env = { ...process.env };
  const model = work.agent?.model || process.env.HERMES_MODEL;
  if (model) env.HERMES_MODEL = model;
  env.HERMES_YOLO_MODE = "1";
  env.HERMES_ACCEPT_HOOKS = "1";
  env.HERMES_HOME = "/workspace/.hermes";
  env.HERMES_SESSION_ID = ctx.hermesSessionId;
  env.HARNESS_EVENT_URL = `${ctx.callbackBase}${ctx.eventsPath}`;
  env.HARNESS_CALLBACK_TOKEN = ctx.callbackToken;

  const turnTimeoutMs = Number(process.env.HARNESS_TURN_TIMEOUT_MS || 600_000);
  const { home: hermesHome, manifestSystemPrompt } = await writeHermesConfig(env, model, work);
  const sessionDownload = await downloadSessionDb(ctx, hermesHome);
  const installedSkills = await installAgentSkills(ctx, env, work.agent?.skills);

  const prompt = String(work.content || "");
  const promptPath = path.join(hermesHome, `prompt-${ctx.runId}.txt`);
  const wrapperPath = path.join(hermesHome, "tfy_hermes_oneshot.py");
  await writeFile(promptPath, prompt, { mode: 0o600 });
  await writeFile(wrapperPath, String.raw`
import os, sys
from hermes_cli.config import load_config
from hermes_cli.oneshot import run_oneshot

def _append_manifest_system_prompt():
    prompt = (os.environ.get("HERMES_EPHEMERAL_SYSTEM_PROMPT") or "").strip()
    if not prompt:
        return
    try:
        import run_agent
    except Exception:
        return
    original = run_agent.AIAgent
    class ManifestPromptAIAgent(original):
        def __init__(self, *args, **kwargs):
            existing = kwargs.get("ephemeral_system_prompt")
            kwargs["ephemeral_system_prompt"] = "\n\n".join(p for p in [existing, prompt] if p)
            super().__init__(*args, **kwargs)
    run_agent.AIAgent = ManifestPromptAIAgent

def _startup():
    _append_manifest_system_prompt()
    try:
        from hermes_cli.plugins import discover_plugins
        discover_plugins()
    except Exception:
        pass
    try:
        from tools.mcp_tool import discover_mcp_tools
        discover_mcp_tools()
    except Exception:
        pass
    try:
        from agent.shell_hooks import register_from_config
        register_from_config(load_config(), accept_hooks=True)
    except Exception:
        pass

if __name__ == "__main__":
    prompt_path, model, provider, toolsets = sys.argv[1], sys.argv[2] or None, sys.argv[3] or None, sys.argv[4] or None
    with open(prompt_path, "r", encoding="utf-8") as handle:
        prompt = handle.read()
    _startup()
    raise SystemExit(run_oneshot(prompt, model=model, provider=provider, toolsets=toolsets))
`, { mode: 0o600 });

  const toolsets = mcpToolsetNames(work.agent?.mcpServers);
  const args = [wrapperPath, promptPath, model || "", env.OPENAI_BASE_URL ? "custom" : "", toolsets.join(",")];

  emitRunEvent(ctx, "executor_diagnostic", JSON.stringify({
    phase: "start",
    model: model || null,
    promptChars: prompt.length,
    mcpServerCount: Array.isArray(work.agent?.mcpServers) ? work.agent.mcpServers.length : 0,
    toolsets,
    skillCount: Array.isArray(work.agent?.skills) ? work.agent.skills.length : 0,
    installedSkills: installedSkills.map((skill) => skill.name),
    manifestSystemPromptConfigured: Boolean(manifestSystemPrompt.trim()),
    manifestSystemPromptChars: manifestSystemPrompt.length,
    openaiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
    openaiApiKeyConfigured: Boolean(env.OPENAI_API_KEY),
    hermesHomeConfigured: Boolean(hermesHome),
    sessionDbDownloaded: sessionDownload.downloaded,
    sessionDbBytes: sessionDownload.bytes,
    terminalBackend: env.HERMES_TERMINAL_BACKEND || null
  }));

  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5_000).unref();
    }, turnTimeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      emitRunEvent(ctx, "stdout_delta", text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      emitRunEvent(ctx, "stderr_delta", redact(text, secrets));
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      emitRunEvent(ctx, "executor_diagnostic", JSON.stringify({
        phase: "exit", code, killed,
        stdoutChars: stdout.length,
        stdoutTrimmedChars: stdout.trim().length,
        stderrChars: stderr.length
      })).finally(() => {
        if (killed) return reject(new Error(`hermes turn exceeded HARNESS_TURN_TIMEOUT_MS=${turnTimeoutMs}ms`));
        if (code !== 0) return reject(new Error(`hermes exited ${code}: ${stderr || stdout}`));
        const result = stdout.trim();
        if (!result) return reject(new Error(`hermes exited 0 with empty stdout; stderr chars=${stderr.length}`));
        if (/^API call failed\b/i.test(result)) return reject(new Error(result));
        resolve(result);
      });
    });
  });
}

export async function executeTurn(work, callbackToken) {
  const ctx = turnContext(work, callbackToken);
  const secrets = [process.env.HARNESS_WORK_B64 || "", callbackToken].filter(Boolean);
  try {
    const result = await runHermes(ctx, work, secrets);
    try {
      await uploadSessionDb(ctx, "/workspace/.hermes");
    } catch (uploadError) {
      const message = errMsg(uploadError);
      await postJson(ctx, ctx.completePath, { status: "failed", error: `session-db upload failed: ${message}` });
      throw uploadError;
    }
    await postJson(ctx, ctx.completePath, { status: "completed", result });
    return { status: "completed", result };
  } catch (error) {
    const message = errMsg(error);
    await postJson(ctx, ctx.completePath, { status: "failed", error: message }).catch((e) => console.error(errMsg(e)));
    throw error;
  }
}
