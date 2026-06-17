import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract as tarExtract } from "tar";

const errMsg = (e) => e instanceof Error ? e.message : String(e);
const DEFAULT_MAX_ATTACHMENTS = 10;
const DEFAULT_MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".heic"
]);

function executorWorkspaceRoot(env = process.env) {
  return env.HOME || "/workspace";
}

function executorHermesHome(env = process.env) {
  return env.HERMES_HOME || path.join(executorWorkspaceRoot(env), ".hermes");
}

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

function safeAttachmentFilename(attachment, index) {
  const source = attachment?.artifact_path || attachment?.filename || `attachment-${index + 1}`;
  const base = path.basename(String(source || `attachment-${index + 1}`));
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
  const fallback = `attachment-${index + 1}`;
  const name = cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
  const id = String(attachment?.slack_file_id || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 32);
  return id && !name.startsWith(`${id}-`) ? `${id}-${name}` : name;
}

function isImageAttachment(attachment) {
  const mimeType = String(attachment?.mime_type || "").toLowerCase();
  if (mimeType.startsWith("image/")) return true;
  const name = String(attachment?.local_path || attachment?.filename || attachment?.artifact_path || "");
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function downloadAttachment({ attachment, targetPath, tfyApiKey, maxBytes, fetchImpl = fetch }) {
  if (!attachment?.download_url) throw new Error(`attachment ${attachment?.filename || targetPath} is missing download_url`);
  const headers = tfyApiKey ? { authorization: `Bearer ${tfyApiKey}` } : {};
  const res = await fetchImpl(attachment.download_url, { headers });
  const textForError = async () => {
    try { return (await res.text()).slice(0, 300); } catch { return ""; }
  };
  if (!res.ok) throw new Error(`attachment download failed ${res.status}: ${await textForError()}`);

  const length = Number(res.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error(`attachment exceeds ${maxBytes} byte limit (${length} bytes)`);
  if (!res.body) throw new Error("attachment download response had no body");

  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`attachment exceeds ${maxBytes} byte limit`);
    chunks.push(buffer);
  }
  await writeFile(targetPath, Buffer.concat(chunks), { mode: 0o600 });
  return total;
}

export async function materializeAttachments({
  work,
  workspaceRoot,
  tfyApiKey,
  fetchImpl = fetch,
  maxFiles = DEFAULT_MAX_ATTACHMENTS,
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES
}) {
  const attachments = Array.isArray(work?.attachments) ? work.attachments.filter((item) => item?.download_url) : [];
  if (!attachments.length) return [];
  if (attachments.length > maxFiles) {
    throw new Error(`work payload has ${attachments.length} attachments; maximum is ${maxFiles}`);
  }
  const runId = String(work?.run_id || "run").replace(/[^a-zA-Z0-9_-]/g, "");
  const inboundDir = path.join(workspaceRoot, "inbound", runId || "run");
  await rm(inboundDir, { recursive: true, force: true });
  await mkdir(inboundDir, { recursive: true });

  const materialized = [];
  for (const [index, attachment] of attachments.entries()) {
    const filename = safeAttachmentFilename(attachment, index);
    const localPath = path.join(inboundDir, filename);
    const bytes = await downloadAttachment({
      attachment,
      targetPath: localPath,
      tfyApiKey,
      maxBytes,
      fetchImpl
    });
    materialized.push({
      ...attachment,
      local_path: localPath,
      local_bytes: bytes,
      hermes_input_type: isImageAttachment({ ...attachment, local_path: localPath }) ? "image" : "file"
    });
  }
  return materialized;
}

