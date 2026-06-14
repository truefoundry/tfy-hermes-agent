import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

function skillNameFromFqn(fqn, fallback) {
  const match = String(fqn || "").match(/^agent-skill:[^/]+\/[^/]+\/([^:]+):(\d+)$/i);
  const raw = match ? match[1] : fallback || "skill";
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "skill";
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: options.stdio || ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}: ${redact(stderr || stdout)}`));
    });
  });
}

async function installAgentSkills(env, skills) {
  const fqns = (skills || []).map((entry) => String(entry || "").trim()).filter(Boolean);
  if (!fqns.length) return [];
  const serviceApi = (env.TFY_SERVICE_API_URL || env.TFY_PLATFORM_BASE_URL || "").replace(/\/+$/, "");
  const token = env.TFY_PLATFORM_API_KEY || "";
  if (!serviceApi || !token) {
    throw new Error("TFY_SERVICE_API_URL and TFY_PLATFORM_API_KEY are required to install Hermes skills");
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
    const listing = await runCommand("tar", ["-tf", tarPath]);
    for (const entry of listing.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
      if (path.isAbsolute(entry) || entry.split(/[\\/]+/).includes("..")) {
        throw new Error(`skill tar for ${item.fqn} contains unsafe path: ${entry}`);
      }
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await runCommand("tar", ["-xf", tarPath, "-C", dest]);
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
  return home;
}

async function writeHermesObserverPlugin(home) {
  const pluginDir = path.join(home, "plugins", "tfy_slack_observer");
  await mkdir(pluginDir, { recursive: true });
  await writeFile(path.join(pluginDir, "plugin.yaml"), [
    "name: tfy_slack_observer",
    "version: 0.1.0",
    "description: Emits sanitized Hermes observer events back to the TrueFoundry Hermes control API.",
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
_RUN_ID = os.environ.get("HARNESS_RUN_ID") or os.environ.get("RUN_ID")
_CONTROL_API = (os.environ.get("HARNESS_CONTROL_API_URL") or os.environ.get("PUBLIC_BASE_URL") or "").rstrip("/")
_TOKEN = os.environ.get("HARNESS_INTERNAL_TOKEN") or ""


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
    if not (_RUN_ID and _CONTROL_API and _TOKEN):
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
        f"{_CONTROL_API}/api/internal/runs/{_RUN_ID}/events",
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

async function runHermes(prompt, work) {
  const env = { ...process.env };
  const model = work.agent?.model || process.env.HERMES_INFERENCE_MODEL;
  if (process.env.TFY_GATEWAY_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.TFY_GATEWAY_API_KEY;
  if (process.env.TFY_GATEWAY_API_KEY && !env.TFY_API_KEY) env.TFY_API_KEY = process.env.TFY_GATEWAY_API_KEY;
  if (process.env.TFY_GATEWAY_BASE_URL && !env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.TFY_GATEWAY_BASE_URL;
  if (model) env.HERMES_INFERENCE_MODEL = model;
  env.HERMES_YOLO_MODE = "1";
  env.HERMES_ACCEPT_HOOKS = "1";
  const hermesHome = await writeHermesConfig(env, model, work);
  const installedSkills = await installAgentSkills(env, work.agent?.skills);

  const promptPath = path.join(hermesHome, `prompt-${runId}.txt`);
  const wrapperPath = path.join(hermesHome, "tfy_hermes_oneshot.py");
  await writeFile(promptPath, prompt, { mode: 0o600 });
  await writeFile(wrapperPath, String.raw`
import sys

from hermes_cli.config import load_config
from hermes_cli.oneshot import run_oneshot


def _startup():
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
    emitRunEvent("runner_diagnostic", JSON.stringify({
      phase: "start",
      model: model || null,
      promptChars: prompt.length,
      mcpServerCount: Array.isArray(work.agent?.mcpServers) ? work.agent.mcpServers.length : 0,
      toolsets,
      skillCount: Array.isArray(work.agent?.skills) ? work.agent.skills.length : 0,
      installedSkills: installedSkills.map((skill) => skill.name),
      openaiBaseUrlConfigured: Boolean(env.OPENAI_BASE_URL),
      openaiApiKeyConfigured: Boolean(env.OPENAI_API_KEY),
      hermesHomeConfigured: Boolean(hermesHome)
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
