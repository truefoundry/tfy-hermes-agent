// Dispatch work to the private Hermes Runtime Service.

export function buildWorkPayload({
  run,
  agent,
  content,
  slack = null,
  attachments = [],
  publicBaseUrl,
  hermesModel
}) {
  return {
    run_id: run.id,
    hermes_session_id: run.hermes_session_id,
    content,
    slack,
    attachments,
    agent: {
      id: agent.id,
      handle: agent.handle,
      name: agent.name,
      description: agent.description || "",
      instructions: agent.instructions || "",
      model: agent.model || hermesModel,
      skills: agent.skills || [],
      mcpServers: agent.mcpServers || []
    },
    callback_url: publicBaseUrl,
    controller_event_url: `${publicBaseUrl}/api/internal/runs/${run.id}/events`
  };
}

export async function triggerHermesRuntime({
  runtimeUrl,
  run,
  work,
  callbackToken,
  fetchImpl = fetch
}) {
  if (!runtimeUrl) throw new Error("HERMES_RUNTIME_URL is required for hermes-runtime backend");
  const base = runtimeUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/api/internal/runs/${encodeURIComponent(run.id)}/dispatch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${callbackToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ work })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`runtime dispatch failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : { accepted: true, backend: "hermes-runtime" };
}

export async function dispatchExecutorTurn(ctx) {
  const { backend = "hermes-runtime" } = ctx;
  if (backend !== "hermes-runtime") {
    throw new Error(`unsupported dispatch backend: ${backend}`);
  }
  return triggerHermesRuntime(ctx);
}
