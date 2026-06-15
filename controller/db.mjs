// Wrapper SQLite database: schema, migrations, and helpers.
//
// The controller is the only writer. Hermes session files live alongside
// wrapper.db as opaque blobs at ${stateRoot}/sessions/<id>.db.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_VERSION = 1;

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = NORMAL',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA foreign_keys = ON',
  'PRAGMA temp_store = MEMORY',
];

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    handle          TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    model           TEXT NOT NULL,
    instructions    TEXT,
    workspace_fqn   TEXT NOT NULL,
    slack_team_id   TEXT,
    skills          TEXT NOT NULL DEFAULT '[]',
    mcp_servers     TEXT NOT NULL DEFAULT '[]',
    slack_allowed_channels TEXT NOT NULL DEFAULT '[]',
    slack_allowed_users    TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS slack_threads (
    team_id            TEXT NOT NULL,
    channel            TEXT NOT NULL,
    thread_ts          TEXT NOT NULL,
    hermes_session_id  TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    PRIMARY KEY (team_id, channel, thread_ts)
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id                TEXT PRIMARY KEY,
    hermes_session_id TEXT NOT NULL,
    status            TEXT NOT NULL,
    result            TEXT,
    error             TEXT,
    slack_channel     TEXT,
    slack_message_ts  TEXT,
    openai_kind       TEXT,
    openai_id         TEXT,
    trigger           TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_runs_status_updated
    ON runs(status, updated_at)
    WHERE status IN ('queued','dispatched','running')`,
  `CREATE INDEX IF NOT EXISTS idx_runs_openai_id ON runs(openai_id)`,
  `CREATE TABLE IF NOT EXISTS run_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    type       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id)`,
  `CREATE TABLE IF NOT EXISTS slack_seen_events (
    event_id TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS slack_seen_messages (
    key     TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS slack_feedback (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        TEXT NOT NULL,
    value         TEXT NOT NULL,
    slack_user_id TEXT,
    channel_id    TEXT,
    message_ts    TEXT,
    created_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS wrapper_schema_version (
    version INTEGER NOT NULL
  )`,
];

/**
 * Current epoch milliseconds as an integer.
 */
export function now() {
  return Date.now();
}

/**
 * Absolute path of the per-session Hermes DB file.
 */
export function sessionDbPath(stateRoot, sessionId) {
  return join(stateRoot, 'sessions', `${sessionId}.db`);
}

function applyPragmas(db) {
  for (const stmt of PRAGMAS) db.pragma(stmt.replace(/^PRAGMA\s+/i, ''));
}

function runMigrations(db) {
  // Always ensure tables exist (idempotent IF NOT EXISTS DDL).
  const ddl = db.transaction(() => {
    for (const stmt of SCHEMA_STATEMENTS) db.exec(stmt);
  });
  ddl();

  const row = db.prepare('SELECT version FROM wrapper_schema_version LIMIT 1').get();
  if (!row) {
    db.prepare('INSERT INTO wrapper_schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    return;
  }
  if (row.version !== SCHEMA_VERSION) {
    // Future migrations would branch on row.version here. For v1 we just
    // update the recorded version after the idempotent DDL above.
    db.prepare('UPDATE wrapper_schema_version SET version = ?').run(SCHEMA_VERSION);
  }
}

/**
 * Open (and migrate) the controller's wrapper.db at ${stateRoot}/wrapper.db.
 * Ensures ${stateRoot} and ${stateRoot}/sessions/ exist.
 */
export function openDb(stateRoot) {
  if (!stateRoot || typeof stateRoot !== 'string') {
    throw new Error('openDb: stateRoot must be a non-empty string');
  }
  mkdirSync(stateRoot, { recursive: true });
  mkdirSync(join(stateRoot, 'sessions'), { recursive: true });

  const db = new Database(join(stateRoot, 'wrapper.db'));
  applyPragmas(db);
  runMigrations(db);
  return db;
}

/**
 * Build the controller's prepared-statement object. Centralized here so the
 * SQL stays close to the schema. The shape is stable; the controller treats
 * these as opaque .run/.get/.all callsites.
 */
export function prepareStatements(db) {
  return {
    upsertAgent: db.prepare(`
      INSERT INTO agents (id, handle, name, model, instructions, workspace_fqn,
                          slack_team_id, skills, mcp_servers,
                          slack_allowed_channels, slack_allowed_users,
                          created_at, updated_at)
      VALUES (@id, @handle, @name, @model, @instructions, @workspace_fqn,
              @slack_team_id, @skills, @mcp_servers,
              @slack_allowed_channels, @slack_allowed_users,
              @created_at, @updated_at)
      ON CONFLICT(id) DO UPDATE SET
        handle = excluded.handle,
        name = excluded.name,
        model = excluded.model,
        instructions = excluded.instructions,
        workspace_fqn = excluded.workspace_fqn,
        slack_team_id = excluded.slack_team_id,
        skills = excluded.skills,
        mcp_servers = excluded.mcp_servers,
        slack_allowed_channels = excluded.slack_allowed_channels,
        slack_allowed_users = excluded.slack_allowed_users,
        updated_at = excluded.updated_at
    `),
    getAgentById: db.prepare('SELECT * FROM agents WHERE id = ?'),
    getAgentByHandle: db.prepare('SELECT * FROM agents WHERE handle = ?'),
    insertRun: db.prepare(`
      INSERT INTO runs (id, hermes_session_id, status, slack_channel,
                        slack_message_ts, openai_kind, openai_id,
                        created_at, updated_at)
      VALUES (@id, @hermes_session_id, @status, @slack_channel,
              @slack_message_ts, @openai_kind, @openai_id,
              @created_at, @updated_at)
    `),
    setRunDispatched: db.prepare('UPDATE runs SET status = ?, trigger = ?, updated_at = ? WHERE id = ?'),
    setRunFailed: db.prepare("UPDATE runs SET status = 'failed', error = ?, trigger = ?, updated_at = ? WHERE id = ?"),
    setRunStatus: db.prepare('UPDATE runs SET status = ?, updated_at = ? WHERE id = ?'),
    completeRun: db.prepare(`
      UPDATE runs SET status = ?, result = ?, error = ?, updated_at = ? WHERE id = ?
    `),
    getRunById: db.prepare('SELECT * FROM runs WHERE id = ?'),
    getRunByOpenAIId: db.prepare('SELECT * FROM runs WHERE openai_id = ? ORDER BY created_at DESC LIMIT 1'),
    selectResumeRuns: db.prepare(`
      SELECT * FROM runs
       WHERE status IN ('dispatched','running')
         AND slack_message_ts IS NOT NULL
    `),
    insertRunEvent: db.prepare('INSERT INTO run_events (run_id, type, payload, created_at) VALUES (?, ?, ?, ?)'),
    selectRunEvents: db.prepare('SELECT id, type, payload, created_at FROM run_events WHERE run_id = ? ORDER BY id ASC'),
    selectRunEventsAfter: db.prepare('SELECT id, type, payload, created_at FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC'),
    getSlackThread: db.prepare('SELECT * FROM slack_threads WHERE team_id = ? AND channel = ? AND thread_ts = ?'),
    insertSlackThread: db.prepare(`
      INSERT INTO slack_threads (team_id, channel, thread_ts, hermes_session_id, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, channel, thread_ts) DO NOTHING
    `),
    claimSlackEvent: db.prepare(`
      INSERT INTO slack_seen_events (event_id, seen_at)
      VALUES (?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `),
    claimSlackMessage: db.prepare(`
      INSERT INTO slack_seen_messages (key, seen_at)
      VALUES (?, ?)
      ON CONFLICT(key) DO NOTHING
    `),
    insertSlackFeedback: db.prepare(`
      INSERT INTO slack_feedback (run_id, value, slack_user_id, channel_id, message_ts, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
  };
}

export { SCHEMA_VERSION };
