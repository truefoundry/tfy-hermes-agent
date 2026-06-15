// Session continuity test (DESIGN.md: "Slack thread = Hermes session.
// One-to-one mapping in slack_threads. The mapping is permanent.")
//
// Exercises the wrapper.db tables and supporting primitives that keep a
// Slack conversation stitched together across executor turns:
//
//   1. slack_threads → hermes_session_id mapping is created on first lookup
//      and reused on subsequent lookups (idempotent).
//   2. The runs table moves through queued → dispatched → completed and
//      reads back via id and openai_id.
//   3. Per-run HMAC tokens verify only under the runId they were minted for.
//   4. The in-process pub/sub bus only delivers events to subscribers of
//      the matching runId.
//
// No HTTP, no live Hermes. Each subtest opens its own wrapper.db in a
// temp directory and tears it down on exit.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

// The token module reads its secret from the caller's parameters, but the
// pub/sub module is process-wide. Setting a deterministic secret here keeps
// the test self-contained with no env coupling.
const RUN_TOKEN_SECRET = "test-secret-do-not-use-in-prod";
process.env.HERMES_RUN_TOKEN_SECRET = RUN_TOKEN_SECRET;

const { openDb, now } = await import("./db.mjs");
const { signRunToken, verifyRunToken } = await import("./tokens.mjs");
const { publish, subscribe } = await import("./pubsub.mjs");

function makeStateRoot() {
  return mkdtempSync(join(tmpdir(), "tfy-hermes-session-test-"));
}

