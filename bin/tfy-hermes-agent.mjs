#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const DEFAULT_REPO_URL = "https://github.com/truefoundry/tfy-hermes-agent";
const DEFAULT_SOURCE_REF = "main";
const DEFAULT_MODEL = "openai-main/gpt-5.5";
const DEFAULT_VOLUME_SIZE_GI = 10;
const REQUIRED_SECRET_KEYS = [
  "TFY_API_KEY",
  "HERMES-RUN-TOKEN-SECRET",
  "HERMES-OPENAI-API-KEY",
  "SLACK-BOT-TOKEN",
  "SLACK-SIGNING-SECRET"
];

function usage() {
  return [
    "Usage:",
    "  tfy-hermes-agent init",
    "  tfy-hermes-agent deploy <hermes.yaml> [--update] [--emit-manifests <dir>] [--skip-live-checks]",
    "",
    "init walks you through Slack + TrueFoundry settings and writes hermes.yaml.",
    "deploy validates the config and applies the controller, executor, and volume to TrueFoundry.",
    "deploy requires TFY_HOST and TFY_API_KEY unless --skip-live-checks is given."
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", file: null, flags: {} };
  }
  if (command === "init") {
    if (rest.length) throw new Error("init takes no arguments");
    return { command, file: null, flags: {} };
  }
  if (command === "deploy") {
    const file = rest.shift();
    if (!file || file.startsWith("--")) throw new Error("deploy requires a hermes.yaml path");
    const flags = {};
    for (let index = 0; index < rest.length; index += 1) {
      const item = rest[index];
      if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
      const key = item.slice(2);
      if (key === "update" || key === "skip-live-checks") {
        flags[key] = true;
      } else if (key === "emit-manifests") {
        const value = rest[index + 1];
        if (!value || value.startsWith("--")) throw new Error("missing value for --emit-manifests");
        flags[key] = value;
        index += 1;
      } else {
        throw new Error(`unknown flag: --${key}`);
      }
    }
    return { command, file, flags };
  }
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
}

function slugifyName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(name)) {
    throw new Error("name must be 2-32 chars and use lowercase letters, numbers, and hyphens (Slack handle limit)");
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
  return { url: `${parsed.protocol}//${parsed.hostname}`, hostname: parsed.hostname };
}

function workspaceName(workspaceFqn) {
  return workspaceFqn.split(":").at(-1);
}

function tenantFromHost(hostname) {
  const match = hostname.match(/(?:^|\.)ml\.([a-z0-9-]+)\.truefoundry\.cloud$/i)
    || hostname.match(/(?:^|\.)([a-z0-9-]+)\.truefoundry\.cloud$/i);
  if (match?.[1]) return match[1];
  if (process.env.TFY_SECRET_TENANT) return process.env.TFY_SECRET_TENANT;
  throw new Error("could not derive secret tenant from host; set TFY_SECRET_TENANT");
}

function tenantFromEnv() {
  if (process.env.TFY_SECRET_TENANT) return process.env.TFY_SECRET_TENANT;
  const base = baseTfyUrl();
  if (!base) return "";
  try {
    return tenantFromHost(new URL(base).hostname);
  } catch {
    return "";
  }
}

function resolveHost(value, name, workspaceFqn) {
  if (String(value || "").trim()) return normalizeHost(value);
  const tenant = tenantFromEnv();
  if (!tenant) {
    throw new Error("host is required unless TFY_HOST or TFY_SECRET_TENANT is set for inference");
  }
  return normalizeHost(`https://${name}-${workspaceName(workspaceFqn)}.ml.${tenant}.truefoundry.cloud`);
}

function stringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

