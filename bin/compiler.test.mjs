// Unit tests for the deploy-time manifest builders. The CLI exposes
// `init` and `deploy` only (DESIGN.md: "no compile, no validate,
// no intermediate YAML files on disk by default"), so we exercise the
// pure helpers directly instead of shelling out to the binary.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

import {
  controllerManifest,
  executorManifest,
  volumeManifest,
  secretsManifest,
  slackManifest,
  planManifests,
  serializeManifest,
  readHermesConfig
} from "./tfy-hermes-agent.mjs";

function fakeConfig(overrides = {}) {
  return {
    name: "devrel-assistant",
    workspaceFqn: "tfy-aws-use1:sai-ws",
    tenant: "tfy-eo",
    host: {
      url: "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud",
      hostname: "devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud"
    },
    description: "DevRel helper",
    instructions: "Be concise.",
    model: "openai-main/gpt-5.5",
    gatewayUrl: "https://your-openai-compatible-gateway/v1",
    secrets: "devrel-assistant-hermes-secrets",
    slack: { allowedChannels: ["C0123456789"], allowedUsers: ["U0123456789"] },
    slackTeamId: "",
    skills: ["agent-skill:tfy-eo/sai-mlrepo/humanizer:1"],
    mcpServers: ["https://mcp-gateway.example.com/servers/posthog"],
    ...overrides
  };
}

test("volumeManifest provisions one RWO controller PVC at the configured workspace", () => {
  const manifest = volumeManifest(fakeConfig());
  assert.equal(manifest.type, "volume");
  assert.equal(manifest.name, "devrel-assistant-data");
  assert.equal(manifest.workspace_fqn, "tfy-aws-use1:sai-ws");
  assert.equal(manifest.config.type, "dynamic");
  assert.deepEqual(manifest.config.access_modes, ["ReadWriteOnce"]);
  assert.equal(manifest.config.storage_class, "default");
  assert.ok(Number.isFinite(manifest.config.size) && manifest.config.size > 0);
});

test("controllerManifest builds a single-replica Service pointing at Dockerfile.controller", () => {
  const manifest = controllerManifest(fakeConfig());
  assert.equal(manifest.type, "service");
  assert.equal(manifest.replicas, 1);
  assert.equal(manifest.image.build_spec.dockerfile_path, "Dockerfile.controller");
  // The /data volume mount is the only persistent storage in the stack.
  assert.equal(manifest.mounts.length, 1);
  assert.equal(manifest.mounts[0].mount_path, "/data");
  assert.match(manifest.mounts[0].volume_fqn, /devrel-assistant-data$/);
  // Per-run HMAC secret must come from the SecretGroup (no shared internal token).
  assert.match(manifest.env.HERMES_RUN_TOKEN_SECRET, /HERMES-RUN-TOKEN-SECRET/);
  // TFY API key gates inbound /v1/* and is also reused for the outbound LLM gateway call;
  // there is no separate HERMES_OPENAI_API_KEY env.
  assert.equal(manifest.env.HERMES_OPENAI_API_KEY, undefined);
  assert.match(manifest.env.TFY_API_KEY, /TFY-API-KEY/);
  // Health probe matches the controller's /api/health surface.
  assert.equal(manifest.liveness_probe.config.path, "/api/health");
  // Executor reference is wired so the controller can dispatch turns.
  assert.equal(manifest.env.HERMES_EXECUTOR_NAME, "devrel-assistant-executor");
});

