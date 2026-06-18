#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const host = String(process.env.HERMES_TEST_AGENT_HOST || process.argv[2] || "")
  .replace(/\/+$/, "");
const token = process.env.HERMES_TEST_AGENT_API_KEY || process.env.TFY_API_KEY || "";
const timeoutMs = Number(process.env.HERMES_LIVE_SMOKE_TIMEOUT_MS || 600_000);
const readinessTimeoutMs = Number(process.env.HERMES_LIVE_SMOKE_READINESS_TIMEOUT_MS || 300_000);
const readinessIntervalMs = Number(process.env.HERMES_LIVE_SMOKE_READINESS_INTERVAL_MS || 10_000);
const expectSlack = process.env.HERMES_LIVE_SMOKE_EXPECT_SLACK !== "0";
const sessionOneFollowups = Number(process.env.HERMES_LIVE_SMOKE_SESSION_ONE_FOLLOWUPS || 3);
const sessionTwoFollowups = Number(process.env.HERMES_LIVE_SMOKE_SESSION_TWO_FOLLOWUPS || 2);

if (!host) throw new Error("HERMES_TEST_AGENT_HOST or first CLI argument is required");
if (!token) throw new Error("TFY_API_KEY or HERMES_TEST_AGENT_API_KEY is required");

function log(step, detail = "") {
  console.log(`==> ${step}${detail ? `: ${detail}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readText(res) {
  return await res.text().catch(() => "");
}

async function request(pathname, {
  method = "GET",
  auth = false,
  body = null,
  headers = {},
  timeout = timeoutMs
} = {}) {
  const res = await fetch(`${host}${pathname}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout)
  });
  const text = await readText(res);
  if (!res.ok) throw new Error(`${method} ${pathname} failed ${res.status}: ${text.slice(0, 1000)}`);
  return text;
}

async function requestJson(pathname, options) {
  const text = await request(pathname, options);
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${pathname} did not return JSON: ${text.slice(0, 500)}`);
  }
}

async function waitForJson(pathname, isReady, label) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < readinessTimeoutMs) {
    try {
      const value = await requestJson(pathname, { timeout: Math.min(timeoutMs, readinessIntervalMs) });
      if (isReady(value)) return value;
      lastError = new Error(`${pathname} returned but ${label} is not ready`);
    } catch (error) {
      lastError = error;
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    log("waiting for readiness", `${label}: ${message}`);
    await sleep(readinessIntervalMs);
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label} was not ready after ${readinessTimeoutMs}ms: ${message}`);
}

function outputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const content = response?.output?.flatMap((item) => item?.content || []) || [];
  return content.map((item) => item?.text || "").join("\n");
}

async function createResponse(input, previousResponseId = null) {
  const body = { model: "hermes-live-smoke", input };
  if (previousResponseId) body.previous_response_id = previousResponseId;
  const response = await requestJson("/v1/responses", {
    method: "POST",
    auth: true,
    body
  });
  assert(response.object === "response", "Responses API returned unexpected object");
  assert(response.status === "completed", `Responses API did not complete: ${response.status}`);
  assert(response.id?.startsWith("resp_"), "Responses API id should start with resp_");
  assert(outputText(response).trim(), "Responses API returned empty output_text");
  return response;
}

async function createChatCompletion(content, { stream = false } = {}) {
  return await request(stream ? "/v1/chat/completions" : "/v1/chat/completions", {
    method: "POST",
    auth: true,
    headers: stream ? { accept: "text/event-stream" } : {},
    body: {
      model: "hermes-live-smoke",
      stream,
      messages: [{ role: "user", content }]
    }
  });
}

function parseSse(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6))
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
}

async function main() {
  log("health", host);
  const health = await waitForJson("/api/health", (value) => value?.ok === true, "controller health");
  assert(health.ok === true, "/api/health did not return ok=true");

  log("Slack health");
  const slackHealth = await requestJson("/slack/health");
  assert(slackHealth.ok === true, "/slack/health did not return ok=true");
  if (expectSlack) {
    assert(slackHealth.slack?.botTokenConfigured === true, "Slack bot token is not configured");
    assert(slackHealth.slack?.signingSecretConfigured === true, "Slack signing secret is not configured");
  }

  log("OpenAI-compatible models");
  const models = await requestJson("/v1/models", { auth: true });
  assert(models.object === "list", "/v1/models returned unexpected object");
  assert(Array.isArray(models.data) && models.data.length > 0, "/v1/models returned no models");

  log("Responses API one-shot");
  const smokeNonce = `smoke-${randomUUID().slice(0, 8)}`;
  const first = await createResponse(
    `Live post-deploy smoke check. Reply with this nonce exactly once: ${smokeNonce}`
  );
  assert(outputText(first).includes(smokeNonce), "Responses API output did not include the requested nonce");

  log("Chat Completions API");
  const chat = JSON.parse(await createChatCompletion(
    `Live post-deploy chat completion check. Reply with this nonce exactly once: ${smokeNonce}`
  ));
  assert(chat.object === "chat.completion", "Chat Completions API returned unexpected object");
  assert(chat.id?.startsWith("chatcmpl_"), "Chat completion id should start with chatcmpl_");
  assert(chat.choices?.[0]?.message?.content?.includes(smokeNonce), "Chat completion did not include the requested nonce");

  log("Chat Completions streaming");
  const streamText = await createChatCompletion(
    `Streaming smoke check. Reply with this nonce exactly once: ${smokeNonce}`,
    { stream: true }
  );
  const events = parseSse(streamText);
  assert(events.some((event) => event.object === "chat.completion.chunk"), "Streaming response did not include chat chunks");
  assert(events.some((event) => event.choices?.[0]?.finish_reason === "stop"), "Streaming response did not finish with stop");

  log("Responses session continuity");
  const nonceA = `session-a-${randomUUID().slice(0, 8)}`;
  let sessionA = await createResponse(
    `This is live smoke session A. Remember this session A nonce: ${nonceA}. Reply with "ready ${nonceA}".`
  );
  assert(outputText(sessionA).includes(nonceA), "Session A initial response did not include nonce");
  for (let i = 0; i < sessionOneFollowups; i += 1) {
    sessionA = await createResponse(
      `Follow-up ${i + 1}. What is the session A nonce? Include only the nonce in your answer.`,
      sessionA.id
    );
    assert(outputText(sessionA).includes(nonceA), `Session A follow-up ${i + 1} did not preserve nonce`);
  }

  log("Responses second session and isolation");
  const nonceB = `session-b-${randomUUID().slice(0, 8)}`;
  let sessionB = await createResponse(
    `This is separate live smoke session B. Remember only this session B nonce: ${nonceB}. Reply with "ready ${nonceB}".`
  );
  assert(outputText(sessionB).includes(nonceB), "Session B initial response did not include nonce");
  for (let i = 0; i < sessionTwoFollowups; i += 1) {
    sessionB = await createResponse(
      `Follow-up ${i + 1}. What is the session B nonce? Include only the nonce in your answer.`,
      sessionB.id
    );
    assert(outputText(sessionB).includes(nonceB), `Session B follow-up ${i + 1} did not preserve nonce`);
  }

  const isolation = await createResponse(
    `Without guessing, do you know any session A nonce from another unrelated conversation? If not, answer exactly "no".`,
    sessionB.id
  );
  const isolationText = outputText(isolation).toLowerCase();
  assert(!isolationText.includes(nonceA.toLowerCase()), "Session B leaked Session A nonce");

  log("parallel session turns");
  const [parallelA, parallelB] = await Promise.all([
    createResponse("Parallel check for session A. Reply with the session A nonce only.", sessionA.id),
    createResponse("Parallel check for session B. Reply with the session B nonce only.", sessionB.id)
  ]);
  assert(outputText(parallelA).includes(nonceA), "Parallel Session A turn did not preserve nonce");
  assert(outputText(parallelB).includes(nonceB), "Parallel Session B turn did not preserve nonce");

  console.log(JSON.stringify({
    ok: true,
    host,
    models: models.data.map((item) => item.id),
    responses: {
      oneShot: first.id,
      sessionA: parallelA.id,
      sessionB: parallelB.id
    },
    slackConfigured: slackHealth.slack
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
