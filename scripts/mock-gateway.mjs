import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8799);
const REPLY = process.env.MOCK_GATEWAY_REPLY || "Local smoke OK.";

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return sendJson(res, 200, {
      object: "list",
      data: [{ id: "mock-model", object: "model", owned_by: "local" }]
    });
  }

  const isChat = req.method === "POST" && (
    url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions"
  );
  if (isChat) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const payload = {
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: REPLY }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return sendJson(res, 200, {
      id: "chatcmpl-mock",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: REPLY },
        finish_reason: "stop"
      }],
      usage: { prompt_tokens: 1, completion_tokens: 4, total_tokens: 5 }
    });
  }

  sendJson(res, 404, { error: { message: `mock gateway: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock gateway listening on :${PORT}`);
});
