import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalToken = "test-internal-token";

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (lastError) throw lastError;
  throw new Error("timed out waiting for condition");
}

async function request(baseUrl, method, apiPath, body = null, headers = {}) {
  const response = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const payload = text && response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text;
  return { response, payload, text };
}

async function stateRun(stateRoot, predicate) {
  return waitFor(async () => {
    const state = JSON.parse(await readFile(path.join(stateRoot, "state.json"), "utf8"));
    return Object.values(state.runs || {}).find(predicate);
  });
}

async function completeRun(baseUrl, runId, result) {
  const { response } = await request(baseUrl, "POST", `/api/internal/runs/${runId}/complete`, {
    status: "completed",
    result
  }, {
    authorization: `Bearer ${internalToken}`
  });
  assert.equal(response.status, 200);
}

async function withServer(fn) {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "tfy-hermes-openai-test-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["controller/controller.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HARNESS_STATE_DIR: stateRoot,
      HARNESS_INTERNAL_TOKEN: internalToken,
      HERMES_OPENAI_SYNC_TIMEOUT_MS: "5000",
      HERMES_OPENAI_POLL_INTERVAL_MS: "50",
      HERMES_SSE_KEEPALIVE_MS: "0"
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  try {
    await waitFor(async () => {
      try {
        const { response } = await request(baseUrl, "GET", "/api/health");
        return response.ok;
      } catch {
        return false;
      }
    });
    await fn({ baseUrl, stateRoot });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(stateRoot, { recursive: true, force: true });
  }

  if (child.exitCode && child.exitCode !== 0 && child.exitCode !== null) {
    throw new Error(`server exited ${child.exitCode}: ${stderr}`);
  }
}

test("Responses API supports background creation, retrieval, and previous_response_id memory", async () => {
  await withServer(async ({ baseUrl }) => {
    const first = await request(baseUrl, "POST", "/v1/responses", {
      model: "test-model",
      input: "first turn",
      background: true
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.payload.status, "in_progress");
    await completeRun(baseUrl, `run_${first.payload.id.slice(5)}`, "FIRST_RESULT");

    const second = await request(baseUrl, "POST", "/v1/responses", {
      model: "test-model",
      input: "second turn",
      previous_response_id: first.payload.id,
      background: true
    });
    assert.equal(second.response.status, 200);
    const secondRunId = `run_${second.payload.id.slice(5)}`;

    const work = await request(baseUrl, "GET", `/api/internal/runs/${secondRunId}/work-item`, null, {
      authorization: `Bearer ${internalToken}`
    });
    assert.equal(work.response.status, 200);
    assert.match(work.payload.memory, /FIRST_RESULT/);
    assert.doesNotMatch(work.payload.memory, /second turn/);

    await completeRun(baseUrl, secondRunId, "SECOND_RESULT");
    const completed = await request(baseUrl, "GET", `/v1/responses/${second.payload.id}`);
    assert.equal(completed.payload.status, "completed");
    assert.equal(completed.payload.output_text, "SECOND_RESULT");
  });
});

test("Chat Completions endpoint returns an OpenAI-style completion object", async () => {
  await withServer(async ({ baseUrl, stateRoot }) => {
    const pending = request(baseUrl, "POST", "/v1/chat/completions", {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }]
    });

    const run = await stateRun(stateRoot, (candidate) => candidate.openai?.kind === "chat.completion");
    await completeRun(baseUrl, run.id, "CHAT_RESULT");

    const completed = await pending;
    assert.equal(completed.response.status, 200);
    assert.equal(completed.payload.object, "chat.completion");
    assert.equal(completed.payload.choices[0].message.content, "CHAT_RESULT");
    assert.equal(completed.payload.choices[0].finish_reason, "stop");
  });
});

test("Responses API streams OpenAI-style SSE events", async () => {
  await withServer(async ({ baseUrl, stateRoot }) => {
    const pending = request(baseUrl, "POST", "/v1/responses", {
      model: "test-model",
      input: "stream this",
      stream: true
    });

    const run = await stateRun(stateRoot, (candidate) => candidate.openai?.kind === "response");
    await completeRun(baseUrl, run.id, "STREAM_RESULT");

    const completed = await pending;
    assert.equal(completed.response.status, 200);
    assert.match(completed.response.headers.get("content-type") || "", /text\/event-stream/);
    assert.match(completed.text, /event: response\.created/);
    assert.match(completed.text, /event: response\.output_text\.delta/);
    assert.match(completed.text, /STREAM_RESULT/);
    assert.match(completed.text, /event: response\.completed/);
  });
});
