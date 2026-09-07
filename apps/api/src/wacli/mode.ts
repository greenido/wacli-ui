import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { logger } from '../logger.js';

export interface AppSettings {
  readOnly: boolean;
  storeDir?: string;
  account?: string;
}

/**
 * Safe mode is only imposed before the operator has made a choice. Once they
 * unlock live sends we persist that and never re-impose the lock on them.
 */
export const FIRST_RUN_READ_ONLY = true;

export class ModeManager {
  /**
   * Loaded on first use, not in the constructor.
   *
   * This is a module singleton, so a constructor that read the database would
   * read it at import time — before startup has had a chance to open it and
   * report a failure properly. Lazy means the first caller gets a live value
   * and a dead database is still announced by `bootDatabase`.
   */
  private settings: AppSettings | null = null;
  /** Set only when a caller asked for its own file, so tests get one store per case. */
  private ownDb: DatabaseSync | null = null;

  constructor(customDbPath?: string) {
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  private current(): AppSettings {
    if (!this.settings) {
      this.settings = this.loadSettings();
    }
    return this.settings;
  }

  /**
   * Settings are a key/value table rather than a row of columns, so adding one
   * later is an insert and not a schema migration. Values are JSON-encoded, so
   * a boolean comes back a boolean instead of the string "false" — which is
   * truthy, and would have unlocked sends on every machine that had ever
   * locked them.
   */
  private loadSettings(): AppSettings {
    const stored: Record<string, unknown> = {};
    try {
      const rows = this.db().prepare('SELECT key, value FROM settings').all() as Array<{
        key: string;
        value: string;
      }>;
      for (const row of rows) {
        try {
          stored[row.key] = JSON.parse(row.value);
        } catch {
          logger.warn('api', 'Ignoring an unreadable setting', { key: row.key });
        }
      }
    } catch (err) {
      // getDb() only throws when the database is gone, and startup refuses to
      // boot in that case. Reaching here means it went away mid-run, so take
      // the safe side of the only setting that can do harm.
      logger.error('api', 'Could not read settings; locking sends', { err });
      return { readOnly: true };
    }

    return {
      // A stored choice always wins, so the operator's decision survives restarts.
      readOnly: stored.readOnly !== undefined ? Boolean(stored.readOnly) : FIRST_RUN_READ_ONLY,
      storeDir: typeof stored.storeDir === 'string' ? stored.storeDir : undefined,
      account: typeof stored.account === 'string' ? stored.account : undefined,
    };
  }

  private saveSettings(): void {
    try {
      const db = this.db();
      const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      const clear = db.prepare('DELETE FROM settings WHERE key = ?');
      for (const [key, value] of Object.entries(this.current())) {
        if (value === undefined) {
          clear.run(key);
        } else {
          upsert.run(key, JSON.stringify(value));
        }
      }
    } catch (err) {
      logger.error('api', 'Failed to persist settings', { err });
    }
  }

  public isReadOnly(): boolean {
    return this.current().readOnly;
  }

  public setReadOnly(readOnly: boolean): void {
    this.current().readOnly = readOnly;
    this.saveSettings();
  }

  public getSettings(): AppSettings {
    return { ...this.current() };
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    // Spreading the raw partial would let an explicit `undefined` (a field the
    // caller simply did not set) erase a stored value — which previously wiped
    // `readOnly` off disk whenever settings were saved without it.
    const next = { ...this.current() };
    for (const [key, value] of Object.entries(partial)) {
      if (value !== undefined) {
        (next as Record<string, unknown>)[key] = value;
      }
    }
    this.settings = next;
    this.saveSettings();
    return { ...next };
  }

  /** Drops the cache so the next read comes from the database again. Used by
   * tests that swap the file underneath a long-lived singleton. */
  public reload(): void {
    this.settings = null;
  }
}

export const modeManager = new ModeManager();
