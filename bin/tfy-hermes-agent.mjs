#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import YAML from "yaml";

const DEFAULT_REPO_URL = "https://github.com/truefoundry/tfy-hermes-agent";
const DEFAULT_SOURCE_REF = "main";
const DEFAULT_MODEL = "openai-main/gpt-5.5";
const REQUIRED_SECRET_KEYS = [
  "TFY_GATEWAY_URL",
  "TFY_API_KEY",
  "TFY_HOST",
  "HARNESS-INTERNAL-TOKEN",
  "SLACK-BOT-TOKEN",
  "SLACK-SIGNING-SECRET"
];

function usage() {
  return [
    "Usage:",
    "  tfy-hermes-agent validate <hermes.yaml> [--update] [--skip-live-checks]",
    "  tfy-hermes-agent compile <hermes.yaml> [--out .hermes-rendered]",
    "  tfy-hermes-agent slack-manifest <hermes.yaml> [--format json|yaml]",
    "  tfy-hermes-agent deploy <hermes.yaml> [--out .hermes-rendered] [--update]",
    "",
    "Live checks and deploy require TFY_BASE_URL/TFY_HOST and TFY_API_KEY."
  ].join("\n");
}

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const key = item.slice(2);
    if (key === "update" || key === "skip-live-checks") {
      flags[key] = true;
    } else {
      const value = rest[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for --${key}`);
      flags[key] = value;
      index += 1;
    }
  }
  return { command, file, flags };
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function slugifyName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) {
    throw new Error("name must be 3-63 chars and use lowercase letters, numbers, and hyphens");
  }
  return name;
}

function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("host is required");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error("host must be a valid URL or hostname");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("host must use http or https");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("host must not include a path, query, or fragment");
  return {
    url: `${parsed.protocol}//${parsed.hostname}`,
    hostname: parsed.hostname
  };
}

function tenantFromHost(hostname) {
  const match = hostname.match(/(?:^|\.)ml\.([a-z0-9-]+)\.truefoundry\.cloud$/i)
    || hostname.match(/(?:^|\.)([a-z0-9-]+)\.truefoundry\.cloud$/i);
  if (match?.[1]) return match[1];
  if (process.env.TFY_SECRET_TENANT) return process.env.TFY_SECRET_TENANT;
  throw new Error("could not derive secret tenant from host; set TFY_SECRET_TENANT");
}

function stringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function validateSkillFqn(value) {
  return /^agent-skill:[a-z0-9-]+\/[a-z0-9._-]+\/[a-z0-9._-]+:\d+$/i.test(value);
}

function validateRegistryName(value, label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/.test(value)) {
    throw new Error(`${label} must use letters, numbers, dots, underscores, or hyphens`);
  }
}

function normalizeMcpUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(`mcp_servers entry is not a valid URL: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`mcp_servers URL must use http or https: ${value}`);
  return parsed.toString().replace(/\/$/, "");
}

async function readHermesConfig(file) {
  if (!file) throw new Error("missing hermes.yaml path");
  const config = YAML.parse(await readFile(file, "utf8"));
  assertObject(config, "hermes.yaml");

  const name = slugifyName(config.name);
  const host = normalizeHost(config.host);
  const workspaceFqn = String(config.workspace_fqn || "").trim();
  if (!workspaceFqn.includes(":")) throw new Error("workspace_fqn is required and must look like cluster:workspace");

  const secrets = String(config.secrets || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/.test(secrets)) throw new Error("secrets must be the TrueFoundry SecretGroup name");

  const skills = stringList(config.skills, "skills");
  const invalidSkills = skills.filter((skill) => !validateSkillFqn(skill));
  if (invalidSkills.length) throw new Error(`skills must be agent-skill FQNs: ${invalidSkills.join(", ")}`);

  const snapshotMlRepo = String(config.snapshot_ml_repo || name).trim();
  const snapshotArtifactName = String(config.snapshot_artifact_name || `${name}-state-snapshots`).trim();
  validateRegistryName(snapshotMlRepo, "snapshot_ml_repo");
  validateRegistryName(snapshotArtifactName, "snapshot_artifact_name");

  return {
    name,
    workspaceFqn,
    host,
    tenant: tenantFromHost(host.hostname),
    description: String(config.description || "").trim(),
    instructions: String(config.instructions || "").trim(),
    model: String(config.model || DEFAULT_MODEL).trim(),
    secrets,
    snapshotMlRepo,
    snapshotArtifactName,
    skills,
    mcpServers: stringList(config.mcp_servers, "mcp_servers").map(normalizeMcpUrl)
  };
}

function names(config) {
  return {
    secrets: config.secrets,
    state: `${config.name}-state`,
    controller: `${config.name}-controller`,
    executor: `${config.name}-executor`,
    snapshotter: `${config.name}-snapshotter`
  };
}

function secretRef(config, key) {
  return `tfy-secret://${config.tenant}:${config.secrets}:${key}`;
}

