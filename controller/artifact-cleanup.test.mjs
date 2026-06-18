import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupSlackRunArtifacts,
  isSlackRunArtifactVersion
} from "./artifact-cleanup.mjs";

const cutoffMs = Date.parse("2026-06-10T00:00:00Z");

function version(overrides = {}) {
  return {
    id: "av_1",
    fqn: "artifact:tfy-eo/hermes-inbound-artifacts-prod/slack-run_abc:1",
    created_at: "2026-06-01T00:00:00Z",
    manifest: {
      name: "slack-run_abc",
      ml_repo: "hermes-inbound-artifacts-prod",
      metadata: { source: "slack", run_id: "run_abc" }
    },
    ...overrides
  };
}

test("isSlackRunArtifactVersion only selects old Slack run artifacts in the target repo", () => {
  const options = { mlRepo: "hermes-inbound-artifacts-prod", prefix: "slack-run_", cutoffMs };
  assert.equal(isSlackRunArtifactVersion(version(), options), true);
  assert.equal(isSlackRunArtifactVersion(version({
    manifest: { ...version().manifest, name: "manual-upload" }
  }), options), false);
  assert.equal(isSlackRunArtifactVersion(version({
    manifest: { ...version().manifest, ml_repo: "other-repo" }
  }), options), false);
  assert.equal(isSlackRunArtifactVersion(version({
    created_at: "2026-06-17T00:00:00Z"
  }), options), false);
  assert.equal(isSlackRunArtifactVersion(version({
    manifest: {
      ...version().manifest,
      metadata: { source: "manual", run_id: "not-a-run" }
    }
  }), options), false);
});

test("cleanupSlackRunArtifacts lists by ML repo id and honors dry-run mode", async () => {
  const calls = [];
  const client = {
    async findMlRepoId(mlRepo) {
      calls.push(["find", mlRepo]);
      return "3426";
    },
    async listArtifactVersions({ mlRepoId }) {
      calls.push(["list", mlRepoId]);
      return [
        version({ id: "delete-me" }),
        version({ id: "keep-new", created_at: "2026-06-17T00:00:00Z" }),
        version({
          id: "keep-manual",
          manifest: {
            ...version().manifest,
            name: "manual-upload",
            metadata: { source: "manual" }
          }
        })
      ];
    },
    async deleteArtifactVersion(id) {
      calls.push(["delete", id]);
    }
  };
  const summary = await cleanupSlackRunArtifacts({
    mlRepo: "hermes-inbound-artifacts-prod",
    retentionDays: 7,
    now: new Date("2026-06-18T00:00:00Z"),
    dryRun: true,
    client
  });
  assert.equal(summary.scanned, 3);
  assert.deepEqual(summary.candidates.map((item) => item.id), ["delete-me"]);
  assert.deepEqual(summary.deleted, []);
  assert.deepEqual(calls, [["find", "hermes-inbound-artifacts-prod"], ["list", "3426"]]);
});

test("cleanupSlackRunArtifacts deletes candidates when dry-run is false", async () => {
  const deleted = [];
  const client = {
    async findMlRepoId() { return "3426"; },
    async listArtifactVersions() { return [version({ id: "delete-me" })]; },
    async deleteArtifactVersion(id) { deleted.push(id); }
  };
  const summary = await cleanupSlackRunArtifacts({
    mlRepo: "hermes-inbound-artifacts-prod",
    retentionDays: 7,
    now: new Date("2026-06-18T00:00:00Z"),
    client
  });
  assert.deepEqual(deleted, ["delete-me"]);
  assert.deepEqual(summary.deleted.map((item) => item.id), ["delete-me"]);
});
