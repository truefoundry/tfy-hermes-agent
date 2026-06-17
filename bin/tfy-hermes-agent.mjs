#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
//
// The TFY API key is reused for both outbound LLM-gateway calls and the
// inbound /v1/* bearer check, so there is no separate HERMES-OPENAI-API-KEY.
const BASE_SECRET_KEYS = [
  "TFY-API-KEY",
  "HERMES-RUN-TOKEN-SECRET",
  "SLACK-BOT-TOKEN",
  "SLACK-SIGNING-SECRET"
];
const DAYTONA_SECRET_KEY = "DAYTONA-API-KEY";
const DEFAULT_DAYTONA_API_URL = "https://app.daytona.io";
// Platform-owned Daytona settings (not agent yaml).
export const DEFAULT_HERMES_DAYTONA_SNAPSHOT = "hermes-executor";
export const DEFAULT_DAYTONA_AUTO_STOP_MINUTES = 5;
export const DEFAULT_DAYTONA_AUTO_DELETE_INTERVAL = -1;

const EXECUTOR_BACKEND_ALIASES = {
  "truefoundry-job": "truefoundry-job",
  "tfy-job": "truefoundry-job",
  truefoundry: "truefoundry-job",
  "truefoundry-service": "truefoundry-service",
  service: "truefoundry-service"
};

export function normalizeExecutorBackend(raw) {
  const text = String(raw ?? "truefoundry-job").trim().toLowerCase();
  if (text === "daytona") {
    throw new Error("executor daytona is not supported; use truefoundry-service (terminal sandbox defaults to daytona)");
  }
  const backend = EXECUTOR_BACKEND_ALIASES[text];
  if (!backend) {
    throw new Error(`executor must be truefoundry-job or truefoundry-service (aliases: tfy-job); got ${JSON.stringify(raw)}`);
  }
  return backend;
}

export function normalizeExecutorConfig(value) {
  if (value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).length > 1 || (Object.keys(value).length === 1 && !("backend" in value))) {
      throw new Error("executor accepts only backend (or a shorthand string: truefoundry-job | truefoundry-service | tfy-job)");
    }
  }
  const raw = value === undefined || value === null
    ? "truefoundry-job"
    : typeof value === "string"
      ? value
      : value.backend;
  return { backend: normalizeExecutorBackend(raw) };
}

export function normalizeTerminalConfig(executorBackend, value) {
  if (executorBackend === "truefoundry-job") {
    if (value != null) {
      throw new Error("terminal is not supported when executor is truefoundry-job");
    }
    return null;
  }
  if (executorBackend !== "truefoundry-service") {
    throw new Error("terminal is only supported when executor is truefoundry-service");
  }
  if (value == null) {
    return { backend: "daytona" };
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    if (Object.keys(value).length > 1 || (Object.keys(value).length === 1 && !("backend" in value))) {
      throw new Error("terminal accepts only backend (currently: daytona)");
    }
  }
  const backend = String(typeof value === "string" ? value : value.backend || "daytona").trim().toLowerCase();
  if (backend !== "daytona") {
    throw new Error(`terminal.backend must be daytona when executor is truefoundry-service; got ${JSON.stringify(value)}`);
  }
  return { backend };
}

export function daytonaPlatformEnv() {
  return {
    apiUrl: DEFAULT_DAYTONA_API_URL,
    snapshot: DEFAULT_HERMES_DAYTONA_SNAPSHOT,
    autoStopMinutes: DEFAULT_DAYTONA_AUTO_STOP_MINUTES,
    autoDeleteInterval: DEFAULT_DAYTONA_AUTO_DELETE_INTERVAL
  };
}

export function requiredSecretKeys(config) {
  const keys = [...BASE_SECRET_KEYS];
  if (config?.executor?.backend === "truefoundry-service") keys.push(DAYTONA_SECRET_KEY);
  return keys;
}
const SECRET_PLACEHOLDER_SLACK = "pending-slack-setup";
const SECRET_PLACEHOLDER_TFY = "pending-tfy-api-key";
const SECRET_PLACEHOLDER_DAYTONA = "pending-daytona-api-key";
const SECRET_PLACEHOLDER_VALUES = new Set([
  "",
  "replace-in-truefoundry-only",
  SECRET_PLACEHOLDER_SLACK,
  SECRET_PLACEHOLDER_TFY,
  SECRET_PLACEHOLDER_DAYTONA,
  "pending"
]);