function csv(values) {
  return values.join(",");
}

function baseTfyUrl() {
  return (process.env.TFY_BASE_URL || process.env.TFY_HOST || "").replace(/\/+$/, "");
}

function controlPlaneUrl(config) {
  return baseTfyUrl() || `https://${config.tenant}.truefoundry.cloud`;
}

function image(dockerfilePath, command) {
  const sourceRef = process.env.HERMES_SOURCE_REF || DEFAULT_SOURCE_REF;
  const sourceBranch = process.env.HERMES_SOURCE_BRANCH || sourceRef;
  const manifest = {
    type: "build",
    build_source: {
      type: "git",
      repo_url: process.env.HERMES_REPO_URL || DEFAULT_REPO_URL,
      branch_name: sourceBranch,
      ref: sourceRef
    },
    build_spec: {
      type: "dockerfile",
      dockerfile_path: dockerfilePath,
      build_context_path: "."
    }
  };
  if (command) manifest.build_spec.command = command;
  return manifest;
}

function secretsManifest(config) {
  return {
    name: config.secrets,
    type: "secret-group",
    workspace_fqn: config.workspaceFqn,
    secrets: {
      TFY_GATEWAY_URL: "https://your-openai-compatible-gateway/v1",
      TFY_API_KEY: "replace-in-truefoundry-only",
      TFY_HOST: controlPlaneUrl(config),
      "HARNESS-INTERNAL-TOKEN": randomBytes(32).toString("hex"),
      "SLACK-BOT-TOKEN": "xoxb-replace-in-truefoundry-only",
      "SLACK-SIGNING-SECRET": "replace-in-truefoundry-only"
    }
  };
}

function stateManifest(config) {
  return {
    name: names(config).state,
    type: "volume",
    workspace_fqn: config.workspaceFqn,
    config: {
      type: "dynamic",
      size: 20,
      storage_class: "managed-csi-premium"
    }
  };
}

