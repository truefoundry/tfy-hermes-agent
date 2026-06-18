import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildWorkPayload,
  dispatchExecutorTurn,
  triggerHermesRuntime
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

describe("triggerHermesRuntime", () => {
  it("posts work to the runtime service dispatch endpoint", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 202,
        text: async () => JSON.stringify({ accepted: true, backend: "hermes-runtime" })
      };
    };
    const work = { run_id: "run_rt", hermes_session_id: "sess_rt", content: "hi", callback_url: "https://c" };
    const result = await triggerHermesRuntime({
      runtimeUrl: "http://devrel-assistant-runtime:8789",
      run: { id: "run_rt" },
      work,
      callbackToken: "token-rt",
      fetchImpl
    });
    assert.equal(result.accepted, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/internal\/runs\/run_rt\/dispatch$/);
    assert.equal(calls[0].init.headers.authorization, "Bearer token-rt");
    assert.deepEqual(JSON.parse(calls[0].init.body), { work });
  });
});

describe("dispatchExecutorTurn", () => {
  it("routes to the runtime backend", async () => {
    const fetchImpl = async () => ({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ accepted: true, backend: "hermes-runtime" })
    });
    const result = await dispatchExecutorTurn({
      backend: "hermes-runtime",
      runtimeUrl: "http://runtime:8789",
      run: { id: "run_1" },
      work: { run_id: "run_1", hermes_session_id: "s", content: "", callback_url: "https://c" },
      callbackToken: "tok",
      fetchImpl
    });
    assert.equal(result.backend, "hermes-runtime");
  });

  it("rejects unknown backends", async () => {
    await assert.rejects(
      () => dispatchExecutorTurn({ backend: "kubernetes" }),
      /unsupported dispatch backend/
    );
  });

  it("rejects removed legacy backends", async () => {
    await assert.rejects(
      () => dispatchExecutorTurn({ backend: "truefoundry-job" }),
      /unsupported dispatch backend/
    );
    await assert.rejects(
      () => dispatchExecutorTurn({ backend: "truefoundry-service" }),
      /unsupported dispatch backend/
    );
  });
});
