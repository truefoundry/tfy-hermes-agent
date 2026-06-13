#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
const configPath = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : null;

const commands = new Set(["validate", "render", "deploy", "test"]);

function usage(exitCode = 2) {
  console.error("Usage: tfy-hermes-agent <validate|render|deploy|test> assistant.yaml");
  process.exit(exitCode);
}

if (!commands.has(command) || !configPath) usage();

function fail(message) {
  console.error(`tfy-hermes-agent: ${message}`);
  process.exit(1);
}

async function readConfig() {
  if (!existsSync(configPath)) fail(`config not found: ${configPath}`);
  const raw = await readFile(configPath, "utf8");
  const config = parseAssistantYaml(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("assistant config must be a YAML object");
  }
  return config;
}

function parseAssistantYaml(raw) {
  const result = {};
  const lines = raw.split(/\r?\n/);
  let currentKey = null;
  let currentObjectKey = null;
  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i];
    if (!original.trim() || original.trim().startsWith("#")) continue;
    const indent = original.match(/^ */)[0].length;
    const line = stripComment(original.trim());
    if (!line) continue;

    if (indent === 0) {
      const [key, value] = splitKeyValue(line, i + 1);
      currentKey = key;
      currentObjectKey = null;
      if (value === "") {
        const next = nextContentLine(lines, i + 1);
        result[key] = next?.trim().startsWith("- ") ? [] : {};
      } else {
        result[key] = parseScalar(value);
      }
      continue;
    }

    if (!currentKey || ![2, 4].includes(indent)) {
      fail(`unsupported YAML shape at line ${i + 1}; use top-level keys with two-space nested values`);
    }

    if (indent === 2 && line.startsWith("- ")) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(parseScalar(line.slice(2).trim()));
      currentObjectKey = null;
      continue;
    }

    if (indent === 4 && line.startsWith("- ")) {
      if (!currentObjectKey || Array.isArray(result[currentKey])) {
        fail(`nested array item has no parent key at line ${i + 1}`);
      }
      if (!Array.isArray(result[currentKey][currentObjectKey])) result[currentKey][currentObjectKey] = [];
      result[currentKey][currentObjectKey].push(parseScalar(line.slice(2).trim()));
      continue;
    }

    if (indent !== 2 || Array.isArray(result[currentKey])) {
      fail(`mixed array/object values under ${currentKey} at line ${i + 1}`);
    }
    const [key, value] = splitKeyValue(line, i + 1);
    if (value === "") {
      const next = nextContentLine(lines, i + 1);
      result[currentKey][key] = next?.trim().startsWith("- ") ? [] : {};
    } else {
      result[currentKey][key] = parseScalar(value);
    }
    currentObjectKey = key;
  }
  return result;
}

function nextContentLine(lines, startIndex) {
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line && !line.startsWith("#")) return line;
  }
  return null;
}

