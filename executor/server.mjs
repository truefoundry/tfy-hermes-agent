import { createServer } from "node:http";
import { verifyRunToken } from "./tokens.mjs";
import { executeTurn } from "./run-turn.mjs";

const PORT = Number(process.env.PORT || 8788);
const RUN_TOKEN_SECRET = process.env.HERMES_RUN_TOKEN_SECRET || "";

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    const dispatchMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/dispatch$/);
    if (req.method === "POST" && dispatchMatch) {
      const runId = decodeURIComponent(dispatchMatch[1]);
      const auth = String(req.headers.authorization || "");
      const token = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
      if (!RUN_TOKEN_SECRET || !verifyRunToken({ token, expectedRunId: runId, secret: RUN_TOKEN_SECRET })) {
        return send(res, 401, { error: "unauthorized" });
      }
      const body = await rawBody(req);
      const work = body ? JSON.parse(body).work : null;
      if (!work || work.run_id !== runId) {
        return send(res, 400, { error: "invalid work payload" });
      }
      send(res, 202, { accepted: true, run_id: runId });
      executeTurn(work, token).catch((error) => {
        console.error(`[executor] run ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (error) {
    send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

if (!RUN_TOKEN_SECRET) {
  console.error("[executor] HERMES_RUN_TOKEN_SECRET is required");
  process.exit(1);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`hermes executor service listening on :${PORT}`);
});
