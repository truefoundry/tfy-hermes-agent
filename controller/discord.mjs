import { createPublicKey, verify } from "node:crypto";

const PLACEHOLDER_VALUES = new Set(["", "replace-in-truefoundry-only", "pending", "pending-discord-setup"]);

export function configuredDiscordSecret(value) {
  const text = String(value || "").trim();
  return text && !PLACEHOLDER_VALUES.has(text) ? text : "";
}

export function listFromEnv(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function verifyDiscordRequest(req, body, publicKey) {
  const keyHex = configuredDiscordSecret(publicKey);
  if (!keyHex) return false;
  const signature = String(req.headers["x-signature-ed25519"] || "");
  const timestamp = String(req.headers["x-signature-timestamp"] || "");
  if (!signature || !timestamp || !/^[0-9a-f]{64}$/i.test(keyHex)) return false;
  const spki = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    Buffer.from(keyHex, "hex")
  ]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, Buffer.from(`${timestamp}${body}`), key, Buffer.from(signature, "hex"));
}

export function discordAccess(config, interaction) {
  const userId = interaction?.member?.user?.id || interaction?.user?.id || "";
  const roleIds = interaction?.member?.roles || [];
  const channelId = interaction?.channel_id || "";
  if (config.allowedUsers.length && !config.allowedUsers.includes(userId)) {
    return { allowed: false, reason: "user_not_allowed" };
  }
  if (config.allowedRoles.length && !roleIds.some((role) => config.allowedRoles.includes(role))) {
    return { allowed: false, reason: "role_not_allowed" };
  }
  if (config.freeResponseChannels.length && channelId && !config.freeResponseChannels.includes(channelId)) {
    return { allowed: false, reason: "channel_not_allowed" };
  }
  return { allowed: true, reason: null };
}

export function extractDiscordPrompt(interaction) {
  const data = interaction?.data || {};
  const options = Array.isArray(data.options) ? data.options : [];
  const requestOption = options.find((item) => ["prompt", "request", "message", "text"].includes(String(item.name || "").toLowerCase()));
  const optionText = requestOption?.value == null ? "" : String(requestOption.value);
  const content = String(data.content || interaction?.content || optionText || "").trim();
  const user = interaction?.member?.user || interaction?.user || {};
  return {
    content,
    commandName: data.name || "",
    userId: user.id || "",
    username: user.username || "",
    channelId: interaction?.channel_id || "",
    guildId: interaction?.guild_id || "",
    token: interaction?.token || "",
    applicationId: interaction?.application_id || ""
  };
}

export function discordPrompt({ request, agent }) {
  return [
    `Selected Hermes agent: @${agent?.handle || "hermes"} (${agent?.name || agent?.id || "agent"})`,
    "Discord context:",
    `User: ${request.userId || "(unknown)"}${request.username ? ` (${request.username})` : ""}`,
    `Guild: ${request.guildId || "(dm)"}`,
    `Channel: ${request.channelId || "(unknown)"}`,
    `Command: ${request.commandName || "(interaction)"}`,
    "",
    "Message text:",
    request.content || "(none)"
  ].join("\n");
}

export function discordCommandDefinition({ name = "hermes", description = "Ask this Hermes agent" } = {}) {
  const commandName = String(name || "hermes")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "hermes";
  return {
    name: commandName,
    description: String(description || "Ask this Hermes agent").slice(0, 100),
    type: 1,
    options: [{
      type: 3,
      name: "prompt",
      description: "What should Hermes do?",
      required: true
    }]
  };
}

export async function postDiscordFollowup({ applicationId, token, content, fetchImpl = fetch }) {
  if (!applicationId || !token) throw new Error("Discord application id and interaction token are required");
  const safeContent = String(content || "").slice(0, 1900) || "Hermes finished, but returned no text.";
  const res = await fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: safeContent })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Discord followup failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}
