import type { DatabaseSync } from 'node:sqlite';

/**
 * Bump this when the statements below change, and add the matching upgrade to
 * `migrations`. The number is stored in the file itself, so a database written
 * by a newer build is recognised rather than silently half-read.
 */
export const SCHEMA_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bookmarks (
  msg_id     TEXT PRIMARY KEY,
  chat_jid   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  chat_jid TEXT NOT NULL,
  tag      TEXT NOT NULL,
  PRIMARY KEY (chat_jid, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags (tag);

CREATE TABLE IF NOT EXISTS scheduled (
  id              TEXT PRIMARY KEY,
  to_jid          TEXT NOT NULL,
  recipient_name  TEXT,
  message         TEXT NOT NULL,
  reply_to        TEXT,
  file_path       TEXT,
  file_name       TEXT,
  mime_type       TEXT,
  scheduled_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL,
  error           TEXT,
  sent_message_id TEXT,
  resend_count    INTEGER,
  last_attempt_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_created_at ON scheduled (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled (status);

CREATE TABLE IF NOT EXISTS activity (
  id         TEXT PRIMARY KEY,
  timestamp  TEXT NOT NULL,
  to_jid     TEXT NOT NULL,
  chat_name  TEXT,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity (timestamp DESC);
`;

/**
 * Applied in order from whatever version the file is already at. Index 0 takes
 * an empty file to version 1, so a fresh install runs the same statements an
 * upgrade would.
 */
const migrations: Array<(db: DatabaseSync) => void> = [(db) => db.exec(SCHEMA_V1)];

/** The version recorded in the file, or 0 for one this build has never opened. */
function readVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * Brings the file up to `SCHEMA_VERSION`.
 *
 * A file from a *newer* build is left alone and reported, because this build
 * cannot know what the columns it is missing mean. Running against it anyway
 * is how a downgrade quietly drops the operator's data.
 */
export function applySchema(db: DatabaseSync): void {
  const current = readVersion(db);

  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database was written by a newer version of Mission Control ` +
        `(schema v${current}, this build speaks v${SCHEMA_VERSION}). Upgrade wacli-ui, ` +
        `or point WACLI_DB_FILE at a different file.`
    );
  }

  if (current === SCHEMA_VERSION) return;

  for (let version = current; version < SCHEMA_VERSION; version++) {
    migrations[version](db);
  }
  // PRAGMA does not accept a bound parameter, and the value is an integer
  // constant from this module rather than anything a caller supplies.
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}