export function appendMaterializedAttachmentsToPrompt(prompt, attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return String(prompt || "");
  const blocks = attachments.map((attachment) => [
    `- filename: ${attachment.filename || path.basename(attachment.local_path)}`,
    attachment.mime_type ? `  mime_type: ${attachment.mime_type}` : null,
    `  local_path: ${attachment.local_path}`,
    Number.isFinite(Number(attachment.local_bytes)) ? `  local_bytes: ${attachment.local_bytes}` : null,
    attachment.artifact_fqn ? `  artifact_fqn: ${attachment.artifact_fqn}` : null,
    attachment.artifact_path ? `  artifact_path: ${attachment.artifact_path}` : null
  ].filter(Boolean).join("\n"));
  return [
    String(prompt || "").trimEnd(),
    [
      "Downloaded file attachments are available in the executor workspace.",
      "Image attachments are also passed to Hermes as image inputs when supported.",
      "Use the local_path values below when the task refers to an attachment:",
      blocks.join("\n")
    ].join("\n")
  ].filter(Boolean).join("\n\n") + "\n";
}

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
  const workspaceRoot = executorWorkspaceRoot(env);
  env.HOME = workspaceRoot;
  env.HERMES_HOME = executorHermesHome(env);
  env.HERMES_SESSION_ID = ctx.hermesSessionId;
  env.HARNESS_EVENT_URL = `${ctx.callbackBase}${ctx.eventsPath}`;
  env.HARNESS_CALLBACK_TOKEN = ctx.callbackToken;

  const turnTimeoutMs = Number(process.env.HARNESS_TURN_TIMEOUT_MS || 3_600_000);
  const { home: hermesHome, manifestSystemPrompt } = await writeHermesConfig(env, model, work);
  const sessionDownload = await downloadSessionDb(ctx, hermesHome);
  const installedSkills = await installAgentSkills(ctx, env, work.agent?.skills);
  const materializedAttachments = await materializeAttachments({
    work,
    workspaceRoot,
    tfyApiKey: env.TFY_API_KEY
  });
  if (materializedAttachments.length) {
    env.HERMES_ATTACHMENTS_DIR = path.dirname(materializedAttachments[0].local_path);
    await emitRunEvent(ctx, "executor_diagnostic", JSON.stringify({
      phase: "attachments",
      count: materializedAttachments.length,
      files: materializedAttachments.map((item) => ({
        filename: item.filename,
        mime_type: item.mime_type,
        local_path: item.local_path,
        bytes: item.local_bytes
      }))
    }));
  }

  const prompt = appendMaterializedAttachmentsToPrompt(work.content, materializedAttachments);
  const promptPath = path.join(hermesHome, `prompt-${ctx.runId}.txt`);
  const attachmentsPath = path.join(hermesHome, `attachments-${ctx.runId}.json`);
  const wrapperPath = path.join(hermesHome, "tfy_hermes_oneshot.py");
  await writeFile(promptPath, prompt, { mode: 0o600 });
  await writeFile(attachmentsPath, JSON.stringify({
    attachments: materializedAttachments,
    image_paths: materializedAttachments
      .filter((attachment) => attachment.hermes_input_type === "image")
      .map((attachment) => attachment.local_path)
  }), { mode: 0o600 });
  await writeFile(wrapperPath, String.raw`
import json
import logging
import os, sys
from contextlib import redirect_stderr, redirect_stdout
from typing import Optional
from hermes_cli.config import load_config
from hermes_cli.oneshot import run_oneshot

try:
    from hermes_cli.oneshot import _run_agent, _normalize_toolsets, _validate_explicit_toolsets
except Exception:
    _run_agent = None
    _normalize_toolsets = None
    _validate_explicit_toolsets = None

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

def _load_image_paths(attachments_path):
    if not attachments_path:
        return []
    try:
        with open(attachments_path, "r", encoding="utf-8") as handle:
            payload = json.load(handle) or {}
    except Exception:
        return []
    paths = payload.get("image_paths") or []
    return [str(path) for path in paths if path and os.path.isfile(str(path))]

def _run_oneshot_with_images(prompt, image_paths, model: Optional[str] = None, provider: Optional[str] = None, toolsets=None) -> int:
    if not image_paths:
        return run_oneshot(prompt, model=model, provider=provider, toolsets=toolsets)
    if _run_agent is None or _validate_explicit_toolsets is None or _normalize_toolsets is None:
        return run_oneshot(prompt, model=model, provider=provider, toolsets=toolsets)

    logging.disable(logging.CRITICAL)
    env_model_early = os.getenv("HERMES_INFERENCE_MODEL", "").strip()
    if provider and not ((model or "").strip() or env_model_early):
        sys.stderr.write(
            "hermes image oneshot: --provider requires --model (or HERMES_INFERENCE_MODEL).\n"
        )
        return 2

    explicit_toolsets, toolsets_error = _validate_explicit_toolsets(toolsets)
    if toolsets_error:
        sys.stderr.write(toolsets_error)
        return 2
    use_config_toolsets = _normalize_toolsets(toolsets) is None

    os.environ["HERMES_YOLO_MODE"] = "1"
    os.environ["HERMES_ACCEPT_HOOKS"] = "1"
    real_stdout = sys.stdout
    real_stderr = sys.stderr
    devnull = open(os.devnull, "w", encoding="utf-8")
    response = None
    failure = None
    try:
        with redirect_stdout(devnull), redirect_stderr(devnull):
            try:
                from agent.image_routing import build_native_content_parts
                content_parts, skipped = build_native_content_parts(prompt, image_paths)
                has_image_part = any(
                    isinstance(part, dict) and part.get("type") == "image_url"
                    for part in content_parts
                )
                user_message = content_parts if has_image_part else prompt
                response = _run_agent(
                    user_message,
                    model=model,
                    provider=provider,
                    toolsets=explicit_toolsets,
                    use_config_toolsets=use_config_toolsets,
                )
            except BaseException as exc:  # noqa: BLE001
                failure = exc
    finally:
        try:
            devnull.close()
        except Exception:
            pass

    if failure is not None:
        if isinstance(failure, (KeyboardInterrupt, SystemExit)):
            raise failure
        real_stderr.write(f"hermes image oneshot: agent failed: {failure}\n")
        real_stderr.flush()
        return 1
    if not (response or "").strip():
        real_stderr.write("hermes image oneshot: no final response was produced; treating the run as failed.\n")
        real_stderr.flush()
        return 1
    real_stdout.write(response)
    if not response.endswith("\n"):
        real_stdout.write("\n")
    real_stdout.flush()
    return 0

if __name__ == "__main__":
    prompt_path, attachments_path, model, provider, toolsets = sys.argv[1], sys.argv[2], sys.argv[3] or None, sys.argv[4] or None, sys.argv[5] or None
    with open(prompt_path, "r", encoding="utf-8") as handle:
        prompt = handle.read()
    image_paths = _load_image_paths(attachments_path)
    _startup()
    raise SystemExit(_run_oneshot_with_images(prompt, image_paths, model=model, provider=provider, toolsets=toolsets))
	`, { mode: 0o600 });

  const toolsets = mcpToolsetNames(work.agent?.mcpServers);
  const args = [wrapperPath, promptPath, attachmentsPath, model || "", env.OPENAI_BASE_URL ? "custom" : "", toolsets.join(",")];

  emitRunEvent(ctx, "executor_diagnostic", JSON.stringify({
    phase: "start",
    model: model || null,
    promptChars: prompt.length,
    mcpServerCount: Array.isArray(work.agent?.mcpServers) ? work.agent.mcpServers.length : 0,
    toolsets,
    skillCount: Array.isArray(work.agent?.skills) ? work.agent.skills.length : 0,
    installedSkills: installedSkills.map((skill) => skill.name),
    attachmentCount: materializedAttachments.length,
    imageAttachmentCount: materializedAttachments.filter((attachment) => attachment.hermes_input_type === "image").length,
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
  const secrets = [callbackToken].filter(Boolean);
  try {
    const result = await runHermes(ctx, work, secrets);
    try {
      await uploadSessionDb(ctx, executorHermesHome());
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