function controllerManifest(config) {
  const resource = names(config);
  return {
    name: resource.controller,
    type: "service",
    workspace_fqn: config.workspaceFqn,
    image: image("Dockerfile.control-api"),
    resources: {
      cpu_request: 0.25,
      cpu_limit: 1,
      memory_request: 512,
      memory_limit: 1024,
      ephemeral_storage_request: 2000,
      ephemeral_storage_limit: 4000
    },
    replicas: 1,
    env: {
      NODE_ENV: "production",
      PORT: "8787",
      HOME: "/data/home",
      HARNESS_STATE_DIR: "/data/state",
      PUBLIC_BASE_URL: config.host.url,
      HARNESS_API_URL: config.host.url,
      TFY_BASE_URL: secretRef(config, "TFY_HOST"),
      TFY_HOST: secretRef(config, "TFY_HOST"),
      TFY_SERVICE_API_URL: secretRef(config, "TFY_HOST"),
      TFY_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_PLATFORM_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_GATEWAY_BASE_URL: secretRef(config, "TFY_GATEWAY_URL"),
      TFY_GATEWAY_API_KEY: secretRef(config, "TFY_API_KEY"),
      HARNESS_INTERNAL_TOKEN: secretRef(config, "HARNESS-INTERNAL-TOKEN"),
      HERMES_OPENAI_API_KEY: secretRef(config, "TFY_API_KEY"),
      SLACK_BOT_TOKEN: secretRef(config, "SLACK-BOT-TOKEN"),
      SLACK_SIGNING_SECRET: secretRef(config, "SLACK-SIGNING-SECRET"),
      TFY_SECRET_TENANT: config.tenant,
      TFY_WORKSPACE_FQN: config.workspaceFqn,
      HERMES_AGENT_HANDLE: config.name,
      HERMES_AGENT_NAME: config.name,
      HERMES_AGENT_DESCRIPTION: config.description,
      HERMES_AGENT_INSTRUCTIONS: config.instructions,
      HERMES_AGENT_SKILLS: csv(config.skills),
      HERMES_AGENT_MCP_SERVERS: csv(config.mcpServers),
      HERMES_AGENT_SECRET_REFS: "",
      HARNESS_MODEL: config.model,
      HERMES_INFERENCE_MODEL: config.model,
      HERMES_JOB_APPLICATION_NAME: resource.executor,
      HERMES_SLACK_RUN_TIMEOUT_MS: "120000",
      HERMES_SLACK_STATUS_TEXT: "is thinking...",
      HERMES_SLACK_LOADING_MESSAGES: "Reading the thread|Planning the next step|Running Hermes|Preparing the reply",
      HERMES_SLACK_STREAM_CHUNK_DELAY_MS: "120",
      HERMES_SLACK_CREATE_USERGROUPS: "false",
      HERMES_SLACK_REQUIRE_CHANNEL_DEPLOYMENT: "false",
      HARNESS_EXECUTION_RUNNER: "truefoundry-jobs",
      HARNESS_CREDENTIAL_BROKER: "truefoundry-secretgroup",
      HARNESS_SANDBOX_PROVIDER: "daytona",
      HARNESS_SANDBOX_SCOPE: "agent-session",
      HARNESS_SANDBOX_IDLE_TIMEOUT_SECONDS: "900"
    },
    ports: [{ port: 8787, protocol: "TCP", expose: true, host: config.host.hostname, app_protocol: "http" }],
    mounts: [{ type: "volume", mount_path: "/data", volume_fqn: `tfy-volume://${config.workspaceFqn}:${resource.state}` }],
    liveness_probe: { config: { type: "http", path: "/api/health", port: 8787, scheme: "HTTP" }, initial_delay_seconds: 20, period_seconds: 15, timeout_seconds: 5, failure_threshold: 5 },
    readiness_probe: { config: { type: "http", path: "/api/health", port: 8787, scheme: "HTTP" }, initial_delay_seconds: 20, period_seconds: 15, timeout_seconds: 5, failure_threshold: 5 },
    rollout_strategy: { type: "rolling_update", max_surge_percentage: 0, max_unavailable_percentage: 100 }
  };
}

function executorManifest(config) {
  return {
    name: names(config).executor,
    type: "job",
    workspace_fqn: config.workspaceFqn,
    trigger: { type: "manual" },
    concurrency_limit: 20,
    retries: 0,
    image: image("Dockerfile.turn-runner", "node runner/turn-runner.mjs"),
    resources: {
      cpu_request: 0.1,
      cpu_limit: 2,
      memory_request: 2048,
      memory_limit: 4096,
      ephemeral_storage_request: 8000,
      ephemeral_storage_limit: 16000
    },
    env: {
      HOME: "/workspace",
      HERMES_HOME: "/workspace/.hermes",
      HARNESS_WORKSPACE_ROOT: "/workspace",
      HARNESS_CONTROL_API_URL: config.host.url,
      HARNESS_INTERNAL_TOKEN: secretRef(config, "HARNESS-INTERNAL-TOKEN"),
      HARNESS_TURN_TIMEOUT_MS: "600000",
      TFY_SERVICE_API_URL: secretRef(config, "TFY_HOST"),
      TFY_PLATFORM_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_BASE_URL: secretRef(config, "TFY_GATEWAY_URL"),
      TFY_GATEWAY_BASE_URL: secretRef(config, "TFY_GATEWAY_URL"),
      TFY_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_GATEWAY_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_SECRET_TENANT: config.tenant,
      TFY_WORKSPACE_FQN: config.workspaceFqn,
      HERMES_INFERENCE_MODEL: config.model,
      HERMES_AGENT_SKILLS: csv(config.skills),
      HERMES_AGENT_MCP_SERVERS: csv(config.mcpServers),
      HARNESS_EXECUTION_RUNNER: "truefoundry-jobs",
      HARNESS_PLATFORM_PROVIDER: "truefoundry",
      HARNESS_EXECUTION_PROVIDER: "harness-runtime-router",
      HARNESS_RUNTIME_ADAPTER: "harness-runtime-router",
      HARNESS_SANDBOX_PROVIDER: "daytona"
    }
  };
}