const USAGE = [
  "Usage:",
  "  tfy-hermes-agent init [--api-only]",
  "  tfy-hermes-agent deploy <name> | agents/<name>/<name>.yaml [--update] [--emit-manifests <dir>] [--skip-live-checks]",
  "",
  "init creates agents/<name>/ with <name>.yaml, .hermes-secrets.local, and slack-app-manifest.json (unless --api-only).",
  "init --api-only skips Slack file output and Slack optional prompts.",
  "deploy auto-creates the SecretGroup via API, compiles manifests to agents/<name>/deployments/, then tfy apply -f each file.",
  "deploy validates the config unless --skip-live-checks (compile-only preview).",
  "deploy reads ~/.truefoundry/credentials.json after tfy login when TFY_HOST/TFY_API_KEY are unset."
].join("\n");

const AGENTS_DIR = "agents";

export const DEFAULT_TFY_CREDENTIALS_PATH = path.join(homedir(), ".truefoundry", "credentials.json");

export const TFY_LOGIN_HINT = [
  "TrueFoundry credentials not found.",
  "Run: tfy login --host https://<tenant>.truefoundry.cloud",
  "For production agents, prefer: tfy login --host <url> --api-key <virtual-account-pat>",
  "Or set TFY_HOST and TFY_API_KEY in your shell."
].join(" ");

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { command: "help", file: null, flags: {} };
  }
  if (command === "init") {
    const flags = {};
    for (const item of rest) {
      if (item === "--api-only") flags["api-only"] = true;
      else throw new Error(`unknown init argument: ${item}\n\n${USAGE}`);
    }
    return { command, file: null, flags };
  }
  if (command !== "deploy") throw new Error(`unknown command: ${command}\n\n${USAGE}`);

  const file = rest.shift();
  if (!file || file.startsWith("--")) throw new Error("deploy requires an agent name or config path (e.g. my-bot or agents/my-bot/my-bot.yaml)");
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

export function agentPaths(name, root = process.cwd()) {
  const handle = slugifyName(name);
  const dir = path.join(root, AGENTS_DIR, handle);
  return {
    handle,
    dir,
    config: path.join(dir, `${handle}.yaml`),
    deployments: path.join(dir, "deployments"),
    slackManifest: path.join(dir, "slack-app-manifest.json"),
    secretsLocal: path.join(dir, ".hermes-secrets.local")
  };
}

export function resolveAgentConfigPath(input, root = process.cwd()) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("deploy requires an agent name or config path");

  if (/\.ya?ml$/i.test(raw)) {
    return path.resolve(root, raw);
  }

  return agentPaths(raw, root).config;
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

export function parseTfyCredentialsJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const host = String(parsed.host || "").trim().replace(/\/+$/, "");
  const accessToken = String(parsed.access_token || parsed.accessToken || "").trim();
  if (!host || !accessToken) return null;
  return { host, accessToken };
}

