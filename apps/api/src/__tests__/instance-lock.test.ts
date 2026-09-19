import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bootDatabase } from '../index.js';
import { closeDatabase, DatabaseInUseError, initDatabase } from '../db/index.js';

/**
 * One console per database. Two servers on one file each ran the scheduler,
 * so each one sent every due message.
 */
describe('One Mission Control per database', () => {
  const savedDbFile = process.env.WACLI_DB_FILE;
  let dir: string;
  let file: string;
  let otherServer: DatabaseSync | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-instance-'));
    file = path.join(dir, 'mission-control.db');
    process.env.WACLI_DB_FILE = file;
  });

  afterEach(() => {
    otherServer?.close();
    otherServer = null;
    closeDatabase();
    process.env.WACLI_DB_FILE = savedDbFile;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Whether a plain connection, as any other process would open, can read the file. */
  function othersCanRead(): boolean {
    const other = new DatabaseSync(file);
    try {
      other.prepare('SELECT count(*) AS n FROM scheduled').get();
      return true;
    } catch (err) {
      if ((err as { errcode?: number }).errcode === 5) return false;
      throw err;
    } finally {
      other.close();
    }
  }

  /** A server already running on the file, holding it the way ours does. */
  function startOtherServer(): void {
    initDatabase(file).exec('SELECT 1');
    closeDatabase();
    otherServer = new DatabaseSync(file);
    otherServer.exec('PRAGMA locking_mode = EXCLUSIVE');
    otherServer.exec('PRAGMA journal_mode = WAL');
    otherServer.exec('BEGIN IMMEDIATE');
    otherServer.exec('COMMIT');
  }

  it('keeps the database to itself while it runs, and lets go when it closes', () => {
    initDatabase(file, { exclusive: true });

    expect(othersCanRead()).toBe(false);

    closeDatabase();
    expect(othersCanRead()).toBe(true);
  });

  it('refuses to start beside a server that already has the database, and says why', () => {
    startOtherServer();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const started = Date.now();
    expect(() => bootDatabase(exit)).toThrow('exit 1');

    // At once, not after waiting out the lock timeout.
    expect(Date.now() - started).toBeLessThan(2_000);
    const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(printed).toContain('Another Mission Control is already running');
    expect(printed).toContain('WACLI_DB_FILE');
  });

  it('names the problem for a caller that asks for the file to itself', () => {
    startOtherServer();

    expect(() => initDatabase(file, { exclusive: true })).toThrow(DatabaseInUseError);
  });
});
