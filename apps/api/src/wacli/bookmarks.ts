import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { logger } from '../logger.js';

export interface Bookmark {
  msgId: string;
  chatJid: string;
  createdAt: string;
}

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

  public set(msgId: string, chatJid: string, bookmarked: boolean): boolean {
    try {
      const db = this.db();
      if (bookmarked) {
        // OR IGNORE keeps the original createdAt when a message is bookmarked
        // twice, which is what the Map-and-file version did by checking first.
        db.prepare(
          'INSERT OR IGNORE INTO bookmarks (msg_id, chat_jid, created_at) VALUES (?, ?, ?)'
        ).run(msgId, chatJid, new Date().toISOString());
      } else {
        db.prepare('DELETE FROM bookmarks WHERE msg_id = ?').run(msgId);
      }
    } catch (err) {
      logger.warn('api', 'Failed to persist a bookmark', { err });
    }
    return bookmarked;
  }
}

export const bookmarkStore = new BookmarkStore();
