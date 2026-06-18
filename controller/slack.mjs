// Slack Web API helpers, Slack Events HMAC verification, message/stream
// formatters, agent access guards, and Hermes-observer → Slack progress
// translation. The controller imports this module and calls into it; this
// file owns no state of its own beyond the configured token+secret.

import { createHmac, timingSafeEqual } from "node:crypto";

export function listFromEnv(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function handleFromString(value) {
  const handle = String(value || "")
    .trim()
    .replace(/^[@#/]+/, "")
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(handle)) {
    throw new Error("agent handle must be 2-32 chars and use lowercase letters, numbers, underscores, or hyphens");
  }
  return handle;
}

export function normalizeSlackChannelIds(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean)));
}

export function normalizeSlackUserIds(values) {
  return normalizeSlackChannelIds(values);
}

export function slackChannelAccess(agent, channel) {
  const allowed = normalizeSlackChannelIds(agent?.slackAllowedChannelIds || []);
  if (!allowed.length) return { allowed: true, reason: null };
  return {
    allowed: allowed.includes(String(channel || "").toUpperCase()),
    reason: "access_policy"
  };
}

export function agentCanRespondToSlackUser(agent, userId) {
  const allowed = normalizeSlackUserIds(agent?.slackAllowedUserIds || []);
  if (!allowed.length) return true;
  return allowed.includes(String(userId || "").toUpperCase());
}

export function agentLabel(agent, fallbackHandle = "hermes") {
  return `@${agent?.handle || fallbackHandle}`;
}

export function cleanSlackText(text) {
  return String(text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<!subteam\^[^>]+>/g, "")
    .trim();
}

