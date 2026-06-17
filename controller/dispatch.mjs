// Executor dispatch: truefoundry-job or truefoundry-service.

import { shellQuote } from "./util.mjs";

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

function executorShellCommand({ callbackUrl, runId, callbackToken, extraEnv = {} }) {
  const envPairs = [
    `HARNESS_CALLBACK_TOKEN=${shellQuote(callbackToken)}`,
    ...Object.entries(extraEnv).map(([key, value]) => `${key}=${shellQuote(String(value ?? ""))}`)
  ];
  const args = [
    "node",
    "executor/executor.mjs",
    shellQuote(callbackUrl),
    shellQuote(runId)
  ].join(" ");
  return `sh -lc ${shellQuote(`${envPairs.join(" ")} ${args}`)}`;
}

export async function triggerTruefoundryJob({
  tfyHost,
  tfyApiKey,
  tfyWorkspaceFqn,
  executorName,
  run,
  work,
  callbackToken,
  tfyGet,
  fetchImpl = fetch
}) {
  if (!tfyHost || !tfyApiKey || !tfyWorkspaceFqn) {
    throw new Error("TFY_HOST, TFY_API_KEY, and TFY_WORKSPACE_FQN are required to dispatch the executor job");
  }
  const apps = await tfyGet(`/api/svc/v1/apps?workspaceFqn=${encodeURIComponent(tfyWorkspaceFqn)}&applicationName=${encodeURIComponent(executorName)}`);
  const job = (Array.isArray(apps.data) ? apps.data : [])[0];
  const deploymentId = job?.deployment?.id || job?.activeDeploymentId;
  if (!deploymentId) throw new Error(`active deployment not found for job ${executorName}`);

  const callbackUrl = String(work?.callback_url || "").trim();
  if (!callbackUrl) throw new Error("work.callback_url is required to dispatch the executor job");
  const command = executorShellCommand({ callbackUrl, runId: run.id, callbackToken });

  const res = await fetchImpl(`${tfyHost}/api/svc/v1/jobs/trigger`, {
    method: "POST",
    headers: { authorization: `Bearer ${tfyApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      deploymentId,
      input: { command },
      metadata: { job_run_name_alias: run.id }
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`job trigger failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

export async function triggerExecutorService({
  executorUrl,
  run,
  work,
  callbackToken,
  fetchImpl = fetch
}) {
  if (!executorUrl) throw new Error("HERMES_EXECUTOR_URL is required for truefoundry-service executor backend");
  const base = executorUrl.replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/api/internal/runs/${encodeURIComponent(run.id)}/dispatch`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${callbackToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ work })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`executor service dispatch failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : { accepted: true, backend: "truefoundry-service" };
}

export async function dispatchExecutorTurn(ctx) {
  const { backend } = ctx;
  if (backend === "truefoundry-service") return triggerExecutorService(ctx);
  if (backend === "truefoundry-job") return triggerTruefoundryJob(ctx);
  throw new Error(`unsupported HERMES_EXECUTOR_BACKEND: ${backend}`);
}
