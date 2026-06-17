#!/usr/bin/env node
/**
 * Live smoke: Slack-like file records -> TrueFoundry artifact stage/upload/finalize
 * -> read signed URL -> download verification.
 *
 * Required:
 *   TFY_HOST + TFY_API_KEY, or ~/.truefoundry/credentials.json from `tfy login`
 *   HERMES_SLACK_INBOUND_ARTIFACT_REPO, or first arg / env TFY_HERMES_LIVE_ARTIFACT_REPO
 *
 * Run:
 *   node controller/slack-artifact-live-smoke.mjs sai-mlrepo
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { ingestSlackFilesToArtifacts } from "./slack-ingest.mjs";

const TEXT_BODY = Buffer.from("tfy hermes live artifact smoke text\n");
const PNG_BODY = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82
]);

async function loadTfyCredentials() {
  const host = process.env.TFY_HOST || process.env.TFY_BASE_URL || "";
  const apiKey = process.env.TFY_API_KEY || "";
  if (host && apiKey) return { host: host.replace(/\/+$/, ""), apiKey };

  const raw = await readFile(join(homedir(), ".truefoundry", "credentials.json"), "utf8");
  const creds = JSON.parse(raw);
  return {
    host: String(creds.host || creds.base_url || creds.baseUrl || "").replace(/\/+$/, ""),
    apiKey: String(creds.access_token || creds.token || creds.api_key || creds.apiKey || "")
  };
}

function fakeSlackFetch(url, options = {}) {
  const href = String(url);
  if (!href.startsWith("https://files.slack.test/")) {
    return fetch(url, options);
  }
  assert.equal(options.headers?.authorization, "Bearer xoxb-live-smoke");
  const body = href.endsWith("/image.png") ? PNG_BODY : TEXT_BODY;
  return {
    ok: true,
    headers: { get: (key) => key.toLowerCase() === "content-length" ? String(body.length) : null },
    body: (async function* streamBody() { yield body; })()
  };
}

async function downloadSignedUrl(url) {
  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`download failed ${res.status}: ${body.toString("utf8").slice(0, 500)}`);
  }
  return body;
}

async function main() {
  const repo = process.argv[2]
    || process.env.TFY_HERMES_LIVE_ARTIFACT_REPO
    || process.env.HERMES_SLACK_INBOUND_ARTIFACT_REPO
    || "";
  if (!repo) {
    throw new Error("artifact repo required: pass repo name as argv[2] or set TFY_HERMES_LIVE_ARTIFACT_REPO");
  }

  const { host, apiKey } = await loadTfyCredentials();
  if (!host || !apiKey) throw new Error("TFY_HOST and TFY_API_KEY are required, or run tfy login first");

  const runId = `run_live_artifact_smoke_${Date.now()}`;
  const attachments = await ingestSlackFilesToArtifacts({
    files: [{
      id: "FLIVE1",
      filename: "live-note.txt",
      mime_type: "text/plain",
      filetype: "text",
      size: TEXT_BODY.length,
      url_private_download: "https://files.slack.test/live-note.txt"
    }, {
      id: "FLIVE2",
      filename: "live-image.png",
      mime_type: "image/png",
      filetype: "png",
      size: PNG_BODY.length,
      url_private_download: "https://files.slack.test/image.png"
    }],
    runId,
    mlRepoRef: repo,
    slackBotToken: "xoxb-live-smoke",
    tfyHost: host,
    tfyApiKey: apiKey,
    stateRoot: "/tmp/tfy-hermes-live-artifact-smoke",
    fetchImpl: fakeSlackFetch
  });

  assert.equal(attachments.length, 2);
  assert.ok(attachments.every((item) => item.artifact_fqn));
  assert.ok(attachments.every((item) => item.download_url));

  const textAttachment = attachments.find((item) => item.filename === "live-note.txt");
  const imageAttachment = attachments.find((item) => item.filename === "live-image.png");
  assert.ok(textAttachment);
  assert.ok(imageAttachment);

  const downloadedText = await downloadSignedUrl(textAttachment.download_url);
  const downloadedImage = await downloadSignedUrl(imageAttachment.download_url);
  assert.deepEqual(downloadedText, TEXT_BODY);
  assert.deepEqual(downloadedImage, PNG_BODY);

  console.log(JSON.stringify({
    ok: true,
    repo,
    runId,
    artifactFqn: attachments[0].artifact_fqn,
    attachments: attachments.map((item) => ({
      filename: item.filename,
      artifact_path: item.artifact_path,
      size: item.size,
      has_download_url: Boolean(item.download_url)
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
