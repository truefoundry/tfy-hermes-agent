import { createHmac, timingSafeEqual } from "node:crypto";

export const slackScopes = [
  "app_mentions:read",
  "channels:history",
  "channels:join",
  "channels:read",
  "chat:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "mpim:history",
  "mpim:read",
  "team:read",
  "users:read"
];

export function parseSlackConfig(env = process.env) {
  const handles = parseStringList(env.SLACK_HANDLES);
  return {
    enabled: env.SLACK_ENABLED === "true",
    appName: env.SLACK_APP_NAME || "Hermes Agent",
    botToken: env.SLACK_BOT_TOKEN || "",
    signingSecret: env.SLACK_SIGNING_SECRET || "",
    botUserId: env.SLACK_BOT_USER_ID || "",
    teamId: env.SLACK_TEAM_ID || "",
    teamName: env.SLACK_TEAM_NAME || "",
    handles: handles.length ? handles.map(normalizeSlackHandle).filter(Boolean) : ["hermes"],
    channelIds: parseStringList(env.SLACK_CHANNEL_IDS).map((value) => value.toUpperCase()),
    responseMode: env.SLACK_RESPONSE_MODE === "all-channel" ? "all-channel" : "mentions",
    allowUnverifiedEvents: env.SLACK_ALLOW_UNVERIFIED_EVENTS === "true"
  };
}

export function normalizeSlackAgentConfig(input = {}) {
  const handles = parseStringList(input.handles).map(normalizeSlackHandle).filter(Boolean);
  return {
    handles: handles.length ? [...new Set(handles)] : ["hermes"],
    channelIds: [...new Set(parseStringList(input.channelIds ?? input.channel_ids).map((value) => value.toUpperCase()))],
    responseMode: input.responseMode === "all-channel" || input.response_mode === "all-channel" ? "all-channel" : "mentions"
  };
}

export function ensureSlackState(state) {
  state.slack ||= {};
  if (!state.slack.threadSessions || typeof state.slack.threadSessions !== "object") state.slack.threadSessions = {};
  if (!Array.isArray(state.slack.eventIds)) state.slack.eventIds = [];
  state.slack.eventIds = state.slack.eventIds.slice(-200);
  return state.slack;
}

export function slackStatus(config, publicBaseUrl = "") {
  const base = normalizePublicBaseUrl(publicBaseUrl);
  return {
    enabled: config.enabled,
    connected: Boolean(config.botToken),
    signingConfigured: Boolean(config.signingSecret),
    teamId: config.teamId,
    teamName: config.teamName,
    botUserId: config.botUserId,
    appName: config.appName,
    handles: config.handles,
    channelIds: config.channelIds,
    responseMode: config.responseMode,
    requestUrl: base ? `${base}/slack/events` : "/slack/events",
    manifestUrl: base ? `${base}/api/slack/manifest` : "/api/slack/manifest",
    scopes: slackScopes
  };
}