function snapshotterManifest(config) {
  const resource = names(config);
  return {
    name: resource.snapshotter,
    type: "job",
    workspace_fqn: config.workspaceFqn,
    trigger: { type: "manual" },
    concurrency_limit: 1,
    retries: 1,
    image: image("Dockerfile.snapshotter", "node snapshotter/snapshotter.mjs"),
    resources: {
      cpu_request: 0.1,
      cpu_limit: 0.5,
      memory_request: 256,
      memory_limit: 512,
      ephemeral_storage_request: 1000,
      ephemeral_storage_limit: 2000
    },
    env: {
      HARNESS_STATE_DIR: "/data/state",
      HERMES_SNAPSHOT_DIR: "/data/snapshots",
      HERMES_SNAPSHOT_RETAIN_COUNT: "50",
      HERMES_SNAPSHOT_ML_REPO: config.snapshotMlRepo,
      HERMES_SNAPSHOT_ARTIFACT_NAME: config.snapshotArtifactName,
      HERMES_AGENT_HANDLE: config.name,
      TFY_BASE_URL: secretRef(config, "TFY_HOST"),
      TFY_HOST: secretRef(config, "TFY_HOST"),
      TFY_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_PLATFORM_API_KEY: secretRef(config, "TFY_API_KEY"),
      TFY_SECRET_TENANT: config.tenant,
      TFY_WORKSPACE_FQN: config.workspaceFqn
    },
    mounts: [{ type: "volume", mount_path: "/data", volume_fqn: `tfy-volume://${config.workspaceFqn}:${resource.state}` }]
  };
}

function titleFromName(name) {
  return name.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function slackManifest(config) {
  const appName = titleFromName(config.name);
  return {
    display_information: {
      name: appName,
      description: "TrueFoundry Hermes agent in Slack",
      long_description: `Use ${appName} to access one TrueFoundry-hosted Hermes agent directly inside Slack. The app supports assistant threads, status updates while work is running, streamed replies, channel mentions, direct messages, and feedback controls.`,
      background_color: "#111827"
    },
    features: {
      assistant_view: {
        assistant_description: config.description || "Ask this Hermes agent to reason through work, summarize Slack context, and run configured tools.",
        suggested_prompts: [
          { title: "Summarize this thread", message: "Summarize the current Slack context and suggest next steps." },
          { title: "Plan an implementation", message: "Turn this request into a concise implementation plan." },
          { title: "Review recent context", message: "Review the visible context and call out risks or missing information." }
        ]
      },
      bot_user: { display_name: config.name, always_online: true }
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "assistant:write",
          "channels:history",
          "channels:join",
          "channels:read",
          "chat:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "mpim:history",
          "mpim:read",
          "team:read",
          "users:read"
        ]
      }
    },
    settings: {
      event_subscriptions: {
        request_url: `${config.host.url}/slack/events`,
        bot_events: [
          "app_mention",
          "assistant_thread_context_changed",
          "assistant_thread_started",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim"
        ]
      },
      interactivity: { is_enabled: true, request_url: `${config.host.url}/slack/interactions` },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false
    }
  };
}

function allManifests(config) {
  return {
    [`${config.name}-secrets.scaffold.yaml`]: secretsManifest(config),
    [`${config.name}-state.yaml`]: stateManifest(config),
    [`${config.name}-controller.yaml`]: controllerManifest(config),
    [`${config.name}-executor.yaml`]: executorManifest(config),
    [`${config.name}-snapshotter.yaml`]: snapshotterManifest(config),
    "slack-app-manifest.json": slackManifest(config)
  };
}

