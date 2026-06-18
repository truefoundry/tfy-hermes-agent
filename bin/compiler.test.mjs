// Unit tests for the deploy-time manifest builders. The CLI exposes
// `init` and `deploy` only — init writes agent config under agents/<name>/,
// deploy compiles manifests to agents/<name>/deployments/.

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import YAML from "yaml";

import {
  artifactCleanupManifest,
  controllerManifest,
  executorManifest,
  executorServiceManifest,
  runtimeManifest,
  runtimeVolumeManifest,
  workerManifest,
  volumeManifest,
  secretsManifest,
  slackManifest,
  planManifests,
  serializeManifest,
  readHermesConfig,
  normalizeExecutorConfig,
  normalizeExecutorBackend,
  normalizeTerminalConfig,
  normalizeSlackInboundArtifactCleanup,
  initExecutorYamlFields,
  daytonaPlatformEnv,
  DEFAULT_HERMES_DAYTONA_SNAPSHOT,
  DEFAULT_DAYTONA_AUTO_STOP_MINUTES,
  DEFAULT_DAYTONA_AUTO_DELETE_INTERVAL,
  requiredSecretKeys,
  isDirectInvocation,
  parseTfyCredentialsJson,
  generateRunTokenSecret,
  parseHermesSecretsLocalContent,
  runTokenNeedsWrite,
  missingRequiredSecretKeys,
  secretGroupNeedsUpdate,
  agentPaths,
  resolveAgentConfigPath
} from "./tfy-hermes-agent.mjs";

const cliPath = fileURLToPath(new URL("./tfy-hermes-agent.mjs", import.meta.url));

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
    agentEmail: "",
    discord: {
      enabled: false,
      allowedUsers: [],
      allowedRoles: [],
      homeChannel: "",
      requireMention: true,
      freeResponseChannels: []
    },
    skills: ["agent-skill:tfy-eo/sai-mlrepo/humanizer:1"],
    mcpServers: ["https://mcp-gateway.example.com/servers/posthog"],
    executor: { backend: "truefoundry-job" },
    ...overrides
  };
}

test("parseTfyCredentialsJson reads host and access_token from tfy login file", () => {
  const creds = parseTfyCredentialsJson(JSON.stringify({
    host: "https://tfy-eo.truefoundry.cloud/",
    access_token: "pat-token",
    refresh_token: "refresh"
  }));
  assert.deepEqual(creds, {
    host: "https://tfy-eo.truefoundry.cloud",
    accessToken: "pat-token"
  });
  assert.equal(parseTfyCredentialsJson("{}"), null);
  assert.equal(parseTfyCredentialsJson(""), null);
});

test("parseHermesSecretsLocalContent reads HERMES-RUN-TOKEN-SECRET from init output", () => {
  const text = "# comment\nHERMES-RUN-TOKEN-SECRET=abc123def456\n";
  assert.equal(parseHermesSecretsLocalContent(text), "abc123def456");
  assert.equal(parseHermesSecretsLocalContent(""), null);
});

test("runTokenNeedsWrite treats placeholders and short values as unset", () => {
  assert.equal(runTokenNeedsWrite(null), true);
  assert.equal(runTokenNeedsWrite("replace-in-truefoundry-only"), true);
  assert.equal(runTokenNeedsWrite("tooshort"), true);
  assert.equal(runTokenNeedsWrite("a".repeat(32)), false);
});

test("secretGroupNeedsUpdate catches newly required keys even with a valid run token", () => {
  const validRunToken = "a".repeat(32);
  const entries = [
    { key: "TFY-API-KEY" },
    { key: "HERMES-RUN-TOKEN-SECRET" },
    { key: "SLACK-BOT-TOKEN" },
    { key: "SLACK-SIGNING-SECRET" }
  ];

  assert.deepEqual(missingRequiredSecretKeys(fakeConfig(), entries), [
    "HERMES-STT-API-KEY",
    "HERMES-TTS-API-KEY"
  ]);
  assert.equal(secretGroupNeedsUpdate(fakeConfig(), entries, validRunToken), true);
});

test("secretGroupNeedsUpdate is false when required keys and run token are valid", () => {
  const validRunToken = "a".repeat(32);
  const entries = requiredSecretKeys(fakeConfig()).map((key) => ({ key }));

  assert.deepEqual(missingRequiredSecretKeys(fakeConfig(), entries), []);
  assert.equal(secretGroupNeedsUpdate(fakeConfig(), entries, validRunToken), false);
});

