#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import YAML from "yaml";

const DEFAULT_REPO_URL = "https://github.com/truefoundry/tfy-hermes-agent";
const DEFAULT_SOURCE_REF = "main";
const DEFAULT_MODEL = "openai-main/gpt-5.5";
const DEFAULT_VOLUME_SIZE_GI = 10;
// TrueFoundry SecretGroup key names must be alphanumeric, dots, or hyphens —
// underscores are rejected by the platform. Env-var names with underscores are
// fine; the controller/executor manifests do the mapping from hyphenated
// secret key to underscored env var.
const REQUIRED_SECRET_KEYS = [
  "TFY-API-KEY",
  "HERMES-RUN-TOKEN-SECRET",
  "HERMES-OPENAI-API-KEY",
  "SLACK-BOT-TOKEN",
  "SLACK-SIGNING-SECRET"
];

const USAGE = [
  "Usage:",
  "  tfy-hermes-agent init",
  "  tfy-hermes-agent deploy <hermes.yaml> [--update] [--emit-manifests <dir>] [--skip-live-checks]",
  "",
  "init walks you through Slack + TrueFoundry settings and writes hermes.yaml.",
  "deploy validates the config and applies the controller, executor, and volume to TrueFoundry.",
  "deploy requires TFY_HOST and TFY_API_KEY unless --skip-live-checks is given."
].join("\n");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", file: null, flags: {} };
  }
  if (command === "init") {
    if (rest.length) throw new Error("init takes no arguments");
    return { command, file: null, flags: {} };
  }
  if (command !== "deploy") throw new Error(`unknown command: ${command}\n\n${USAGE}`);

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
  try { parsed = new URL(withScheme); } catch { throw new Error("host must be a valid URL or hostname"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("host must use http or https");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("host must not include a path, query, or fragment");
  return { url: `${parsed.protocol}//${parsed.hostname}`, hostname: parsed.hostname };
}

function baseTfyUrl() {
  return (process.env.TFY_HOST || "").replace(/\/+$/, "");
}

function tenantFromHost(hostname) {
  const match = hostname.match(/(?:^|\.)ml\.([a-z0-9-]+)\.truefoundry\.cloud$/i)
    || hostname.match(/(?:^|\.)([a-z0-9-]+)\.truefoundry\.cloud$/i);
  if (match?.[1]) return match[1];
  if (process.env.TFY_SECRET_TENANT) return process.env.TFY_SECRET_TENANT;
  throw new Error("could not derive secret tenant from host; set TFY_SECRET_TENANT");
}

function resolveHost(value, name, workspaceFqn) {
  if (String(value || "").trim()) return normalizeHost(value);
  // Tenant inference: explicit env var beats TFY_HOST parsing.
  let tenant = process.env.TFY_SECRET_TENANT || "";
  if (!tenant) {
    const base = baseTfyUrl();
    if (base) {
      try { tenant = tenantFromHost(new URL(base).hostname); } catch { /* fall through */ }
    }
  }
  if (!tenant) throw new Error("host is required unless TFY_HOST or TFY_SECRET_TENANT is set for inference");
  const workspaceName = workspaceFqn.split(":").at(-1);
  return normalizeHost(`https://${name}-${workspaceName}.ml.${tenant}.truefoundry.cloud`);
}

function stringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  return value.map((item) => String(item || "").trim()).filter(Boolean);
}

const SKILL_FQN_RE = /^agent-skill:[a-z0-9-]+\/[a-z0-9._-]+\/[a-z0-9._-]+:\d+$/i;
function validateSkillFqn(value) { return SKILL_FQN_RE.test(value); }

function normalizeMcpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "").trim()); } catch { throw new Error(`mcp_servers entry is not a valid URL: ${value}`); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`mcp_servers URL must use http or https: ${value}`);
  return parsed.toString().replace(/\/$/, "");
}

function normalizeGatewayUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("gateway_url is required unless OPENAI_BASE_URL is set");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("gateway_url must be a valid OpenAI-compatible HTTP URL"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("gateway_url must use http or https");
  return parsed.toString().replace(/\/$/, "");
}

