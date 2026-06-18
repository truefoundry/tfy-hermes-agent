#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseMlRepoRef } from "./artifacts.mjs";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_PREFIX = "slack-run_";
const DEFAULT_LIMIT = 100;

function envFlag(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || "").trim());
}

function positiveInteger(value, fallback, label) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function rowsOf(body) {
  return Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
}

function paginationTotal(body) {
  const total = Number(body?.pagination?.total);
  return Number.isFinite(total) ? total : null;
}

function artifactName(row) {
  const name = row?.manifest?.name || row?.name;
  if (name) return String(name);
  const match = String(row?.fqn || "").match(/^artifact:[^/]+\/[^/]+\/([^:]+)(?::\d+)?$/);
  return match?.[1] || "";
}

function artifactRepo(row) {
  const repo = row?.manifest?.ml_repo || row?.ml_repo;
  if (repo) return String(repo);
  const match = String(row?.fqn || "").match(/^artifact:[^/]+\/([^/]+)\//);
  return match?.[1] || "";
}

function metadataOf(row) {
  return row?.manifest?.metadata && typeof row.manifest.metadata === "object" ? row.manifest.metadata : {};
}

function timestampMs(row) {
  const raw = row?.created_at || row?.createdAt || row?.manifest?.created_at || row?.manifest?.createdAt;
  const parsed = Date.parse(String(raw || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSlackRunArtifactVersion(row, { mlRepo, prefix, cutoffMs }) {
  if (artifactRepo(row) && artifactRepo(row) !== mlRepo) return false;
  const name = artifactName(row);
  if (!name.startsWith(prefix)) return false;
  const metadata = metadataOf(row);
  const runId = String(metadata.run_id || "");
  const source = String(metadata.source || "");
  if (source !== "slack" && !runId.startsWith("run_")) return false;
  const created = timestampMs(row);
  if (!created) return false;
  return created < cutoffMs;
}

export function createArtifactCleanupClient({ tfyHost, tfyApiKey, fetchImpl = fetch }) {
  if (!tfyHost || !tfyApiKey) throw new Error("TFY_HOST and TFY_API_KEY are required for artifact cleanup");
  const base = String(tfyHost).replace(/\/+$/, "");

  async function mlJson(method, apiPath, body) {
    const res = await fetchImpl(`${base}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${tfyApiKey}`,
        "content-type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`TrueFoundry ${method} ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
    return text ? JSON.parse(text) : {};
  }

  async function findMlRepoId(mlRepo) {
    const body = await mlJson("GET", `/api/ml/v1/ml-repos?name=${encodeURIComponent(mlRepo)}&limit=50&offset=0`);
    const matches = rowsOf(body).filter((row) => row?.manifest?.name === mlRepo || row?.name === mlRepo);
    if (!matches.length) throw new Error(`ML repo not found or not accessible: ${mlRepo}`);
    if (matches.length > 1) throw new Error(`multiple ML repos matched ${mlRepo}; refusing cleanup`);
    return String(matches[0].id);
  }

  async function listArtifactVersions({ mlRepoId, limit = DEFAULT_LIMIT }) {
    const all = [];
    for (let offset = 0; ; offset += limit) {
      const body = await mlJson(
        "GET",
        `/api/ml/v1/artifact-versions?ml_repo_id=${encodeURIComponent(mlRepoId)}&limit=${limit}&offset=${offset}`
      );
      const rows = rowsOf(body);
      all.push(...rows);
      const total = paginationTotal(body);
      if (total != null ? all.length >= total : rows.length < limit) return all;
    }
  }

  async function deleteArtifactVersion(id) {
    await mlJson("DELETE", `/api/ml/v1/artifact-versions/${encodeURIComponent(id)}`);
  }

  return { findMlRepoId, listArtifactVersions, deleteArtifactVersion };
}

export async function cleanupSlackRunArtifacts({
  tfyHost,
  tfyApiKey,
  mlRepo,
  retentionDays = DEFAULT_RETENTION_DAYS,
  prefix = DEFAULT_PREFIX,
  dryRun = false,
  now = new Date(),
  fetchImpl = fetch,
  client = null
}) {
  const repoName = parseMlRepoRef(mlRepo);
  if (!repoName) throw new Error("HERMES_SLACK_INBOUND_ARTIFACT_REPO is required");
  const resolvedRetentionDays = positiveInteger(retentionDays, DEFAULT_RETENTION_DAYS, "retentionDays");
  const resolvedPrefix = String(prefix || DEFAULT_PREFIX).trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(resolvedPrefix)) {
    throw new Error("cleanup prefix must use only letters, numbers, underscores, and hyphens");
  }

  const api = client || createArtifactCleanupClient({ tfyHost, tfyApiKey, fetchImpl });
  const mlRepoId = await api.findMlRepoId(repoName);
  const cutoffMs = new Date(now).getTime() - resolvedRetentionDays * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(cutoffMs)) throw new Error("now must be a valid Date");

  const scanned = await api.listArtifactVersions({ mlRepoId });
  const candidates = scanned.filter((row) => isSlackRunArtifactVersion(row, {
    mlRepo: repoName,
    prefix: resolvedPrefix,
    cutoffMs
  }));
  const deleted = [];
  const failed = [];
  if (!dryRun) {
    for (const row of candidates) {
      try {
        await api.deleteArtifactVersion(row.id);
        deleted.push({ id: row.id, fqn: row.fqn, name: artifactName(row), created_at: row.created_at });
      } catch (error) {
        failed.push({
          id: row.id,
          fqn: row.fqn,
          name: artifactName(row),
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const summary = {
    mlRepo: repoName,
    mlRepoId,
    dryRun,
    retentionDays: resolvedRetentionDays,
    prefix: resolvedPrefix,
    cutoff: new Date(cutoffMs).toISOString(),
    scanned: scanned.length,
    candidates: candidates.map((row) => ({
      id: row.id,
      fqn: row.fqn,
      name: artifactName(row),
      created_at: row.created_at
    })),
    deleted,
    failed
  };
  if (failed.length) {
    const error = new Error(`artifact cleanup failed for ${failed.length} version${failed.length === 1 ? "" : "s"}`);
    error.summary = summary;
    throw error;
  }
  return summary;
}

export function isDirectInvocation(entryPath = process.argv[1]) {
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  const summary = await cleanupSlackRunArtifacts({
    tfyHost: process.env.TFY_HOST,
    tfyApiKey: process.env.TFY_API_KEY,
    mlRepo: process.env.HERMES_SLACK_INBOUND_ARTIFACT_REPO,
    retentionDays: process.env.HERMES_ARTIFACT_CLEANUP_RETENTION_DAYS,
    prefix: process.env.HERMES_ARTIFACT_CLEANUP_PREFIX,
    dryRun: envFlag(process.env.HERMES_ARTIFACT_CLEANUP_DRY_RUN)
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (isDirectInvocation()) {
  main().catch((error) => {
    if (error?.summary) console.error(JSON.stringify(error.summary, null, 2));
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