function splitKeyValue(line, lineNumber) {
  const index = line.indexOf(":");
  if (index <= 0) fail(`expected key/value at line ${lineNumber}`);
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function stripComment(line) {
  const index = line.indexOf(" #");
  return (index >= 0 ? line.slice(0, index) : line).trim();
}

function parseScalar(value) {
  if (value === "") return "";
  if (value === "[]") return [];
  if (value === "{}") return {};
  if (/^\[.*\]$/.test(value)) {
    try {
      return JSON.parse(value.replace(/'/g, '"'));
    } catch {
      return value.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^["']|["']$/g, "");
}

function assertString(config, key) {
  if (typeof config[key] !== "string" || !config[key].trim()) {
    fail(`missing required string: ${key}`);
  }
}

function assertSecretRef(value, key) {
  if (typeof value !== "string" || !value.startsWith("tfy-secret://")) {
    fail(`${key} must be a tfy-secret:// reference`);
  }
}

function parseSecretTenant(secretRef) {
  const match = secretRef.match(/^tfy-secret:\/\/([^:]+):([^:]+):([^:]+)$/);
  if (!match) fail(`invalid tfy-secret reference: ${secretRef}`);
  return match[1];
}

function validateShape(config) {
  assertString(config, "name");
  assertString(config, "workspace_fqn");
  assertString(config, "tfy_base_url");
  assertString(config, "model");
  if (!config.hosts || typeof config.hosts !== "object") fail("missing hosts");
  if (typeof config.hosts.control_api !== "string" || !config.hosts.control_api.trim()) {
    fail("missing hosts.control_api");
  }
  if (!config.secrets || typeof config.secrets !== "object") fail("missing secrets");
  assertSecretRef(config.secrets.gateway_base_url, "secrets.gateway_base_url");
  assertSecretRef(config.secrets.gateway_api_key, "secrets.gateway_api_key");
  if (parseSecretTenant(config.secrets.gateway_base_url) !== parseSecretTenant(config.secrets.gateway_api_key)) {
    fail("gateway secret refs must use the same tenant");
  }
  for (const [key, value] of Object.entries(config.secrets)) assertSecretRef(value, `secrets.${key}`);
  for (const key of ["skills", "mcp_servers"]) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some((item) => typeof item !== "string" || !item.trim()))) {
      fail(`${key} must be an array of strings`);
    }
  }
  for (const server of config.mcp_servers || []) {
    if (!isMcpGatewayUrl(server)) {
      fail(`mcp_servers entries must be MCP Gateway URLs or paths: ${server}`);
    }
  }
  if (config.slack !== undefined) {
    if (!config.slack || typeof config.slack !== "object" || Array.isArray(config.slack)) fail("slack must be an object");
    const slack = config.slack;
    if (slack.enabled !== undefined && typeof slack.enabled !== "boolean") fail("slack.enabled must be a boolean");
    if (slack.handles !== undefined && (!Array.isArray(slack.handles) || slack.handles.some((item) => typeof item !== "string" || !item.trim()))) {
      fail("slack.handles must be an array of strings");
    }
    if (slack.channel_ids !== undefined && (!Array.isArray(slack.channel_ids) || slack.channel_ids.some((item) => typeof item !== "string" || !item.trim()))) {
      fail("slack.channel_ids must be an array of strings");
    }
    if (slack.response_mode !== undefined && !["mentions", "all-channel"].includes(slack.response_mode)) {
      fail("slack.response_mode must be mentions or all-channel");
    }
    if (slack.enabled) {
      assertSecretRef(config.secrets.slack_bot_token, "secrets.slack_bot_token");
      assertSecretRef(config.secrets.slack_signing_secret, "secrets.slack_signing_secret");
    }
  }
}

function isMcpGatewayUrl(value) {
  return /^(https?:\/\/.*|\$\{gateway_base_url\}|)\/mcp\/[^/]+\/server\/?$/.test(String(value));
}

function mcpServerNameFromUrl(value) {
  const match = String(value).match(/\/mcp\/([^/]+)\/server\/?$/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function tfyFetch(config, apiPath) {
  const token = await tfyToken();
  if (!token) return null;
  const baseUrl = config.tfy_base_url.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}${apiPath}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const text = await res.text();
  if (!res.ok) fail(`TrueFoundry ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
}

async function validateLiveRefs(config) {
  const token = await tfyToken();
  if (!token) {
    console.warn("No TFY_API_KEY or tfy login credentials found; skipped live MCP/skills validation");
    return;
  }
  if (Array.isArray(config.mcp_servers) && config.mcp_servers.length) {
    const body = await tfyFetch(config, "/api/svc/v1/mcp-servers");
    const visible = new Set((body?.data || []).map((server) => server.name || server.manifest?.name).filter(Boolean));
    const missing = config.mcp_servers
      .map(mcpServerNameFromUrl)
      .filter((name) => name && !visible.has(name));
    if (missing.length) fail(`MCP servers not visible through gateway: ${missing.join(", ")}`);
  }
  if (Array.isArray(config.skills) && config.skills.length) {
    if (!config.skills_registry_url) {
      console.warn("skills_registry_url not set; skipped live skills registry validation");
      return;
    }
    const res = await fetch(config.skills_registry_url, {
      headers: { authorization: `Bearer ${token}` }
    });
    const text = await res.text();
    if (!res.ok) fail(`skills registry failed ${res.status}: ${text.slice(0, 500)}`);
    const body = text ? JSON.parse(text) : {};
    const rows = Array.isArray(body.skills) ? body.skills : Array.isArray(body.data) ? body.data : [];
    const allowed = new Set(rows.map((skill) => String(skill.slug || skill.name || skill.id)));
    const missing = config.skills.filter((name) => !allowed.has(name));
    if (missing.length) fail(`skills not found in registry: ${missing.join(", ")}`);
  }
}

async function tfyToken() {
  if (process.env.TFY_API_KEY) return process.env.TFY_API_KEY;
  try {
    const raw = await readFile(path.join(os.homedir(), ".truefoundry", "credentials.json"), "utf8");
    const credentials = JSON.parse(raw);
    return credentials.access_token || credentials.api_key || "";
  } catch {
    return "";
  }
}

function renderVars(config) {
  const tenant = parseSecretTenant(config.secrets.gateway_api_key);
  const secretRefs = Object.values(config.secrets || {});
  return {
    TFY_WORKSPACE_FQN: config.workspace_fqn,
    TFY_SECRET_TENANT: tenant,
    TFY_BASE_URL: config.tfy_base_url.replace(/\/+$/, ""),
    CONTROL_API_HOST: config.hosts.control_api,
    HERMES_API_HOST: config.hosts.hermes_api || config.hosts.control_api.replace(/^([^.]+)/, "$1-hermes-api"),
    HERMES_REPO_URL: config.repo_url || "https://github.com/truefoundry/tfy-hermes-agent",
    HERMES_SOURCE_BRANCH: config.source_branch || "main",
    HERMES_SOURCE_REF: config.source_ref || "main",
    HERMES_MODEL: config.model,
    GATEWAY_BASE_URL_REF: config.secrets.gateway_base_url,
    GATEWAY_API_KEY_REF: config.secrets.gateway_api_key,
    CONTROL_API_NAME: config.control_api_name || "harness-control-api",
    TURN_RUNNER_NAME: config.turn_runner_name || "hermes-turn-runner",
    HERMES_API_NAME: config.hermes_api_name || "hermes-api",
    CONTROL_VOLUME_NAME: config.control_volume || "hermes-control-state",
    HERMES_VOLUME_NAME: config.hermes_volume || "hermes-state",
    CONTROL_VOLUME_SIZE: config.control_volume_size || 10,
    CONTROL_VOLUME_STORAGE_CLASS: config.control_volume_storage_class || "managed-csi-premium",
    HERMES_VOLUME_SIZE: config.hermes_volume_size || 20,
    HERMES_VOLUME_STORAGE_CLASS: config.hermes_volume_storage_class || "azurefile",
    HERMES_SKILLS_REGISTRY_URL: config.skills_registry_url || "",
    HERMES_DEFAULT_SKILLS: JSON.stringify(config.skills || []),
    HERMES_DEFAULT_MCP_SERVERS: JSON.stringify(config.mcp_servers || []),
    HERMES_DEFAULT_SECRET_REFS: JSON.stringify(secretRefs),
    SLACK_ENABLED: String(config.slack?.enabled === true),
    SLACK_APP_NAME: config.slack?.app_name || config.name,
    SLACK_BOT_TOKEN_REF: config.secrets.slack_bot_token || '""',
    SLACK_SIGNING_SECRET_REF: config.secrets.slack_signing_secret || '""',
    SLACK_BOT_USER_ID: config.slack?.bot_user_id || "",
    SLACK_TEAM_ID: config.slack?.team_id || "",
    SLACK_TEAM_NAME: config.slack?.team_name || "",
    SLACK_HANDLES: JSON.stringify(config.slack?.handles || ["hermes"]),
    SLACK_CHANNEL_IDS: JSON.stringify(config.slack?.channel_ids || []),
    SLACK_RESPONSE_MODE: config.slack?.response_mode || "mentions"
  };
}

function replaceVars(input, vars) {
  return input.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    if (vars[key] === undefined) fail(`template variable ${key} is not defined`);
    return String(vars[key]);
  });
}

async function render(config) {
  const outputDir = path.join(path.dirname(configPath), ".rendered");
  await mkdir(outputDir, { recursive: true });
  const vars = renderVars(config);
  const names = [
    "control-volume.yaml",
    "hermes-state-volume.yaml",
    "turn-runner-job.yaml",
    "hermes-api-service.yaml",
    "control-api-service.yaml"
  ];
  for (const name of names) {
    const template = await readFile(path.join(root, "templates", name), "utf8");
    await writeFile(path.join(outputDir, name), replaceVars(template, vars));
  }
  return outputDir;
}

function run(cmd, args, options = {}) {
  const { env: extraEnv, ...spawnOptions } = options;
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, ...(extraEnv || {}) },
    ...spawnOptions
  });
  if (result.status !== 0) fail(`${cmd} ${args.join(" ")} failed`);
}

async function deploy(config) {
  const outputDir = await render(config);
  const tfyEnv = {
    TFY_HOST: process.env.TFY_HOST || config.tfy_base_url.replace(/\/+$/, ""),
    TFY_BASE_URL: process.env.TFY_BASE_URL || config.tfy_base_url.replace(/\/+$/, "")
  };
  for (const name of [
    "control-volume.yaml",
    "hermes-state-volume.yaml",
    "turn-runner-job.yaml",
    "hermes-api-service.yaml",
    "control-api-service.yaml"
  ]) {
    run("tfy", ["deploy", "-f", path.join(outputDir, name), "--no-wait"], { env: tfyEnv });
  }
  console.log(`Rendered and deployed manifests from ${outputDir}`);
}

async function test(config) {
  const base = `https://${config.hosts.control_api}`;
  const health = await fetch(`${base}/api/health`);
  if (!health.ok) fail(`health failed: ${health.status}`);
  const body = await health.json();
  console.log(`health ok: ${JSON.stringify(body)}`);
}

const config = await readConfig();
validateShape(config);

if (command === "validate") {
  await validateLiveRefs(config);
  console.log("assistant config valid");
} else if (command === "render") {
  const outputDir = await render(config);
  console.log(`rendered manifests to ${outputDir}`);
} else if (command === "deploy") {
  await validateLiveRefs(config);
  await deploy(config);
} else if (command === "test") {
  await test(config);
}
