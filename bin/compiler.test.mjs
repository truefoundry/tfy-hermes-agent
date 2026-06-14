import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["bin/tfy-hermes-agent.mjs", ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TFY_SECRET_TENANT: "tfy-eo",
        TFY_HOST: "https://tfy-eo.truefoundry.cloud",
        ...env
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`CLI exited ${code}: ${stderr || stdout}`));
    });
  });
}

test("compiler writes canonical component manifests and Slack app manifest", async () => {
  const outDir = await mkdtemp(path.join(tmpdir(), "tfy-hermes-compile-test-"));
  try {
    await runCli(["compile", "examples/agent.hermes.yaml", "--out", outDir]);

    const secrets = YAML.parse(await readFile(path.join(outDir, "devrel-assistant-secrets.scaffold.yaml"), "utf8"));
    assert.deepEqual(Object.keys(secrets.secrets), [
      "TFY_API_KEY",
      "HARNESS-INTERNAL-TOKEN",
      "SLACK-BOT-TOKEN",
      "SLACK-SIGNING-SECRET"
    ]);

    const controller = YAML.parse(await readFile(path.join(outDir, "devrel-assistant-controller.yaml"), "utf8"));
    assert.equal(controller.image.build_spec.dockerfile_path, "Dockerfile.controller");
    assert.equal(controller.env.TFY_HOST, "https://tfy-eo.truefoundry.cloud");
    assert.match(controller.env.TFY_API_KEY, /^tfy-secret:\/\//);
    assert.equal(controller.env.HERMES_EXECUTOR_NAME, "devrel-assistant-executor");

    const executor = YAML.parse(await readFile(path.join(outDir, "devrel-assistant-executor.yaml"), "utf8"));
    assert.equal(executor.image.build_spec.dockerfile_path, "Dockerfile.executor");
    assert.equal(executor.image.build_spec.command, "node executor/executor.mjs");
    assert.equal(executor.env.TFY_HOST, "https://tfy-eo.truefoundry.cloud");
    assert.equal(executor.env.OPENAI_BASE_URL, "https://your-openai-compatible-gateway/v1");
    assert.match(executor.env.OPENAI_API_KEY, /^tfy-secret:\/\//);

    const snapshotter = YAML.parse(await readFile(path.join(outDir, "devrel-assistant-snapshotter.yaml"), "utf8"));
    assert.equal(snapshotter.image.build_spec.dockerfile_path, "Dockerfile.snapshotter");
    assert.equal(snapshotter.image.build_spec.command, "python snapshotter/snapshotter.py");

    const slackManifest = JSON.parse(await readFile(path.join(outDir, "slack-app-manifest.json"), "utf8"));
    assert.equal(slackManifest.settings.event_subscriptions.request_url, "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud/slack/events");
    assert.equal(slackManifest.settings.interactivity.request_url, "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud/slack/interactions");
    assert.equal(slackManifest.settings.socket_mode_enabled, false);
    assert.ok(slackManifest.oauth_config.scopes.bot.includes("chat:write"));
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
