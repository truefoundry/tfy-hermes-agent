#!/usr/bin/env node
/**
 * End-to-end smoke: Slack event → artifact ingest (mocked TFY) → work payload → executor prompt.
 * Run: node controller/slack-files-smoke.mjs
 */

import assert from "node:assert/strict";

import { ingestSlackFilesToArtifacts } from "./slack-ingest.mjs";
import { normalizeSlackFiles, slackPrompt } from "./slack.mjs";

const RUN_ID = "run_smoke1234";
const SLACK_EVENT = {
  team_id: "T01234567",
  event: {
    type: "message",
    channel: "D01234567",
    channel_type: "im",
    user: "U01234567",
    ts: "1710000000.000100",
    thread_ts: "1710000000.000100",
    text: "save this booth photo to KubeCon notes",
    files: [{
      id: "F01234567",
      name: "booth.jpg",
      mimetype: "image/jpeg",
      filetype: "jpg",
      size: 18,
      url_private_download: "https://files.slack.com/mock/booth.jpg"
    }, {
      id: "F07654321",
      name: "notes.pdf",
      mimetype: "application/pdf",
      filetype: "pdf",
      size: 22,
      url_private_download: "https://files.slack.com/mock/notes.pdf"
    }]
  }
};

function mockArtifactClient() {
  let stagedId = "av_smoke_1";
  const uploads = [];
  return {
    uploads,
    client: {
      stageArtifactVersion: async ({ mlRepo, name, metadata }) => {
        assert.equal(mlRepo, "slack-inbound");
        assert.equal(name, "slack-run_smoke1234");
        assert.equal(metadata.run_id, RUN_ID);
        assert.equal(metadata.file_count, 2);
        return { id: stagedId, storage_root: "s3://mock/root", artifact_id: "art_smoke" };
      },
      getWriteSignedUrl: async ({ path }) => `https://upload.mock/${path}`,
      uploadToSignedUrl: async ({ signedUrl, body, contentType }) => {
        uploads.push({ signedUrl, bytes: body.length, contentType });
      },
      finalizeArtifactVersion: async () => ({
        data: { fqn: "artifact:tfy-eo/sai-ws/slack-run_smoke1234:1" }
      }),
      getReadSignedUrls: async ({ paths }) => paths.map((path) => ({
        path,
        signed_url: `https://read.mock/${path}?sig=smoke`
      })),
      markStageFailure: async () => {}
    }
  };
}

function mockFetch({ slackBodies, artifactClient }) {
  return async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://files.slack.com/mock/")) {
      assert.match(options.headers?.authorization || "", /^Bearer xoxb-/);
      const body = href.endsWith("booth.jpg") ? "fake-jpeg-bytes-xx" : "fake-pdf-bytes-yyyyyy";
      return {
        ok: true,
        headers: { get: () => String(body.length) },
        body: (async function* () { yield Buffer.from(body); })()
      };
    }
    if (href.startsWith("https://upload.mock/")) {
      await artifactClient.uploadToSignedUrl({
        signedUrl: href,
        body: Buffer.from(options.body || ""),
        contentType: options.headers?.["content-type"]
      });
      return { ok: true, text: async () => "" };
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
}

function buildHarnessWork({ content, slack, attachments }) {
  return {
    run_id: RUN_ID,
    hermes_session_id: "session_smoke",
    content,
    slack,
    attachments,
    agent: {
      id: "agt_smoke",
      handle: "devrel-assistant",
      name: "DevRel Assistant",
      description: "smoke",
      instructions: "be concise",
      model: "openai-main/gpt-5.5",
      skills: [],
      mcpServers: ["https://mcp.example/devrel-dashboard"]
    },
    callback_url: "https://controller.example",
    controller_event_url: `https://controller.example/api/internal/runs/${RUN_ID}/events`
  };
}

async function main() {
  console.log("=== Slack file ingest smoke ===\n");

  const event = SLACK_EVENT.event;
  const slackFiles = normalizeSlackFiles(event.files);
  assert.equal(slackFiles.length, 2);

  const { client, uploads } = mockArtifactClient();
  const attachments = await ingestSlackFilesToArtifacts({
    files: slackFiles,
    runId: RUN_ID,
    mlRepoRef: "slack-inbound",
    slackBotToken: "xoxb-smoke-token",
    tfyHost: "https://tenant.truefoundry.cloud",
    tfyApiKey: "tfy-smoke-key",
    stateRoot: "/tmp/hermes-slack-smoke",
    fetchImpl: mockFetch({ artifactClient: client }),
    artifactClient: client
  });

  assert.equal(uploads.length, 2);
  assert.equal(attachments.length, 2);
  assert.ok(attachments.every((item) => item.download_url.startsWith("https://read.mock/")));
  assert.ok(attachments.every((item) => item.artifact_fqn.includes("slack-run_smoke1234")));

  const slackContext = {
    team_id: SLACK_EVENT.team_id,
    channel_id: event.channel,
    thread_ts: event.thread_ts,
    message_ts: event.ts,
    user_id: event.user,
    text: event.text.replace(/<@[^>]+>/g, "").trim()
  };

  const prompt = slackPrompt({
    text: slackContext.text,
    slack: slackContext,
    attachments,
    context: { channel_id: event.channel, team_id: SLACK_EVENT.team_id },
    agent: { handle: "devrel-assistant", name: "DevRel Assistant" },
    fallbackHandle: "hermes"
  });

  const decoded = buildHarnessWork({ content: prompt, slack: slackContext, attachments });

  assert.equal(decoded.run_id, RUN_ID);
  assert.equal(decoded.attachments.length, 2);
  assert.match(decoded.content, /save this booth photo to KubeCon notes/);
  assert.match(decoded.content, /booth\.jpg/);
  assert.match(decoded.content, /notes\.pdf/);
  assert.match(decoded.content, /download_url_auth: signed URL; do not add Authorization header/);
  assert.equal(decoded.slack.user_id, "U01234567");

  // Executor reads work.content into prompt-<run_id>.txt — mirror that step.
  const executorPrompt = String(decoded.content || "");
  assert.ok(executorPrompt.includes(decoded.attachments[0].download_url));

  console.log("1. Slack event (text + 2 files)");
  console.log(JSON.stringify({ text: event.text, files: slackFiles.map((f) => f.filename) }, null, 2));

  console.log("\n2. Artifact uploads (mock TFY signed URLs)");
  console.log(JSON.stringify(uploads.map((u) => ({
    url: u.signedUrl,
    bytes: u.bytes,
    contentType: u.contentType
  })), null, 2));

  console.log("\n3. Attachments passed to executor");
  console.log(JSON.stringify(attachments, null, 2));

  console.log("\n4. Work payload (attachments + prompt excerpt)");
  console.log(JSON.stringify({
    run_id: decoded.run_id,
    attachment_count: decoded.attachments.length,
    slack_user: decoded.slack.user_id,
    prompt_excerpt: decoded.content.split("\n").slice(0, 12).join("\n")
  }, null, 2));

  console.log("\n5. Executor would write this prompt file:");
  console.log("---");
  console.log(executorPrompt);
  console.log("---");

  console.log("\nPASS: Slack → artifact ingest → work payload → executor prompt chain verified.");
}

main().catch((error) => {
  console.error("\nFAIL:", error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
