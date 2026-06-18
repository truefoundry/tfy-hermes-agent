import { createServer } from "node:http";
import { verifyRunToken } from "../executor/tokens.mjs";
import { executeTurn } from "../executor/run-turn.mjs";

const PORT = Number(process.env.PORT || 8789);
const RUN_TOKEN_SECRET = process.env.HERMES_RUN_TOKEN_SECRET || "";
const MAX_CONCURRENT_RUNS = Number(process.env.HERMES_RUNTIME_MAX_CONCURRENT_RUNS || 1);

const activeRuns = new Map();
const queue = [];

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString("utf8") : "";
}

function authorize(req, runId) {
  const auth = String(req.headers.authorization || "");
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  if (!RUN_TOKEN_SECRET || !verifyRunToken({ token, expectedRunId: runId, secret: RUN_TOKEN_SECRET })) {
    return null;
  }
  return token;
}

function drainQueue() {
  while (activeRuns.size < MAX_CONCURRENT_RUNS && queue.length) {
    const item = queue.shift();
    activeRuns.set(item.runId, { startedAt: Date.now() });
    executeTurn(item.work, item.token)
      .catch((error) => {
        console.error(`[runtime] run ${item.runId} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        activeRuns.delete(item.runId);
        drainQueue();
      });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, {
        ok: true,
        activeRuns: activeRuns.size,
        queuedRuns: queue.length,
        maxConcurrentRuns: MAX_CONCURRENT_RUNS,
        hermesHome: process.env.HERMES_HOME || ""
      });
    }

    const dispatchMatch = url.pathname.match(/^\/api\/internal\/runs\/([^/]+)\/dispatch$/);
    if (req.method === "POST" && dispatchMatch) {
      const runId = decodeURIComponent(dispatchMatch[1]);
      const token = authorize(req, runId);
      if (!token) return send(res, 401, { error: "unauthorized" });
      const body = await rawBody(req);
      const work = body ? JSON.parse(body).work : null;
      if (!work || work.run_id !== runId) return send(res, 400, { error: "invalid work payload" });

      queue.push({ runId, work, token });
      drainQueue();
      return send(res, 202, {
        accepted: true,
        backend: "hermes-runtime",
        run_id: runId,
        queued: !activeRuns.has(runId),
        activeRuns: activeRuns.size,
        queuedRuns: queue.length
      });
    }

    return send(res, 404, { error: "not found" });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

if (!RUN_TOKEN_SECRET) {
  console.error("[runtime] HERMES_RUN_TOKEN_SECRET is required");
  process.exit(1);
}

process.env.HERMES_STATE_OWNER = "runtime";

server.listen(PORT, "0.0.0.0", () => {
  console.log(`hermes runtime listening on :${PORT}`);
});
