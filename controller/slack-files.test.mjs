import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeSlackFiles,
  slackMessageEventAllowed,
  slackPrompt,
  slackTitle
} from "./slack.mjs";
import {
  createArtifactClient,
  parseMlRepoRef,
  sanitizeArtifactName,
  sanitizeArtifactPath,
  downloadSlackFileToBuffer
} from "./artifacts.mjs";
import { ingestSlackFilesToArtifacts } from "./slack-ingest.mjs";

test("slackMessageEventAllowed accepts normal messages and file_share", () => {
  assert.equal(slackMessageEventAllowed({ channel: "C1", user: "U1", text: "hi" }), true);
  assert.equal(slackMessageEventAllowed({ channel: "C1", user: "U1", subtype: "file_share", files: [] }), true);
  assert.equal(slackMessageEventAllowed({ channel: "C1", user: "U1", subtype: "bot_message" }), false);
  assert.equal(slackMessageEventAllowed({ channel: "C1", user: "U1", bot_id: "B1" }), false);
});

test("normalizeSlackFiles maps Slack file objects", () => {
  const files = normalizeSlackFiles([{
    id: "F123",
    name: "photo.jpg",
    mimetype: "image/jpeg",
    filetype: "jpg",
    size: 1024,
    url_private_download: "https://files.slack.com/photo.jpg"
  }]);
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], {
    id: "F123",
    filename: "photo.jpg",
    mime_type: "image/jpeg",
    filetype: "jpg",
    size: 1024,
    url_private_download: "https://files.slack.com/photo.jpg"
  });
});

test("slackPrompt includes text and attachments together", () => {
  const prompt = slackPrompt({
    text: "save to notes",
    slack: { user_id: "U1", thread_ts: "111.222", message_ts: "111.333", text: "save to notes" },
    attachments: [{
      slack_file_id: "F123",
      filename: "photo.jpg",
      mime_type: "image/jpeg",
      filetype: "jpg",
      size: 1024,
      artifact_fqn: "artifact:tenant/repo/slack-run:1",
      artifact_path: "F123-photo.jpg",
      download_url: "https://signed.example/photo.jpg"
    }],
    context: { channel_id: "C1", team_id: "T1" },
    agent: { handle: "devrel", name: "DevRel Assistant" },
    fallbackHandle: "hermes"
  });
  assert.match(prompt, /Message text:\nsave to notes/);
  assert.match(prompt, /File attachments \(uploaded to TrueFoundry Artifacts\):/);
  assert.match(prompt, /artifact_fqn: artifact:tenant\/repo\/slack-run:1/);
  assert.match(prompt, /download_url: https:\/\/signed.example\/photo.jpg/);
  assert.match(prompt, /download_url_auth: signed URL; do not add Authorization header/);
  assert.match(prompt, /Slack user: U1/);
});

test("slackTitle falls back to attachment filename", () => {
  assert.equal(slackTitle("", [{ filename: "booth.jpg" }]), "File: booth.jpg");
});

test("parseMlRepoRef accepts repo name and tfy-mlrepo FQN", () => {
  assert.equal(parseMlRepoRef("slack-inbound"), "slack-inbound");
  assert.equal(parseMlRepoRef("tfy-mlrepo://tfy-eo:sai-ws/slack-inbound"), "slack-inbound");
});

test("sanitizeArtifactName and path derive stable upload locations", () => {
  assert.equal(sanitizeArtifactName("run_abc123"), "slack-run_abc123");
  assert.equal(sanitizeArtifactPath("F123", "my photo.jpg"), "F123-my_photo.jpg");
});

test("downloadSlackFileToBuffer enforces size limits", async () => {
  await assert.rejects(
    () => downloadSlackFileToBuffer({
      url: "https://files.example/x",
      botToken: "xoxb-test",
      maxBytes: 8,
      fetchImpl: async () => ({
        ok: true,
        headers: { get: () => null },
        body: (async function* () {
          yield Buffer.from("123456789");
        })()
      })
    }),
    /exceeds 8 byte limit/
  );
});

