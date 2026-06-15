// Pure builders for OpenAI-compatible response shapes.
//
// The controller passes a `run` row (see DESIGN.md `runs` schema) plus the
// configured model identifier; these helpers translate that into the JSON
// objects the OpenAI Responses and Chat Completions APIs return. They have
// no IO of their own so they are trivial to unit-test in isolation.

export function openAIId(prefix, runId) {
  return `${prefix}_${String(runId).replace(/^run_/, "")}`;
}

export function runIdFromOpenAIId(value) {
  const id = String(value || "");
  if (id.startsWith("resp_")) return `run_${id.slice(5)}`;
  if (id.startsWith("chatcmpl_")) return `run_${id.slice(9)}`;
  return id;
}

export function createdUnix(run) {
  const value = Number(run?.created_at ?? run?.createdAt ?? Date.now());
  return Math.floor((Number.isFinite(value) ? value : Date.now()) / 1000);
}

export function responseStatus(run) {
  if (run?.status === "completed") return "completed";
  if (run?.status === "failed") return "failed";
  return "in_progress";
}

export function responseObject(run, { model }) {
  const responseId = run.openai_id || openAIId("resp", run.id);
  const completed = run.status === "completed";
  const failed = run.status === "failed";
  const outputText = completed ? String(run.result || "") : "";
  return {
    id: responseId,
    object: "response",
    created_at: createdUnix(run),
    status: responseStatus(run),
    error: failed ? { message: run.error || "Hermes run failed", type: "server_error" } : null,
    incomplete_details: null,
    instructions: null,
    model,
    output: completed ? [{
      id: openAIId("msg", run.id),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: outputText, annotations: [] }]
    }] : [],
    output_text: outputText,
    usage: null,
    metadata: null
  };
}

export function chatCompletionObject(run, { model }) {
  const completionId = run.openai_id || openAIId("chatcmpl", run.id);
  return {
    id: completionId,
    object: "chat.completion",
    created: createdUnix(run),
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: run.status === "completed" ? String(run.result || "") : ""
      },
      logprobs: null,
      finish_reason: run.status === "completed" ? "stop" : null
    }],
    usage: null
  };
}

export function chatCompletionChunk(run, { model, delta = {}, finishReason = null, usage = null } = {}) {
  const completionId = run.openai_id || openAIId("chatcmpl", run.id);
  return {
    id: completionId,
    object: "chat.completion.chunk",
    created: createdUnix(run),
    model,
    choices: usage ? [] : [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
    usage
  };
}