export function parseMessageHandle(text) {
  const cleaned = cleanSlackText(text);
  const match = cleaned.match(/^(?:agent:|use\s+)?[@#/]([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?:\s+|$)([\s\S]*)$/);
  if (!match) return { handle: null, text: cleaned };
  return { handle: handleFromString(match[1]), text: match[2].trim() };
}

export function slackTitle(text, attachments = []) {
  const cleaned = cleanSlackText(text).replace(/\s+/g, " ").trim();
  if (cleaned) return cleaned.slice(0, 80);
  const first = attachments?.[0]?.filename;
  return first ? `File: ${first}`.slice(0, 80) : "Hermes conversation";
}

export function chunkText(text, size = 3500) {
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

const SLACK_TASK_TEXT_LIMIT = 256;

export const SLACK_PLAN_TASKS = Object.freeze({
  request: "hermes_request",
  attachments: "hermes_attachments",
  executor: "hermes_executor",
  model: "hermes_model",
  activity: "hermes_activity",
  response: "hermes_response"
});

function truncateTaskText(value, limit = SLACK_TASK_TEXT_LIMIT) {
  const text = String(value || "").replace(/\s+\n/g, "\n").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

export function slackTaskDetails(lines) {
  return truncateTaskText(lines.filter(Boolean).join("\n"));
}

export function slackPlanUpdate(title) {
  return {
    type: "plan_update",
    title: truncateTaskText(title)
  };
}

export function slackTaskUpdate({ id, title, status, details = null, output = null, sources = null }) {
  const chunk = {
    type: "task_update",
    id,
    title: truncateTaskText(title),
    status
  };
  if (details) chunk.details = Array.isArray(details) ? slackTaskDetails(details) : truncateTaskText(details);
  if (output) chunk.output = truncateTaskText(output);
  if (Array.isArray(sources) && sources.length) chunk.sources = sources;
  return chunk;
}

export function slackInitialPlanChunks({ agent, fallbackHandle, hasAttachments = false }) {
  return [
    slackPlanUpdate(`Run ${agentLabel(agent, fallbackHandle)}`),
    slackTaskUpdate({
      id: SLACK_PLAN_TASKS.request,
      title: "Understand request",
      status: "in_progress",
      details: "Reading the Slack message"
    }),
    hasAttachments ? slackTaskUpdate({
      id: SLACK_PLAN_TASKS.attachments,
      title: "Prepare attachments",
      status: "pending",
      details: "Waiting to download files"
    }) : null,
    slackTaskUpdate({
      id: SLACK_PLAN_TASKS.executor,
      title: "Start executor",
      status: "pending",
      details: "Waiting to queue Hermes"
    }),
    slackTaskUpdate({
      id: SLACK_PLAN_TASKS.model,
      title: "Think with model",
      status: "pending"
    }),
    slackTaskUpdate({
      id: SLACK_PLAN_TASKS.activity,
      title: "Executor activity",
      status: "pending"
    }),
    slackTaskUpdate({
      id: SLACK_PLAN_TASKS.response,
      title: "Write response",
      status: "pending"
    })
  ].filter(Boolean);
}

export function slackMessageClaimKey({ teamId, channel, ts, userId }) {
  return [teamId || "unknown-team", channel, ts, userId || "unknown-user"].join(":");
}

export function slackMessageEventAllowed(event) {
  if (!event || event.bot_id || !event.channel || !event.user) return false;
  if (!event.subtype) return true;
  return event.subtype === "file_share";
}

export function normalizeSlackFiles(files) {
  return (files || []).map((file) => {
    const record = file || {};
    const filename = String(record.name || record.filename || record.title || "file").trim() || "file";
    const mimeType = String(record.mimetype || record.mime_type || "application/octet-stream").trim();
    const filetype = String(record.filetype || "").trim() || null;
    const size = Number(record.size || 0) || 0;
    const id = String(record.id || "").trim() || null;
    const urlPrivateDownload = String(record.url_private_download || record.url_private || "").trim() || null;
    return {
      id,
      filename,
      mime_type: mimeType,
      filetype,
      size,
      url_private_download: urlPrivateDownload
    };
  }).filter((file) => file.id || file.url_private_download);
}

function formatAttachmentBlock(attachment) {
  const lines = [
    `- filename: ${attachment.filename}`,
    `  mime_type: ${attachment.mime_type}`,
    attachment.filetype ? `  filetype: ${attachment.filetype}` : null,
    `  size: ${attachment.size}`,
    attachment.slack_file_id ? `  slack_file_id: ${attachment.slack_file_id}` : null,
    attachment.artifact_fqn ? `  artifact_fqn: ${attachment.artifact_fqn}` : null,
    attachment.artifact_path ? `  artifact_path: ${attachment.artifact_path}` : null,
    attachment.download_url ? `  download_url: ${attachment.download_url}` : null,
    attachment.download_url ? "  download_url_auth: signed URL; do not add Authorization header" : null
  ].filter(Boolean);
  return lines.join("\n");
}

export function slackPrompt({
  text,
  slack = null,
  attachments = [],
  context,
  agent,
  fallbackHandle
}) {
  const lines = [];
  if (agent?.handle) lines.push(`Selected Hermes agent: ${agentLabel(agent, fallbackHandle)} (${agent.name || agent.id})`);
  if (context?.channel_id) lines.push(`Active Slack channel: ${context.channel_id}`);
  if (context?.team_id) lines.push(`Slack team: ${context.team_id}`);
  if (slack?.user_id) lines.push(`Slack user: ${slack.user_id}`);
  if (slack?.thread_ts) lines.push(`Slack thread: ${slack.thread_ts}`);
  if (slack?.message_ts) lines.push(`Slack message: ${slack.message_ts}`);

  const messageText = String(text ?? slack?.text ?? "").trim();
  const blocks = [];
  if (lines.length) blocks.push(`Slack context:\n${lines.join("\n")}`);
  blocks.push(`Message text:\n${messageText || "(none)"}`);
  if (attachments.length) {
    blocks.push([
      "File attachments (uploaded to TrueFoundry Artifacts):",
      attachments.map((attachment) => formatAttachmentBlock(attachment)).join("\n")
    ].join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

export function slackFeedbackBlocks(runId) {
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
    if (/(token|secret|password|passwd|api[_-]?key|authorization|cookie|credential|private)/i.test(key)) {
      return `${key}: [redacted]`;
    }
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

function statusIsError(status) {
  return /^(?:error|failed|failure)$/i.test(String(status || ""));
}

function slug(value, fallback) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

function rememberActive(state, key, id) {
  const list = state.activeByName.get(key) || [];
  list.push(id);
  state.activeByName.set(key, list);
}

function takeActive(state, key, fallbackId) {
  const list = state.activeByName.get(key) || [];
  const id = list.shift() || fallbackId;
  if (list.length) state.activeByName.set(key, list);
  else state.activeByName.delete(key);
  return id;
}

export function createSlackProgressState() {
  return {
    activityStarted: false,
    toolSeq: 0,
    subagentSeq: 0,
    activeByName: new Map()
  };
}

export function observerProgressChunks(payload, state = createSlackProgressState()) {
  if (!payload || typeof payload !== "object") return [];
  const chunks = [];
  const startActivity = () => {
    if (state.activityStarted) return;
    state.activityStarted = true;
    chunks.push(slackTaskUpdate({
      id: SLACK_PLAN_TASKS.activity,
      title: "Executor activity",
      status: "in_progress",
      details: "Hermes executor is active"
    }));
  };
  const duration = Number.isFinite(Number(payload.duration_ms))
    ? `Completed in ${formatDurationMs(Number(payload.duration_ms))}`
    : "";

  switch (payload.kind) {
    case "model_request_start":
      chunks.push(slackTaskUpdate({
        id: SLACK_PLAN_TASKS.model,
        title: "Think with model",
        status: "in_progress",
        details: payload.model ? `Using ${payload.model}` : "Model request started"
      }));
      return chunks;
    case "model_request_complete": {
      const tools = Number(payload.assistant_tool_call_count || 0);
      chunks.push(slackTaskUpdate({
        id: SLACK_PLAN_TASKS.model,
        title: "Think with model",
        status: "complete",
        details: tools
          ? `Planned ${tools} tool call${tools === 1 ? "" : "s"}`
          : duration || "Model response received"
      }));
      return chunks;
    }
    case "model_request_error":
      chunks.push(slackTaskUpdate({
        id: SLACK_PLAN_TASKS.model,
        title: "Think with model",
        status: "error",
        details: payload.error_message || payload.reason || "Model request failed"
      }));
      return chunks;
    case "tool_start": {
      startActivity();
      const name = payload.tool_name || "tool";
      const id = `hermes_tool_${++state.toolSeq}_${slug(name, "tool")}`;
      rememberActive(state, `tool:${name}`, id);
      chunks.push(slackTaskUpdate({
        id,
        title: `Call ${name}`,
        status: "in_progress",
        details: formatToolArgs(payload.args).replace(/^\s*[()]+|\)+$/g, "") || "Tool call started"
      }));
      return chunks;
    }
    case "tool_complete": {
      startActivity();
      const name = payload.tool_name || "tool";
      const fallbackId = `hermes_tool_${++state.toolSeq}_${slug(name, "tool")}`;
      const id = takeActive(state, `tool:${name}`, fallbackId);
      const error = payload.error_message ? `Failed: ${payload.error_message}` : "";
      chunks.push(slackTaskUpdate({
        id,
        title: `Call ${name}`,
        status: statusIsError(payload.status) || payload.error_message ? "error" : "complete",
        details: error || duration || "Tool finished"
      }));
      return chunks;
    }
    case "subagent_start": {
      startActivity();
      const name = payload.child_role || "subagent";
      const id = `hermes_subagent_${++state.subagentSeq}_${slug(name, "subagent")}`;
      rememberActive(state, `subagent:${name}`, id);
      chunks.push(slackTaskUpdate({
        id,
        title: `Run ${name}`,
        status: "in_progress",
        details: payload.child_goal || "Subagent started"
      }));
      return chunks;
    }
    case "subagent_stop": {
      startActivity();
      const name = payload.child_role || "subagent";
      const fallbackId = `hermes_subagent_${++state.subagentSeq}_${slug(name, "subagent")}`;
      const id = takeActive(state, `subagent:${name}`, fallbackId);
      chunks.push(slackTaskUpdate({
        id,
        title: `Run ${name}`,
        status: statusIsError(payload.status) ? "error" : "complete",
        details: duration || payload.child_summary || "Subagent finished"
      }));
      return chunks;
    }
    default:
      return chunks;
  }
}

export function formatObserverProgress(payload) {
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
// Slack Web API client
// ---------------------------------------------------------------------------

export function createSlackClient({ botToken, signingSecret, statusText, loadingMessages }) {
  function verifyRequest(req, body) {
    if (!signingSecret) return false;
    const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
    const signature = String(req.headers["x-slack-signature"] || "");
    if (!timestamp || !signature) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;
    const expected = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${timestamp}:${body}`)
      .digest("hex")}`;
    const eb = Buffer.from(expected);
    const sb = Buffer.from(signature);
    return eb.length === sb.length && timingSafeEqual(eb, sb);
  }

  async function api(method, body) {
    if (!botToken) throw new Error("Slack bot token is required for Slack integration");
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
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

  const md = (text) => ({ type: "markdown_text", text });

  function setStatus({ channel, threadTs, status = statusText }) {
    return api("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status,
      loading_messages: loadingMessages
    });
  }

  function clearStatus({ channel, threadTs }) {
    return api("assistant.threads.setStatus", {
      channel_id: channel,
      thread_ts: threadTs,
      status: ""
    });
  }

  function startStream({ channel, threadTs, teamId, userId, agent, fallbackHandle, hasAttachments = false }) {
    return api("chat.startStream", {
      channel,
      thread_ts: threadTs,
      recipient_team_id: teamId,
      recipient_user_id: userId,
      task_display_mode: "plan",
      chunks: slackInitialPlanChunks({ agent, fallbackHandle, hasAttachments })
    });
  }

  function appendStream({ channel, ts, markdownText = "", chunks = null }) {
    const body = { channel, ts };
    const allChunks = [];
    if (markdownText) allChunks.push(md(markdownText));
    if (chunks) allChunks.push(...chunks);
    if (allChunks.length) body.chunks = allChunks;
    return api("chat.appendStream", body);
  }

  function stopStream({ channel, ts, markdownText = "", chunks = null, blocks = [] }) {
    const body = { channel, ts };
    const allChunks = [];
    if (markdownText) allChunks.push(md(markdownText));
    if (chunks) allChunks.push(...chunks);
    if (allChunks.length) body.chunks = allChunks;
    if (blocks.length) body.blocks = blocks;
    return api("chat.stopStream", body);
  }

  function postMessage({ channel, threadTs, text, blocks = null }) {
    const body = { channel, thread_ts: threadTs, text };
    if (blocks) body.blocks = blocks;
    return api("chat.postMessage", body);
  }

  return {
    hasBotToken: Boolean(botToken),
    verifyRequest,
    api,
    setStatus,
    clearStatus,
    startStream,
    appendStream,
    stopStream,
    postMessage
  };
}
