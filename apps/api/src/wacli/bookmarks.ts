import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { logger } from '../logger.js';

export interface BookmarkMetadata {
  chatName?: string;
  senderName?: string;
  text?: string;
  ts?: string;
}

export interface Bookmark {
  msgId: string;
  chatJid: string;
  createdAt: string;
  chatName?: string;
  senderName?: string;
  text?: string;
  ts?: string;
}

interface BookmarkRow {
  msg_id: string;
  chat_jid: string;
  created_at: string;
  chat_name: string | null;
  sender_name: string | null;
  text: string | null;
  ts: string | null;
}

const DEFAULT_BOOKMARK_LIMIT = 200;
const MAX_BOOKMARK_LIMIT = 500;
const BATCH_CHUNK_SIZE = 500;

/**
 * Local message bookmarks.
 *
 * These are deliberately NOT WhatsApp stars. wacli 0.17.x can read a synced
 * star (`messages starred`) but has no command to set one, so anything the
 * operator marks here stays on this machine. Keeping the two apart means the
 * gold star in the thread always reflects real WhatsApp state, and a bookmark
 * never pretends to have left the building.
 */
export class BookmarkStore {
  /** Set only when a caller asked for its own file, so tests get one store per case. */
  private ownDb: DatabaseSync | null = null;

  constructor(customDbPath?: string) {
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  public has(msgId: string): boolean {
    try {
      return this.db().prepare('SELECT 1 FROM bookmarks WHERE msg_id = ?').get(msgId) !== undefined;
    } catch (err) {
      logger.warn('api', 'Failed to read a bookmark', { err });
      return false;
    }
  }

  /**
   * Batch-checks which of `msgIds` are bookmarked in a single SQLite query
   * (or one indexed query by `chatJid` when checking a large conversation export),
   * avoiding N+1 per-row queries on message lists, searches, and exports.
   */
  public getBookmarkedIds(msgIds: readonly string[], chatJid?: string): Set<string> {
    const ids = msgIds.filter(Boolean);
    if (ids.length === 0) return new Set();

    try {
      const db = this.db();
      const matched = new Set<string>();

      if (chatJid && ids.length > BATCH_CHUNK_SIZE) {
        const rows = db
          .prepare('SELECT msg_id FROM bookmarks WHERE chat_jid = ?')
          .all(chatJid) as Array<{ msg_id: string }>;
        for (const r of rows) matched.add(r.msg_id);
        return matched;
      }

      for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
        const slice = ids.slice(i, i + BATCH_CHUNK_SIZE);
        const placeholders = slice.map(() => '?').join(',');
        const rows = db
          .prepare(`SELECT msg_id FROM bookmarks WHERE msg_id IN (${placeholders})`)
          .all(...slice) as Array<{ msg_id: string }>;
        for (const r of rows) matched.add(r.msg_id);
      }
      return matched;
    } catch (err) {
      logger.warn('api', 'Failed to batch-read bookmarks', { err });
      return new Set();
    }
  }

  public set(
    msgId: string,
    chatJid: string,
    bookmarked: boolean,
    meta?: BookmarkMetadata
  ): boolean {
    try {
      const db = this.db();
      if (bookmarked) {
        // ON CONFLICT keeps the original createdAt when a message is bookmarked
        // twice while allowing optional metadata to be filled in.
        db.prepare(
          `INSERT INTO bookmarks (msg_id, chat_jid, created_at, chat_name, sender_name, text, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(msg_id) DO UPDATE SET
             chat_name   = COALESCE(excluded.chat_name, bookmarks.chat_name),
             sender_name = COALESCE(excluded.sender_name, bookmarks.sender_name),
             text        = COALESCE(excluded.text, bookmarks.text),
             ts          = COALESCE(excluded.ts, bookmarks.ts)`
        ).run(
          msgId,
          chatJid,
          new Date().toISOString(),
          meta?.chatName ?? null,
          meta?.senderName ?? null,
          meta?.text ?? null,
          meta?.ts ?? null
        );
      } else {
        db.prepare('DELETE FROM bookmarks WHERE msg_id = ?').run(msgId);
      }
    } catch (err) {
      logger.warn('api', 'Failed to persist a bookmark', { err });
    }
    return bookmarked;
  }

  public list(opts: { chat?: string; limit?: number } = {}): Bookmark[] {
    try {
      const db = this.db();
      const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_BOOKMARK_LIMIT), MAX_BOOKMARK_LIMIT);
      const rows = (
        opts.chat
          ? db
              .prepare(
                `SELECT msg_id, chat_jid, created_at, chat_name, sender_name, text, ts
                 FROM bookmarks
                 WHERE chat_jid = ?
                 ORDER BY created_at DESC, msg_id DESC
                 LIMIT ?`
              )
              .all(opts.chat, limit)
          : db
              .prepare(
                `SELECT msg_id, chat_jid, created_at, chat_name, sender_name, text, ts
                 FROM bookmarks
                 ORDER BY created_at DESC, msg_id DESC
                 LIMIT ?`
              )
              .all(limit)
      ) as unknown as BookmarkRow[];

      return rows.map((r) => ({
        msgId: r.msg_id,
        chatJid: r.chat_jid,
        createdAt: r.created_at,
        ...(r.chat_name ? { chatName: r.chat_name } : {}),
        ...(r.sender_name ? { senderName: r.sender_name } : {}),
        ...(r.text ? { text: r.text } : {}),
        ...(r.ts ? { ts: r.ts } : {}),
      }));
    } catch (err) {
      logger.warn('api', 'Failed to list bookmarks', { err });
      return [];
    }
  }
}

export const bookmarkStore = new BookmarkStore();