function normalizeSlackAccess(value) {
  if (value == null) return { allowedChannels: [], allowedUsers: [] };
  assertObject(value, "slack");
  const upper = (list, label) => Array.from(new Set(stringList(list, label).map((item) => item.toUpperCase())));
  const allowedChannels = upper(value.allowed_channels, "slack.allowed_channels");
  const allowedUsers = upper(value.allowed_users, "slack.allowed_users");
  const badChannels = allowedChannels.filter((c) => !/^[CGD][A-Z0-9]{2,}$/.test(c));
  const badUsers = allowedUsers.filter((u) => !/^[UW][A-Z0-9]{2,}$/.test(u));
  if (badChannels.length) throw new Error(`slack.allowed_channels must contain Slack channel IDs: ${badChannels.join(", ")}`);
  if (badUsers.length) throw new Error(`slack.allowed_users must contain Slack user IDs: ${badUsers.join(", ")}`);
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
  const badSkills = skills.filter((s) => !validateSkillFqn(s));
  if (badSkills.length) throw new Error(`skills must be agent-skill FQNs: ${badSkills.join(", ")}`);

  return {
    name,
    workspaceFqn,
    host,
    tenant: tenantFromHost(host.hostname),
    description: String(config.description || "").trim(),
    instructions: String(config.instructions || "").trim(),
    model: String(config.model || DEFAULT_MODEL).trim(),
    gatewayUrl: normalizeGatewayUrl(config.gateway_url || process.env.OPENAI_BASE_URL),
    secrets,
    slack: normalizeSlackAccess(config.slack),
    slackTeamId: String(config.slack_team_id || "").trim(),
    skills,
    mcpServers: stringList(config.mcp_servers, "mcp_servers").map(normalizeMcpUrl)
  };
}

function resourceNames(config) {
  return {
    volume: `${config.name}-data`,
    controller: `${config.name}-controller`,
    executor: `${config.name}-executor`
  };
}

function secretRef(config, key) {
  return `tfy-secret://${config.tenant}:${config.secrets}:${key}`;
}

function controlPlaneUrl(config) {
  return baseTfyUrl() || `https://${config.tenant}.truefoundry.cloud`;
}

function buildImage(dockerfilePath, command) {
  const sourceRef = process.env.HERMES_SOURCE_REF || DEFAULT_SOURCE_REF;
  const manifest = {
    type: "build",
    build_source: {
      type: "git",
      repo_url: process.env.HERMES_REPO_URL || DEFAULT_REPO_URL,
      branch_name: process.env.HERMES_SOURCE_BRANCH || sourceRef,
      ref: sourceRef
    },
    build_spec: { type: "dockerfile", dockerfile_path: dockerfilePath, build_context_path: "." }
  };
  if (command) manifest.build_spec.command = command;
  return manifest;
}

export function volumeManifest(config) {
  return {
    name: resourceNames(config).volume,
    type: "volume",
    workspace_fqn: config.workspaceFqn,
    config: {
      type: "dynamic",
      size: DEFAULT_VOLUME_SIZE_GI,
      storage_class: "default",
      access_modes: ["ReadWriteOnce"]
    }
  };
}

export function controllerManifest(config) {
  const r = resourceNames(config);
  const probe = { config: { type: "http", path: "/api/health", port: 8787, scheme: "HTTP" }, initial_delay_seconds: 20, period_seconds: 15, timeout_seconds: 5, failure_threshold: 5 };
  const csv = (list) => list.join(",");
  return {
    name: r.controller,
    type: "service",
    workspace_fqn: config.workspaceFqn,
    image: buildImage("Dockerfile.controller"),
    resources: {
      cpu_request: 0.25, cpu_limit: 1,
      memory_request: 512, memory_limit: 1024,
      ephemeral_storage_request: 2000, ephemeral_storage_limit: 4000
    },
    replicas: 1,
    env: {
      STATE_ROOT: "/data",
      PUBLIC_BASE_URL: config.host.url,
      TFY_HOST: controlPlaneUrl(config),
      TFY_API_KEY: secretRef(config, "TFY-API-KEY"),
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
      HERMES_EXECUTOR_NAME: r.executor
    },
    ports: [{ port: 8787, protocol: "TCP", expose: true, host: config.host.hostname, app_protocol: "http" }],
    mounts: [{ type: "volume", mount_path: "/data", volume_fqn: `tfy-volume://${config.workspaceFqn}:${r.volume}` }],
    liveness_probe: probe,
    readiness_probe: probe,
    rollout_strategy: { type: "rolling_update", max_surge_percentage: 0, max_unavailable_percentage: 100 }
  };
}

