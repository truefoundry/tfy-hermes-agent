// Periodic reconciler for stuck runs and Slack dedup TTL cleanup.
//
// Responsibilities (per DESIGN.md):
//   - Flip 'queued' runs to 'dispatched' (or re-trigger idempotently) when
//     they have aged past dispatchTtlMs without an executor heartbeat.
//   - Mark 'dispatched'/'running' runs 'failed' if they exceed runTtlMs
//     without a /complete callback and the platform reports the job
//     terminal.
//   - Sweep dedup tables (slack_seen_events, slack_seen_messages) older
//     than 24h.
//
// The reconciler does not assume Slack/TrueFoundry calls are available.
// All IO goes through the injected tfyGet / tfyTriggerJob functions so the
// loop is unit-testable and can run no-op when the platform is unconfigured.
//
// Returns a `stop()` function that clears the interval.

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_DISPATCH_TTL_MS = 30_000;
const DEFAULT_RUN_TTL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function isTerminalJobState(state) {
  const text = String(state || "").toLowerCase();
  return [
    "succeeded",
    "success",
    "completed",
    "failed",
    "failure",
    "error",
    "cancelled",
    "canceled",
    "killed",
    "terminated"
  ].includes(text);
}

function pickJobAlias(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = Array.isArray(payload.data) ? payload.data[0] : payload.data || payload;
  if (!data || typeof data !== "object") return null;
  return data.status || data.state || data.phase || null;
}

async function probeJobForRun({ tfyGet, runId }) {
  if (typeof tfyGet !== "function") return { found: false, state: null };
  try {
    const body = await tfyGet(`/api/svc/v1/jobs/runs?job_run_name_alias=${encodeURIComponent(runId)}&limit=1`);
    const data = Array.isArray(body?.data) ? body.data : [];
    if (!data.length) return { found: false, state: null };
    return { found: true, state: pickJobAlias({ data }) };
  } catch (error) {
    return { found: false, state: null, error };
  }
}

export function startReconciler(db, {
  intervalMs = DEFAULT_INTERVAL_MS,
  dispatchTtlMs = DEFAULT_DISPATCH_TTL_MS,
  runTtlMs = DEFAULT_RUN_TTL_MS,
  tfyGet = null,
  tfyTriggerJob = null,
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
      const probe = await probeJobForRun({ tfyGet, runId: row.id });
      if (probe.found) {
        markDispatched.run(JSON.stringify({ recovered_by: "reconciler", state: probe.state }), nowMs, row.id);
        logger?.log?.(`[reconciler] queued run ${row.id} found on platform (state=${probe.state ?? "unknown"}); marked dispatched`);
        continue;
      }
      // The run's prompt is not persisted in the runs table — it only lives
      // in the signed work payload that was passed to the original Trigger
      // Job call. If no platform job exists for this run AND the dispatch
      // window has elapsed, the most honest thing to do is mark it failed
      // and let the user resend. Re-triggering with an empty prompt would
      // produce a meaningless run.
      markFailed.run(
        "reconciler: queued past dispatch TTL with no platform job found; resend the message",
        nowMs,
        row.id
      );
      logger?.warn?.(`[reconciler] queued run ${row.id} stale and not on platform; marked failed`);
    }
  }

  async function reconcileInflight(nowMs) {
    const cutoff = nowMs - runTtlMs;
    const rows = selectInflightStale.all(cutoff);
    for (const row of rows) {
      const probe = await probeJobForRun({ tfyGet, runId: row.id });
      if (probe.found && isTerminalJobState(probe.state)) {
        markFailed.run(
          `reconciler: job terminal without /complete (state=${probe.state ?? "unknown"})`,
          nowMs,
          row.id
        );
        logger?.warn?.(`[reconciler] inflight run ${row.id} terminal on platform (state=${probe.state}); marked failed`);
        continue;
      }
      if (!probe.found && !probe.error) {
        markFailed.run(
          "reconciler: job not found on platform after run TTL",
          nowMs,
          row.id
        );
        logger?.warn?.(`[reconciler] inflight run ${row.id} missing on platform; marked failed`);
      }
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