async function writeOutput(file, value) {
  const text = file.endsWith(".json") ? `${JSON.stringify(value, null, 2)}\n` : YAML.stringify(value, { lineWidth: 0 });
  await writeFile(file, text);
}

async function compile(config, outDir) {
  await mkdir(outDir, { recursive: true });
  const files = [];
  for (const [name, manifest] of Object.entries(allManifests(config))) {
    const target = path.join(outDir, name);
    await writeOutput(target, manifest);
    files.push(target);
  }
  return files;
}

function liveChecksAvailable() {
  return Boolean(baseTfyUrl() && process.env.TFY_API_KEY);
}

async function tfyFetch(apiPath, options = {}) {
  if (!liveChecksAvailable()) throw new Error("TFY_BASE_URL/TFY_HOST and TFY_API_KEY are required for live checks");
  const res = await fetch(`${baseTfyUrl()}${apiPath}`, {
    ...options,
    headers: {
      authorization: `Bearer ${process.env.TFY_API_KEY}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`TrueFoundry ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
  return body;
}

async function checkNameCollisions(config, allowUpdate) {
  if (!liveChecksAvailable()) return ["Skipped live collision checks because TFY credentials are not configured."];
  const resource = names(config);
  const body = await tfyFetch(`/api/svc/v1/apps?workspaceFqn=${encodeURIComponent(config.workspaceFqn)}&limit=200`);
  const rows = Array.isArray(body.data) ? body.data : [];
  const applicationNames = [resource.controller, resource.executor, resource.snapshotter];
  const existing = rows.filter((row) => applicationNames.includes(row.name || row.applicationName));
  const hostOwners = rows.filter((row) => {
    const ports = row.manifest?.ports || row.deployment?.manifest?.ports || [];
    return Array.isArray(ports) && ports.some((port) => port?.host === config.host.hostname);
  });
  if (existing.length && !allowUpdate) {
    throw new Error(`component name collision: ${existing.map((row) => row.name || row.applicationName).join(", ")}. Use --update to update existing deployments.`);
  }
  const unexpectedHostOwners = hostOwners.filter((row) => !applicationNames.includes(row.name || row.applicationName));
  if (unexpectedHostOwners.length) {
    throw new Error(`host ${config.host.hostname} is already used by: ${unexpectedHostOwners.map((row) => row.name || row.applicationName).join(", ")}`);
  }
  return [
    ...(existing.length ? [`Will update existing deployments: ${existing.map((row) => row.name || row.applicationName).join(", ")}`] : []),
    ...(hostOwners.length ? [`Host ${config.host.hostname} is already attached to ${hostOwners.map((row) => row.name || row.applicationName).join(", ")}`] : [])
  ];
}

async function checkSecretGroup(config) {
  if (!liveChecksAvailable()) return ["Skipped live SecretGroup checks because TFY credentials are not configured."];
  const groups = await tfyFetch("/api/svc/v1/secret-groups");
  const rows = Array.isArray(groups.data) ? groups.data : [];
  const group = rows.find((row) => row.name === config.secrets || row.manifest?.name === config.secrets);
  if (!group) throw new Error(`SecretGroup not found: ${config.secrets}`);
  const groupId = group.id || group.fqn || group.name;
  const secrets = await tfyFetch("/api/svc/v1/secrets", {
    method: "POST",
    body: JSON.stringify({ secretGroupId: groupId, limit: 100, offset: 0 })
  });
  const keys = new Set((Array.isArray(secrets.data) ? secrets.data : []).map((row) => row.key || row.name));
  const missing = REQUIRED_SECRET_KEYS.filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`SecretGroup ${config.secrets} is missing keys: ${missing.join(", ")}`);
  return [];
}

function collectUrls(value, urls = new Set()) {
  if (typeof value === "string") {
    if (value.includes("{{mcpProxyBaseURL}}")) urls.add(value.replace("{{mcpProxyBaseURL}}", "https://gateway.truefoundry.ai").replace(/\/$/, ""));
    try {
      const parsed = new URL(value);
      if (["http:", "https:"].includes(parsed.protocol)) urls.add(parsed.toString().replace(/\/$/, ""));
    } catch {}
  } else if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectUrls(item, urls);
  }
  return urls;
}

async function checkMcpGateway(config) {
  if (!config.mcpServers.length) return [];
  if (!liveChecksAvailable()) return ["Skipped live MCP Gateway checks because TFY credentials are not configured."];
  const body = await tfyFetch("/api/svc/v1/mcp-servers");
  const urls = collectUrls(body);
  const missing = config.mcpServers.filter((url) => !urls.has(url));
  if (missing.length) throw new Error(`MCP URLs are not visible through TrueFoundry MCP Gateway: ${missing.join(", ")}`);
  return [];
}

async function checkSkills(config) {
  if (!config.skills.length) return [];
  if (!liveChecksAvailable()) return ["Skipped live skill checks because TFY credentials are not configured."];
  const body = await tfyFetch("/api/ml/v1/x/agent-skill-versions/bulk-get", {
    method: "POST",
    body: JSON.stringify({
      data: config.skills.map((fqn) => ({ fqn, fetch_skill_md_content: false }))
    })
  });
  const returned = new Set((Array.isArray(body.data) ? body.data : []).map((row) => row.fqn));
  const missing = config.skills.filter((fqn) => !returned.has(fqn));
  if (missing.length) throw new Error(`skills are not visible through TrueFoundry: ${missing.join(", ")}`);
  return [];
}

async function checkSnapshotMlRepo(config) {
  if (!liveChecksAvailable()) return ["Skipped live snapshot ML Repo checks because TFY credentials are not configured."];
  const body = await tfyFetch("/api/ml/v1/ml-repos?limit=200");
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const names = new Set(rows.map((row) => row.name || row.manifest?.name || row.fqn?.split("/").at(-1)).filter(Boolean));
  if (!names.has(config.snapshotMlRepo)) {
    throw new Error(`snapshot_ml_repo not found or not accessible: ${config.snapshotMlRepo}`);
  }
  return [];
}

async function validate(config, { allowUpdate = false, skipLiveChecks = false } = {}) {
  if (skipLiveChecks) return [];
  return [
    ...(await checkNameCollisions(config, allowUpdate)),
    ...(await checkSecretGroup(config)),
    ...(await checkMcpGateway(config)),
    ...(await checkSkills(config)),
    ...(await checkSnapshotMlRepo(config))
  ];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, TFY_HOST: baseTfyUrl() || process.env.TFY_HOST || "" } });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function deploy(config, outDir, flags) {
  if (!liveChecksAvailable()) throw new Error("deploy requires TFY_BASE_URL/TFY_HOST and TFY_API_KEY");
  await validate(config, { allowUpdate: Boolean(flags.update) });
  const files = await compile(config, outDir);
  const filesByName = new Map(files.map((file) => [path.basename(file), file]));
  const deployFiles = [
    `${config.name}-state.yaml`,
    `${config.name}-controller.yaml`,
    `${config.name}-executor.yaml`,
    `${config.name}-snapshotter.yaml`
  ].map((name) => filesByName.get(name)).filter(Boolean);
  for (const file of deployFiles) await run("tfy", ["apply", "-f", file]);
  return deployFiles;
}

async function main() {
  const { command, file, flags } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage());
    return;
  }
  const config = await readHermesConfig(file);
  process.env.TFY_BASE_URL ||= controlPlaneUrl(config);
  const outDir = flags.out || ".hermes-rendered";

  if (command === "validate") {
    const warnings = await validate(config, { allowUpdate: Boolean(flags.update), skipLiveChecks: Boolean(flags["skip-live-checks"]) });
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    console.log("hermes.yaml is valid");
    return;
  }
  if (command === "compile") {
    const files = await compile(config, outDir);
    console.log(`wrote ${files.length} files to ${outDir}`);
    return;
  }
  if (command === "slack-manifest") {
    const manifest = slackManifest(config);
    if ((flags.format || "json") === "yaml") process.stdout.write(YAML.stringify(manifest, { lineWidth: 0 }));
    else process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "deploy") {
    const files = await deploy(config, outDir, flags);
    console.log(`submitted ${files.length} TrueFoundry deployments`);
    console.log(`Slack manifest: ${path.join(outDir, "slack-app-manifest.json")}`);
    return;
  }
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