test("secretGroupNeedsUpdate refreshes TFY-API-KEY from current deploy credentials", () => {
  const validRunToken = "a".repeat(32);
  const entries = requiredSecretKeys(fakeConfig()).map((key) => ({ key }));

  assert.equal(
    secretGroupNeedsUpdate(fakeConfig(), entries, validRunToken, "old-token", "new-token"),
    true
  );
  assert.equal(
    secretGroupNeedsUpdate(fakeConfig(), entries, validRunToken, "same-token", "same-token"),
    false
  );
});

test("generateRunTokenSecret returns 64 hex chars (32 bytes)", () => {
  const secret = generateRunTokenSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.notEqual(generateRunTokenSecret(), generateRunTokenSecret());
});

test("isDirectInvocation follows npm bin symlinks to the CLI entrypoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tfy-hermes-cli-"));
  try {
    const linkPath = path.join(dir, "tfy-hermes-agent");
    await symlink(cliPath, linkPath);
    assert.equal(isDirectInvocation(cliPath), true);
    assert.equal(isDirectInvocation(linkPath), true);
    assert.equal(isDirectInvocation(fileURLToPath(import.meta.url)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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

test("normalizeExecutorConfig defaults to hermes-runtime", () => {
  assert.deepEqual(normalizeExecutorConfig(undefined), { backend: "hermes-runtime" });
  assert.deepEqual(normalizeExecutorConfig("runtime"), { backend: "hermes-runtime" });
  assert.deepEqual(normalizeExecutorConfig("tfy-job"), { backend: "truefoundry-job" });
  assert.deepEqual(normalizeExecutorConfig("truefoundry"), { backend: "truefoundry-job" });
  assert.deepEqual(normalizeExecutorConfig("truefoundry-service"), { backend: "truefoundry-service" });
  assert.deepEqual(normalizeExecutorConfig("service"), { backend: "truefoundry-service" });
});

test("normalizeExecutorConfig rejects extra keys and unknown backends", () => {
  assert.throws(
    () => normalizeExecutorConfig({ backend: "truefoundry-job", snapshot: "x" }),
    /accepts only backend/
  );
  assert.throws(() => normalizeExecutorConfig("kubernetes"), /executor must be hermes-runtime, truefoundry-job, or truefoundry-service/);
  assert.throws(() => normalizeExecutorConfig("daytona"), /executor daytona is not supported/);
});

test("initExecutorYamlFields omits executor for runtime/default and job, writes service + terminal for service mode", () => {
  assert.deepEqual(initExecutorYamlFields("truefoundry-job"), {});
  assert.deepEqual(initExecutorYamlFields(undefined), {});
  assert.deepEqual(initExecutorYamlFields("hermes-runtime"), {});
  assert.deepEqual(initExecutorYamlFields("truefoundry-service"), {
    executor: "truefoundry-service",
    terminal: { backend: "daytona" }
  });
});

test("normalizeTerminalConfig enforces truefoundry-service and daytona-only backend", () => {
  assert.deepEqual(normalizeTerminalConfig("truefoundry-service", undefined), { backend: "daytona" });
  assert.deepEqual(normalizeTerminalConfig("truefoundry-service", { backend: "daytona" }), { backend: "daytona" });
  assert.throws(() => normalizeTerminalConfig("truefoundry-job", { backend: "daytona" }), /not supported when executor is truefoundry-job/);
  assert.throws(() => normalizeTerminalConfig("truefoundry-service", { backend: "ssh" }), /terminal\.backend must be daytona/);
});

test("controllerManifest wires truefoundry-service executor URL", () => {
  const manifest = controllerManifest(fakeConfig({ executor: { backend: "truefoundry-service" } }));
  assert.equal(manifest.env.HERMES_EXECUTOR_BACKEND, "truefoundry-service");
  assert.equal(manifest.env.HERMES_EXECUTOR_URL, "http://devrel-assistant-executor:8788");
  assert.equal(manifest.env.HERMES_EXECUTOR_NAME, undefined);
});

test("controllerManifest wires hermes-runtime URL", () => {
  const manifest = controllerManifest(fakeConfig({ executor: { backend: "hermes-runtime" } }));
  assert.equal(manifest.env.HERMES_EXECUTOR_BACKEND, "hermes-runtime");
  assert.equal(manifest.env.HERMES_RUNTIME_URL, "http://devrel-assistant-runtime:8789");
  assert.equal(manifest.env.HERMES_EXECUTOR_NAME, undefined);
  assert.equal(manifest.env.HERMES_EXECUTOR_URL, undefined);
});

test("requiredSecretKeys adds DAYTONA-API-KEY for truefoundry-service backend", () => {
  assert.deepEqual(requiredSecretKeys(fakeConfig()).sort(), [
    "HERMES-RUN-TOKEN-SECRET",
    "HERMES-STT-API-KEY",
    "HERMES-TTS-API-KEY",
    "SLACK-BOT-TOKEN",
    "SLACK-SIGNING-SECRET",
    "TFY-API-KEY"
  ].sort());
  assert.ok(requiredSecretKeys(fakeConfig({
    executor: { backend: "truefoundry-service" }
  })).includes("DAYTONA-API-KEY"));
  assert.ok(requiredSecretKeys(fakeConfig({
    slackInboundArtifactRepo: "hermes-inbound-artifacts-prod",
    slackInboundArtifactCleanup: { enabled: true }
  })).includes("HERMES-ARTIFACT-CLEANUP-TFY-API-KEY"));
  assert.ok(requiredSecretKeys(fakeConfig({
    agentEmail: "devrel-assistant@agent.email"
  })).includes("AGENTMAIL-API-KEY"));
  assert.ok(requiredSecretKeys(fakeConfig({
    agentEmail: "devrel-assistant@agent.email"
  })).includes("AGENTMAIL-WEBHOOK-SECRET"));
  assert.ok(requiredSecretKeys(fakeConfig({
    discord: {
      enabled: true,
      allowedUsers: [],
      allowedRoles: [],
      homeChannel: "",
      requireMention: true,
      freeResponseChannels: []
    }
  })).includes("DISCORD-BOT-TOKEN"));
  assert.ok(requiredSecretKeys(fakeConfig({
    discord: {
      enabled: true,
      allowedUsers: [],
      allowedRoles: [],
      homeChannel: "",
      requireMention: true,
      freeResponseChannels: []
    }
  })).includes("DISCORD-PUBLIC-KEY"));
});

test("daytonaPlatformEnv exposes platform-owned defaults", () => {
  assert.deepEqual(daytonaPlatformEnv(), {
    apiUrl: "https://app.daytona.io",
    snapshot: DEFAULT_HERMES_DAYTONA_SNAPSHOT,
    autoStopMinutes: DEFAULT_DAYTONA_AUTO_STOP_MINUTES,
    autoDeleteInterval: DEFAULT_DAYTONA_AUTO_DELETE_INTERVAL
  });
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
  assert.equal(manifest.env.HERMES_EXECUTOR_BACKEND, "truefoundry-job");
  assert.equal(manifest.env.HERMES_EXECUTOR_NAME, "devrel-assistant-executor");
  assert.equal(manifest.env.HERMES_AGENT_EMAIL, "");
  assert.equal(manifest.env.DISCORD_ENABLED, "false");
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
  assert.match(manifest.env.HERMES_STT_API_KEY, /HERMES-STT-API-KEY/);
  assert.match(manifest.env.HERMES_TTS_API_KEY, /HERMES-TTS-API-KEY/);
});

test("executorServiceManifest builds a Service for internal dispatch", () => {
  const manifest = executorServiceManifest(fakeConfig({
    executor: { backend: "truefoundry-service" }
  }));
  assert.equal(manifest.type, "service");
  assert.equal(manifest.image.build_spec.command, "node executor/server.mjs");
  assert.equal(manifest.ports[0].port, 8788);
  assert.equal(manifest.ports[0].expose, false);
  assert.match(manifest.env.DAYTONA_API_KEY, /DAYTONA-API-KEY/);
  assert.match(manifest.env.HERMES_RUN_TOKEN_SECRET, /HERMES-RUN-TOKEN-SECRET/);
  assert.equal(manifest.env.HERMES_TERMINAL_BACKEND, "daytona");
  assert.equal(manifest.liveness_probe.config.path, "/api/health");
  assert.equal(manifest.liveness_probe.config.port, 8788);
});

test("runtimeManifest builds the stateful Hermes Runtime Service", () => {
  const config = fakeConfig({ executor: { backend: "hermes-runtime" } });
  const volume = runtimeVolumeManifest(config);
  assert.equal(volume.type, "volume");
  assert.equal(volume.name, "devrel-assistant-runtime-state");

  const manifest = runtimeManifest(config);
  assert.equal(manifest.type, "service");
  assert.equal(manifest.name, "devrel-assistant-runtime");
  assert.equal(manifest.replicas, 1);
  assert.equal(manifest.image.build_spec.dockerfile_path, "Dockerfile.runtime");
  assert.equal(manifest.image.build_spec.command, "node runtime/server.mjs");
  assert.equal(manifest.ports[0].port, 8789);
  assert.equal(manifest.ports[0].expose, false);
  assert.equal(manifest.env.HERMES_STATE_OWNER, "runtime");
  assert.equal(manifest.env.HERMES_RUNTIME_MAX_CONCURRENT_RUNS, "1");
  assert.match(manifest.env.HERMES_RUN_TOKEN_SECRET, /HERMES-RUN-TOKEN-SECRET/);
  assert.equal(manifest.mounts[0].mount_path, "/workspace/.hermes");
  assert.match(manifest.mounts[0].volume_fqn, /devrel-assistant-runtime-state$/);
});

test("workerManifest builds a disposable worker Job", () => {
  const manifest = workerManifest(fakeConfig({ executor: { backend: "hermes-runtime" } }));
  assert.equal(manifest.type, "job");
  assert.equal(manifest.name, "devrel-assistant-worker");
  assert.equal(manifest.image.build_spec.dockerfile_path, "Dockerfile.executor");
  assert.equal(manifest.image.build_spec.command, "node executor/executor.mjs");
  assert.ok(!manifest.mounts || manifest.mounts.length === 0);
});

test("secretsManifest scaffolds the SecretGroup that the controller requires", () => {
  const manifest = secretsManifest(fakeConfig());
  assert.equal(manifest.type, "secret-group");
  assert.deepEqual(Object.keys(manifest.secrets).sort(), [
    "HERMES-RUN-TOKEN-SECRET",
    "HERMES-STT-API-KEY",
    "HERMES-TTS-API-KEY",
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
  assert.ok(manifest.oauth_config.scopes.bot.includes("files:read"));
});

test("controllerManifest emits HERMES_SLACK_INBOUND_ARTIFACT_REPO when configured", () => {
  const manifest = controllerManifest(fakeConfig({ slackInboundArtifactRepo: "slack-inbound" }));
  assert.equal(manifest.env.HERMES_SLACK_INBOUND_ARTIFACT_REPO, "slack-inbound");
});

test("controllerManifest omits HERMES_SLACK_INBOUND_ARTIFACT_REPO when unset", () => {
  const manifest = controllerManifest(fakeConfig());
  assert.equal(manifest.env.HERMES_SLACK_INBOUND_ARTIFACT_REPO, undefined);
});

test("normalizeSlackInboundArtifactCleanup defaults to weekly cleanup when artifact repo is set", () => {
  assert.deepEqual(normalizeSlackInboundArtifactCleanup(null, { enabledByDefault: true }), {
    enabled: true,
    retentionDays: 7,
    schedule: "0 2 * * 0",
    prefix: "slack-run_",
    timezone: "UTC",
    failureAlert: null
  });
  assert.equal(normalizeSlackInboundArtifactCleanup(false, { enabledByDefault: true }).enabled, false);
  assert.deepEqual(normalizeSlackInboundArtifactCleanup({
    failure_alert: {
      type: "email",
      notification_channel: "tfy-eo:notification-channel:ops-email",
      to_emails: ["ops@example.com"]
    }
  }, { enabledByDefault: true }).failureAlert, {
    type: "email",
    notification_channel: "tfy-eo:notification-channel:ops-email",
    to_emails: ["ops@example.com"]
  });
  assert.throws(
    () => normalizeSlackInboundArtifactCleanup({ retention_days: 0 }, { enabledByDefault: true }),
    /retention_days/
  );
  assert.throws(
    () => normalizeSlackInboundArtifactCleanup({ failure_alert: { type: "email", notification_channel: "ops-email" } }, { enabledByDefault: true }),
    /to_emails/
  );
});

test("artifactCleanupManifest builds a weekly cleanup job for Slack inbound artifacts", () => {
  const manifest = artifactCleanupManifest(fakeConfig({
    slackInboundArtifactRepo: "hermes-inbound-artifacts-prod",
    slackInboundArtifactCleanup: {
      enabled: true,
      retentionDays: 7,
      schedule: "0 2 * * 0",
      prefix: "slack-run_",
      timezone: "UTC"
    }
  }));
  assert.equal(manifest.type, "job");
  assert.equal(manifest.name, "devrel-assistant-cleanup");
  assert.deepEqual(manifest.trigger, {
    type: "scheduled",
    schedule: "0 2 * * 0",
    concurrency_policy: "Forbid",
    timezone: "UTC"
  });
  assert.equal(manifest.concurrency_limit, 1);
  assert.equal(manifest.image.build_spec.dockerfile_path, "Dockerfile.controller");
  assert.equal(manifest.image.build_spec.command, "node controller/artifact-cleanup.mjs");
  assert.equal(manifest.alerts, undefined);
  assert.match(manifest.env.TFY_API_KEY, /HERMES-ARTIFACT-CLEANUP-TFY-API-KEY/);
  assert.equal(manifest.env.HERMES_SLACK_INBOUND_ARTIFACT_REPO, "hermes-inbound-artifacts-prod");
  assert.equal(manifest.env.HERMES_ARTIFACT_CLEANUP_RETENTION_DAYS, "7");
  assert.equal(manifest.env.HERMES_ARTIFACT_CLEANUP_PREFIX, "slack-run_");
  assert.equal(manifest.env.HERMES_ARTIFACT_CLEANUP_DRY_RUN, "false");
});

test("artifactCleanupManifest emits failure alerts only when configured", () => {
  const manifest = artifactCleanupManifest(fakeConfig({
    slackInboundArtifactRepo: "hermes-inbound-artifacts-prod",
    slackInboundArtifactCleanup: {
      enabled: true,
      retentionDays: 7,
      schedule: "0 2 * * 0",
      prefix: "slack-run_",
      timezone: "UTC",
      failureAlert: {
        type: "email",
        notification_channel: "tfy-eo:notification-channel:ops-email",
        to_emails: ["ops@example.com"]
      }
    }
  }));
  assert.deepEqual(manifest.alerts, [{
    notification_target: {
      type: "email",
      notification_channel: "tfy-eo:notification-channel:ops-email",
      to_emails: ["ops@example.com"]
    },
    on_start: false,
    on_completion: false,
    on_failure: true
  }]);
});

test("planManifests defaults to volume + controller + executor and never emits secrets unless asked", () => {
  const list = planManifests(fakeConfig(), { includeSecrets: false });
  const filenames = list.map((item) => item.filename);
  assert.deepEqual(filenames, [
    "devrel-assistant-volume.yaml",
    "devrel-assistant-controller.yaml",
    "devrel-assistant-executor.yaml"
  ]);
  // No snapshotter/state files: the snapshotter stack was removed.
  for (const filename of filenames) {
    assert.doesNotMatch(filename, /snapshotter|state/);
  }
});

test("planManifests adds artifact cleanup only when Slack artifact cleanup is enabled", () => {
  assert.ok(!planManifests(fakeConfig({
    slackInboundArtifactRepo: "hermes-inbound-artifacts-prod",
    slackInboundArtifactCleanup: { enabled: false }
  }), { includeSecrets: false }).some((item) => item.filename.endsWith("-artifact-cleanup.yaml")));
  assert.ok(planManifests(fakeConfig({
    slackInboundArtifactRepo: "hermes-inbound-artifacts-prod",
    slackInboundArtifactCleanup: { enabled: true, retentionDays: 7, schedule: "0 2 * * 0", prefix: "slack-run_", timezone: "UTC" }
  }), { includeSecrets: false }).some((item) => item.filename.endsWith("-artifact-cleanup.yaml")));
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

test("agentPaths lays out agents/<name>/ with config, deployments, and secrets local", () => {
  const root = "/tmp/project";
  const paths = agentPaths("devrel-assistant", root);
  assert.equal(paths.handle, "devrel-assistant");
  assert.equal(paths.dir, path.join(root, "agents", "devrel-assistant"));
  assert.equal(paths.config, path.join(root, "agents", "devrel-assistant", "devrel-assistant.yaml"));
  assert.equal(paths.deployments, path.join(root, "agents", "devrel-assistant", "deployments"));
  assert.equal(paths.slackManifest, path.join(root, "agents", "devrel-assistant", "slack-app-manifest.json"));
  assert.equal(paths.secretsLocal, path.join(root, "agents", "devrel-assistant", ".hermes-secrets.local"));
});

test("resolveAgentConfigPath accepts a short name or explicit yaml path", () => {
  const root = "/tmp/project";
  assert.equal(
    resolveAgentConfigPath("devrel-assistant", root),
    path.join(root, "agents", "devrel-assistant", "devrel-assistant.yaml")
  );
  assert.equal(
    resolveAgentConfigPath("agents/devrel-assistant/devrel-assistant.yaml", root),
    path.join(root, "agents", "devrel-assistant", "devrel-assistant.yaml")
  );
});

test("readHermesConfig validates and normalizes the example agent config", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tfy-hermes-config-test-"));
  try {
    const yamlPath = path.join(dir, "agents", "devrel-assistant", "devrel-assistant.yaml");
    await mkdir(path.dirname(yamlPath), { recursive: true });
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
      agent_email: "devrel-assistant@agent.email",
      discord: {
        enabled: true,
        allowed_users: ["123456789012345678"],
        allowed_roles: ["234567890123456789"],
        home_channel: "345678901234567890",
        require_mention: false,
        free_response_channels: ["456789012345678901"]
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
    assert.equal(parsed.agentEmail, "devrel-assistant@agent.email");
    assert.equal(parsed.discord.enabled, true);
    assert.deepEqual(parsed.discord.allowedUsers, ["123456789012345678"]);
    assert.deepEqual(parsed.discord.allowedRoles, ["234567890123456789"]);
    assert.equal(parsed.discord.homeChannel, "345678901234567890");
    assert.equal(parsed.discord.requireMention, false);
    assert.deepEqual(parsed.discord.freeResponseChannels, ["456789012345678901"]);
    assert.equal(parsed.slackInboundArtifactCleanup.enabled, false);
    // sanity-check that the parsed config flows through the manifest builders.
    const controller = controllerManifest(parsed);
    assert.equal(controller.env.TFY_API_KEY, "tfy-secret://tfy-eo:devrel-assistant-hermes-secrets:TFY-API-KEY");
    assert.equal(controller.env.HERMES_AGENT_EMAIL, "devrel-assistant@agent.email");
    assert.equal(controller.env.AGENTMAIL_API_KEY, "tfy-secret://tfy-eo:devrel-assistant-hermes-secrets:AGENTMAIL-API-KEY");
    assert.equal(controller.env.DISCORD_ENABLED, "true");
    assert.equal(controller.env.DISCORD_ALLOWED_USERS, "123456789012345678");
    assert.equal(controller.env.DISCORD_REQUIRE_MENTION, "false");
    // Lingering reference to the removed shared HARNESS_INTERNAL_TOKEN must not exist.
    assert.equal(controller.env.HARNESS_INTERNAL_TOKEN, undefined);
    await readFile(yamlPath, "utf8"); // ensure the test file is still on disk
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readHermesConfig supports a small user-authored manifest with deploy-time defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tfy-hermes-min-config-test-"));
  const previousWorkspace = process.env.TFY_WORKSPACE_FQN;
  const previousHost = process.env.TFY_HOST;
  const previousGateway = process.env.OPENAI_BASE_URL;
  try {
    process.env.TFY_WORKSPACE_FQN = "tfy-ea-dev-eo-az:sai-ws";
    process.env.TFY_HOST = "https://tfy-eo.truefoundry.cloud";
    delete process.env.OPENAI_BASE_URL;

    const yamlPath = path.join(dir, "hermes.yaml");
    await writeFile(yamlPath, YAML.stringify({
      name: "minimal-agent",
      description: "Small manifest",
      instructions: "Be direct.",
      skills: ["agent-skill:tfy-eo/sai-mlrepo/humanizer:1"],
      mcp_servers: ["https://mcp-gateway.example.com/servers/posthog"]
    }));

    const parsed = await readHermesConfig(yamlPath);
    assert.equal(parsed.name, "minimal-agent");
    assert.equal(parsed.workspaceFqn, "tfy-ea-dev-eo-az:sai-ws");
    assert.equal(parsed.host.url, "https://minimal-agent-sai-ws.ml.tfy-eo.truefoundry.cloud");
    assert.equal(parsed.gatewayUrl, "https://gateway.truefoundry.ai");
    assert.equal(parsed.model, "openai-main/gpt-5.5");
    assert.equal(parsed.secrets, "minimal-agent-hermes-secrets");
    assert.equal(parsed.executor.backend, "hermes-runtime");
    assert.deepEqual(parsed.skills, ["agent-skill:tfy-eo/sai-mlrepo/humanizer:1"]);
    assert.deepEqual(parsed.mcpServers, ["https://mcp-gateway.example.com/servers/posthog"]);
  } finally {
    if (previousWorkspace == null) delete process.env.TFY_WORKSPACE_FQN;
    else process.env.TFY_WORKSPACE_FQN = previousWorkspace;
    if (previousHost == null) delete process.env.TFY_HOST;
    else process.env.TFY_HOST = previousHost;
    if (previousGateway == null) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousGateway;
    await rm(dir, { recursive: true, force: true });
  }
});

test("checked-in tfy-eo test agent example stays deployable", async () => {
  const exampleConfig = fileURLToPath(new URL("../examples/tfy-eo-test-agent/hermes-test-agent.yaml", import.meta.url));
  const deploymentsDir = fileURLToPath(new URL("../examples/tfy-eo-test-agent/deployments/", import.meta.url));
  const slackManifestPath = fileURLToPath(new URL("../examples/tfy-eo-test-agent/slack-app-manifest.json", import.meta.url));

  const parsed = await readHermesConfig(exampleConfig);
  assert.equal(parsed.name, "hermes-test-agent");
  assert.equal(parsed.workspaceFqn, "tfy-ea-dev-eo-az:sai-ws");
  assert.equal(parsed.tenant, "tfy-eo");
  assert.equal(parsed.host.url, "https://hermes-test-agent-sai-ws.ml.tfy-eo.truefoundry.cloud");
  assert.equal(parsed.gatewayUrl, "https://gateway.truefoundry.ai");
  assert.equal(parsed.model, "openai-main/gpt-5.5");
  assert.equal(parsed.secrets, "hermes-test-agent-secrets");
  assert.equal(parsed.executor.backend, "hermes-runtime");
  assert.equal(parsed.slackInboundArtifactRepo, "hermes-inbound-artifacts-prod");
  assert.deepEqual(parsed.slackInboundArtifactCleanup, {
    enabled: true,
    retentionDays: 7,
    schedule: "0 2 * * 0",
    prefix: "slack-run_",
    timezone: "UTC",
    failureAlert: null
  });

  const planned = planManifests(parsed, { includeSecrets: false });
  assert.deepEqual(planned.map((item) => item.filename), [
    "hermes-test-agent-volume.yaml",
    "hermes-test-agent-runtime-volume.yaml",
    "hermes-test-agent-runtime.yaml",
    "hermes-test-agent-worker.yaml",
    "hermes-test-agent-controller.yaml",
    "hermes-test-agent-artifact-cleanup.yaml"
  ]);

  const controller = planned.find((item) => item.filename.endsWith("-controller.yaml")).manifest;
  assert.equal(controller.env.HERMES_EXECUTOR_BACKEND, "hermes-runtime");
  assert.equal(controller.env.HERMES_RUNTIME_URL, "http://hermes-test-agent-runtime:8789");
  assert.equal(controller.env.TFY_API_KEY, "tfy-secret://tfy-eo:hermes-test-agent-secrets:TFY-API-KEY");
  assert.equal(controller.env.HERMES_RUN_TOKEN_SECRET, "tfy-secret://tfy-eo:hermes-test-agent-secrets:HERMES-RUN-TOKEN-SECRET");
  assert.equal(controller.env.SLACK_BOT_TOKEN, "tfy-secret://tfy-eo:hermes-test-agent-secrets:SLACK-BOT-TOKEN");
  assert.equal(controller.env.SLACK_SIGNING_SECRET, "tfy-secret://tfy-eo:hermes-test-agent-secrets:SLACK-SIGNING-SECRET");

  for (const item of planned) {
    const generated = YAML.parse(await readFile(path.join(deploymentsDir, item.filename), "utf8"));
    assert.deepEqual(generated, item.manifest);
  }

  const generatedSlackManifest = JSON.parse(await readFile(slackManifestPath, "utf8"));
  assert.deepEqual(generatedSlackManifest, slackManifest(parsed));
});
