# tfy-hermes-agent — Design

## Goal

Anyone in the company can deploy a personal Hermes assistant on TrueFoundry with two commands. Each assistant is its own stack. The stack is the smallest possible wrapper around Hermes that turns it into a Slack-facing, OpenAI-compatible service.

## Principles

1. **Minimal.** Fewer components, fewer tables, fewer commands. Delete before adding.
2. **Lightweight.** No background processes that aren't earning their keep. No JSON file rewrites. No polling when push works.
3. **Fast.** Sub-second Slack streaming. Per-turn job dispatch is the only unavoidable cold path; everything else is in-process.
4. **Lean on what exists.** Hermes already has sessions, messages, FTS5, compaction, backup. We don't reimplement them. TrueFoundry already has Jobs, Services, Volumes, SecretGroups, Helm. We don't reinvent infra.

## Non-goals

- Multi-tenant shared platform (50 small stacks is the model)
- Horizontal scaling of a single agent (replicas = 1)
- Replacing Hermes's session/memory layer

---

## Architecture

```
                       ┌─────────────────────────────────────┐
   Slack ──────────────│  Controller (Service, replicas: 1)  │
   /v1/* clients ──────│  • Slack Events + Interactions      │
                       │  • OpenAI /v1/responses, /v1/chat   │
                       │  • Internal callbacks (events,      │
                       │    session-db get/put, complete)    │
                       │  • In-process pub/sub for streaming │
                       └────────────┬────────────────────────┘
                                    │
                       ┌────────────▼───────────┐
                       │  Controller PVC (RWO)  │   /data
                       │   wrapper.db           │     ← our tables
                       │   sessions/<id>.db     │     ← one Hermes DB per Slack thread
                       └────────────────────────┘
                                    ▲
                                    │  HTTPS (per-run HMAC)
                                    │  GET  session-db at start
                                    │  POST session-db at end
                                    │
                       ┌────────────┴────────────────────────┐
                       │  Executor (Job, per turn)           │
                       │  ephemeral container FS:            │
                       │    /workspace/.hermes/state.db      │
                       │  • Download → run hermes -z → Upload│
                       └─────────────────────────────────────┘
```

Three components. One volume (controller-only, ordinary RWO disk). Per-session SQLite files. No shared filesystems.

---

## Components

### Controller (`controller/controller.mjs`)

Single Node HTTP service. `replicas: 1`. Owns the only persistent volume in the stack.

| Surface | Path | Notes |
|---|---|---|
| Health | `GET /api/health` | for liveness |
| Slack | `POST /slack/events`, `POST /slack/interactions` | HMAC-verified |
| OpenAI | `POST /v1/responses`, `POST /v1/chat/completions`, `GET /v1/models` | API-key gated, fail-closed |
| Internal | `POST /api/internal/runs/:id/events`, `POST /api/internal/runs/:id/complete` | per-run HMAC-token gated |
| Internal | `GET /api/internal/runs/:id/session-db`, `POST /api/internal/runs/:id/session-db` | per-run HMAC-token gated; 404 on GET means "first turn" |

Responsibilities:
- Receive Slack events, route to the right Hermes session
- Translate `/v1/*` calls into runs
- Dispatch executor jobs via TrueFoundry Trigger Job API
- Ship the session DB to the executor at start, persist the updated DB on completion
- Stream events back to Slack and `/v1/*` SSE consumers via in-process pub/sub
- Reconcile stuck runs (60s loop)

What it does **not** do:
- Store conversation history (Hermes does, inside `sessions/<id>.db`)
- Manage tokens, costs, compaction (Hermes does)
- Hold any state in memory that can't be rebuilt from disk

### Executor (`executor/executor.mjs`)

Per-turn Job. One container start per Hermes turn. No mounted volume — uses ordinary container filesystem.

1. Decode `HARNESS_WORK_B64` from env (signed by controller, contains `run_id`, `session_id`, prompt, agent config, callback URL, HMAC token)
2. `mkdir /workspace/.hermes`
3. `GET /api/internal/runs/:id/session-db` → write body to `/workspace/.hermes/state.db` (404 = empty start)
4. Install agent skills (TrueFoundry agent-skill presigned URLs)
5. Write `HERMES_HOME=/workspace/.hermes` config + observer plugin
6. `python -m hermes -z` with `HERMES_SESSION_ID=<session_id>`
7. Stream stdout/stderr/observer events to controller (`POST /events`)
8. On Hermes exit: `POST /api/internal/runs/:id/session-db` with the updated `state.db`
9. `POST /api/internal/runs/:id/complete` with final result