function withDb(fn) {
  const stateRoot = makeStateRoot();
  const db = openDb(stateRoot);
  try {
    return fn(db);
  } finally {
    try { db.close(); } catch {}
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

function upsertSlackThread(db, { teamId, channel, threadTs }) {
  const existing = db
    .prepare("SELECT hermes_session_id FROM slack_threads WHERE team_id = ? AND channel = ? AND thread_ts = ?")
    .get(teamId, channel, threadTs);
  if (existing?.hermes_session_id) return existing.hermes_session_id;
  const sessionId = randomUUID();
  db.prepare(
    "INSERT INTO slack_threads (team_id, channel, thread_ts, hermes_session_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, channel, thread_ts) DO NOTHING"
  ).run(teamId, channel, threadTs, sessionId, now());
  const fresh = db
    .prepare("SELECT hermes_session_id FROM slack_threads WHERE team_id = ? AND channel = ? AND thread_ts = ?")
    .get(teamId, channel, threadTs);
  return fresh?.hermes_session_id || sessionId;
}

function insertRun(db, { runId, hermesSessionId, openaiKind, openaiId }) {
  const ts = now();
  db.prepare(
    "INSERT INTO runs (id, hermes_session_id, status, openai_kind, openai_id, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)"
  ).run(runId, hermesSessionId, openaiKind ?? null, openaiId ?? null, ts, ts);
}

function setRunStatus(db, runId, status, extras = {}) {
  const fields = ["status = ?", "updated_at = ?"];
  const values = [status, now()];
  if (Object.prototype.hasOwnProperty.call(extras, "result")) {
    fields.push("result = ?");
    values.push(extras.result);
  }
  if (Object.prototype.hasOwnProperty.call(extras, "error")) {
    fields.push("error = ?");
    values.push(extras.error);
  }
  values.push(runId);
  db.prepare(`UPDATE runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

function getRun(db, runId) {
  return db.prepare("SELECT * FROM runs WHERE id = ?").get(runId);
}

test("slack_threads creates and then reuses the same hermes_session_id for a Slack thread", () => {
  withDb((db) => {
    const key = { teamId: "T1", channel: "C123", threadTs: "1718380800.001" };
    const first = upsertSlackThread(db, key);
    assert.ok(first, "first lookup should mint a session id");
    assert.match(first, /^[0-9a-f-]{36}$/i);

    const second = upsertSlackThread(db, key);
    assert.equal(second, first, "second lookup must return the same session id");

    // A different thread_ts is a brand new mapping.
    const other = upsertSlackThread(db, { ...key, threadTs: "1718380801.002" });
    assert.notEqual(other, first, "different thread_ts maps to a different session");
  });
});

test("slack_threads composite key (team_id, channel, thread_ts) is idempotent under concurrent insert", () => {
  withDb((db) => {
    // Simulate the race where two events for the same thread both try to
    // INSERT: ON CONFLICT DO NOTHING must keep the first session id.
    const key = { teamId: "T1", channel: "C123", threadTs: "1718380800.001" };
    const first = upsertSlackThread(db, key);
    // Manual INSERT with a different session id should be a no-op.
    db.prepare(
      "INSERT INTO slack_threads (team_id, channel, thread_ts, hermes_session_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, channel, thread_ts) DO NOTHING"
    ).run(key.teamId, key.channel, key.threadTs, randomUUID(), now());
    const after = upsertSlackThread(db, key);
    assert.equal(after, first, "ON CONFLICT must not overwrite the existing session id");
  });
});

test("runs lifecycle moves queued → dispatched → completed and reads back consistently", () => {
  withDb((db) => {
    const hermesSessionId = upsertSlackThread(db, {
      teamId: "T1", channel: "C123", threadTs: "1718380900.001"
    });
    const runId = "run_lifecycle1";
    const openaiId = "resp_lifecycle1";
    insertRun(db, { runId, hermesSessionId, openaiKind: "response", openaiId });

    let row = getRun(db, runId);
    assert.equal(row.status, "queued");
    assert.equal(row.hermes_session_id, hermesSessionId);

    setRunStatus(db, runId, "dispatched");
    row = getRun(db, runId);
    assert.equal(row.status, "dispatched");

    setRunStatus(db, runId, "completed", { result: "ok", error: null });
    row = getRun(db, runId);
    assert.equal(row.status, "completed");
    assert.equal(row.result, "ok");
    assert.equal(row.error, null);

    // Reading the run back by openai_id (used for previous_response_id continuity)
    // must yield the same session id, which is how `/v1/responses` reuses Hermes
    // memory across turns.
    const byOpenAI = db
      .prepare("SELECT * FROM runs WHERE openai_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(openaiId);
    assert.equal(byOpenAI.id, runId);
    assert.equal(byOpenAI.hermes_session_id, hermesSessionId);
  });
});

test("per-run HMAC token verifies only under the runId it was signed for", () => {
  const runIdX = "run_x";
  const runIdY = "run_y";
  const token = signRunToken({ runId: runIdX, secret: RUN_TOKEN_SECRET, expSeconds: 600 });
  assert.ok(token.startsWith("v1."), "token should be in the v1.<runId>.<exp>.<sig> format");

  assert.equal(
    verifyRunToken({ token, expectedRunId: runIdX, secret: RUN_TOKEN_SECRET }),
    true,
    "matching runId must verify"
  );
  assert.equal(
    verifyRunToken({ token, expectedRunId: runIdY, secret: RUN_TOKEN_SECRET }),
    false,
    "mismatched runId must NOT verify"
  );
  assert.equal(
    verifyRunToken({ token, expectedRunId: runIdX, secret: "wrong-secret" }),
    false,
    "wrong secret must NOT verify"
  );
});

test("pubsub bus delivers events for runId X only to subscribers of X", async () => {
  const runX = "run_pubsubX";
  const runY = "run_pubsubY";
  const seenX = [];
  const seenY = [];

  const unsubX = subscribe(runX, (event) => { seenX.push(event); });
  const unsubY = subscribe(runY, (event) => { seenY.push(event); });

  try {
    publish(runX, { type: "event", payload: "for-x-1" });
    publish(runX, { type: "complete", status: "completed" });
    publish(runY, { type: "event", payload: "for-y-1" });

    // EventEmitter is synchronous, but await a microtask so any
    // promise-chained handlers (none today) would still get a chance.
    await Promise.resolve();

    assert.equal(seenX.length, 2, "X subscriber should see exactly its two events");
    assert.equal(seenX[0].payload, "for-x-1");
    assert.equal(seenX[1].type, "complete");
    assert.equal(seenY.length, 1, "Y subscriber should see only its own event");
    assert.equal(seenY[0].payload, "for-y-1");
  } finally {
    unsubX();
    unsubY();
  }
});
