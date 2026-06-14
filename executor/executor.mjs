import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import tar from "tar";

const workB64 = process.env.HARNESS_WORK_B64 || "";
const turnTimeoutMs = Number(process.env.HARNESS_TURN_TIMEOUT_MS || 600_000);

if (!workB64) {
  console.error("HARNESS_WORK_B64 is required");
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(Buffer.from(workB64, "base64").toString("utf8"));
} catch (error) {
  console.error(`HARNESS_WORK_B64 could not be decoded: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const runId = payload?.run_id;
const hermesSessionId = payload?.hermes_session_id;
// Per DESIGN.md, HARNESS_CALLBACK_TOKEN is delivered as its own job env (paired
// with HARNESS_WORK_B64). Accept callback_token inside the payload as a fallback
// for older controller dispatches.
const callbackToken = process.env.HARNESS_CALLBACK_TOKEN || payload?.callback_token || "";
const callbackBase = (payload?.callback_url || process.env.HARNESS_CONTROLLER_URL || "").replace(/\/+$/, "");

if (!runId || !hermesSessionId || !callbackToken || !callbackBase) {
  console.error("HARNESS_WORK_B64 payload missing required fields (run_id, hermes_session_id, callback_token, callback_url)");
  process.exit(2);
}

const eventsPath = `/api/internal/runs/${encodeURIComponent(runId)}/events`;
const sessionDbPath = `/api/internal/runs/${encodeURIComponent(runId)}/session-db`;
const completePath = `/api/internal/runs/${encodeURIComponent(runId)}/complete`;

function authHeaders(extra = {}) {
  return {
    authorization: `Bearer ${callbackToken}`,
    ...extra
  };
}

async function postJson(apiPath, body) {
  const res = await fetch(`${callbackBase}${apiPath}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function getStream(apiPath) {
  return fetch(`${callbackBase}${apiPath}`, { headers: authHeaders() });
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _workB64Redactor = workB64 && workB64.length >= 12
  ? new RegExp(escapeRegex(workB64), "g")
  : null;
const _callbackTokenRedactor = callbackToken && callbackToken.length >= 12
  ? new RegExp(escapeRegex(callbackToken), "g")
  : null;

function redact(text) {
  let out = String(text || "")
    .replace(/\b(?:xoxb|xoxp|xapp)-[a-zA-Z0-9-]+/g, "slack-token-redacted")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-redacted")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer redacted");
  if (_workB64Redactor) out = out.replace(_workB64Redactor, "harness-work-b64-redacted");
  if (_callbackTokenRedactor) out = out.replace(_callbackTokenRedactor, "harness-callback-token-redacted");
  return out;
}

function emitRunEvent(type, text) {
  return postJson(eventsPath, { type, text }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
  });
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function mcpServerNameFromUrl(value, index) {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/").filter(Boolean);
    const raw = parts.length >= 2 && parts.at(-1) === "server" ? parts.at(-2) : parts.at(-1);
    const name = String(raw || `remote-${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return name || `remote-${index + 1}`;
  } catch {
    return `remote-${index + 1}`;
  }
}

function mcpConfigLines(servers) {
  const urls = (servers || []).filter((entry) => /^https?:\/\//i.test(String(entry)));
  if (!urls.length) return [];
  const seen = new Map();
  const lines = ["mcp_servers:"];
  urls.forEach((url, index) => {
    const baseName = mcpServerNameFromUrl(url, index);
    const count = seen.get(baseName) || 0;
    seen.set(baseName, count + 1);
    const name = count ? `${baseName}-${count + 1}` : baseName;
    lines.push(`  ${name}:`);
    lines.push(`    url: ${yamlString(url)}`);
    lines.push("    headers:");
    lines.push("      Authorization: \"Bearer ${TFY_API_KEY}\"");
  });
  return lines;
}

function mcpToolsetNames(servers) {
  const seen = new Map();
  return (servers || []).map((entry, index) => {
    const value = String(entry || "").trim();
    if (!value) return "";
    if (!/^https?:\/\//i.test(value)) return value;
    const baseName = mcpServerNameFromUrl(value, index);
    const count = seen.get(baseName) || 0;
    seen.set(baseName, count + 1);
    return count ? `${baseName}-${count + 1}` : baseName;
  }).filter(Boolean);
}

function bulletList(values) {
  return (values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .map((value) => `- ${value}`)
    .join("\n");
}

function buildManifestSystemPrompt(work) {
  const agent = work.agent || {};
  const blocks = [
    "Additional instructions from hermes.yaml:",
    agent.name ? `Agent name: ${agent.name}` : "",
    agent.handle ? `Slack handle: @${agent.handle}` : "",
    agent.description ? `Description: ${agent.description}` : "",
    String(agent.instructions || "").trim() ? `Instructions:\n${String(agent.instructions).trim()}` : "",
    Array.isArray(agent.skills) && agent.skills.length ? `Configured skill FQNs:\n${bulletList(agent.skills)}` : "",
    Array.isArray(agent.mcpServers) && agent.mcpServers.length ? `Configured MCP servers:\n${bulletList(agent.mcpServers)}` : ""
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

async function downloadSessionDb(hermesHome) {
  const dbPath = path.join(hermesHome, "state.db");
  const res = await getStream(sessionDbPath);
  if (res.status === 404) {
    return { downloaded: false, bytes: 0, path: dbPath };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`session-db download failed ${res.status}: ${text.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("session-db response had no body");
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dbPath, { mode: 0o600 }));
  const info = await stat(dbPath);
  return { downloaded: true, bytes: info.size, path: dbPath };
}

async function uploadSessionDb(hermesHome) {
  const dbPath = path.join(hermesHome, "state.db");
  if (!existsSync(dbPath)) {
    console.error(`session-db upload skipped: ${dbPath} does not exist`);
    return { uploaded: false, bytes: 0 };
  }
  const info = await stat(dbPath);
  const stream = createReadStream(dbPath);
  const res = await fetch(`${callbackBase}${sessionDbPath}`, {
    method: "POST",
    headers: authHeaders({
      "content-type": "application/octet-stream",
      "content-length": String(info.size)
    }),
    body: Readable.toWeb(stream),
    duplex: "half"
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`session-db upload failed ${res.status}: ${text.slice(0, 500)}`);
  }
  return { uploaded: true, bytes: info.size };
}

async function installAgentSkills(env, skills) {
  const fqns = (skills || []).map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!fqns.length) return [];
  const serviceApi = (env.TFY_HOST || "").replace(/\/+$/, "");
  const token = env.TFY_API_KEY || "";
  if (!serviceApi || !token) {
    throw new Error("TFY_HOST and TFY_API_KEY are required to install Hermes skills");
  }

  const res = await fetch(`${serviceApi}/api/ml/v1/x/agent-skill-versions/presigned-urls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
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
    const tarPath = path.join(tmpdir(), `${runId}-${name}.tar`);
    const tarRes = await fetch(item.presigned_url);
    if (!tarRes.ok) throw new Error(`skill tar download failed for ${item.fqn}: ${tarRes.status}`);
    await writeFile(tarPath, Buffer.from(await tarRes.arrayBuffer()), { mode: 0o600 });

    const entries = [];
    await tar.list({
      file: tarPath,
      strict: true,
      onentry: (entry) => { entries.push(entry.path); }
    });
    for (const entry of entries) {
      if (isUnsafeTarPath(entry)) {
        throw new Error(`skill tar for ${item.fqn} contains unsafe path: ${entry}`);
      }
    }

    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await tar.extract({
      file: tarPath,
      cwd: dest,
      strict: true,
      filter: (entryPath) => !isUnsafeTarPath(entryPath)
    });
    await rm(tarPath, { force: true });
    installed.push({ fqn: item.fqn, name });
  }
  return installed;
}

function looksLikeHermesFailure(text) {
  return /^API call failed\b/i.test(String(text || "").trim());
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
    ...mcpConfigLines(work.agent?.mcpServers),
    ""
  ].join("\n");
  await writeFile(path.join(home, "config.yaml"), config, { mode: 0o600 });
  return { home, manifestSystemPrompt };
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
import json
import os
import re
import time
import urllib.error
import urllib.request

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
    body = {
        "type": "hermes_observer",
        "text": json.dumps({
            "kind": kind,
            "created_at": time.time(),
            **payload,
        }, separators=(",", ":"), default=str),
    }
    req = urllib.request.Request(
        _EVENT_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "authorization": f"Bearer {_TOKEN}",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        urllib.request.urlopen(req, timeout=2).read()
    except Exception:
        pass


def _tool_label(tool_name, args=None):
    compact_args = _compact(args or {})
    return {"tool_name": tool_name, "args": compact_args}


def _seconds_to_ms(value):
    try:
        return float(value) * 1000
    except (TypeError, ValueError):
        return None


def on_pre_api_request(**kwargs):
    _emit(
        "model_request_start",
        model=kwargs.get("model"),
        provider=kwargs.get("provider"),
        tool_count=kwargs.get("tool_count"),
        message_count=kwargs.get("message_count"),
        api_call_count=kwargs.get("api_call_count"),
    )


def on_post_api_request(**kwargs):
    _emit(
        "model_request_complete",
        model=kwargs.get("model") or kwargs.get("response_model"),
        finish_reason=kwargs.get("finish_reason"),
        duration_ms=_seconds_to_ms(kwargs.get("api_duration")),
        assistant_tool_call_count=kwargs.get("assistant_tool_call_count"),
        usage=_compact(kwargs.get("usage")),
    )


def on_api_request_error(**kwargs):
    error = kwargs.get("error") if isinstance(kwargs.get("error"), dict) else {}
    _emit(
        "model_request_error",
        model=kwargs.get("model"),
        duration_ms=_seconds_to_ms(kwargs.get("api_duration")),
        reason=kwargs.get("reason"),
        error_type=error.get("type") or kwargs.get("error_type"),
        error_message=_short(error.get("message") or kwargs.get("error_message") or ""),
    )


def on_pre_tool_call(**kwargs):
    _emit("tool_start", **_tool_label(kwargs.get("tool_name"), kwargs.get("args")))


def on_post_tool_call(**kwargs):
    _emit(
        "tool_complete",
        tool_name=kwargs.get("tool_name"),
        status=kwargs.get("status"),
        duration_ms=kwargs.get("duration_ms"),
        error_type=kwargs.get("error_type"),
        error_message=_short(kwargs.get("error_message") or ""),
    )


def on_subagent_start(**kwargs):
    _emit(
        "subagent_start",
        child_role=kwargs.get("child_role"),
        child_goal=_short(kwargs.get("child_goal") or ""),
    )


def on_subagent_stop(**kwargs):
    _emit(
        "subagent_stop",
        child_role=kwargs.get("child_role"),
        status=kwargs.get("status"),
        duration_ms=kwargs.get("duration_ms"),
        child_summary=_short(kwargs.get("child_summary") or ""),
    )


def register(ctx):
    ctx.register_hook("pre_api_request", on_pre_api_request)
    ctx.register_hook("post_api_request", on_post_api_request)
    ctx.register_hook("api_request_error", on_api_request_error)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("subagent_start", on_subagent_start)
    ctx.register_hook("subagent_stop", on_subagent_stop)
`, { mode: 0o600 });
}

async function runHermes(work) {
  const env = { ...process.env };
  const model = work.agent?.model || process.env.HERMES_MODEL;
  if (model) env.HERMES_MODEL = model;
  env.HERMES_YOLO_MODE = "1";
  env.HERMES_ACCEPT_HOOKS = "1";
  env.HERMES_HOME = "/workspace/.hermes";
  env.HERMES_SESSION_ID = hermesSessionId;
  env.HARNESS_EVENT_URL = `${callbackBase}${eventsPath}`;
  env.HARNESS_CALLBACK_TOKEN = callbackToken;

  const { home: hermesHome, manifestSystemPrompt } = await writeHermesConfig(env, model, work);
  const sessionDownload = await downloadSessionDb(hermesHome);
  const installedSkills = await installAgentSkills(env, work.agent?.skills);

  const prompt = String(work.content || "");
  const promptPath = path.join(hermesHome, `prompt-${runId}.txt`);
  const wrapperPath = path.join(hermesHome, "tfy_hermes_oneshot.py");
  await writeFile(promptPath, prompt, { mode: 0o600 });
  await writeFile(wrapperPath, String.raw`
import os
import sys

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
            kwargs["ephemeral_system_prompt"] = "\n\n".join(
                part for part in [existing, prompt] if part
            )
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
    prompt_path = sys.argv[1]
    model = sys.argv[2] or None
    provider = sys.argv[3] or None
    toolsets = sys.argv[4] or None
    with open(prompt_path, "r", encoding="utf-8") as handle:
        prompt = handle.read()
    _startup()
    raise SystemExit(run_oneshot(prompt, model=model, provider=provider, toolsets=toolsets))
`, { mode: 0o600 });

  const toolsets = mcpToolsetNames(work.agent?.mcpServers);
  const args = [wrapperPath, promptPath, model || "", env.OPENAI_BASE_URL ? "custom" : "", toolsets.join(",")];

  return new Promise((resolve, reject) => {
    emitRunEvent("executor_diagnostic", JSON.stringify({
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
      sessionDbBytes: sessionDownload.bytes
    }));
    const child = spawn("python", args, { env, stdio: ["ignore", "pipe", "pipe"] });
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
      const exitDiagnostic = emitRunEvent("executor_diagnostic", JSON.stringify({
        phase: "exit",
        code,
        killed,
        stdoutChars: stdout.length,
        stdoutTrimmedChars: stdout.trim().length,
        stderrChars: stderr.length
      }));
      exitDiagnostic.finally(() => {
        if (killed) return reject(new Error(`hermes turn exceeded HARNESS_TURN_TIMEOUT_MS=${turnTimeoutMs}ms`));
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
  const result = await runHermes(payload);
  try {
    await uploadSessionDb("/workspace/.hermes");
  } catch (uploadError) {
    const message = uploadError instanceof Error ? uploadError.message : String(uploadError);
    console.error(message);
    await postJson(completePath, { status: "failed", error: `session-db upload failed: ${message}` }).catch((postError) => {
      console.error(postError instanceof Error ? postError.message : String(postError));
    });
    process.exit(1);
  }
  await postJson(completePath, { status: "completed", result });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  try {
    await postJson(completePath, { status: "failed", error: message });
  } catch (postError) {
    console.error(postError instanceof Error ? postError.message : String(postError));
  }
  process.exit(1);
}