function validateSkillFqn(value) {
  return /^agent-skill:[a-z0-9-]+\/[a-z0-9._-]+\/[a-z0-9._-]+:\d+$/i.test(value);
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

function normalizeGatewayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("gateway_url is required unless OPENAI_BASE_URL is set");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("gateway_url must be a valid OpenAI-compatible HTTP URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("gateway_url must use http or https");
  return parsed.toString().replace(/\/$/, "");
}

function uniqueUpperList(value, label) {
  return Array.from(new Set(stringList(value, label).map((item) => item.toUpperCase())));
}

function normalizeSlackAccess(value) {
  if (value == null) return { allowedChannels: [], allowedUsers: [] };
  assertObject(value, "slack");
  const allowedChannels = uniqueUpperList(value.allowed_channels, "slack.allowed_channels");
  const allowedUsers = uniqueUpperList(value.allowed_users, "slack.allowed_users");
  const invalidChannels = allowedChannels.filter((channel) => !/^[CGD][A-Z0-9]{2,}$/.test(channel));
  const invalidUsers = allowedUsers.filter((user) => !/^[UW][A-Z0-9]{2,}$/.test(user));
  if (invalidChannels.length) throw new Error(`slack.allowed_channels must contain Slack channel IDs: ${invalidChannels.join(", ")}`);
  if (invalidUsers.length) throw new Error(`slack.allowed_users must contain Slack user IDs: ${invalidUsers.join(", ")}`);
  return { allowedChannels, allowedUsers };
}

export async function readHermesConfig(file) {
  if (!file) throw new Error("missing hermes.yaml path");
  const config = YAML.parse(await readFile(file, "utf8"));
  assertObject(config, "hermes.yaml");

  const name = slugifyName(config.name);
  const workspaceFqn = String(config.workspace_fqn || "").trim();
  if (!workspaceFqn.includes(":")) throw new Error("workspace_fqn is required and must look like cluster:workspace");
  const host = resolveHost(config.host, name, workspaceFqn);

  const secrets = String(config.secrets || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/.test(secrets)) throw new Error("secrets must be the TrueFoundry SecretGroup name");

  const skills = stringList(config.skills, "skills");
  const invalidSkills = skills.filter((skill) => !validateSkillFqn(skill));
  if (invalidSkills.length) throw new Error(`skills must be agent-skill FQNs: ${invalidSkills.join(", ")}`);

  const slack = normalizeSlackAccess(config.slack);
  const gatewayUrl = normalizeGatewayUrl(config.gateway_url || process.env.OPENAI_BASE_URL);

  const slackTeamId = String(config.slack_team_id || "").trim();

  return {
    name,
    workspaceFqn,
    host,
    tenant: tenantFromHost(host.hostname),
    description: String(config.description || "").trim(),
    instructions: String(config.instructions || "").trim(),
    model: String(config.model || DEFAULT_MODEL).trim(),
    gatewayUrl,
    secrets,
    slack,
    slackTeamId,
    skills,
    mcpServers: stringList(config.mcp_servers, "mcp_servers").map(normalizeMcpUrl)
  };
}

function names(config) {
  return {
    secrets: config.secrets,
    volume: `${config.name}-data`,
    controller: `${config.name}-controller`,
    executor: `${config.name}-executor`
  };
}

function secretRef(config, key) {
  return `tfy-secret://${config.tenant}:${config.secrets}:${key}`;
}

function csv(values) {
  return values.join(",");
}

function baseTfyUrl() {
  return (process.env.TFY_HOST || "").replace(/\/+$/, "");
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

export function volumeManifest(config) {
  return {
    name: names(config).volume,
    type: "volume",
    workspace_fqn: config.workspaceFqn,
    config: {
      type: "dynamic",
      size: DEFAULT_VOLUME_SIZE_GI,
      access_modes: ["ReadWriteOnce"]
    }
  };
}

export function controllerManifest(config) {
  const resource = names(config);
  return {
    name: resource.controller,
    type: "service",
    workspace_fqn: config.workspaceFqn,
    image: image("Dockerfile.controller"),
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
      STATE_ROOT: "/data",
      PUBLIC_BASE_URL: config.host.url,
      TFY_HOST: controlPlaneUrl(config),
      TFY_API_KEY: secretRef(config, "TFY_API_KEY"),
      HERMES_RUN_TOKEN_SECRET: secretRef(config, "HERMES-RUN-TOKEN-SECRET"),
      HERMES_OPENAI_API_KEY: secretRef(config, "HERMES-OPENAI-API-KEY"),
      SLACK_BOT_TOKEN: secretRef(config, "SLACK-BOT-TOKEN"),
      SLACK_SIGNING_SECRET: secretRef(config, "SLACK-SIGNING-SECRET"),
      TFY_WORKSPACE_FQN: config.workspaceFqn,
      HERMES_AGENT_HANDLE: config.name,
      HERMES_AGENT_NAME: config.name,
      HERMES_AGENT_DESCRIPTION: config.description,
      HERMES_AGENT_INSTRUCTIONS: config.instructions,
      HERMES_AGENT_SKILLS: csv(config.skills),
      HERMES_AGENT_MCP_SERVERS: csv(config.mcpServers),
      HERMES_SLACK_ALLOWED_CHANNELS: csv(config.slack.allowedChannels),
      HERMES_SLACK_ALLOWED_USERS: csv(config.slack.allowedUsers),
      HERMES_SLACK_TEAM_ID: config.slackTeamId,
      HERMES_MODEL: config.model,
      HERMES_GATEWAY_URL: config.gatewayUrl,
      HERMES_EXECUTOR_NAME: resource.executor
    },
    ports: [{ port: 8787, protocol: "TCP", expose: true, host: config.host.hostname, app_protocol: "http" }],
    mounts: [{ type: "volume", mount_path: "/data", volume_fqn: `tfy-volume://${config.workspaceFqn}:${resource.volume}` }],
    liveness_probe: { config: { type: "http", path: "/api/health", port: 8787, scheme: "HTTP" }, initial_delay_seconds: 20, period_seconds: 15, timeout_seconds: 5, failure_threshold: 5 },
    readiness_probe: { config: { type: "http", path: "/api/health", port: 8787, scheme: "HTTP" }, initial_delay_seconds: 20, period_seconds: 15, timeout_seconds: 5, failure_threshold: 5 },
    rollout_strategy: { type: "rolling_update", max_surge_percentage: 0, max_unavailable_percentage: 100 }
  };
}

export function executorManifest(config) {
  return {
    name: names(config).executor,
    type: "job",
    workspace_fqn: config.workspaceFqn,
    trigger: { type: "manual" },
    concurrency_limit: 20,
    retries: 0,
    image: image("Dockerfile.executor", "node executor/executor.mjs"),
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
      HARNESS_CONTROLLER_URL: config.host.url,
      HARNESS_TURN_TIMEOUT_MS: "600000",
      TFY_HOST: controlPlaneUrl(config),
      TFY_API_KEY: secretRef(config, "TFY_API_KEY"),
      OPENAI_BASE_URL: config.gatewayUrl,
      OPENAI_API_KEY: secretRef(config, "HERMES-OPENAI-API-KEY"),
      HERMES_MODEL: config.model
    }
  };
}

