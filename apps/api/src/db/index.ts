import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applySchema } from './schema.js';
import { resolveDbPath } from './paths.js';

/**
 * Thrown when the database cannot be opened or brought up to schema.
 *
 * Mission Control does not run without it. Safe mode, the scheduled queue and
 * the activity log all live here, and a server that came up with no store
 * would answer "read-only: false" from a default rather than from the
 * operator's actual choice — quietly re-arming sends they had never unlocked.
 * So this is fatal at startup by design: loud, with the path in the message.
 */
export class DatabaseUnavailableError extends Error {
  public readonly dbPath: string;

  constructor(dbPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot open the Mission Control database at ${dbPath}: ${detail}`);
    this.name = 'DatabaseUnavailableError';
    this.dbPath = dbPath;
    this.cause = cause;
  }
}

let db: DatabaseSync | null = null;
let openedPath: string | null = null;

function open(dbPath: string): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const handle = new DatabaseSync(dbPath);

  // WAL keeps the 3s scheduler tick from blocking a read the UI is waiting on.
  handle.exec('PRAGMA journal_mode = WAL');
  // The scheduler's dispatch and an interactive write can still collide; wait
  // rather than failing the request outright.
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA foreign_keys = ON');
  applySchema(handle);

  return handle;
}

/**
 * Opens the database, or throws `DatabaseUnavailableError`.
 *
 * Called once from server startup so the failure lands in one place that can
 * report it properly, rather than at import time inside whichever store
 * happened to be loaded first.
 */
export function initDatabase(dbPath = resolveDbPath()): DatabaseSync {
  if (db && openedPath === dbPath) return db;
  if (db) closeDatabase();

  try {
    db = open(dbPath);
    openedPath = dbPath;
    // A store this permissive is a home-directory file holding chat JIDs and
    // message bodies; it gets the same 0600 the JSON files had.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // Windows, or a filesystem with no notion of modes. Not worth failing on.
    }
    return db;
  } catch (err) {
    db = null;
    openedPath = null;
    throw new DatabaseUnavailableError(dbPath, err);
  }
}

/**
 * The open database.
 *
 * Stores call this on each use rather than caching the handle, so a test that
 * swaps the file underneath them is picked up without reconstructing them.
 */
export function getDb(): DatabaseSync {
  const wanted = resolveDbPath();
  if (!db || openedPath !== wanted) {
    return initDatabase(wanted);
  }
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Already closed, or closing during an abrupt shutdown.
  }
  db = null;
  openedPath = null;
}

/** The path currently open, for diagnostics and the health endpoint. */
export function currentDbPath(): string | null {
  return openedPath;
}

export { resolveDbPath } from './paths.js';
