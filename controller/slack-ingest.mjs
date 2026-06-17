// Download Slack file attachments and upload them to TrueFoundry Artifacts.

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  createArtifactClient,
  downloadSlackFileToBuffer,
  parseMlRepoRef,
  sanitizeArtifactName,
  sanitizeArtifactPath
} from "./artifacts.mjs";
import { normalizeSlackFiles } from "./slack.mjs";

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function resolveSlackFileRecords({ files, slackApi }) {
  const normalized = normalizeSlackFiles(files);
  const resolved = [];
  for (const file of normalized) {
    if (file.url_private_download) {
      resolved.push(file);
      continue;
    }
    if (!slackApi || !file.id) {
      throw new Error(`Slack file ${file.id || file.filename} is missing a download URL`);
    }
    const info = await slackApi("files.info", { file: file.id });
    const full = info?.file || {};
    const enriched = normalizeSlackFiles([full])[0];
    if (!enriched?.url_private_download) {
      throw new Error(`Slack files.info did not return url_private_download for ${file.id}`);
    }
    resolved.push({ ...file, ...enriched });
  }
  return resolved;
}

export async function ingestSlackFilesToArtifacts({
  files,
  runId,
  mlRepoRef,
  slackBotToken,
  tfyHost,
  tfyApiKey,
  stateRoot = "/data",
  slackApi = null,
  maxFiles = DEFAULT_MAX_FILES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  fetchImpl = fetch,
  artifactClient = null
}) {
  const mlRepo = parseMlRepoRef(mlRepoRef);
  if (!mlRepo) {
    throw new Error("HERMES_SLACK_INBOUND_ARTIFACT_REPO is required when Slack messages include file attachments");
  }

  const fileRecords = await resolveSlackFileRecords({ files, slackApi });
  if (!fileRecords.length) return [];
  if (fileRecords.length > maxFiles) {
    throw new Error(`Slack message has ${fileRecords.length} files; maximum is ${maxFiles}`);
  }

  const client = artifactClient || createArtifactClient({ tfyHost, tfyApiKey, fetchImpl });
  const artifactName = sanitizeArtifactName(runId);
  const metadata = {
    source: "slack",
    run_id: runId,
    file_count: fileRecords.length
  };

  const staged = await client.stageArtifactVersion({ mlRepo, name: artifactName, metadata });
  const versionId = staged.id;
  const inboundDir = join(stateRoot, "inbound", runId);

  try {
    await mkdir(inboundDir, { recursive: true });
    const artifactPaths = [];

    for (const file of fileRecords) {
      const artifactPath = sanitizeArtifactPath(file.id, file.filename);
      const bytes = await downloadSlackFileToBuffer({
        url: file.url_private_download,
        botToken: slackBotToken,
        maxBytes: maxFileBytes,
        fetchImpl
      });
      const uploadTarget = await client.getWriteSignedUrl({
        versionId,
        path: artifactPath,
        storageRoot: staged.storage_root
      });
      const uploadRequest = typeof uploadTarget === "string" ? { signedUrl: uploadTarget } : uploadTarget;
      await client.uploadToSignedUrl({
        ...uploadRequest,
        body: bytes,
        contentType: file.mime_type || "application/octet-stream"
      });
      artifactPaths.push({ file, artifactPath });
    }

    const finalized = await client.finalizeArtifactVersion({ mlRepo, name: artifactName, metadata });
    const artifactFqn = finalized?.data?.fqn
      || (await client.getArtifactVersion(versionId))?.data?.fqn
      || null;

    const readUrls = await client.getReadSignedUrls({
      versionId,
      paths: artifactPaths.map((entry) => entry.artifactPath)
    });
    const readUrlByPath = new Map(readUrls.map((entry) => [entry.path, entry.signed_url]));

    return artifactPaths.map(({ file, artifactPath }) => ({
      slack_file_id: file.id,
      filename: file.filename,
      mime_type: file.mime_type,
      filetype: file.filetype,
      size: file.size,
      artifact_fqn: artifactFqn,
      artifact_path: artifactPath,
      download_url: readUrlByPath.get(artifactPath)
    }));
  } catch (error) {
    await client.markStageFailure(versionId);
    throw error;
  } finally {
    await rm(inboundDir, { recursive: true, force: true }).catch(() => {});
  }
}
