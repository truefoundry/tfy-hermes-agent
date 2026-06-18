// Periodic reconciler for stuck runs and Slack dedup TTL cleanup.
//
// Responsibilities:
//   - Mark 'queued' runs failed when they have aged past dispatchTtlMs without
//     being handed to the runtime.
//   - Mark 'dispatched'/'running' runs 'failed' if they exceed runTtlMs
//     without a /complete callback or progress event.
//   - Sweep dedup tables (slack_seen_events, slack_seen_messages) older
//     than 24h.
//
// The reconciler does not assume Slack/TrueFoundry calls are available.
// Runtime probes go through the injected probeRunOnPlatform function so the
// loop is unit-testable and can run no-op when unconfigured.
//
// Returns a `stop()` function that clears the interval.

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_DISPATCH_TTL_MS = 30_000;
const DEFAULT_RUN_TTL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

async function probeRuntime({ probeRunOnPlatform, runId }) {
  if (typeof probeRunOnPlatform === "function") {
    return probeRunOnPlatform(runId);
  }
  return { found: false, state: null };
}

export function startReconciler(db, {
  intervalMs = DEFAULT_INTERVAL_MS,
  dispatchTtlMs = DEFAULT_DISPATCH_TTL_MS,
  runTtlMs = DEFAULT_RUN_TTL_MS,
  probeRunOnPlatform = null,
  logger = console
} = {}) {
  if (!db) throw new Error("startReconciler: db is required");

  const selectQueuedStale = db.prepare(
    "SELECT id, hermes_session_id, updated_at FROM runs WHERE status = 'queued' AND updated_at < ?"
  );
  const selectInflightStale = db.prepare(
    "SELECT id, status, hermes_session_id, updated_at FROM runs WHERE status IN ('dispatched','running') AND updated_at < ?"
  );
  const markDispatched = db.prepare(
    "UPDATE runs SET status = 'dispatched', trigger = ?, updated_at = ? WHERE id = ? AND status = 'queued'"
  );
  const markFailed = db.prepare(
    "UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status IN ('queued','dispatched','running')"
  );
  const deleteOldSeenEvents = db.prepare("DELETE FROM slack_seen_events WHERE seen_at < ?");
  const deleteOldSeenMessages = db.prepare("DELETE FROM slack_seen_messages WHERE seen_at < ?");

  async function reconcileQueued(nowMs) {
    const cutoff = nowMs - dispatchTtlMs;
    const rows = selectQueuedStale.all(cutoff);
    for (const row of rows) {
      markFailed.run(
        "reconciler: queued past dispatch TTL without runtime dispatch; resend the message",
        nowMs,
        row.id
      );
      logger?.warn?.(`[reconciler] queued run ${row.id} stale before runtime dispatch; marked failed`);
    }
  }

  async function reconcileInflight(nowMs) {
    const cutoff = nowMs - runTtlMs;
    const rows = selectInflightStale.all(cutoff);
    for (const row of rows) {
      const probe = await probeRuntime({ probeRunOnPlatform, runId: row.id });
      const stateText = probe.error
        ? `runtime probe error: ${probe.error instanceof Error ? probe.error.message : String(probe.error)}`
        : `runtime state=${probe.found ? probe.state ?? "unknown" : "unavailable"}`;
      markFailed.run(
        `reconciler: run exceeded TTL without /complete or progress event (${stateText})`,
        nowMs,
        row.id
      );
      logger?.warn?.(`[reconciler] inflight run ${row.id} stale (${stateText}); marked failed`);
    }
  }

  function sweepDedup(nowMs) {
    const cutoff = nowMs - DAY_MS;
    const events = deleteOldSeenEvents.run(cutoff);
    const messages = deleteOldSeenMessages.run(cutoff);
    if (events.changes || messages.changes) {
      logger?.log?.(`[reconciler] pruned slack_seen_events=${events.changes} slack_seen_messages=${messages.changes}`);
    }
  }

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    const nowMs = Date.now();
    try {
      await reconcileQueued(nowMs);
      await reconcileInflight(nowMs);
      sweepDedup(nowMs);
    } catch (error) {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      logger?.error?.(`[reconciler] tick failed: ${message}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    tick().catch((error) => {
      const message = error instanceof Error ? error.stack || error.message : String(error);
      logger?.error?.(`[reconciler] unhandled error: ${message}`);
    });
  }, intervalMs);
  timer.unref?.();

  // Kick off one immediate tick so a controller boot doesn't have to wait a
  // full interval before clearing stale dedup rows / stuck runs.
  tick().catch(() => {});

  return function stop() {
    clearInterval(timer);
  };
}
