import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { resolveConfigDir } from './paths.js';

/**
 * One-time import of the four JSON stores this database replaces.
 *
 * The legacy `WACLI_*_FILE` variables are still read here, and only here: an
 * existing install that pointed them somewhere custom keeps its data, but
 * nothing writes back to those paths afterwards. A file that is imported is
 * renamed rather than deleted, so the operator keeps a copy of what moved.
 */
interface LegacySource {
  /** The table that must be empty for this file to be imported. */
  table: string;
  envVar: string;
  fileName: string;
  load: (db: DatabaseSync, parsed: unknown) => number;
}

const sources: LegacySource[] = [
  {
    table: 'settings',
    envVar: 'WACLI_SETTINGS_FILE',
    fileName: 'settings.json',
    load: (db, parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
      const insert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      let count = 0;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value === undefined) continue;
        insert.run(key, JSON.stringify(value));
        count++;
      }
      return count;
    },
  },
  {
    table: 'bookmarks',
    envVar: 'WACLI_BOOKMARKS_FILE',
    fileName: 'bookmarks.json',
    load: (db, parsed) => {
      if (!Array.isArray(parsed)) return 0;
      const insert = db.prepare(
        'INSERT OR REPLACE INTO bookmarks (msg_id, chat_jid, created_at) VALUES (?, ?, ?)'
      );
      let count = 0;
      for (const item of parsed as Array<Record<string, unknown>>) {
        if (!item || typeof item.msgId !== 'string') continue;
        insert.run(
          item.msgId,
          typeof item.chatJid === 'string' ? item.chatJid : '',
          typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString()
        );
        count++;
      }
      return count;
    },
  },
  {
    table: 'tags',
    envVar: 'WACLI_TAGS_FILE',
    fileName: 'tags.json',
    load: (db, parsed) => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 0;
      const insert = db.prepare('INSERT OR REPLACE INTO tags (chat_jid, tag) VALUES (?, ?)');
      let count = 0;
      for (const [jid, tags] of Object.entries(parsed as Record<string, unknown>)) {
        if (!Array.isArray(tags)) continue;
        for (const tag of tags) {
          if (typeof tag !== 'string' || !tag) continue;
          insert.run(jid, tag);
          count++;
        }
      }
      return count;
    },
  },
  {
    table: 'scheduled',
    envVar: 'WACLI_SCHEDULED_FILE',
    fileName: 'scheduled.json',
    load: (db, parsed) => {
      if (!Array.isArray(parsed)) return 0;
      const insert = db.prepare(
        `INSERT OR REPLACE INTO scheduled
           (id, to_jid, recipient_name, message, reply_to, file_path, file_name, mime_type,
            scheduled_at, created_at, status, error, sent_message_id, resend_count, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let count = 0;
      for (const item of parsed as Array<Record<string, unknown>>) {
        if (!item || typeof item.id !== 'string') continue;
        const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
        insert.run(
          item.id,
          str(item.to) ?? '',
          str(item.recipientName),
          str(item.message) ?? '',
          str(item.replyTo),
          str(item.filePath),
          str(item.fileName),
          str(item.mimeType),
          str(item.scheduledAt) ?? new Date().toISOString(),
          str(item.createdAt) ?? new Date().toISOString(),
          str(item.status) ?? 'pending',
          str(item.error),
          str(item.sentMessageId),
          typeof item.resendCount === 'number' ? item.resendCount : null,
          str(item.lastAttemptAt)
        );
        count++;
      }
      return count;
    },
  },
];

function legacyPathFor(source: LegacySource, configDir: string): string {
  return process.env[source.envVar] || path.join(configDir, source.fileName);
}

function isEmpty(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n === 0;
}

/**
 * Imports any legacy JSON store into its table, once.
 *
 * A table with rows in it is left alone — that is what makes this safe to run
 * on every boot, and what stops a stale JSON file resurrecting data the
 * operator deleted after the move.
 */
export function migrateJsonStores(db: DatabaseSync): void {
  const configDir = resolveConfigDir();

  for (const source of sources) {
    const filePath = legacyPathFor(source, configDir);

    let raw: string;
    try {
      if (!fs.existsSync(filePath)) continue;
      if (!isEmpty(db, source.table)) continue;
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      logger.warn('api', 'Could not read a legacy store for migration', { file: filePath, err });
      continue;
    }

    let imported: number;
    try {
      const parsed: unknown = JSON.parse(raw);
      // One transaction per file: a row that fails to parse halfway through
      // leaves the table empty and the JSON in place, so the next boot retries
      // rather than starting from a half-populated table it now thinks is full.
      db.exec('BEGIN');
      try {
        imported = source.load(db, parsed);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      logger.warn('api', 'Could not migrate a legacy store; leaving it in place', {
        file: filePath,
        err,
      });
      continue;
    }

    try {
      fs.renameSync(filePath, `${filePath}.migrated`);
    } catch (err) {
      // The data is in the database either way. Say so, because the stale file
      // staying put is confusing on its own.
      logger.warn('api', 'Migrated a legacy store but could not rename the file', {
        file: filePath,
        err,
      });
    }

    logger.info('api', 'Migrated a legacy JSON store into SQLite', {
      file: path.basename(filePath),
      table: source.table,
      rows: imported,
    });
  }
}