Hermes runs against **local disk** for the entire turn. The DB only travels over the network twice: once down, once up.

### CLI (`bin/tfy-hermes-agent.mjs`)

Two commands.

```bash
hermes init                 # interactive: Slack app, secrets, writes hermes.yaml
hermes deploy hermes.yaml   # validate + tfy apply controller/executor/volume manifests
```

No `compile`, no `validate`, no intermediate YAML files on disk by default. `--emit-manifests` for debugging.

---

## Data model

### Hermes-owned, per Slack thread (`/data/sessions/<session_id>.db`)

One SQLite file per Hermes session. Schema is whatever Hermes ships (we don't read or write it). The wrapper treats each file as an opaque blob keyed by `session_id`. Hermes's own tables of interest (for awareness, not our use):

- `sessions(id, source, user_id, model, system_prompt, parent_session_id, started_at, ended_at, message_count, *_tokens, *_cost_usd, title, ...)`
- `messages(id, session_id, role, content, tool_calls, tool_name, timestamp, ...)`
- `messages_fts` (FTS5)
- `state_meta`, `compression_locks`

Per-session files keep transfers tiny — only the relevant slice moves over the wire, not the multi-session blob.

### Wrapper-owned (`/data/wrapper.db`)

```sql
-- one row total per stack
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  handle          TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  model           TEXT NOT NULL,
  instructions    TEXT,
  workspace_fqn   TEXT NOT NULL,
  slack_team_id   TEXT,
  skills          TEXT NOT NULL DEFAULT '[]',  -- JSON array
  mcp_servers     TEXT NOT NULL DEFAULT '[]',
  slack_allowed_channels TEXT NOT NULL DEFAULT '[]',
  slack_allowed_users    TEXT NOT NULL DEFAULT '[]',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- Slack thread → Hermes session
CREATE TABLE slack_threads (
  team_id            TEXT NOT NULL,
  channel            TEXT NOT NULL,
  thread_ts          TEXT NOT NULL,
  hermes_session_id  TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel, thread_ts)
);

-- per-turn lifecycle (executor coordination, NOT conversation history)
CREATE TABLE runs (
  id                TEXT PRIMARY KEY,
  hermes_session_id TEXT NOT NULL,
  status            TEXT NOT NULL,            -- queued|dispatched|running|completed|failed
  result            TEXT,
  error             TEXT,
  slack_channel     TEXT,
  slack_message_ts  TEXT,                     -- the streaming message; survives restart
  openai_kind       TEXT,                     -- response | chat.completion | slack
  openai_id         TEXT,                     -- resp_... or chatcmpl_...
  trigger           TEXT,                     -- JSON: TrueFoundry trigger response
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX idx_runs_status_updated ON runs(status, updated_at)
  WHERE status IN ('queued','dispatched','running');
CREATE INDEX idx_runs_openai_id ON runs(openai_id);

-- executor → controller streaming pipeline
CREATE TABLE run_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL,
  type       TEXT NOT NULL,                   -- stdout_delta|hermes_observer|executor_diagnostic|stderr_delta
  payload    TEXT NOT NULL,                   -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_run_events_run ON run_events(run_id, id);

-- Slack dedup (TTL via reconciler)
CREATE TABLE slack_seen_events   (event_id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
CREATE TABLE slack_seen_messages (key TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);

-- feedback buttons
CREATE TABLE slack_feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT NOT NULL,
  value         TEXT NOT NULL,                -- 'good' | 'bad'
  slack_user_id TEXT,
  channel_id    TEXT,
  message_ts    TEXT,
  created_at    INTEGER NOT NULL
);

-- migrations
CREATE TABLE wrapper_schema_version (version INTEGER NOT NULL);
```

That's the whole wrapper schema. No `sessions`, no `messages` — Hermes owns those, one file per Slack thread.

PRAGMAs on open: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, `foreign_keys=ON`, `temp_store=MEMORY`. Use `better-sqlite3` (synchronous, in-process, fastest Node SQLite binding). Only the controller writes; no multi-writer ever.

---

## Turn lifecycle

User Sai posts `@hermes summarize the recent PR discussion` in `#hermes-test` at `1718380800.001`.

```
1. POST /slack/events arrives
2. Verify HMAC. INSERT slack_seen_events ON CONFLICT DO NOTHING.
   If conflict → 200, exit.

3. SELECT hermes_session_id FROM slack_threads
     WHERE team_id=? AND channel=? AND thread_ts=?
   Hit → reuse. Miss → generate UUID v4, INSERT new row.

4. INSERT INTO runs (id, hermes_session_id, status='queued', slack_channel, ...)

5. Open Slack stream: chat.startStream → returns ts. UPDATE runs SET slack_message_ts=ts.

6. Build signed work payload:
     { run_id, hermes_session_id, content, agent_config, controller_url }
     base64(JSON). HMAC(master_secret, run_id+exp) → HARNESS_CALLBACK_TOKEN.
   Both go into job env.

7. Trigger TrueFoundry job with metadata.job_run_name_alias=run_id (idempotency key).
   Success → UPDATE runs SET status='dispatched'.
   Failure → UPDATE runs SET status='failed', error=?

8. Controller subscribes its in-process pub/sub channel `run:run_p1`.

--- executor pod starts ---

9. Decode HARNESS_WORK_B64. Verify HMAC token has not expired.
10. mkdir /workspace/.hermes
11. GET /api/internal/runs/run_p1/session-db
      Authorization: Bearer <per-run HMAC token>
    200 → stream body to /workspace/.hermes/state.db
    404 → first turn, leave it empty (Hermes will create)
12. Install agent skills via TrueFoundry presigned URLs.
13. HERMES_HOME=/workspace/.hermes HERMES_SESSION_ID=<id> python -m hermes -z

14. As Hermes runs, observer plugin + stdout capture POST to:
      /api/internal/runs/run_p1/events
    Controller verifies token, INSERTs row, publishes to `run:run_p1`.
    Slack streamer + /v1/* SSE consumers receive deltas via the bus.

15. Hermes exits with status 0 + final stdout.
16. POST /api/internal/runs/run_p1/session-db
      Authorization: Bearer <per-run HMAC token>
      Content-Type: application/octet-stream
      Body: contents of /workspace/.hermes/state.db
    Controller writes to /data/sessions/<session_id>.db.tmp then renames atomically.

17. POST /api/internal/runs/run_p1/complete
      { status: 'completed', result: '...' }
    Controller: UPDATE runs SET status='completed', result=?, updated_at=NOW
    Closes Slack stream with chat.stopStream + feedback blocks.
    Closes any /v1/* SSE consumers.

18. Job exits. Container FS reclaimed. Nothing to clean up.

--- later ---

19. User clicks 👍: POST /slack/interactions
    INSERT INTO slack_feedback (...).
```

**Turn 2 in the same Slack thread:** step 3 hits, step 11 returns the existing DB. Hermes loads prior messages, appends turn 2, the upload at step 16 carries the new state back. Symmetric.

---

## Session continuity

**Slack thread = Hermes session.** One-to-one mapping in `slack_threads`. The mapping is permanent; there is no expiry.

- Thread three months old → mapping holds → `GET session-db` returns the old DB → Hermes resumes natively. Token budget/compaction is Hermes's problem.
- New thread → new UUID → first `GET` returns 404 → Hermes creates an empty session.
- Slack edits the root → `thread_ts` doesn't change → mapping holds.
- `/v1/*` continuity uses `previous_response_id` → `runs.openai_id` → `hermes_session_id`. Same mechanism.

---

## Deploy flow

```bash
$ hermes init
> Slack workspace URL: …
> Agent handle: devrel
> Agent name: DevRel Assistant
> Model: openai-main/gpt-5.5
> Workspace FQN: tfy-aws-use1:dev
> Skills (FQNs): …
> MCP servers (URLs): …

✓ Wrote hermes.yaml
✓ Wrote slack-app-manifest.json
✓ Scaffolded SecretGroup my-agent-secrets (fill values in TrueFoundry UI)

Next: hermes deploy hermes.yaml
```

```bash
$ hermes deploy hermes.yaml

✓ Validating against TrueFoundry…
✓ Resolving host: devrel-dev.ml.tenant.truefoundry.cloud
✓ tfy apply controller (Service)
✓ tfy apply executor (Job template)
✓ tfy apply volume (PVC, RWO, 10Gi default)
✓ Controller ready at https://devrel-dev.ml.tenant.truefoundry.cloud

Slack: install the app from slack-app-manifest.json and point Events to
       https://devrel-dev.ml.tenant.truefoundry.cloud/slack/events
```

No intermediate folder of YAML files. `tfy apply` runs against in-memory manifests piped via stdin. `--emit-manifests ./out` for debugging only.

The deploy uses TrueFoundry deploy-skills primitives:
- Service for the controller (`truefoundry-applications`/`deploy`)
- Job template for the executor (`truefoundry-jobs`)
- Volume for the controller PVC (`truefoundry-volumes`, ordinary RWO storage class — same as any normal app)
- SecretGroup reference (`truefoundry-secrets`)

---

## Failure recovery

| Failure | Recovery |
|---|---|
| Controller crash mid-turn | New pod starts. Reads `runs WHERE status IN ('dispatched','running') AND slack_message_ts IS NOT NULL`. Re-subscribes pub/sub. Backfills missed events from `run_events`, posts the diff to Slack. |
| Controller crash between TriggerJob and `UPDATE status='dispatched'` | Reconciler (60s) finds `queued` past 30s. Calls `Get Job Run` with `job_run_name_alias=run_id`. Job exists → flip to `dispatched`. Doesn't → re-trigger (alias makes it idempotent). |
| Executor crash mid-turn | No `session-db` POST happens → controller's `sessions/<id>.db` is **unchanged**. The conversation is exactly as it was before the turn started. Reconciler marks the run `failed`. User retries; clean slate. **A failed turn cannot corrupt the conversation.** |
| Slack stream message lost on controller restart | First row above resumes it. If beyond Slack's edit window, append a follow-up message with the remainder. |
| PVC unmounted / volume disaster | Restore from daily artifact backup (one cron: `sqlite3 .backup` of `wrapper.db` + tar of `sessions/`, both small, push to ML repo). |
| Hermes upgrade with schema change | Hermes runs its own migrations on DB open. Wrapper migrations run on controller boot. Independent. |
| Two executors triggered for the same run (race) | `job_run_name_alias=run_id` enforces uniqueness at the platform layer. If it doesn't, the second `GET session-db` returns the same blob → both turns operate on identical input → last `POST session-db` wins (controller serializes by `hermes_session_id`). Safe but wasteful; the reconciler should never cause this in practice. |

---

## Hard limits (call them out)

- **Controller `replicas: 1`.** SQLite is single-writer; scaling horizontally requires Postgres. Single-replica throughput is hundreds of Slack events/sec — past anything a personal assistant needs.
- **One Hermes turn at a time per Slack thread.** Concurrent turns in the same session aren't supported by Hermes's compaction model. Controller serializes by `hermes_session_id` — second event arriving while a turn is in flight queues behind it.
- **Session DB size cap: 50 MB.** Generous — typical session DBs stay well under 1 MB even at high usage because Hermes compacts. If a session ever exceeds the cap, chunk the upload. Not seen in practice yet.

No NFS, no RWX, no shared filesystem, no cluster storage-class dependency. Ordinary RWO disk works on every cloud.

---

## What gets deleted from the current codebase

| Today | After |
|---|---|
| `state.json`, `loadState`, `saveState`, `mutationQueue`, `stateWriteChain`, `pruneState`, `MAX_RUNS`, `MAX_SESSIONS` | gone |
| `snapshotter/`, `Dockerfile.snapshotter`, generated `*-snapshotter.yaml`, `*-state.yaml` | gone (one optional `sqlite3 .backup` cron if offsite backup is wanted) |
| `state.sessions[].messages[]`, `sessionMemory()`, prompt-concat-with-history logic in executor | gone (Hermes owns conversation history per-session) |
| `state.runs[].events[]` as arrays in JSON | replaced by `run_events` rows |
| `validate` / `compile` / `deploy` three-command CLI + folder of generated manifests | `init` + `deploy`, no intermediate files |
| Polling `loadState()` every 1s in `streamRunToSlack` / `streamRunText` | in-process pub/sub on `run:<id>` channel |
| Shared `HARNESS_INTERNAL_TOKEN` | per-run HMAC tokens |
| Executor `GET /work-item` round-trip | signed payload in env (`HARNESS_WORK_B64`) |
| `tar -xf` shell-out in skill installer | `node:tar` with safe-path enforcement |
| Warn-then-allow on missing `HERMES_OPENAI_API_KEY` | fail-closed on startup |

---

## File layout (after)

```
controller/
  controller.mjs          # HTTP service, ~900 lines (from 1873)
  db.mjs                  # better-sqlite3 wrapper + schema/migrations
  pubsub.mjs              # in-process per-run event bus
  reconciler.mjs          # 60s loop for stuck runs + dedup TTL cleanup

executor/
  executor.mjs            # ~420 lines (from 580); GET/POST session-db, no /work-item

bin/
  tfy-hermes-agent.mjs    # init + deploy only, ~250 lines (from 675)

Dockerfile.controller
Dockerfile.executor

examples/
  agent.hermes.yaml       # canonical sample

skills/                   # deploy runbook (unchanged)

DESIGN.md                 # this file
README.md                 # short orientation
AGENTS.md                 # repo norms
```

No `snapshotter/`. No generated-manifest folders. No shared volumes between pods.
