import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWorkPayload,
  dispatchExecutorTurn,
  triggerExecutorService,
  triggerTruefoundryJob
} from "./dispatch.mjs";

describe("buildWorkPayload", () => {
  it("includes agent manifest fields and callback urls", () => {
    const payload = buildWorkPayload({
      run: { id: "run_abc", hermes_session_id: "sess_1" },
      agent: {
        id: "agt_1",
        handle: "bot",
        name: "Bot",
        description: "desc",
        instructions: "do things",
        model: "openai-main/gpt-5.5",
        skills: ["skill:a"],
        mcpServers: ["https://example.com/mcp/server"]
      },
      content: "hello",
      publicBaseUrl: "https://controller.example",
      hermesModel: "openai-main/gpt-5.5"
    });
    assert.equal(payload.run_id, "run_abc");
    assert.equal(payload.hermes_session_id, "sess_1");
    assert.equal(payload.content, "hello");
    assert.equal(payload.callback_url, "https://controller.example");
    assert.equal(payload.controller_event_url, "https://controller.example/api/internal/runs/run_abc/events");
    assert.equal(payload.agent.handle, "bot");
    assert.deepEqual(payload.agent.skills, ["skill:a"]);
  });
});

describe("triggerExecutorService", () => {
  it("posts work to the executor service dispatch endpoint", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ accepted: true })
      };
    };
    const work = { run_id: "run_xyz", hermes_session_id: "sess_2", content: "hi", callback_url: "https://c" };
    const result = await triggerExecutorService({
      executorUrl: "http://devrel-assistant-executor:8788",
      run: { id: "run_xyz" },
      work,
      callbackToken: "token-123",
      fetchImpl
    });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/internal\/runs\/run_xyz\/dispatch$/);
    assert.equal(calls[0].init.headers.authorization, "Bearer token-123");
    assert.deepEqual(JSON.parse(calls[0].init.body), { work });
  });
});

describe("triggerTruefoundryJob", () => {
  it("triggers a TF job that fetches work from the controller", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const tfyGet = async () => ({ data: [{ deployment: { id: "dep_1" } }] });
    await triggerTruefoundryJob({
      tfyHost: "https://tfy.example",
      tfyApiKey: "key",
      tfyWorkspaceFqn: "ws",
      executorName: "devrel-assistant-executor",
      run: { id: "run_job" },
      work: { run_id: "run_job", hermes_session_id: "sess", content: "x", callback_url: "https://c" },
      callbackToken: "cb",
      tfyGet,
      fetchImpl
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://tfy.example/api/svc/v1/jobs/trigger");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.deploymentId, "dep_1");
    assert.match(body.input.command, /HARNESS_CALLBACK_TOKEN=/);
    assert.match(body.input.command, /https:\/\/c/);
    assert.match(body.input.command, /run_job/);
    assert.match(body.input.command, /node executor\/executor\.mjs/);
  });
});

describe("dispatchExecutorTurn", () => {
  it("routes to the service backend", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ accepted: true, backend: "truefoundry-service" })
    });
    const result = await dispatchExecutorTurn({
      backend: "truefoundry-service",
      executorUrl: "http://executor:8788",
      run: { id: "run_1" },
      work: { run_id: "run_1", hermes_session_id: "s", content: "", callback_url: "https://c" },
      callbackToken: "tok",
      fetchImpl
    });
    assert.equal(result.accepted, true);
  });

  it("rejects unknown backends", async () => {
    await assert.rejects(
      () => dispatchExecutorTurn({ backend: "kubernetes" }),
      /unsupported HERMES_EXECUTOR_BACKEND/
    );
  });
});
