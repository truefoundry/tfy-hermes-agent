#!/usr/bin/env node
/**
 * E2E smoke against a local compose stack (controller + executor + mock gateway).
 * Expects: docker compose -f docker-compose.local.yml up --build -d
 */

const BASE = (process.env.LOCAL_CONTROLLER_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const API_KEY = process.env.TFY_API_KEY || "local-test-api-key";
const EXPECT = process.env.MOCK_GATEWAY_REPLY || "Local smoke OK.";
const HEALTH_TIMEOUT_MS = Number(process.env.LOCAL_HEALTH_TIMEOUT_MS || 180_000);
const TURN_TIMEOUT_MS = Number(process.env.LOCAL_TURN_TIMEOUT_MS || 180_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealth() {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error(`controller not healthy at ${BASE}/api/health after ${HEALTH_TIMEOUT_MS}ms`);
}

async function main() {
  console.log(`waiting for ${BASE}/api/health ...`);
  await waitHealth();
  console.log("controller healthy");

  const res = await fetch(`${BASE}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.HERMES_MODEL || "mock-model",
      input: "Reply with exactly: Local smoke OK."
    }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`/v1/responses failed ${res.status}: ${JSON.stringify(body)}`);
  }
  if (body.status !== "completed") {
    throw new Error(`run not completed (status=${body.status}): ${body.error?.message || JSON.stringify(body)}`);
  }
  const text = String(body.output_text || "").trim();
  if (!text.includes(EXPECT)) {
    throw new Error(`unexpected output (expected substring ${JSON.stringify(EXPECT)}): ${JSON.stringify(text)}`);
  }
  console.log(`local e2e smoke passed: ${text}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