export function slackManifest(config, publicBaseUrl = "") {
  const base = normalizePublicBaseUrl(publicBaseUrl);
  return {
    display_information: {
      name: config.appName || "Hermes Agent",
      description: "Routes Slack messages to a Hermes assistant",
      background_color: "#1d1c1d"
    },
    features: {
      app_home: {
        home_tab_enabled: false,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false
      },
      bot_user: {
        display_name: config.appName || "Hermes Agent",
        always_online: false
      }
    },
    oauth_config: {
      scopes: { bot: slackScopes }
    },
    settings: {
      event_subscriptions: {
        request_url: base ? `${base}/slack/events` : "",
        bot_events: ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim"]
      },
      interactivity: {
        is_enabled: false
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false
    }
  };
}

export function verifySlackSignature(headers, rawBody, signingSecret, allowUnverifiedEvents = false) {
  if (!signingSecret) return allowUnverifiedEvents;
  const timestamp = headers["x-slack-request-timestamp"];
  const signature = headers["x-slack-signature"];
  if (!timestamp || !signature) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(String(signature));
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function createSlackBridge({
  config,
  loadState,
  saveState,
  send,
  sendText,
  defaultAgentId,
  now,
  id,
  enqueueSessionMessage,
  waitForRun,
  publicBaseUrl
}) {
  async function status(req, res) {
    return send(res, 200, slackStatus(config, publicBaseUrl(req)));
  }

  async function manifest(req, res) {
    return send(res, 200, slackManifest(config, publicBaseUrl(req)));
  }

  async function events(req, res) {
    if (!config.enabled) return sendText(res, 404, "slack bridge disabled");

    const raw = await readRawBody(req);
    if (!verifySlackSignature(req.headers, raw, config.signingSecret, config.allowUnverifiedEvents)) {
      return sendText(res, 401, "invalid slack signature");
    }

    let payload;
    try {
      payload = JSON.parse(raw || "{}");
    } catch {
      return sendText(res, 400, "invalid slack payload");
    }

    if (payload.type === "url_verification") {
      return sendText(res, 200, payload.challenge || "", "text/plain; charset=utf-8");
    }

    const state = await loadState();
    ensureSlackState(state);
    if (payload.event_id && state.slack.eventIds.includes(payload.event_id)) {
      return sendText(res, 200, "ok");
    }
    if (payload.event_id) {
      state.slack.eventIds = [...state.slack.eventIds, payload.event_id].slice(-200);
      await saveState(state);
    }

    sendText(res, 200, "ok");
    processEvent(payload).catch((error) => {
      console.error("slack event failed", error);
    });
  }

  async function processEvent(payload) {
    if (payload.type !== "event_callback") return;
    const event = payload.event || {};
    if (!["app_mention", "message"].includes(event.type)) return;
    if (event.subtype || event.bot_id) return;
    if (isSelfMessage(payload, event, config.botUserId)) return;

    const teamId = payload.team_id || event.team || config.teamId || "";
    const agent = await resolveAgent(event);
    if (!agent) return;

    const agentSlack = normalizeSlackAgentConfig(agent.slack || config);
    const cleanText = cleanSlackText(event, config.botUserId, agentSlack.handles);
    if (!cleanText) return;

    const threadTs = event.thread_ts || event.ts || "";
    const sessionId = await resolveThreadSession({
      key: slackThreadKey({ ...event, team: teamId }, agent.id),
      agentId: agent.id,
      title: `Slack ${event.channel || "thread"}`,
      source: {
        type: "slack",
        teamId,
        channelId: event.channel || "",
        threadTs
      }
    });

    const run = await enqueueSessionMessage(sessionId, cleanText, {
      type: "slack",
      teamId,
      channelId: event.channel || "",
      threadTs,
      userId: event.user || ""
    });
    const completed = await waitForRun(run.id);
    const text = slackReplyText(completed);
    await slackApi("chat.postMessage", {
      channel: event.channel,
      thread_ts: threadTs,
      text
    });
  }

  async function resolveAgent(event) {
    const state = await loadState();
    const agents = Object.values(state.agents || {});
    const candidates = agents.length ? agents : [{ id: defaultAgentId, slack: config }];
    const text = String(event.text || "").toLowerCase();
    const channel = String(event.channel || "").toUpperCase();

    for (const agent of candidates) {
      const slack = normalizeSlackAgentConfig(agent.slack || config);
      for (const handle of slack.handles) {
        const escaped = escapeRegExp(handle);
        if (new RegExp(`(^|\\s)@${escaped}(\\b|\\s|$)`, "i").test(text)) return agent;
      }
    }

    const channelMatches = candidates.filter((agent) => {
      const slack = normalizeSlackAgentConfig(agent.slack || config);
      return slack.channelIds.includes(channel);
    });
    const allChannel = channelMatches.find((agent) => normalizeSlackAgentConfig(agent.slack || config).responseMode === "all-channel");
    if (allChannel) return allChannel;
    if (event.type === "message" && (event.channel_type === "im" || channel.startsWith("D"))) {
      return candidates.find((agent) => agent.id === defaultAgentId) || candidates[0] || null;
    }
    if (event.type === "app_mention") return channelMatches[0] || candidates.find((agent) => agent.id === defaultAgentId) || candidates[0] || null;
    return null;
  }

  async function resolveThreadSession({ key, agentId, title, source }) {
    const state = await loadState();
    ensureSlackState(state);
    const existing = state.slack.threadSessions[key];
    if (existing && state.sessions?.[existing]) return existing;

    const sessionId = id("ses");
    state.sessions ||= {};
    state.sessions[sessionId] = {
      id: sessionId,
      agentId,
      userId: `slack:${source.teamId}:${source.channelId}:${source.threadTs}`,
      title,
      source,
      messages: [],
      createdAt: now(),
      updatedAt: now()
    };
    state.slack.threadSessions[key] = sessionId;
    await saveState(state);
    return sessionId;
  }

  async function slackApi(method, body) {
    if (!config.botToken) throw new Error("Slack bot token is not configured.");
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${config.botToken}`
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(`Slack ${method} failed: ${payload.error || response.statusText}`);
    }
    return payload;
  }

  return { status, manifest, events, processEvent };
}

function parseStringList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (!value) return [];
  const raw = String(value).trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
  } catch {
    // Fall through to comma-separated parsing.
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeSlackHandle(value) {
  return String(value || "")
    .trim()
    .replace(/^[@!]+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function normalizePublicBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function slackThreadKey(event, agentId) {
  return [event.team || "", event.channel || "", event.thread_ts || event.ts || "", agentId].join(":");
}

function isSelfMessage(payload, event, botUserId) {
  const selfIds = [
    botUserId,
    payload.authorizations?.[0]?.user_id,
    payload.authed_users?.[0]
  ].filter(Boolean);
  return selfIds.includes(event.user);
}

function cleanSlackText(event, botUserId, handles) {
  let text = String(event.text || "");
  if (botUserId) text = text.replace(new RegExp(`<@${escapeRegExp(botUserId)}>`, "g"), "");
  if (event.type === "app_mention") text = text.replace(/^<@[A-Z0-9]+>\s*/i, "");
  for (const handle of handles || []) {
    text = text.replace(new RegExp(`(^|\\s)@${escapeRegExp(handle)}(\\b|\\s|$)`, "ig"), " ");
  }
  return text.replace(/\s+/g, " ").trim();
}

function slackReplyText(completed) {
  if (completed?.run?.status === "failed") {
    return `Hermes failed: ${String(completed.run.error || "run failed").slice(0, 3400)}`;
  }
  return String(completed?.run?.result || completed?.result || "Done.").slice(0, 3500);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
