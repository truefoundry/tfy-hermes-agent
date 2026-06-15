// Unit tests for the OpenAI response shape builders. These exercise the
// pure helpers extracted in openai-adapter.mjs so we can verify the JSON
// envelopes the controller returns to /v1/responses and /v1/chat/completions
// without booting an HTTP server or talking to Hermes.

import assert from "node:assert/strict";
import test from "node:test";

import {
  openAIId,
  runIdFromOpenAIId,
  createdUnix,
  responseStatus,
  responseObject,
  chatCompletionObject,
  chatCompletionChunk
} from "./openai-adapter.mjs";

const MODEL = "openai-main/gpt-5.5";

function baseRun(overrides = {}) {
  return {
    id: "run_abc123",
    openai_id: null,
    status: "queued",
    result: null,
    error: null,
    created_at: 1_700_000_000_000,
    ...overrides
  };
}

test("openAIId strips the run_ prefix and stamps the requested family prefix", () => {
  assert.equal(openAIId("resp", "run_abc123"), "resp_abc123");
  assert.equal(openAIId("chatcmpl", "run_xyz"), "chatcmpl_xyz");
  // Already-bare ids are tolerated so callers do not have to special-case.
  assert.equal(openAIId("msg", "bare"), "msg_bare");
});

test("runIdFromOpenAIId inverts both response and chat.completion families", () => {
  assert.equal(runIdFromOpenAIId("resp_abc123"), "run_abc123");
  assert.equal(runIdFromOpenAIId("chatcmpl_xyz"), "run_xyz");
  assert.equal(runIdFromOpenAIId("run_passthrough"), "run_passthrough");
});

test("createdUnix converts a run's created_at millis to whole seconds", () => {
  assert.equal(createdUnix({ created_at: 1_700_000_000_000 }), 1_700_000_000);
  assert.equal(createdUnix({ createdAt: 1_700_000_000_000 }), 1_700_000_000);
  // Falls back to "now" rather than NaN when nothing is set.
  assert.ok(Number.isFinite(createdUnix({})));
});

test("responseStatus maps run.status onto the OpenAI lifecycle", () => {
  assert.equal(responseStatus({ status: "completed" }), "completed");
  assert.equal(responseStatus({ status: "failed" }), "failed");
  assert.equal(responseStatus({ status: "queued" }), "in_progress");
  assert.equal(responseStatus({ status: "dispatched" }), "in_progress");
  assert.equal(responseStatus({ status: "running" }), "in_progress");
});

test("responseObject for a queued run is in_progress with empty output", () => {
  const obj = responseObject(baseRun(), { model: MODEL });
  assert.equal(obj.object, "response");
  assert.equal(obj.status, "in_progress");
  assert.equal(obj.id, "resp_abc123");
  assert.equal(obj.model, MODEL);
  assert.deepEqual(obj.output, []);
  assert.equal(obj.output_text, "");
  assert.equal(obj.error, null);
});

test("responseObject for a completed run carries output_text and a message item", () => {
  const obj = responseObject(baseRun({
    status: "completed",
    result: "STREAM_RESULT",
    openai_id: "resp_custom"
  }), { model: MODEL });
  assert.equal(obj.status, "completed");
  assert.equal(obj.id, "resp_custom");
  assert.equal(obj.output_text, "STREAM_RESULT");
  assert.equal(obj.output.length, 1);
  assert.equal(obj.output[0].type, "message");
  assert.equal(obj.output[0].role, "assistant");
  assert.equal(obj.output[0].content[0].type, "output_text");
  assert.equal(obj.output[0].content[0].text, "STREAM_RESULT");
});

test("responseObject for a failed run surfaces an OpenAI-shaped error", () => {
  const obj = responseObject(baseRun({ status: "failed", error: "boom" }), { model: MODEL });
  assert.equal(obj.status, "failed");
  assert.equal(obj.error?.type, "server_error");
  assert.equal(obj.error?.message, "boom");
  assert.deepEqual(obj.output, []);
  assert.equal(obj.output_text, "");
});

test("chatCompletionObject returns an OpenAI-style completion envelope", () => {
  const completed = chatCompletionObject(baseRun({
    status: "completed",
    result: "CHAT_RESULT"
  }), { model: MODEL });
  assert.equal(completed.object, "chat.completion");
  assert.equal(completed.id, "chatcmpl_abc123");
  assert.equal(completed.model, MODEL);
  assert.equal(completed.choices[0].message.role, "assistant");
  assert.equal(completed.choices[0].message.content, "CHAT_RESULT");
  assert.equal(completed.choices[0].finish_reason, "stop");
});

test("chatCompletionObject leaves finish_reason null while the run is mid-flight", () => {
  const inflight = chatCompletionObject(baseRun({ status: "running" }), { model: MODEL });
  assert.equal(inflight.choices[0].finish_reason, null);
  assert.equal(inflight.choices[0].message.content, "");
});

test("chatCompletionChunk forwards deltas and finish_reason, and emits a usage tail when asked", () => {
  const run = baseRun({ status: "running" });
  const delta = chatCompletionChunk(run, { model: MODEL, delta: { content: "hi" } });
  assert.equal(delta.object, "chat.completion.chunk");
  assert.equal(delta.choices[0].delta.content, "hi");
  assert.equal(delta.choices[0].finish_reason, null);

  const stop = chatCompletionChunk(run, { model: MODEL, finishReason: "stop" });
  assert.equal(stop.choices[0].finish_reason, "stop");

  const usageTail = chatCompletionChunk(run, {
    model: MODEL,
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
  });
  assert.deepEqual(usageTail.choices, []);
  assert.deepEqual(usageTail.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
});
