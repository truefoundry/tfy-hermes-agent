// Wrapper SQLite database: schema, migrations, and helpers.
//
// The controller is the only writer. PRAGMAs and table definitions follow
// DESIGN.md verbatim. Hermes session files live alongside wrapper.db as
// opaque blobs at ${stateRoot}/sessions/<id>.db.

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
 * Current epoch milliseconds as an integer. Matches DESIGN.md's `now()`.
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

export { SCHEMA_VERSION };
