import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { logger } from '../logger.js';

export interface ActivityEntry {
  id: string;
  timestamp: string;
  to: string;
  chatName?: string;
  message: string;
  status: 'pending' | 'success' | 'error';
  error?: string;
  /**
   * WhatsApp's id for the message this send produced, once the server reports
   * one. It is what lets an ACTIVITY row focus the message it logged instead of
   * only opening the conversation.
   */
  messageId?: string;
}

interface ActivityRow {
  id: string;
  timestamp: string;
  to_jid: string;
  chat_name: string | null;
  message: string;
  status: string;
  error: string | null;
  message_id: string | null;
}

/** One page of history, newest first, plus the cursor for the page after it. */
export interface ActivityPage {
  items: ActivityEntry[];
  /** Pass back as `before` to continue. Null when the last row is included. */
  nextCursor: string | null;
  /** Everything on record, for the tab's count. */
  total: number;
}

/** The default page. Ten rows is what the strip shows without scrolling. */
export const ACTIVITY_PAGE_SIZE = 10;

/** A page nobody should be able to ask past, however the query is crafted. */
const MAX_PAGE_SIZE = 200;

/**
 * How long a send stays on the record.
 *
 * These rows carry chat JIDs and message bodies, so they expire on the same
 * principle the run logs do — just over a longer window, because the activity
 * log is something the operator reads back rather than a diagnostic.
 */
export const ACTIVITY_RETENTION_DAYS = 90;

/**
 * The send audit stream.
 *
 * This used to live in the browser's own memory, which meant it was gone on
 * refresh, different in every tab, and blind to any scheduled message that
 * fired while no console was open — the sends least likely to be watched were
 * the ones least likely to be recorded. Writing it here from the routes that
 * actually dispatch is what makes it an audit trail rather than a session note.
 */
export class ActivityStore {
  /** Set only when a caller asked for its own file, so tests get one store per case. */
  private ownDb: DatabaseSync | null = null;

  constructor(customDbPath?: string) {
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  private static fromRow(row: ActivityRow): ActivityEntry {
    const opt = (v: string | null): string | undefined => v ?? undefined;
    return {
      id: row.id,
      timestamp: row.timestamp,
      to: row.to_jid,
      chatName: opt(row.chat_name),
      message: row.message,
      status: row.status as ActivityEntry['status'],
      error: opt(row.error),
      messageId: opt(row.message_id),
    };
  }

  /** Records a send in flight. Returns the id to settle it with. */
  public record(entry: Omit<ActivityEntry, 'id' | 'timestamp'> & { timestamp?: string }): string {
    const id = `send-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = entry.timestamp ?? new Date().toISOString();

    try {
      this.db()
        .prepare(
          `INSERT INTO activity (id, timestamp, to_jid, chat_name, message, status, error, message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          timestamp,
          entry.to,
          entry.chatName ?? null,
          entry.message,
          entry.status,
          entry.error ?? null,
          entry.messageId ?? null
        );
    } catch (err) {
      // A send that went out must not be undone by a log write that did not.
      logger.warn('send', 'Failed to record a send in the activity log', { err });
    }
    return id;
  }

  /** Settles a recorded send: succeeded, failed, and with which message id. */
  public settle(
    id: string,
    update: Partial<Pick<ActivityEntry, 'status' | 'error' | 'messageId'>>
  ): void {
    const sets: string[] = [];
    const values: Array<string | null> = [];

    if (update.status !== undefined) {
      sets.push('status = ?');
      values.push(update.status);
    }
    if (update.error !== undefined) {
      sets.push('error = ?');
      values.push(update.error);
    }
    if (update.messageId !== undefined) {
      sets.push('message_id = ?');
      values.push(update.messageId);
    }
    if (sets.length === 0) return;

    try {
      this.db()
        .prepare(`UPDATE activity SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id);
    } catch (err) {
      logger.warn('send', 'Failed to settle an activity log entry', { err });
    }
  }

  /**
   * One page, newest first.
   *
   * `before` is the previous page's oldest timestamp, not an offset: a send
   * landing while the operator scrolls shifts every offset by one and would
   * otherwise make them read the same row twice. Ties are broken on id so two
   * sends in the same millisecond cannot hide each other.
   */
  public list(opts: { limit?: number; before?: string } = {}): ActivityPage {
    const limit = Math.min(Math.max(1, opts.limit ?? ACTIVITY_PAGE_SIZE), MAX_PAGE_SIZE);

    try {
      const db = this.db();
      const total = (db.prepare('SELECT COUNT(*) AS n FROM activity').get() as { n: number }).n;

      // One row past the page, to answer "is there more" without a second query.
      const rows = (
        opts.before
          ? db
              .prepare(
                `SELECT * FROM activity
                 WHERE timestamp < ? OR (timestamp = ? AND id < ?)
                 ORDER BY timestamp DESC, id DESC LIMIT ?`
              )
              .all(cursorTime(opts.before), cursorTime(opts.before), cursorId(opts.before), limit + 1)
          : db
              .prepare('SELECT * FROM activity ORDER BY timestamp DESC, id DESC LIMIT ?')
              .all(limit + 1)
      ) as unknown as ActivityRow[];

      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(ActivityStore.fromRow),
        nextCursor: rows.length > limit && last ? `${last.timestamp}|${last.id}` : null,
        total,
      };
    } catch (err) {
      logger.warn('send', 'Failed to read the activity log', { err });
      return { items: [], nextCursor: null, total: 0 };
    }
  }

  /**
   * Drops rows past the retention window. Returns how many went.
   *
   * Called at startup rather than on a timer: a console left open for a month
   * is not the case worth a background job, and a restart is when the operator
   * can see the count in the log.
   */
  public prune(retentionDays = ACTIVITY_RETENTION_DAYS): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    try {
      const removed = Number(
        this.db().prepare('DELETE FROM activity WHERE timestamp < ?').run(cutoff).changes
      );
      if (removed > 0) {
        logger.info('send', 'Expired old activity log entries', { removed, retentionDays });
      }
      return removed;
    } catch (err) {
      logger.warn('send', 'Failed to prune the activity log', { err });
      return 0;
    }
  }
}

/** A cursor is `<timestamp>|<id>`; splitting on the last bar keeps both whole. */
function cursorTime(cursor: string): string {
  const bar = cursor.lastIndexOf('|');
  return bar === -1 ? cursor : cursor.slice(0, bar);
}

function cursorId(cursor: string): string {
  const bar = cursor.lastIndexOf('|');
  return bar === -1 ? '' : cursor.slice(bar + 1);
}

export const activityStore = new ActivityStore();
