const runId = process.env.HARNESS_RUN_ID || process.env.RUN_ID;
const controlApi = (process.env.HARNESS_CONTROL_API_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

if (!runId || !controlApi) {
  console.error("HARNESS_RUN_ID and HARNESS_CONTROL_API_URL are required");
  process.exit(2);
}

async function getJson(apiPath) {
  const res = await fetch(`${controlApi}${apiPath}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function postJson(apiPath, body) {
  const res = await fetch(`${controlApi}${apiPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function buildPrompt(work) {
  const memory = work.memory ? `Conversation so far:\n${work.memory}\n\n` : "";
  const skills = Array.isArray(work.agent?.skills) && work.agent.skills.length
    ? `Allowed skills: ${work.agent.skills.join(", ")}\n`
    : "";
  const mcp = Array.isArray(work.agent?.mcpServers) && work.agent.mcpServers.length
    ? `Allowed MCP servers: ${work.agent.mcpServers.join(", ")}\n`
    : "";
  return `${skills}${mcp}${memory}User: ${work.content}`;
}

function buildMessages(work) {
  const system = [
    "You are Hermes, a TrueFoundry-hosted assistant.",
    "All model calls must go through the configured TrueFoundry LLM Gateway.",
    Array.isArray(work.agent?.skills) && work.agent.skills.length
      ? `Allowed skills: ${work.agent.skills.join(", ")}.`
      : "No skills are enabled for this assistant.",
    Array.isArray(work.agent?.mcpServers) && work.agent.mcpServers.length
      ? "Use only the MCP Gateway servers configured for this assistant."
      : "No MCP servers are enabled for this assistant."
  ].join("\n");
  const history = Array.isArray(work.session?.messages)
    ? work.session.messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content || "")
    }))
    : [{ role: "user", content: buildPrompt(work) }];
  return [{ role: "system", content: system }, ...history];
}

function gatewayChatUrl(baseUrl) {
  const clean = baseUrl.replace(/\/+$/, "");
  return clean.endsWith("/v1") ? `${clean}/chat/completions` : `${clean}/v1/chat/completions`;
}

function resolveMcpServers(work, gatewayBaseUrl, gatewayApiKey) {
  const cleanBase = gatewayBaseUrl.replace(/\/+$/, "");
  return (work.agent?.mcpServers || []).map((entry) => {
    let url = String(entry);
    if (url.startsWith("${gateway_base_url}/")) {
      url = `${cleanBase}/${url.slice("${gateway_base_url}/".length)}`;
    } else if (url.startsWith("/")) {
      url = `${cleanBase}${url}`;
    }
    return {
      type: "mcp-server-url",
      url,
      headers: {
        Authorization: `Bearer ${gatewayApiKey}`
      },
      enable_all_tools: true
    };
  });
}

function extractGatewayText(body) {
  const message = body?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
      .join("")
      .trim();
  }
  if (typeof body?.output_text === "string") return body.output_text;
  if (typeof body?.content === "string") return body.content;
  return "";
}

async function runGatewayChat(work) {
  const model = work.agent?.model || process.env.HERMES_INFERENCE_MODEL;
  const gatewayBaseUrl = process.env.TFY_GATEWAY_BASE_URL || process.env.TFY_BASE_URL || "";
  const gatewayApiKey = process.env.TFY_GATEWAY_API_KEY || process.env.TFY_API_KEY || "";
  if (!gatewayBaseUrl || !gatewayApiKey) {
    throw new Error("TFY_GATEWAY_BASE_URL and TFY_GATEWAY_API_KEY are required");
  }
  const payload = {
    model,
    messages: buildMessages(work),
    stream: false,
    iteration_limit: 6
  };
  const mcpServers = resolveMcpServers(work, gatewayBaseUrl, gatewayApiKey);
  if (mcpServers.length) payload.mcp_servers = mcpServers;

  const res = await fetch(gatewayChatUrl(gatewayBaseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${gatewayApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM Gateway chat failed ${res.status}: ${text.slice(0, 1000)}`);
  const body = text ? JSON.parse(text) : {};
  const result = extractGatewayText(body).trim();
  if (!result) throw new Error(`LLM Gateway returned an empty response: ${text.slice(0, 1000)}`);
  return result;
}

try {
  const work = await getJson(`/api/internal/runs/${encodeURIComponent(runId)}/work-item`);
  const result = await runGatewayChat(work);
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