test("artifact signed URL upload uses headers derived from artifact storage root", async () => {
  const requests = [];
  const client = createArtifactClient({
    tfyHost: "https://tenant.truefoundry.cloud",
    tfyApiKey: "tfy-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/ml/v1/artifact-versions/signed-urls")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: [{ path: "photo.jpg", signed_url: "https://artifact-upload.example/photo.jpg" }]
          })
        };
      }
      return { ok: true, text: async () => "" };
    }
  });

  const uploadTarget = await client.getWriteSignedUrl({
    versionId: "av_123",
    path: "photo.jpg",
    storageRoot: "wasbs://container@account.blob.core.windows.net/mlfoundry/repo/artifacts"
  });
  await client.uploadToSignedUrl({
    ...uploadTarget,
    body: Buffer.from("image"),
    contentType: "image/jpeg"
  });

  const upload = requests.find((request) => request.url === "https://artifact-upload.example/photo.jpg");
  assert.equal(upload.options.headers["content-type"], "image/jpeg");
  assert.equal(upload.options.headers["x-ms-blob-type"], "BlockBlob");
});

test("artifact signed URL upload does not add Azure headers for object stores that do not need them", async () => {
  const requests = [];
  const client = createArtifactClient({
    tfyHost: "https://tenant.truefoundry.cloud",
    tfyApiKey: "tfy-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/ml/v1/artifact-versions/signed-urls")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: [{ path: "photo.jpg", signed_url: "https://artifact-upload.example/photo.jpg" }]
          })
        };
      }
      return { ok: true, text: async () => "" };
    }
  });

  const uploadTarget = await client.getWriteSignedUrl({
    versionId: "av_123",
    path: "photo.jpg",
    storageRoot: "s3://bucket/mlfoundry/repo/artifacts"
  });
  await client.uploadToSignedUrl({
    ...uploadTarget,
    body: Buffer.from("image"),
    contentType: "image/jpeg"
  });

  const upload = requests.find((request) => request.url === "https://artifact-upload.example/photo.jpg");
  assert.equal(upload.options.headers["content-type"], "image/jpeg");
  assert.equal(upload.options.headers["x-ms-blob-type"], undefined);
});

test("artifact signed URL upload honors server-provided upload headers", async () => {
  const requests = [];
  const client = createArtifactClient({
    tfyHost: "https://tenant.truefoundry.cloud",
    tfyApiKey: "tfy-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith("/api/ml/v1/artifact-versions/signed-urls")) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: [{
              path: "photo.jpg",
              signed_url: "https://artifact-upload.example/photo.jpg",
              headers: { "x-storage-provider-required": "true" }
            }]
          })
        };
      }
      return { ok: true, text: async () => "" };
    }
  });

  const uploadTarget = await client.getWriteSignedUrl({
    versionId: "av_123",
    path: "photo.jpg",
    storageRoot: "gs://bucket/mlfoundry/repo/artifacts"
  });
  await client.uploadToSignedUrl({
    ...uploadTarget,
    body: Buffer.from("image"),
    contentType: "image/jpeg"
  });

  const upload = requests.find((request) => request.url === "https://artifact-upload.example/photo.jpg");
  assert.equal(upload.options.headers["content-type"], "image/jpeg");
  assert.equal(upload.options.headers["x-storage-provider-required"], "true");
  assert.equal(upload.options.headers["x-ms-blob-type"], undefined);
});

