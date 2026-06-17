#!/usr/bin/env node
/**
 * Local smoke: artifact URL -> executor download -> local_path in Hermes prompt
 * -> Hermes reads the downloaded file -> controller receives the output.
 *
 * This uses a mock controller/artifact server and a fake `python` executable so
 * the smoke does not need real TrueFoundry or hermes-agent credentials.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runId = "run_attachment_smoke";
const callbackToken = "local-callback-token";
const tfyApiKey = "tfy-local-key";
const artifactText = "artifact smoke content: executor downloaded me";

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function main() {
  const tmp = await mkdtemp(path.join(tmpdir(), "tfy-hermes-attachment-smoke-"));
  const binDir = path.join(tmp, "bin");
  const workspaceDir = path.join(tmp, "workspace");
  await writeFile(path.join(tmp, "artifact-source.txt"), artifactText);
  await mkdir(binDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });

  const fakePythonPath = path.join(binDir, "python");
  await writeFile(fakePythonPath, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";

const promptPath = process.argv[3];
const prompt = readFileSync(promptPath, "utf8");
const match = prompt.match(/^\\s*local_path:\\s*(.+)$/m);
if (!match) {
  console.error("fake hermes: local_path missing from prompt");
  process.exit(3);
}
const localPath = match[1].trim();
const fileText = readFileSync(localPath, "utf8");
console.log(JSON.stringify({
  used_file: path.basename(localPath),
  file_text: fileText,
  prompt_mentions_local_path: prompt.includes(localPath)
}));
`, { mode: 0o755 });
  await chmod(fakePythonPath, 0o755);

  const requests = [];
  const completes = [];
  let baseUrl = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const body = await readBody(req);
    requests.push({
      method: req.method,
      path: url.pathname,
      authorization: String(req.headers.authorization || ""),
      body
    });

    if (req.method === "GET" && url.pathname === `/api/internal/runs/${runId}/work`) {
      const work = {
        run_id: runId,
        hermes_session_id: "session_attachment_smoke",
        callback_url: baseUrl,
        content: "Read the attached file and report what it says.",
        attachments: [{
          slack_file_id: "FLOCAL1",
          filename: "input.txt",
          mime_type: "text/plain",
          size: artifactText.length,
          artifact_fqn: "artifact:local/smoke/input:1",
          artifact_path: "FLOCAL1-input.txt",
          download_url: `${baseUrl}/artifact/input.txt`
        }],
        agent: {
          id: "agent-local",
          handle: "local",
          name: "Local Smoke",
          model: "local-model",
          skills: [],
          mcpServers: []
        }
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ work }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/artifact/input.txt") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(Buffer.byteLength(artifactText))
      });
      res.end(artifactText);
      return;
    }

    if (req.method === "GET" && url.pathname === `/api/internal/runs/${runId}/session-db`) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/api/internal/runs/${runId}/events`) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && url.pathname === `/api/internal/runs/${runId}/complete`) {
      const parsed = body ? JSON.parse(body) : {};
      completes.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, ["executor/executor.mjs", baseUrl, runId], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        HOME: workspaceDir,
        HERMES_HOME: path.join(workspaceDir, ".hermes"),
        HARNESS_CALLBACK_TOKEN: callbackToken,
        HARNESS_TURN_TIMEOUT_MS: "10000",
        TFY_HOST: "http://tfy.local",
        TFY_API_KEY: tfyApiKey,
        OPENAI_BASE_URL: "http://llm.local/v1",
        OPENAI_API_KEY: tfyApiKey,
        HERMES_MODEL: "local-model"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    const exitCode = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(exitCode, 0, stderr || stdout);
    assert.ok(requests.some((request) => request.method === "GET" && request.path === `/api/internal/runs/${runId}/work`));
    const artifactRequest = requests.find((request) => request.method === "GET" && request.path === "/artifact/input.txt");
    assert.equal(artifactRequest?.authorization, `Bearer ${tfyApiKey}`);
    assert.ok(completes.length, "executor did not report completion");
    assert.equal(completes.at(-1).status, "completed");
    const result = JSON.parse(completes.at(-1).result);
    assert.equal(result.file_text, artifactText);
    assert.equal(result.prompt_mentions_local_path, true);

    console.log(JSON.stringify({
      exit_code: exitCode,
      downloaded_artifact_with_tfy_bearer: artifactRequest?.authorization === `Bearer ${tfyApiKey}`,
      hermes_result: result,
      requested_paths: requests.map((request) => `${request.method} ${request.path}`)
    }, null, 2));
  } finally {
    server.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
