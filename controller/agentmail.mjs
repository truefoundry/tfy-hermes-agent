import { createHmac, timingSafeEqual } from "node:crypto";

const PLACEHOLDER_VALUES = new Set([
  "",
  "replace-in-truefoundry-only",
  "pending",
  "pending-agentmail-setup"
]);

export function configuredSecret(value) {
  const text = String(value || "").trim();
  return text && !PLACEHOLDER_VALUES.has(text) ? text : "";
}

export function normalizeAgentEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function header(req, name) {
  return String(req.headers[name.toLowerCase()] || "");
}

export function verifyAgentMailWebhook(req, body, secret) {
  const signingSecret = configuredSecret(secret);
  if (!signingSecret) return false;
  const id = header(req, "svix-id");
  const timestamp = header(req, "svix-timestamp");
  const signatureHeader = header(req, "svix-signature");
  if (!id || !timestamp || !signatureHeader) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) return false;

  const secretPart = signingSecret.startsWith("whsec_") ? signingSecret.slice("whsec_".length) : signingSecret;
  const key = Buffer.from(secretPart, "base64");
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");

  return signatureHeader.split(/\s+/).some((entry) => {
    const [, value] = entry.split(",", 2);
    if (!value) return false;
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(value);
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  });
}

function first(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function extractAgentMailMessage(payload) {
  const eventType = payload?.event_type || payload?.eventType || payload?.type || "";
  const data = payload?.data || payload?.message || payload?.event?.message || payload?.event || payload || {};
  const message = data.message || data;
  const inbox = data.inbox || payload?.inbox || {};
  const inboxId = message.inbox_id || message.inboxId || inbox.inbox_id || inbox.inboxId || "";
  const inboxEmail = normalizeAgentEmail(message.inbox_email || message.inboxEmail || inbox.email || first(message.to) || "");
  const messageId = message.message_id || message.messageId || "";
  const threadId = message.thread_id || message.threadId || messageId;
  const from = String(message.from || "").trim();
  const subject = String(message.subject || "").trim();
  const text = String(message.extracted_text || message.text || message.preview || "").trim();
  const html = String(message.extracted_html || message.html || "").trim();
  const eventId = payload?.event_id || payload?.eventId || payload?.id || messageId;
  return {
    eventType,
    eventId,
    inboxId,
    inboxEmail,
    messageId,
    threadId,
    from,
    to: Array.isArray(message.to) ? message.to : [],
    cc: Array.isArray(message.cc) ? message.cc : [],
    subject,
    text,
    html,
    raw: payload
  };
}

export function agentMailPrompt({ message, agent }) {
  return [
    `Selected Hermes agent: @${agent?.handle || "hermes"} (${agent?.name || agent?.id || "agent"})`,
    "Email context:",
    `Inbox: ${message.inboxEmail || message.inboxId || "(unknown)"}`,
    `From: ${message.from || "(unknown)"}`,
    `Subject: ${message.subject || "(no subject)"}`,
    `Thread: ${message.threadId || "(unknown)"}`,
    `Message: ${message.messageId || "(unknown)"}`,
    "",
    "Message text:",
    message.text || message.html || "(empty)"
  ].join("\n");
}

export async function agentMailApi({ apiKey, path, method = "POST", body = null, fetchImpl = fetch }) {
  const token = configuredSecret(apiKey);
  if (!token) throw new Error("AgentMail API key is not configured");
  const res = await fetchImpl(`https://api.agentmail.to/v0${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const payload = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`AgentMail ${method} ${path} failed ${res.status}: ${text.slice(0, 500)}`);
  return payload;
}

export function replyAllPath({ inboxId, messageId }) {
  return `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}/reply-all`;
}