export async function readTfyCredentialsFile(credentialsPath = DEFAULT_TFY_CREDENTIALS_PATH) {
  try {
    return parseTfyCredentialsJson(await readFile(credentialsPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveTfyCredentials({ required }) {
  const hasEnvHost = Boolean(String(process.env.TFY_HOST || "").trim());
  const hasEnvKey = Boolean(String(process.env.TFY_API_KEY || "").trim());
  if (hasEnvHost && hasEnvKey) return "env";

  const fileCreds = await readTfyCredentialsFile();
  if (fileCreds) {
    if (!hasEnvHost) process.env.TFY_HOST = fileCreds.host;
    if (!hasEnvKey) process.env.TFY_API_KEY = fileCreds.accessToken;
  }

  if (baseTfyUrl() && String(process.env.TFY_API_KEY || "").trim()) {
    return hasEnvHost && hasEnvKey ? "env" : "credentials.json";
  }
  if (required) throw new Error(TFY_LOGIN_HINT);
  return null;
}

function tenantFromHost(hostname) {
  const match = hostname.match(/(?:^|\.)ml\.([a-z0-9-]+)\.truefoundry\.cloud$/i)
    || hostname.match(/(?:^|\.)([a-z0-9-]+)\.truefoundry\.cloud$/i);
  if (match?.[1]) return match[1];
  throw new Error(`could not derive tenant from host '${hostname}'`);
}

function resolveHost(value, name, workspaceFqn) {
  if (String(value || "").trim()) return normalizeHost(value);
  // Derive the tenant from TFY_HOST. Anything that calls `deploy` needs
  // TFY_HOST set anyway (for control-plane calls), so there's no scenario
  // where we have neither host nor TFY_HOST.
  const base = baseTfyUrl();
  if (!base) throw new Error("host is required unless TFY_HOST is set (so the tenant can be inferred)");
  const tenant = tenantFromHost(new URL(base).hostname);
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

  const version = String(config.version || "").trim();
  if (version && !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/.test(version)) {
    throw new Error("version must be a git branch, tag, or commit SHA");
  }
  const executor = normalizeExecutorConfig(config.executor);
  const terminal = normalizeTerminalConfig(executor.backend, config.terminal);

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
    mcpServers: stringList(config.mcp_servers, "mcp_servers").map(normalizeMcpUrl),
    slackInboundArtifactRepo: String(config.slack_inbound_artifact_repo || "").trim(),
    version,
    executor,
    terminal
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

function buildImage(config, dockerfilePath, command) {
  // Priority: hermes.yaml `version` field → HERMES_SOURCE_REF env → "main".
  // `version` accepts any git ref the build system can clone: a branch name,
  // a tag, or a commit SHA. It populates both `branch_name` (used by the
  // platform's git puller) and `ref` (used for clone pinning).
  const sourceRef = config.version || process.env.HERMES_SOURCE_REF || DEFAULT_SOURCE_REF;
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

function healthProbe(port) {
  return { config: { type: "http", path: "/api/health", port, scheme: "HTTP" }, initial_delay_seconds: 20, period_seconds: 15, timeout_seconds: 5, failure_threshold: 5 };
}

export function controllerManifest(config) {
  const r = resourceNames(config);
  const probe = healthProbe(8787);
  const csv = (list) => list.join(",");
  const env = {
      STATE_ROOT: "/data",
      PUBLIC_BASE_URL: config.host.url,
      TFY_HOST: controlPlaneUrl(config),
      TFY_API_KEY: secretRef(config, "TFY-API-KEY"),
      HERMES_RUN_TOKEN_SECRET: secretRef(config, "HERMES-RUN-TOKEN-SECRET"),
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
      HERMES_EXECUTOR_BACKEND: config.executor.backend,
      HERMES_SLACK_RUN_TIMEOUT_MS: "3600000"
  };
  if (config.executor.backend === "truefoundry-job") {
    env.HERMES_EXECUTOR_NAME = r.executor;
  }
  if (config.executor.backend === "truefoundry-service") {
    env.HERMES_EXECUTOR_URL = `http://${r.executor}:8788`;
  }
  if (config.slackInboundArtifactRepo) {
    env.HERMES_SLACK_INBOUND_ARTIFACT_REPO = config.slackInboundArtifactRepo;
  }
  return {
    name: r.controller,
    type: "service",
    workspace_fqn: config.workspaceFqn,
    image: buildImage(config, "Dockerfile.controller"),
    resources: {
      cpu_request: 0.25, cpu_limit: 1,
      memory_request: 512, memory_limit: 1024,
      ephemeral_storage_request: 2000, ephemeral_storage_limit: 4000
    },
    replicas: 1,
    env,
    ports: [{ port: 8787, protocol: "TCP", expose: true, host: config.host.hostname, app_protocol: "http" }],
    mounts: [{ type: "volume", mount_path: "/data", volume_fqn: `tfy-volume://${config.workspaceFqn}:${r.volume}` }],
    liveness_probe: probe,
    readiness_probe: probe,
    rollout_strategy: { type: "rolling_update", max_surge_percentage: 0, max_unavailable_percentage: 100 }
  };
}

function executorEnv(config) {
  const env = {
    HOME: "/workspace",
    HERMES_HOME: "/workspace/.hermes",
    HARNESS_TURN_TIMEOUT_MS: "3600000",
    TFY_HOST: controlPlaneUrl(config),
    TFY_API_KEY: secretRef(config, "TFY-API-KEY"),
    OPENAI_BASE_URL: config.gatewayUrl,
    // Hermes calls the TrueFoundry LLM gateway with this bearer; the gateway
    // authenticates with the TFY API key, not the controller's inbound bearer.
    OPENAI_API_KEY: secretRef(config, "TFY-API-KEY"),
    HERMES_MODEL: config.model
  };
  if (config.executor.backend === "truefoundry-service") {
    env.HERMES_RUN_TOKEN_SECRET = secretRef(config, "HERMES-RUN-TOKEN-SECRET");
    const daytona = daytonaPlatformEnv();
    env.HERMES_TERMINAL_BACKEND = "daytona";
    env.DAYTONA_API_KEY = secretRef(config, DAYTONA_SECRET_KEY);
    env.HERMES_DAYTONA_API_URL = daytona.apiUrl;
    env.HERMES_DAYTONA_SNAPSHOT = daytona.snapshot;
    env.HERMES_DAYTONA_AUTO_STOP_INTERVAL = String(daytona.autoStopMinutes);
    env.HERMES_DAYTONA_AUTO_DELETE_INTERVAL = String(daytona.autoDeleteInterval);
  }
  return env;
}

function executorResources() {
  return {
    cpu_request: 0.1, cpu_limit: 2,
    memory_request: 2048, memory_limit: 4096,
    ephemeral_storage_request: 8000, ephemeral_storage_limit: 16000
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
    image: buildImage(config, "Dockerfile.executor", "node executor/executor.mjs"),
    resources: executorResources(),
    env: executorEnv(config)
  };
}

export function executorServiceManifest(config) {
  const probe = healthProbe(8788);
  return {
    name: resourceNames(config).executor,
    type: "service",
    workspace_fqn: config.workspaceFqn,
    image: buildImage(config, "Dockerfile.executor", "node executor/server.mjs"),
    resources: executorResources(),
    replicas: 1,
    env: executorEnv(config),
    ports: [{ port: 8788, protocol: "TCP", expose: false, app_protocol: "http" }],
    liveness_probe: probe,
    readiness_probe: probe
  };
}

export function secretsManifest(config) {
  const secrets = Object.fromEntries(requiredSecretKeys(config).map((key) => [key, "replace-in-truefoundry-only"]));
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
          "chat:write", "files:read",
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
  if (!liveChecksAvailable()) throw new Error(TFY_LOGIN_HINT);
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
  if (!group) {
    throw new Error(
      `SecretGroup not found: ${config.secrets} (deploy could not create it — check secret-store integration access)`
    );
  }
  const groupId = group.id || group.fqn || group.name;
  const secrets = await tfyFetch("/api/svc/v1/secrets", {
    method: "POST",
    body: JSON.stringify({ secretGroupId: groupId, limit: 100, offset: 0 })
  });
  const keys = new Set(rowsOf(secrets).map((row) => row.key || row.name));
  const missing = requiredSecretKeys(config).filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`SecretGroup ${config.secrets} is missing keys: ${missing.join(", ")}`);
}

function parseHermesSecretsLocalContent(text) {
  const match = String(text || "").match(/^HERMES-RUN-TOKEN-SECRET=(.+)$/m);
  return match ? match[1].trim() : null;
}

function runTokenNeedsWrite(value) {
  const text = String(value || "").trim();
  return !text || SECRET_PLACEHOLDER_VALUES.has(text) || text.length < 32;
}

async function readHermesSecretsLocal(hermesFile) {
  const secretsPath = path.join(path.dirname(path.resolve(hermesFile)), ".hermes-secrets.local");
  try {
    return parseHermesSecretsLocalContent(await readFile(secretsPath, "utf8"));
  } catch {
    return null;
  }
}

async function findSecretGroupRow(config) {
  const groups = rowsOf(await tfyFetch("/api/svc/v1/secret-groups"));
  return groups.find((row) => row.name === config.secrets || row.manifest?.name === config.secrets) || null;
}

async function discoverSecretStoreIntegrationId() {
  const body = await tfyFetch("/api/svc/v1/provider-accounts?type=secret-store");
  for (const row of rowsOf(body)) {
    for (const integration of row.integrations || []) {
      const id = integration?.id || integration?.fqn;
      if (id) return id;
    }
  }
  throw new Error("no secret-store integration found; create the SecretGroup in TrueFoundry UI");
}

async function listSecretEntries(groupId) {
  const body = await tfyFetch("/api/svc/v1/secrets", {
    method: "POST",
    body: JSON.stringify({ secretGroupId: groupId, limit: 100, offset: 0 })
  });
  return rowsOf(body);
}

async function fetchSecretValue(secretId) {
  const body = await tfyFetch(`/api/svc/v1/secrets/${encodeURIComponent(secretId)}`);
  return body?.value ?? body?.manifest?.value ?? body?.data?.value ?? null;
}

function defaultSecretValue(key, tfyApiKey) {
  if (key === "TFY-API-KEY") return tfyApiKey || SECRET_PLACEHOLDER_TFY;
  if (key === DAYTONA_SECRET_KEY) return SECRET_PLACEHOLDER_DAYTONA;
  if (key.startsWith("SLACK-")) return SECRET_PLACEHOLDER_SLACK;
  return SECRET_PLACEHOLDER_TFY;
}

async function buildSecretsPayloadForPut(config, entries, runToken, tfyApiKey) {
  const byKey = new Map(entries.map((entry) => [entry.key || entry.name, entry]));
  const payload = [];
  for (const key of requiredSecretKeys(config)) {
    if (key === "HERMES-RUN-TOKEN-SECRET") {
      payload.push({ key, value: runToken });
      continue;
    }
    const entry = byKey.get(key);
    if (entry?.id) {
      const value = await fetchSecretValue(entry.id);
      if (value != null && !SECRET_PLACEHOLDER_VALUES.has(String(value).trim())) {
        payload.push({ key, value: String(value) });
        continue;
      }
    }
    payload.push({ key, value: defaultSecretValue(key, tfyApiKey) });
  }
  return payload;
}

async function ensureSecretGroup(config, hermesFile, { skipLiveChecks }) {
  if (skipLiveChecks || !liveChecksAvailable()) return;

  let runToken = await readHermesSecretsLocal(hermesFile);
  if (!runToken) {
    runToken = generateRunTokenSecret();
    console.log("generated HERMES-RUN-TOKEN-SECRET (no .hermes-secrets.local beside hermes.yaml)");
  }

  const tfyApiKey = String(process.env.TFY_API_KEY || "").trim();
  const group = await findSecretGroupRow(config);

  if (!group) {
    const integrationId = await discoverSecretStoreIntegrationId();
    await tfyFetch("/api/svc/v1/secret-groups", {
      method: "POST",
      body: JSON.stringify({
        name: config.secrets,
        workspaceFqn: config.workspaceFqn,
        integrationId,
        secrets: requiredSecretKeys(config).map((key) => ({
          key,
          value: key === "HERMES-RUN-TOKEN-SECRET"
            ? runToken
            : defaultSecretValue(key, tfyApiKey)
        }))
      })
    });
    console.log(`created SecretGroup ${config.secrets} and set HERMES-RUN-TOKEN-SECRET automatically`);
    return;
  }

  const groupId = group.id || group.fqn || group.name;
  const entries = await listSecretEntries(groupId);
  const byKey = new Map(entries.map((entry) => [entry.key || entry.name, entry]));
  const hermesEntry = byKey.get("HERMES-RUN-TOKEN-SECRET");

  if (hermesEntry?.id) {
    const current = await fetchSecretValue(hermesEntry.id);
    if (!runTokenNeedsWrite(current)) return;
  }

  const payload = await buildSecretsPayloadForPut(config, entries, runToken, tfyApiKey);
  await tfyFetch(`/api/svc/v1/secret-groups/${encodeURIComponent(groupId)}`, {
    method: "PUT",
    body: JSON.stringify({ secrets: payload })
  });
  console.log(`set HERMES-RUN-TOKEN-SECRET in SecretGroup ${config.secrets}`);
}

async function checkCollisions(config, allowUpdate) {
  const r = resourceNames(config);
  // `workspaceFqn` is camelCase on the wire; `workspace_fqn` is silently
  // ignored and returns an unfiltered tenant page that can hide collisions.
  const rows = rowsOf(await tfyFetch(`/api/svc/v1/apps?workspaceFqn=${encodeURIComponent(config.workspaceFqn)}&limit=200`));
  const includesExecutor = config.executor.backend === "truefoundry-job" || config.executor.backend === "truefoundry-service";
  const ours = includesExecutor ? [r.controller, r.executor] : [r.controller];
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
  if (!liveChecksAvailable()) throw new Error(TFY_LOGIN_HINT);
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
  if (config.executor.backend === "truefoundry-job") {
    list.push({ filename: `${config.name}-executor.yaml`, manifest: executorManifest(config) });
  } else if (config.executor.backend === "truefoundry-service") {
    list.push({ filename: `${config.name}-executor.yaml`, manifest: executorServiceManifest(config) });
  }
  return list;
}

async function emitManifestsToDir(items, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const { filename, manifest } of items) {
    await writeFile(path.join(outDir, filename), serializeManifest(manifest, filename));
  }
}

async function applyManifestsFromDir(items, outDir) {
  for (const { filename } of items) {
    const manifestPath = path.join(outDir, filename);
    console.log(`tfy apply ${path.relative(process.cwd(), manifestPath) || filename}`);
    await run("tfy", ["apply", "-f", manifestPath]);
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

async function promptMultiline(rl, label) {
  console.log(`${label} (blank line to finish, or Enter alone to skip):`);
  const lines = [];
  while (true) {
    const line = await rl.question("> ");
    if (!line.trim()) {
      if (!lines.length) return "";
      break;
    }
    lines.push(line);
  }
  return lines.join("\n").trim();
}

const SLACK_APPS_URL = "https://api.slack.com/apps";

async function runInit(flags = {}) {
  const apiOnly = Boolean(flags["api-only"]);
  await resolveTfyCredentials({ required: false });
  const rl = readline.createInterface({ input, output, terminal: true });
  try {
    console.log(
      apiOnly
        ? "This wizard creates agents/<name>/ with <name>.yaml and .hermes-secrets.local.\n"
        : "This wizard creates agents/<name>/ with <name>.yaml, slack-app-manifest.json, and .hermes-secrets.local.\n"
    );
    const handle = await prompt(rl, "Agent handle (2-32 chars, lowercase, hyphens)", { required: true, validate: slugifyName });
    const paths = agentPaths(handle);
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
    const secretsName = await prompt(rl, "SecretGroup name", {
      def: `${handle}-hermes-secrets`,
      validate: (value) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/.test(value)) throw new Error("invalid SecretGroup name");
        return value;
      }
    });

    console.log("\nOptional fields (press Enter to skip each):\n");
    const version = await prompt(rl, "Git ref for controller/executor image build", { def: DEFAULT_SOURCE_REF });
    const host = await prompt(rl, "Public controller host URL");
    const instructions = await promptMultiline(rl, "System instructions (appended each executor turn)");
    const skills = await promptList(rl, "Skill FQNs", {
      validate: (value) => { if (!validateSkillFqn(value)) throw new Error(`invalid skill FQN: ${value}`); }
    });
    const mcpServers = await promptList(rl, "MCP server URLs", { validate: normalizeMcpUrl });
    let slackTeamId = "";
    let allowedChannels = [];
    let allowedUsers = [];
    if (!apiOnly) {
      slackTeamId = await prompt(rl, "Slack team id (T…)");
      allowedChannels = await promptList(rl, "Slack allowed channel IDs (C…)");
      allowedUsers = await promptList(rl, "Slack allowed user IDs (U…)");
    }

    const runTokenSecret = generateRunTokenSecret();

    const hermesDoc = {
      name: handle,
      workspace_fqn: workspaceFqn,
      description,
      model,
      gateway_url: gatewayUrl,
      secrets: secretsName
    };
    if (version && version !== DEFAULT_SOURCE_REF) hermesDoc.version = version;
    if (host) hermesDoc.host = host;
    if (instructions) hermesDoc.instructions = instructions;
    if (!apiOnly) {
      if (slackTeamId) hermesDoc.slack_team_id = slackTeamId;
      if (allowedChannels.length || allowedUsers.length) {
        hermesDoc.slack = {};
        if (allowedChannels.length) hermesDoc.slack.allowed_channels = allowedChannels;
        if (allowedUsers.length) hermesDoc.slack.allowed_users = allowedUsers;
      }
    }
    if (skills.length) hermesDoc.skills = skills;
    if (mcpServers.length) hermesDoc.mcp_servers = mcpServers;

    await mkdir(paths.deployments, { recursive: true });
    await writeFile(paths.config, YAML.stringify(hermesDoc, { lineWidth: 0 }));

    if (!apiOnly) {
      const stubManifest = slackManifest({ name: handle, host: resolveHost(null, handle, workspaceFqn), description });
      await writeFile(paths.slackManifest, `${JSON.stringify(stubManifest, null, 2)}\n`);
      console.log(`wrote ${paths.slackManifest}`);
    }

    await writeFile(
      paths.secretsLocal,
      [
        `# Generated by tfy-hermes-agent init — do not commit (see .gitignore)`,
        `HERMES-RUN-TOKEN-SECRET=${runTokenSecret}`,
        ""
      ].join("\n"),
      { mode: 0o600 }
    );

    console.log(`\nwrote ${paths.config}`);
    console.log(`wrote ${paths.secretsLocal} (gitignored)`);
    console.log(`created ${paths.deployments}/\n`);
    console.log("Generated HERMES-RUN-TOKEN-SECRET for this agent (executor callback HMAC):");
    console.log(`  ${runTokenSecret}`);
    console.log("If updating an existing deployment, keep the SecretGroup value you already use.\n");
    console.log("Next steps:");
    const deployArg = path.relative(process.cwd(), paths.config) || paths.config;
    if (apiOnly) {
      console.log(`  1. Run: tfy-hermes-agent deploy ${handle}`);
      console.log("     (or: tfy-hermes-agent deploy " + deployArg + ")");
      console.log("     No manual secret steps — deploy creates the SecretGroup and sets");
      console.log("     HERMES-RUN-TOKEN-SECRET and TFY-API-KEY from credentials.json automatically.");
      console.log("  2. Call /v1/chat/completions on the controller host to verify.");
    } else {
      console.log(`  1. Install the Slack app at ${SLACK_APPS_URL}`);
      console.log("     Create New App → From an app manifest → paste agents/<name>/slack-app-manifest.json → Install App.");
      console.log("     Copy SLACK-BOT-TOKEN and SLACK-SIGNING-SECRET from the app settings.");
      console.log(`  2. Run: tfy-hermes-agent deploy ${handle}`);
      console.log("     (or: tfy-hermes-agent deploy " + deployArg + ")");
      console.log("     HERMES-RUN-TOKEN-SECRET and TFY-API-KEY are set automatically — no manual step.");
      console.log("     Then paste your Slack tokens into SLACK-BOT-TOKEN and SLACK-SIGNING-SECRET");
      console.log("     in the SecretGroup (the only secrets you enter by hand).");
      console.log("  3. Confirm Slack Event Subscriptions and Interactivity URLs match your controller host.");
    }
  } finally {
    rl.close();
  }
}

async function runDeploy(file, flags) {
  const configPath = resolveAgentConfigPath(file);
  const config = await readHermesConfig(configPath);
  const agentDir = path.dirname(configPath);
  const deploymentsDir = flags["emit-manifests"]
    ? path.resolve(flags["emit-manifests"])
    : path.join(agentDir, "deployments");

  await resolveTfyCredentials({ required: !flags["skip-live-checks"] });
  process.env.TFY_HOST ||= controlPlaneUrl(config);

  await ensureSecretGroup(config, configPath, {
    skipLiveChecks: Boolean(flags["skip-live-checks"])
  });

  await liveValidate(config, {
    allowUpdate: Boolean(flags.update),
    skipLiveChecks: Boolean(flags["skip-live-checks"])
  });

  const items = planManifests(config, { includeSecrets: Boolean(flags.update) });

  await emitManifestsToDir(items, deploymentsDir);
  console.log(`wrote ${items.length} manifest files to ${path.relative(process.cwd(), deploymentsDir) || deploymentsDir}`);

  // --skip-live-checks is the "preview offline" mode; never apply in that mode.
  // Otherwise applying without live-validated workspace/secret state is dangerous.
  if (flags["skip-live-checks"]) {
    console.log("skip-live-checks set: manifests prepared but not applied. Review files in deployments/, then re-run without --skip-live-checks.");
    return;
  }

  await applyManifestsFromDir(items, deploymentsDir);

  console.log("");
  console.log(`Controller: ${config.host.url}`);
  console.log(`Slack Events URL: ${config.host.url}/slack/events`);
  console.log(`Slack Interactions URL: ${config.host.url}/slack/interactions`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.command === "help") { console.log(USAGE); return; }
  if (parsed.command === "init") { await runInit(parsed.flags); return; }
  if (parsed.command === "deploy") { await runDeploy(parsed.file, parsed.flags); return; }
  throw new Error(`unknown command: ${parsed.command}\n\n${USAGE}`);
}

function generateRunTokenSecret() {
  return randomBytes(32).toString("hex");
}

export function isDirectInvocation(entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export {
  generateRunTokenSecret,
  parseHermesSecretsLocalContent,
  runTokenNeedsWrite
};

if (isDirectInvocation()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