export function secretsManifest(config) {
  const secrets = {};
  for (const key of REQUIRED_SECRET_KEYS) secrets[key] = "replace-in-truefoundry-only";
  return {
    name: config.secrets,
    type: "secret-group",
    workspace_fqn: config.workspaceFqn,
    secrets
  };
}

function titleFromName(name) {
  return name.split("-").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

export function slackManifest(config) {
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

function liveChecksAvailable() {
  return Boolean(baseTfyUrl() && process.env.TFY_API_KEY);
}

async function tfyFetch(apiPath, options = {}) {
  if (!liveChecksAvailable()) throw new Error("TFY_HOST and TFY_API_KEY are required for live checks");
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

async function checkWorkspace(config) {
  const body = await tfyFetch("/api/svc/v1/workspaces?limit=500");
  const rows = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const found = rows.some((row) => {
    const fqn = row.fqn || row.manifest?.fqn || `${row.cluster_id || row.clusterName || ""}:${row.name || row.manifest?.name || ""}`;
    return fqn === config.workspaceFqn;
  });
  if (!found) throw new Error(`workspace_fqn not found or not accessible: ${config.workspaceFqn}`);
}

async function checkSecretGroup(config) {
  const groups = await tfyFetch("/api/svc/v1/secret-groups");
  const rows = Array.isArray(groups.data) ? groups.data : [];
  const group = rows.find((row) => row.name === config.secrets || row.manifest?.name === config.secrets);
  if (!group) throw new Error(`SecretGroup not found: ${config.secrets} (create it in TrueFoundry first)`);
  const groupId = group.id || group.fqn || group.name;
  const secrets = await tfyFetch("/api/svc/v1/secrets", {
    method: "POST",
    body: JSON.stringify({ secretGroupId: groupId, limit: 100, offset: 0 })
  });
  const keys = new Set((Array.isArray(secrets.data) ? secrets.data : []).map((row) => row.key || row.name));
  const missing = REQUIRED_SECRET_KEYS.filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`SecretGroup ${config.secrets} is missing keys: ${missing.join(", ")}`);
}

async function checkCollisions(config, allowUpdate) {
  const resource = names(config);
  const body = await tfyFetch(`/api/svc/v1/apps?workspace_fqn=${encodeURIComponent(config.workspaceFqn)}&limit=200`);
  const rows = Array.isArray(body.data) ? body.data : [];
  const ours = [resource.controller, resource.executor];
  const existing = rows.filter((row) => ours.includes(row.name || row.applicationName));
  if (existing.length && !allowUpdate) {
    throw new Error(`deployment exists: ${existing.map((row) => row.name || row.applicationName).join(", ")}. Pass --update to overwrite.`);
  }
  const hostOwners = rows.filter((row) => {
    const ports = row.manifest?.ports || row.deployment?.manifest?.ports || [];
    return Array.isArray(ports) && ports.some((port) => port?.host === config.host.hostname);
  });
  const unexpected = hostOwners.filter((row) => !ours.includes(row.name || row.applicationName));
  if (unexpected.length) {
    throw new Error(`host ${config.host.hostname} is already used by: ${unexpected.map((row) => row.name || row.applicationName).join(", ")}`);
  }
}

async function liveValidate(config, { allowUpdate, skipLiveChecks }) {
  if (skipLiveChecks) return;
  if (!liveChecksAvailable()) throw new Error("deploy requires TFY_HOST and TFY_API_KEY (or pass --skip-live-checks)");
  await checkWorkspace(config);
  await checkSecretGroup(config);
  await checkCollisions(config, allowUpdate);
}

function runStdin(command, args, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, TFY_HOST: baseTfyUrl() || process.env.TFY_HOST || "" }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
    child.stdin.end(payload);
  });
}

