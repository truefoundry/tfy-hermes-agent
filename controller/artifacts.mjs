// TrueFoundry ML Repo artifact upload helpers (stage → signed URL → finalize).

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;

export function parseMlRepoRef(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const fqnMatch = raw.match(/^tfy-mlrepo:\/\/[^:]+:[^/]+\/([^/]+)$/i);
  if (fqnMatch) return fqnMatch[1];
  if (/^[a-zA-Z][a-zA-Z0-9-]{1,98}[a-zA-Z0-9]$/.test(raw)) return raw;
  throw new Error(`slack_inbound_artifact_repo must be an ML repo name or tfy-mlrepo:// FQN, got: ${raw}`);
}

export function sanitizeArtifactName(runId) {
  const safe = String(runId || "run").replace(/[^a-zA-Z0-9_-]/g, "");
  const name = `slack-${safe || "run"}`.slice(0, 256);
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`could not derive artifact name from run id ${runId}`);
  }
  return name;
}

export function sanitizeArtifactPath(slackFileId, filename) {
  const safeName = String(filename || "file").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  const safeId = String(slackFileId || "file").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  return `${safeId}-${safeName || "file"}`;
}

function artifactManifest({ mlRepo, name, metadata = {} }) {
  return {
    type: "artifact-version",
    name,
    ml_repo: mlRepo,
    metadata,
    source: { type: "truefoundry" }
  };
}

function isAzureSignedUrl(value) {
  try {
    const url = new URL(value);
    return /\.blob\.core\.windows\.net$/i.test(url.hostname)
      || /\.dfs\.core\.windows\.net$/i.test(url.hostname)
      || (url.searchParams.has("sig") && url.searchParams.has("sv") && url.searchParams.has("se"));
  } catch {
    return false;
  }
}

function uploadHeaders({ signedUrl, contentType, forceAzureBlobHeader = false }) {
  const headers = contentType ? { "content-type": contentType } : {};
  if (forceAzureBlobHeader || isAzureSignedUrl(signedUrl)) {
    headers["x-ms-blob-type"] = "BlockBlob";
  }
  return headers;
}

export function createArtifactClient({ tfyHost, tfyApiKey, fetchImpl = fetch }) {
  if (!tfyHost || !tfyApiKey) {
    throw new Error("TFY_HOST and TFY_API_KEY are required for artifact uploads");
  }

  async function mlJson(method, apiPath, body) {
    const res = await fetchImpl(`${tfyHost}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${tfyApiKey}`,
        "content-type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`TrueFoundry ${method} ${apiPath} failed ${res.status}: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async function stageArtifactVersion({ mlRepo, name, metadata }) {
    const payload = await mlJson("POST", "/api/ml/v1/artifact-versions/stage", {
      manifest: artifactManifest({ mlRepo, name, metadata })
    });
    if (!payload?.id) throw new Error("artifact stage response missing id");
    return payload;
  }

  async function getWriteSignedUrl({ versionId, path }) {
    const payload = await mlJson("POST", "/api/ml/v1/artifact-versions/signed-urls", {
      id: versionId,
      paths: [path],
      operation: "WRITE"
    });
    const entry = (payload?.data || []).find((item) => item.path === path) || payload?.data?.[0];
    if (!entry?.signed_url) throw new Error(`artifact WRITE signed URL missing for ${path}`);
    return entry.signed_url;
  }

  async function uploadToSignedUrl({ signedUrl, body, contentType }) {
    let headers = uploadHeaders({ signedUrl, contentType });
    const res = await fetchImpl(signedUrl, {
      method: "PUT",
      headers,
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (!headers["x-ms-blob-type"] && /x-ms-blob-type|MissingRequiredHeader/i.test(text)) {
        headers = uploadHeaders({ signedUrl, contentType, forceAzureBlobHeader: true });
        const retry = await fetchImpl(signedUrl, {
          method: "PUT",
          headers,
          body
        });
        if (retry.ok) return;
        const retryText = await retry.text().catch(() => "");
        throw new Error(`artifact upload failed ${retry.status}: ${retryText.slice(0, 300)}`);
      }
      throw new Error(`artifact upload failed ${res.status}: ${text.slice(0, 300)}`);
    }
  }

  async function finalizeArtifactVersion({ mlRepo, name, metadata }) {
    return mlJson("PUT", "/api/ml/v1/artifact-versions", {
      manifest: artifactManifest({ mlRepo, name, metadata })
    });
  }

  async function getArtifactVersion(versionId) {
    return mlJson("GET", `/api/ml/v1/artifact-versions/${encodeURIComponent(versionId)}`);
  }

  async function getReadSignedUrls({ versionId, paths }) {
    const payload = await mlJson("POST", "/api/ml/v1/artifact-versions/signed-urls", {
      id: versionId,
      paths,
      operation: "READ"
    });
    const byPath = new Map((payload?.data || []).map((entry) => [entry.path, entry.signed_url]));
    return paths.map((path) => {
      const signedUrl = byPath.get(path);
      if (!signedUrl) throw new Error(`artifact READ signed URL missing for ${path}`);
      return { path, signed_url: signedUrl };
    });
  }

  async function markStageFailure(versionId) {
    await mlJson("POST", "/api/ml/v1/artifact-versions/mark-stage-failure", { id: versionId }).catch(() => {});
  }

  return {
    stageArtifactVersion,
    getWriteSignedUrl,
    uploadToSignedUrl,
    finalizeArtifactVersion,
    getArtifactVersion,
    getReadSignedUrls,
    markStageFailure
  };
}

export async function downloadSlackFileToBuffer({ url, botToken, maxBytes = DEFAULT_MAX_FILE_BYTES, fetchImpl = fetch }) {
  if (!url) throw new Error("Slack file download URL is missing");
  if (!botToken) throw new Error("Slack bot token is required to download files");
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${botToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Slack file download failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const length = Number(res.headers.get("content-length") || 0);
  if (length > maxBytes) {
    throw new Error(`Slack file exceeds ${maxBytes} byte limit (${length} bytes)`);
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Slack file exceeds ${maxBytes} byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