test("executorManifest builds a Job template that runs the executor and mounts no volume", () => {
  const manifest = executorManifest(fakeConfig());
  assert.equal(manifest.type, "job");
  assert.equal(manifest.image.build_spec.dockerfile_path, "Dockerfile.executor");
  assert.equal(manifest.image.build_spec.command, "node executor/executor.mjs");
  // Executor runs against an ephemeral container FS — no PVC mount.
  assert.ok(!manifest.mounts || manifest.mounts.length === 0);
  assert.equal(manifest.env.HERMES_HOME, "/workspace/.hermes");
  // OPENAI_API_KEY is referenced via the SecretGroup, never inline.
  assert.match(manifest.env.OPENAI_API_KEY, /^tfy-secret:\/\//);
});

test("secretsManifest scaffolds the SecretGroup that DESIGN.md requires", () => {
  const manifest = secretsManifest(fakeConfig());
  assert.equal(manifest.type, "secret-group");
  assert.deepEqual(Object.keys(manifest.secrets).sort(), [
    "HERMES-RUN-TOKEN-SECRET",
    "SLACK-BOT-TOKEN",
    "SLACK-SIGNING-SECRET",
    "TFY-API-KEY"
  ]);
  // None of the scaffolded values should be a real-looking secret.
  for (const value of Object.values(manifest.secrets)) {
    assert.equal(value, "replace-in-truefoundry-only");
  }
});

test("slackManifest points Slack at /slack/events and /slack/interactions on the controller host", () => {
  const manifest = slackManifest(fakeConfig());
  assert.equal(
    manifest.settings.event_subscriptions.request_url,
    "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud/slack/events"
  );
  assert.equal(
    manifest.settings.interactivity.request_url,
    "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud/slack/interactions"
  );
  assert.equal(manifest.settings.socket_mode_enabled, false);
  assert.ok(manifest.oauth_config.scopes.bot.includes("chat:write"));
});

test("planManifests defaults to volume + controller + executor and never emits secrets unless asked", () => {
  const list = planManifests(fakeConfig(), { includeSecrets: false });
  const filenames = list.map((item) => item.filename);
  assert.deepEqual(filenames, [
    "devrel-assistant-volume.yaml",
    "devrel-assistant-controller.yaml",
    "devrel-assistant-executor.yaml"
  ]);
  // No snapshotter/state files: DESIGN.md deleted the entire snapshotter stack.
  for (const filename of filenames) {
    assert.doesNotMatch(filename, /snapshotter|state/);
  }
});

test("planManifests with includeSecrets prepends the scaffold SecretGroup", () => {
  const list = planManifests(fakeConfig(), { includeSecrets: true });
  assert.equal(list[0].filename, "devrel-assistant-secrets.scaffold.yaml");
  assert.equal(list[0].manifest.type, "secret-group");
});

test("serializeManifest emits YAML for .yaml filenames and JSON for .json filenames", () => {
  const yamlText = serializeManifest({ a: 1, b: ["x"] }, "thing.yaml");
  assert.equal(typeof yamlText, "string");
  assert.deepEqual(YAML.parse(yamlText), { a: 1, b: ["x"] });

  const jsonText = serializeManifest({ a: 1 }, "thing.json");
  assert.deepEqual(JSON.parse(jsonText), { a: 1 });
});

test("readHermesConfig validates and normalizes the example hermes.yaml", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tfy-hermes-config-test-"));
  try {
    const yamlPath = path.join(dir, "agent.hermes.yaml");
    // Mirror examples/agent.hermes.yaml with a deterministic host override
    // so the test does not rely on TFY_HOST tenant inference.
    const config = {
      name: "devrel-assistant",
      workspace_fqn: "tfy-aws-use1:sai-ws",
      host: "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud",
      description: "DevRel helper",
      instructions: "Be concise.",
      model: "openai-main/gpt-5.5",
      gateway_url: "https://your-openai-compatible-gateway/v1",
      secrets: "devrel-assistant-hermes-secrets",
      slack: {
        allowed_channels: ["C0123456789"],
        allowed_users: ["U0123456789"]
      },
      skills: ["agent-skill:tfy-eo/sai-mlrepo/humanizer:1"],
      mcp_servers: ["https://mcp-gateway.example.com/servers/posthog"]
    };
    await writeFile(yamlPath, YAML.stringify(config));

    const parsed = await readHermesConfig(yamlPath);
    assert.equal(parsed.name, "devrel-assistant");
    assert.equal(parsed.workspaceFqn, "tfy-aws-use1:sai-ws");
    assert.equal(parsed.tenant, "tfy-eo");
    assert.equal(parsed.host.url, "https://devrel-assistant-sai-ws.ml.tfy-eo.truefoundry.cloud");
    assert.equal(parsed.gatewayUrl, "https://your-openai-compatible-gateway/v1");
    assert.deepEqual(parsed.skills, ["agent-skill:tfy-eo/sai-mlrepo/humanizer:1"]);
    assert.deepEqual(parsed.slack.allowedChannels, ["C0123456789"]);
    assert.deepEqual(parsed.slack.allowedUsers, ["U0123456789"]);
    // sanity-check that the parsed config flows through the manifest builders.
    const controller = controllerManifest(parsed);
    assert.equal(controller.env.TFY_API_KEY, "tfy-secret://tfy-eo:devrel-assistant-hermes-secrets:TFY-API-KEY");
    // Lingering reference to the removed shared HARNESS_INTERNAL_TOKEN must not exist.
    assert.equal(controller.env.HARNESS_INTERNAL_TOKEN, undefined);
    await readFile(yamlPath, "utf8"); // ensure the test file is still on disk
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