export function serializeManifest(manifest, filename) {
  return filename.endsWith(".json")
    ? `${JSON.stringify(manifest, null, 2)}\n`
    : YAML.stringify(manifest, { lineWidth: 0 });
}

export function planManifests(config, { includeSecrets }) {
  const list = [];
  if (includeSecrets) list.push({ filename: `${config.name}-secrets.scaffold.yaml`, manifest: secretsManifest(config) });
  list.push({ filename: `${config.name}-volume.yaml`, manifest: volumeManifest(config) });
  list.push({ filename: `${config.name}-controller.yaml`, manifest: controllerManifest(config) });
  list.push({ filename: `${config.name}-executor.yaml`, manifest: executorManifest(config) });
  return list;
}

async function emitManifestsToDir(items, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const { filename, manifest } of items) {
    await writeFile(path.join(outDir, filename), serializeManifest(manifest, filename));
  }
}

async function applyManifests(items) {
  for (const { filename, manifest } of items) {
    const payload = serializeManifest(manifest, filename);
    console.log(`tfy apply ${filename}`);
    await runStdin("tfy", ["apply", "-f", "-"], payload);
  }
}

async function prompt(rl, label, { def = "", required = false, validate } = {}) {
  while (true) {
    const suffix = def ? ` [${def}]` : "";
    const raw = (await rl.question(`${label}${suffix}: `)).trim();
    const value = raw || def;
    if (!value) {
      if (!required) return "";
      console.error("  this field is required");
      continue;
    }
    if (validate) {
      try {
        return validate(value);
      } catch (error) {
        console.error(`  ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    return value;
  }
}

async function promptList(rl, label, { validate } = {}) {
  const raw = (await rl.question(`${label} (comma-separated, blank for none): `)).trim();
  if (!raw) return [];
  const items = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (validate) for (const item of items) validate(item);
  return items;
}

async function runInit() {
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    console.log("This wizard writes hermes.yaml and slack-app-manifest.json in the current directory.");
    console.log("");
    const handle = await prompt(rl, "Agent handle (2-32 chars, lowercase, hyphens)", {
      required: true,
      validate: slugifyName
    });
    const agentName = await prompt(rl, "Agent display name", { def: titleFromName(handle) });
    const description = await prompt(rl, "Agent description");
    const model = await prompt(rl, "Model", { def: DEFAULT_MODEL });
    const workspaceFqn = await prompt(rl, "Workspace FQN (cluster:workspace)", {
      required: true,
      validate: (value) => {
        if (!value.includes(":")) throw new Error("workspace FQN must look like cluster:workspace");
        return value.trim();
      }
    });
    const gatewayUrl = await prompt(rl, "OpenAI-compatible gateway URL", {
      required: true,
      validate: normalizeGatewayUrl
    });
    const slackWorkspaceUrl = await prompt(rl, "Slack workspace URL (e.g. https://your-team.slack.com)", {
      required: true,
      validate: (value) => {
        const url = new URL(value.startsWith("http") ? value : `https://${value}`);
        if (!url.hostname.endsWith("slack.com")) throw new Error("must be a slack.com URL");
        return url.origin;
      }
    });
    const secretsName = await prompt(rl, "SecretGroup name", {
      def: `${handle}-hermes-secrets`,
      validate: (value) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/.test(value)) throw new Error("invalid SecretGroup name");
        return value;
      }
    });
    const skills = await promptList(rl, "Skill FQNs", {
      validate: (value) => {
        if (!validateSkillFqn(value)) throw new Error(`invalid skill FQN: ${value}`);
      }
    });
    const mcpServers = await promptList(rl, "MCP server URLs", {
      validate: normalizeMcpUrl
    });

    const config = {
      name: handle,
      display_name: agentName,
      workspace_fqn: workspaceFqn,
      description,
      model,
      gateway_url: gatewayUrl,
      slack_workspace_url: slackWorkspaceUrl,
      secrets: secretsName,
      skills,
      mcp_servers: mcpServers
    };

    const yamlPath = path.resolve(process.cwd(), "hermes.yaml");
    await writeFile(yamlPath, YAML.stringify(config, { lineWidth: 0 }));

    const fakeConfig = {
      name: handle,
      host: resolveHost(null, handle, workspaceFqn),
      description
    };
    const slackPath = path.resolve(process.cwd(), "slack-app-manifest.json");
    await writeFile(slackPath, `${JSON.stringify(slackManifest(fakeConfig), null, 2)}\n`);

    console.log("");
    console.log(`wrote ${yamlPath}`);
    console.log(`wrote ${slackPath}`);
    console.log("");
    console.log("Next steps:");
    console.log(`  1. Create a TrueFoundry SecretGroup named "${secretsName}" with these keys:`);
    for (const key of REQUIRED_SECRET_KEYS) console.log(`       - ${key}`);
    console.log(`  2. Install the Slack app at ${slackWorkspaceUrl}/apps using slack-app-manifest.json`);
    console.log(`     and copy the bot token + signing secret into the SecretGroup.`);
    console.log(`  3. Run: tfy-hermes-agent deploy hermes.yaml`);
  } finally {
    rl.close();
  }
}

async function runDeploy(file, flags) {
  const config = await readHermesConfig(file);
  process.env.TFY_HOST ||= controlPlaneUrl(config);

  await liveValidate(config, {
    allowUpdate: Boolean(flags.update),
    skipLiveChecks: Boolean(flags["skip-live-checks"])
  });

  const items = planManifests(config, { includeSecrets: Boolean(flags.update) });

  if (flags["emit-manifests"]) {
    await emitManifestsToDir(items, flags["emit-manifests"]);
    console.log(`wrote ${items.length} manifest files to ${flags["emit-manifests"]}`);
  }

  await applyManifests(items);

  console.log("");
  console.log(`Controller: ${config.host.url}`);
  console.log(`Slack Events URL: ${config.host.url}/slack/events`);
  console.log(`Slack Interactions URL: ${config.host.url}/slack/interactions`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") {
    console.log(usage());
    return;
  }
  if (parsed.command === "init") {
    await runInit();
    return;
  }
  if (parsed.command === "deploy") {
    await runDeploy(parsed.file, parsed.flags);
    return;
  }
  throw new Error(`unknown command: ${parsed.command}\n\n${usage()}`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