test("artifact finalize sends staged storage root as source uri", async () => {
  const requests = [];
  const client = createArtifactClient({
    tfyHost: "https://tenant.truefoundry.cloud",
    tfyApiKey: "tfy-key",
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      return {
        ok: true,
        text: async () => JSON.stringify({ data: { fqn: "artifact:tenant/repo/slack-run:1" } })
      };
    }
  });

  await client.finalizeArtifactVersion({
    mlRepo: "slack-inbound",
    name: "slack-run_abc",
    metadata: { source: "slack" },
    storageRoot: "wasbs://container@account.blob.core.windows.net/mlfoundry/repo/artifacts"
  });

  const finalize = requests.find((request) => request.url.endsWith("/api/ml/v1/artifact-versions"));
  const body = JSON.parse(finalize.options.body);
  assert.equal(body.manifest.source.type, "truefoundry");
  assert.equal(body.manifest.source.uri, "wasbs://container@account.blob.core.windows.net/mlfoundry/repo/artifacts");
});

test("ingestSlackFilesToArtifacts uploads Slack files to staged artifact version", async () => {
  const calls = [];
  const artifactClient = {
    stageArtifactVersion: async ({ mlRepo, name, metadata }) => {
      calls.push(["stage", mlRepo, name, metadata]);
      return { id: "av_123", storage_root: "s3://bucket/root", artifact_id: "art_1" };
    },
    getWriteSignedUrl: async ({ versionId, path }) => {
      calls.push(["write-url", versionId, path]);
      return `https://upload.example/${path}`;
    },
    uploadToSignedUrl: async ({ signedUrl, body, contentType }) => {
      calls.push(["upload", signedUrl, body.toString(), contentType]);
    },
    finalizeArtifactVersion: async ({ mlRepo, name, storageRoot }) => {
      calls.push(["finalize", mlRepo, name, storageRoot]);
      return { data: { fqn: "artifact:tenant/repo/slack-run_abc:1" } };
    },
    getReadSignedUrls: async ({ versionId, paths }) => {
      calls.push(["read-urls", versionId, paths]);
      return paths.map((path) => ({ path, signed_url: `https://read.example/${path}` }));
    },
    markStageFailure: async () => {}
  };

  const attachments = await ingestSlackFilesToArtifacts({
    files: [{
      id: "F123",
      filename: "note.txt",
      mime_type: "text/plain",
      filetype: "text",
      size: 4,
      url_private_download: "https://files.slack.com/note.txt"
    }],
    runId: "run_abc",
    mlRepoRef: "slack-inbound",
    slackBotToken: "xoxb-test",
    tfyHost: "https://tenant.truefoundry.cloud",
    tfyApiKey: "tfy-key",
    stateRoot: "/tmp/hermes-test-inbound",
    fetchImpl: async (url, options = {}) => {
      if (url === "https://files.slack.com/note.txt") {
        assert.equal(options.headers?.authorization, "Bearer xoxb-test");
        return {
          ok: true,
          headers: { get: () => "4" },
          body: (async function* () {
            yield Buffer.from("note");
          })()
        };
      }
      if (String(url).startsWith("https://upload.example/")) {
        return { ok: true, text: async () => "" };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    artifactClient
  });

  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].slack_file_id, "F123");
  assert.equal(attachments[0].artifact_fqn, "artifact:tenant/repo/slack-run_abc:1");
  assert.equal(attachments[0].download_url, "https://read.example/F123-note.txt");
  assert.deepEqual(calls[0], ["stage", "slack-inbound", "slack-run_abc", { source: "slack", run_id: "run_abc", file_count: 1 }]);
  assert.deepEqual(calls[3], ["finalize", "slack-inbound", "slack-run_abc", "s3://bucket/root"]);
});

test("ingestSlackFilesToArtifacts requires artifact repo when files are present", async () => {
  await assert.rejects(
    () => ingestSlackFilesToArtifacts({
      files: [{ id: "F1", filename: "a.txt", url_private_download: "https://x" }],
      runId: "run_1",
      mlRepoRef: "",
      slackBotToken: "xoxb-test",
      tfyHost: "https://tenant.truefoundry.cloud",
      tfyApiKey: "tfy-key"
    }),
    /HERMES_SLACK_INBOUND_ARTIFACT_REPO is required/
  );
});
