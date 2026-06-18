import assert from "node:assert/strict";
import test from "node:test";

import {
  createSlackProgressState,
  observerProgressChunks,
  slackInitialPlanChunks,
  slackTaskUpdate,
  SLACK_PLAN_TASKS
} from "./slack.mjs";

test("slackInitialPlanChunks creates a multi-step Slack plan", () => {
  const chunks = slackInitialPlanChunks({
    agent: { handle: "hermes-test-agent" },
    fallbackHandle: "hermes",
    hasAttachments: true
  });

  assert.equal(chunks[0].type, "plan_update");
  assert.equal(chunks[0].title, "Run @hermes-test-agent");
  assert.deepEqual(chunks.slice(1).map((chunk) => chunk.id), [
    SLACK_PLAN_TASKS.request,
    SLACK_PLAN_TASKS.attachments,
    SLACK_PLAN_TASKS.executor,
    SLACK_PLAN_TASKS.model,
    SLACK_PLAN_TASKS.activity,
    SLACK_PLAN_TASKS.response
  ]);
  assert.equal(chunks.find((chunk) => chunk.id === SLACK_PLAN_TASKS.request).status, "in_progress");
  assert.equal(chunks.find((chunk) => chunk.id === SLACK_PLAN_TASKS.response).status, "pending");
});

test("slackTaskUpdate truncates long details for Slack task chunks", () => {
  const chunk = slackTaskUpdate({
    id: "task",
    title: "A".repeat(300),
    status: "in_progress",
    details: ["B".repeat(300)]
  });

  assert.equal(chunk.title.length, 256);
  assert.equal(chunk.details.length, 256);
  assert.match(chunk.title, /\.\.\.$/);
  assert.match(chunk.details, /\.\.\.$/);
});

test("observerProgressChunks updates model and matching tool tasks", () => {
  const state = createSlackProgressState();
  const modelStart = observerProgressChunks({
    kind: "model_request_start",
    model: "openai-main/gpt-5.5"
  }, state);
  assert.deepEqual(modelStart, [{
    type: "task_update",
    id: SLACK_PLAN_TASKS.model,
    title: "Think with model",
    status: "in_progress",
    details: "Using openai-main/gpt-5.5"
  }]);

  const toolStart = observerProgressChunks({
    kind: "tool_start",
    tool_name: "read_file",
    args: { path: "/tmp/input.png", token: "secret-value" }
  }, state);
  const toolTask = toolStart.find((chunk) => chunk.id.startsWith("hermes_tool_"));
  assert.equal(toolStart[0].id, SLACK_PLAN_TASKS.activity);
  assert.equal(toolStart[0].status, "in_progress");
  assert.equal(toolTask.title, "Call read_file");
  assert.equal(toolTask.status, "in_progress");
  assert.match(toolTask.details, /path: \/tmp\/input\.png/);
  assert.match(toolTask.details, /token: \[redacted\]/);

  const toolComplete = observerProgressChunks({
    kind: "tool_complete",
    tool_name: "read_file",
    status: "success",
    duration_ms: 1250
  }, state);
  assert.equal(toolComplete.length, 1);
  assert.equal(toolComplete[0].id, toolTask.id);
  assert.equal(toolComplete[0].status, "complete");
  assert.equal(toolComplete[0].details, "Completed in 1.3s");
});
