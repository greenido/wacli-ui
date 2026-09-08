import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { logger } from '../logger.js';

/** Keeps one operator's typing from fragmenting a tag into three. */
export function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

/**
 * Local chat tags.
 *
 * wacli has `contacts tags add|rm`, but nothing that reads them back: neither
 * `contacts show` nor `contacts search` returns a tag field, and there is no
 * `tags list`. Writing there would be a dead drop — the operator would label a
 * chat and never see the label again. So tags live here, on the same footing as
 * bookmarks: this machine's own metadata, never sent to WhatsApp, and labelled
 * that way in the UI.
 *
 * One row per (chat, tag) rather than a JSON array per chat: `allTags` and
 * `countFor` become one indexed query instead of a walk over every chat, and a
 * rename is a single UPDATE rather than a rewrite of the whole file.
 */
export class TagStore {
  /** Set only when a caller asked for its own file, so tests get one store per case. */
  private ownDb: DatabaseSync | null = null;

  constructor(customDbPath?: string) {
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  public get(jid: string): string[] {
    try {
      const rows = this.db()
        .prepare('SELECT tag FROM tags WHERE chat_jid = ? ORDER BY tag')
        .all(jid) as Array<{ tag: string }>;
      return rows.map((r) => r.tag);
    } catch (err) {
      logger.warn('api', 'Failed to read tags for a chat', { err });
      return [];
    }
  }

  /** Every tag in use, for the rail's filter row. */
  public allTags(): string[] {
    try {
      const rows = this.db()
        .prepare('SELECT DISTINCT tag FROM tags ORDER BY tag')
        .all() as Array<{ tag: string }>;
      return rows.map((r) => r.tag);
    } catch (err) {
      logger.warn('api', 'Failed to read tags', { err });
      return [];
    }
  }

  public all(): Record<string, string[]> {
    try {
      const rows = this.db()
        .prepare('SELECT chat_jid, tag FROM tags ORDER BY chat_jid, tag')
        .all() as Array<{ chat_jid: string; tag: string }>;
      const byJid: Record<string, string[]> = {};
      for (const row of rows) {
        (byJid[row.chat_jid] ??= []).push(row.tag);
      }
      return byJid;
    } catch (err) {
      logger.warn('api', 'Failed to read tags', { err });
      return {};
    }
  }

  public add(jid: string, tag: string): string[] {
    const normalized = normalizeTag(tag);
    if (!normalized) return this.get(jid);

    try {
      this.db()
        .prepare('INSERT OR IGNORE INTO tags (chat_jid, tag) VALUES (?, ?)')
        .run(jid, normalized);
    } catch (err) {
      logger.warn('api', 'Failed to add a tag', { err });
    }
    return this.get(jid);
  }

  /** How many chats carry a tag — the blast radius of renaming or deleting it. */
  public countFor(tag: string): number {
    const normalized = normalizeTag(tag);
    if (!normalized) return 0;

    try {
      const row = this.db()
        .prepare('SELECT COUNT(*) AS n FROM tags WHERE tag = ?')
        .get(normalized) as { n: number };
      return row.n;
    } catch (err) {
      logger.warn('api', 'Failed to count a tag', { err });
      return 0;
    }
  }

  /**
   * Renames a tag on every chat carrying it, so a vocabulary that drifted can
   * be corrected in one place instead of chat by chat.
   *
   * Renaming onto a name already in use merges the two: a chat that held both
   * ends up with one chip rather than a doubled one. That is a decision, not a
   * detail — the caller confirms it first, and the returned `merged` flag says
   * whether it happened. UPDATE OR REPLACE does the merge, dropping the row
   * that would collide instead of failing the statement.
   */
  public rename(from: string, to: string): { renamed: number; merged: boolean } {
    const before = normalizeTag(from);
    const after = normalizeTag(to);
    if (!before || !after || before === after) return { renamed: 0, merged: false };

    try {
      const db = this.db();
      // Read before the write: afterwards every renamed chat carries `after`
      // and the question of whether it pre-existed can no longer be asked.
      const merged =
        (db.prepare('SELECT COUNT(*) AS n FROM tags WHERE tag = ?').get(after) as { n: number }).n >
        0;
      const renamed = db
        .prepare('UPDATE OR REPLACE tags SET tag = ? WHERE tag = ?')
        .run(after, before).changes;
      return { renamed: Number(renamed), merged };
    } catch (err) {
      logger.warn('api', 'Failed to rename a tag', { err });
      return { renamed: 0, merged: false };
    }
  }

  /** Drops a tag from every chat carrying it. Returns how many were touched. */
  public deleteTag(tag: string): number {
    const normalized = normalizeTag(tag);
    if (!normalized) return 0;

    try {
      return Number(this.db().prepare('DELETE FROM tags WHERE tag = ?').run(normalized).changes);
    } catch (err) {
      logger.warn('api', 'Failed to delete a tag', { err });
      return 0;
    }
  }

  public remove(jid: string, tag: string): string[] {
    const normalized = normalizeTag(tag);
    try {
      this.db().prepare('DELETE FROM tags WHERE chat_jid = ? AND tag = ?').run(jid, normalized);
    } catch (err) {
      logger.warn('api', 'Failed to remove a tag', { err });
    }
    return this.get(jid);
  }
}

export const tagStore = new TagStore();
