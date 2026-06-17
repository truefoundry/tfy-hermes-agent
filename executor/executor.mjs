import { executeTurn } from "./run-turn.mjs";

const errMsg = (e) => e instanceof Error ? e.message : String(e);

const callbackToken = process.env.HARNESS_CALLBACK_TOKEN || "";
const callbackBase = String(process.argv[2] || "").replace(/\/+$/, "");
const runId = String(process.argv[3] || "").trim();

if (!callbackBase || !runId) {
  console.error("usage: node executor/executor.mjs <callback_url> <run_id>");
  process.exit(2);
}

if (!callbackToken) {
  console.error("HARNESS_CALLBACK_TOKEN is required");
  process.exit(2);
}

async function fetchWork() {
  const res = await fetch(`${callbackBase}/api/internal/runs/${encodeURIComponent(runId)}/work`, {
    headers: { authorization: `Bearer ${callbackToken}` }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`work fetch failed ${res.status}: ${text.slice(0, 500)}`);
  const payload = text ? JSON.parse(text) : {};
  const work = payload.work;
  if (!work || work.run_id !== runId) throw new Error("invalid work payload");
  return work;
}

try {
  const payload = await fetchWork();
  await executeTurn(payload, callbackToken);
} catch (error) {
  console.error(errMsg(error));
  process.exit(1);
}
