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

/**
 * Thrown at startup when another Mission Control already has the database.
 *
 * Two servers on one database each run the scheduler, so each one sent every
 * due message: a single "send at 9:00" went out once per server.
 */
export class DatabaseInUseError extends DatabaseUnavailableError {
  constructor(dbPath: string, cause: unknown) {
    super(dbPath, cause);
    this.name = 'DatabaseInUseError';
    this.message = `Another Mission Control is already running on the database at ${dbPath}.`;
  }
}

/** SQLite's "another connection holds the lock". */
const SQLITE_BUSY = 5;

interface OpenOptions {
  /**
   * Keep every other connection out, other processes included, until this
   * handle closes. The server asks for this so that it runs alone; tests and
   * standalone handles do not.
   */
  exclusive?: boolean;
}

let db: DatabaseSync | null = null;
let openedPath: string | null = null;
let openedExclusive = false;

function open(dbPath: string, { exclusive = false }: OpenOptions = {}): DatabaseSync {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const handle = new DatabaseSync(dbPath);

  // A home-directory file holding chat JIDs and message bodies; it gets the
  // same 0600 the JSON files had. Here rather than in initDatabase so a
  // standalone handle is not the one exception that leaves it world-readable.
  try {
    fs.chmodSync(dbPath, 0o600);
  } catch {
    // Windows, or a filesystem with no notion of modes. Not worth failing on.
  }

  try {
    if (exclusive) {
      // Before the first read, which in WAL mode is what takes the lock; in
      // this mode it is then held until the handle closes. No busy wait yet,
      // so a second server stops at once with a reason instead of stalling.
      handle.exec('PRAGMA locking_mode = EXCLUSIVE');
    }
    // WAL keeps the 3s scheduler tick from blocking a read the UI is waiting on.
    handle.exec('PRAGMA journal_mode = WAL');
    if (exclusive) {
      // Taken here outright rather than left to whichever statement comes next.
      handle.exec('BEGIN IMMEDIATE');
      handle.exec('COMMIT');
    }
    // The scheduler's dispatch and an interactive write can still collide; wait
    // rather than failing the request outright.
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA foreign_keys = ON');
    applySchema(handle);
  } catch (err) {
    handle.close();
    throw err;
  }

  return handle;
}

/**
 * Opens a database at an explicit path without touching the process-wide one.
 *
 * For a caller that needs its own isolated handle — chiefly a test standing up
 * one store per case — where going through the singleton would have every
 * instance share, and clobber, the same file.
 */
export function openDatabaseAt(dbPath: string): DatabaseSync {
  try {
    return open(dbPath);
  } catch (err) {
    throw new DatabaseUnavailableError(dbPath, err);
  }
}

/**
 * Opens the database, or throws `DatabaseUnavailableError`.
 *
 * Called once from server startup so the failure lands in one place that can
 * report it properly, rather than at import time inside whichever store
 * happened to be loaded first.
 */
export function initDatabase(dbPath = resolveDbPath(), options: OpenOptions = {}): DatabaseSync {
  const exclusive = options.exclusive ?? false;
  if (db && openedPath === dbPath && (openedExclusive || !exclusive)) return db;
  if (db) closeDatabase();

  try {
    db = open(dbPath, { exclusive });
    openedPath = dbPath;
    openedExclusive = exclusive;
    return db;
  } catch (err) {
    db = null;
    openedPath = null;
    const busy = (err as { errcode?: unknown }).errcode === SQLITE_BUSY;
    throw exclusive && busy
      ? new DatabaseInUseError(dbPath, err)
      : new DatabaseUnavailableError(dbPath, err);
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
  openedExclusive = false;
}

export { resolveDbPath } from './paths.js';