export function executorManifest(config) {
  return {
    name: resourceNames(config).executor,
    type: "job",
    workspace_fqn: config.workspaceFqn,
    trigger: { type: "manual" },
    concurrency_limit: 20,
    retries: 0,
    image: buildImage("Dockerfile.executor", "node executor/executor.mjs"),
    resources: {
      cpu_request: 0.1, cpu_limit: 2,
      memory_request: 2048, memory_limit: 4096,
      ephemeral_storage_request: 8000, ephemeral_storage_limit: 16000
    },
    env: {
      HOME: "/workspace",
      HERMES_HOME: "/workspace/.hermes",
      HARNESS_TURN_TIMEOUT_MS: "600000",
      TFY_HOST: controlPlaneUrl(config),
      TFY_API_KEY: secretRef(config, "TFY-API-KEY"),
      OPENAI_BASE_URL: config.gatewayUrl,
      OPENAI_API_KEY: secretRef(config, "HERMES-OPENAI-API-KEY"),
      HERMES_MODEL: config.model
    }
  };
}

export function secretsManifest(config) {
  const secrets = Object.fromEntries(REQUIRED_SECRET_KEYS.map((key) => [key, "replace-in-truefoundry-only"]));
  return { name: config.secrets, type: "secret-group", workspace_fqn: config.workspaceFqn, secrets };
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
          "app_mentions:read", "assistant:write",
          "channels:history", "channels:join", "channels:read",
          "chat:write",
          "groups:history", "groups:read",
          "im:history", "im:read",
          "mpim:history", "mpim:read",
          "team:read", "users:read"
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
  if (!res.ok) throw new Error(`TrueFoundry ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

function rowsOf(body) {
  return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
}

async function checkWorkspace(config) {
  const rows = rowsOf(await tfyFetch("/api/svc/v1/workspaces?limit=500"));
  const found = rows.some((row) => {
    const fqn = row.fqn || row.manifest?.fqn || `${row.cluster_id || row.clusterName || ""}:${row.name || row.manifest?.name || ""}`;
    return fqn === config.workspaceFqn;
  });
  if (!found) throw new Error(`workspace_fqn not found or not accessible: ${config.workspaceFqn}`);
}

async function checkSecretGroup(config) {
  const groups = rowsOf(await tfyFetch("/api/svc/v1/secret-groups"));
  const group = groups.find((row) => row.name === config.secrets || row.manifest?.name === config.secrets);
  if (!group) throw new Error(`SecretGroup not found: ${config.secrets} (create it in TrueFoundry first)`);
  const groupId = group.id || group.fqn || group.name;
  const secrets = await tfyFetch("/api/svc/v1/secrets", {
    method: "POST",
    body: JSON.stringify({ secretGroupId: groupId, limit: 100, offset: 0 })
  });
  const keys = new Set(rowsOf(secrets).map((row) => row.key || row.name));
  const missing = REQUIRED_SECRET_KEYS.filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`SecretGroup ${config.secrets} is missing keys: ${missing.join(", ")}`);
}

async function checkCollisions(config, allowUpdate) {
  const r = resourceNames(config);
  const rows = rowsOf(await tfyFetch(`/api/svc/v1/apps?workspace_fqn=${encodeURIComponent(config.workspaceFqn)}&limit=200`));
  const ours = [r.controller, r.executor];
  const nameOf = (row) => row.name || row.applicationName;
  const existing = rows.filter((row) => ours.includes(nameOf(row)));
  if (existing.length && !allowUpdate) {
    throw new Error(`deployment exists: ${existing.map(nameOf).join(", ")}. Pass --update to overwrite.`);
  }
  const unexpected = rows.filter((row) => {
    if (ours.includes(nameOf(row))) return false;
    const ports = row.manifest?.ports || row.deployment?.manifest?.ports || [];
    return Array.isArray(ports) && ports.some((port) => port?.host === config.host.hostname);
  });
  if (unexpected.length) {
    throw new Error(`host ${config.host.hostname} is already used by: ${unexpected.map(nameOf).join(", ")}`);
  }
}

async function liveValidate(config, { allowUpdate, skipLiveChecks }) {
  if (skipLiveChecks) return;
  if (!liveChecksAvailable()) throw new Error("deploy requires TFY_HOST and TFY_API_KEY (or pass --skip-live-checks)");
  await checkWorkspace(config);
  await checkSecretGroup(config);
  await checkCollisions(config, allowUpdate);
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
  // TrueFoundry CLI's `tfy apply -f` requires a real file path; it does not
  // read stdin. Stage each manifest in a temp dir, apply, then clean up.
  const stageDir = path.join(tmpdir(), `tfy-hermes-${randomBytes(6).toString("hex")}`);
  await mkdir(stageDir, { recursive: true });
  try {
    for (const { filename, manifest } of items) {
      const stagedPath = path.join(stageDir, filename);
      await writeFile(stagedPath, serializeManifest(manifest, filename));
      console.log(`tfy apply ${filename}`);
      await run("tfy", ["apply", "-f", stagedPath]);
    }
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, TFY_HOST: baseTfyUrl() || process.env.TFY_HOST || "" }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function prompt(rl, label, { def = "", required = false, validate } = {}) {
  while (true) {
    const raw = (await rl.question(`${label}${def ? ` [${def}]` : ""}: `)).trim();
    const value = raw || def;
    if (!value) {
      if (!required) return "";
      console.error("  this field is required");
      continue;
    }
    if (!validate) return value;
    try { return validate(value); }
    catch (error) { console.error(`  ${error instanceof Error ? error.message : String(error)}`); }
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
    console.log("This wizard writes hermes.yaml and slack-app-manifest.json in the current directory.\n");
    const handle = await prompt(rl, "Agent handle (2-32 chars, lowercase, hyphens)", { required: true, validate: slugifyName });
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
    const gatewayUrl = await prompt(rl, "OpenAI-compatible gateway URL", { required: true, validate: normalizeGatewayUrl });
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
      validate: (value) => { if (!validateSkillFqn(value)) throw new Error(`invalid skill FQN: ${value}`); }
    });
    const mcpServers = await promptList(rl, "MCP server URLs", { validate: normalizeMcpUrl });

    const yamlPath = path.resolve(process.cwd(), "hermes.yaml");
    await writeFile(yamlPath, YAML.stringify({
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
    }, { lineWidth: 0 }));

    const slackPath = path.resolve(process.cwd(), "slack-app-manifest.json");
    const stubManifest = slackManifest({ name: handle, host: resolveHost(null, handle, workspaceFqn), description });
    await writeFile(slackPath, `${JSON.stringify(stubManifest, null, 2)}\n`);

    console.log(`\nwrote ${yamlPath}`);
    console.log(`wrote ${slackPath}\n`);
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

  // --skip-live-checks is the "preview offline" mode; never apply in that mode.
  // Otherwise applying without live-validated workspace/secret state is dangerous.
  if (flags["skip-live-checks"]) {
    console.log("skip-live-checks set: manifests prepared but not applied. Review and run `tfy apply -f <file>` manually, or re-run without --skip-live-checks.");
    return;
  }

  await applyManifests(items);

  console.log("");
  console.log(`Controller: ${config.host.url}`);
  console.log(`Slack Events URL: ${config.host.url}/slack/events`);
  console.log(`Slack Interactions URL: ${config.host.url}/slack/interactions`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") { console.log(USAGE); return; }
  if (parsed.command === "init") { await runInit(); return; }
  if (parsed.command === "deploy") { await runDeploy(parsed.file, parsed.flags); return; }
  throw new Error(`unknown command: ${parsed.command}\n\n${USAGE}`);
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try { return fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
}

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
