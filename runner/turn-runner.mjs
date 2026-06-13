import { spawn } from "node:child_process";

const runId = process.env.HARNESS_RUN_ID || process.env.RUN_ID;
const controlApi = (process.env.HARNESS_CONTROL_API_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");

if (!runId || !controlApi) {
  console.error("HARNESS_RUN_ID and HARNESS_CONTROL_API_URL are required");
  process.exit(2);
}

async function getJson(apiPath) {
  const res = await fetch(`${controlApi}${apiPath}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function postJson(apiPath, body) {
  const res = await fetch(`${controlApi}${apiPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${apiPath} failed ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function buildPrompt(work) {
  const memory = work.memory ? `Conversation so far:\n${work.memory}\n\n` : "";
  const skills = Array.isArray(work.agent?.skills) && work.agent.skills.length
    ? `Allowed skills: ${work.agent.skills.join(", ")}\n`
    : "";
  const mcp = Array.isArray(work.agent?.mcpServers) && work.agent.mcpServers.length
    ? `Allowed MCP servers: ${work.agent.mcpServers.join(", ")}\n`
    : "";
  return `${skills}${mcp}${memory}User: ${work.content}`;
}

function runHermes(prompt, work) {
  const env = { ...process.env };
  const model = work.agent?.model || process.env.HERMES_INFERENCE_MODEL;
  if (process.env.TFY_GATEWAY_API_KEY && !env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.TFY_GATEWAY_API_KEY;
  if (process.env.TFY_GATEWAY_BASE_URL && !env.OPENAI_BASE_URL) env.OPENAI_BASE_URL = process.env.TFY_GATEWAY_BASE_URL;
  if (model) env.HERMES_INFERENCE_MODEL = model;
  env.HERMES_YOLO_MODE = "1";
  env.HERMES_ACCEPT_HOOKS = "1";

  const args = ["-m", "hermes_cli.main", "-z", prompt];
  if (model) args.push("--model", model);
  if (work.agent?.mcpServers?.length) args.push("--toolsets", work.agent.mcpServers.join(","));

  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`hermes exited ${code}: ${stderr || stdout}`));
    });
  });
}

try {
  const work = await getJson(`/api/internal/runs/${encodeURIComponent(runId)}/work-item`);
  const result = await runHermes(buildPrompt(work), work);
  await postJson(`/api/internal/runs/${encodeURIComponent(runId)}/complete`, {
    status: "completed",
    result
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  try {
    await postJson(`/api/internal/runs/${encodeURIComponent(runId)}/complete`, {
      status: "failed",
      error: message
    });
  } catch (postError) {
    console.error(postError instanceof Error ? postError.message : String(postError));
  }
  process.exit(1);
}
