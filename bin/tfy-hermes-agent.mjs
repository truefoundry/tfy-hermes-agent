#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

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
  const config = YAML.parse(raw);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    fail("assistant config must be a YAML object");
  }
  return config;
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
    const missing = config.mcp_servers.filter((name) => !visible.has(name));
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
  return {
    TFY_WORKSPACE_FQN: config.workspace_fqn,
    TFY_SECRET_TENANT: tenant,
    TFY_BASE_URL: config.tfy_base_url.replace(/\/+$/, ""),
    CONTROL_API_HOST: config.hosts.control_api,
    HERMES_API_HOST: config.hosts.hermes_api || config.hosts.control_api.replace(/^([^.]+)/, "$1-hermes-api"),
    HERMES_REPO_URL: config.repo_url || "https://github.com/truefoundry/tfy-hermes-agent",
    HERMES_SOURCE_REF: config.source_ref || "main",
    HERMES_MODEL: config.model,
    GATEWAY_BASE_URL_REF: config.secrets.gateway_base_url,
    GATEWAY_API_KEY_REF: config.secrets.gateway_api_key,
    CONTROL_API_NAME: config.control_api_name || "harness-control-api",
    TURN_RUNNER_NAME: config.turn_runner_name || "hermes-turn-runner",
    HERMES_API_NAME: config.hermes_api_name || "hermes-api",
    CONTROL_VOLUME_NAME: config.control_volume || "hermes-control-state",
    HERMES_VOLUME_NAME: config.hermes_volume || "hermes-state",
    HERMES_SKILLS_REGISTRY_URL: config.skills_registry_url || ""
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
