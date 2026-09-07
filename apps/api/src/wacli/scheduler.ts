import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { execWacli, POST_SEND_WAIT } from './commands.js';
import { modeManager } from './mode.js';
import { logger } from '../logger.js';
import { isSynthesisedMessageId, sentMessageIdFrom } from './normalize.js';
import type { EventBridge } from '../ws/event-bridge.js';

export interface ScheduledMessage {
  id: string;
  to: string;
  recipientName?: string;
  message: string;
  replyTo?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  scheduledAt: string;
  createdAt: string;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  error?: string;
  sentMessageId?: string;
  /** How many times the operator has manually resent this after a failure. */
  resendCount?: number;
  /** When the last manual resend was requested, for the "tried 2m ago" line. */
  lastAttemptAt?: string;
  /**
   * Derived on read, never persisted: the attachment for a failed file message
   * is gone from disk, so a resend would go out as plain text.
   */
  attachmentMissing?: boolean;
}

/** The `scheduled` table's own shape, snake_case as stored. */
interface ScheduledRow {
  id: string;
  to_jid: string;
  recipient_name: string | null;
  message: string;
  reply_to: string | null;
  file_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  scheduled_at: string;
  created_at: string;
  status: string;
  error: string | null;
  sent_message_id: string | null;
  resend_count: number | null;
  last_attempt_at: string | null;
}

export type ResendOutcome =
  | { ok: true; item: ScheduledMessage }
  | { ok: false; error: string };

/** The one thing the scheduler needs from the process manager. */
export interface ExclusiveRunner {
  executeExclusive<T>(action: () => Promise<T>): Promise<T>;
}

export class Scheduler {
  /**
   * Set only when a caller asked for its own file, so tests get one store per
   * case. Otherwise the process-wide handle, resolved per use.
   */
  private ownDb: DatabaseSync | null = null;
  /**
   * The whole queue, in memory.
   *
   * This is not a cache — the 3s tick, the in-flight set and the resend path
   * all work against it, and a due message has to be found without a query per
   * beat. The table is the durable copy; the map is the working set, and the
   * two are written together.
   */
  private items: Map<string, ScheduledMessage> = new Map();
  private hydrated = false;
  private timer: NodeJS.Timeout | null = null;
  private eventBridge: EventBridge | null = null;
  private exclusiveRunner: ExclusiveRunner | null = null;
  /** Ids currently being dispatched, to prevent overlapping ticks double-sending. */
  private inFlight: Set<string> = new Set();
  private isChecking = false;

  constructor(customDbPath?: string, bridge?: EventBridge) {
    this.eventBridge = bridge ?? null;
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  /**
   * Fills the map from the table, once, on first use rather than in the
   * constructor.
   *
   * This is a module singleton: constructing it eagerly would read the table at
   * import time, which on a first boot is *before* the legacy JSON has been
   * migrated into it. The queue would come up empty, and stay empty until the
   * next restart — with 91 records sitting in the table it had already decided
   * were not there.
   */
  private ensureLoaded(): void {
    if (this.hydrated) return;
    this.hydrated = true;
    this.load();
  }

  public setEventBridge(bridge: EventBridge): void {
    this.eventBridge = bridge;
  }

  public setExclusiveRunner(runner: ExclusiveRunner): void {
    this.exclusiveRunner = runner;
  }

  /**
   * Runs a send with the store to itself.
   *
   * A due message dispatches on a 3s timer, which means it almost always fires
   * while the sync daemon is up and holding the store lock — and the daemon
   * never releases it between polls, so the send simply fails. Pausing the
   * daemon around the send is what makes it land, the same as for the
   * interactive routes. Left unset the action runs as-is, which is what the
   * scheduler tests want.
   */
  private async exclusively<T>(action: () => Promise<T>): Promise<T> {
    if (!this.exclusiveRunner) return action();
    return this.exclusiveRunner.executeExclusive(action);
  }

  /** A stored row, back in the shape the rest of this file works in. */
  private static fromRow(row: ScheduledRow): ScheduledMessage {
    const opt = (v: string | null): string | undefined => v ?? undefined;
    return {
      id: row.id,
      to: row.to_jid,
      recipientName: opt(row.recipient_name),
      message: row.message,
      replyTo: opt(row.reply_to),
      filePath: opt(row.file_path),
      fileName: opt(row.file_name),
      mimeType: opt(row.mime_type),
      scheduledAt: row.scheduled_at,
      createdAt: row.created_at,
      status: row.status as ScheduledMessage['status'],
      error: opt(row.error),
      sentMessageId: opt(row.sent_message_id),
      resendCount: row.resend_count ?? undefined,
      lastAttemptAt: opt(row.last_attempt_at),
    };
  }

  private load(): void {
    try {
      const rows = this.db().prepare('SELECT * FROM scheduled').all() as unknown as ScheduledRow[];
      let healed = 0;
      for (const row of rows) {
        const item = Scheduler.fromRow(row);
        // Records written before wacli's id was read correctly carry a
        // placeholder no archive can match. Dropping it on the way in is
        // what stops every one of them answering a click with "that
        // message is not in the local archive".
        if (isSynthesisedMessageId(item.sentMessageId)) {
          delete item.sentMessageId;
          healed++;
        }
        this.items.set(item.id, item);
      }
      if (healed > 0) {
        logger.info('send', 'Dropped placeholder message ids from scheduled history', {
          count: healed,
        });
        this.save();
      }
    } catch (err) {
      logger.warn('send', 'Failed to load scheduled messages', { err });
    }
  }

  /**
   * Writes the map back to the table.
   *
   * Still whole-set rather than per-row, because the callers that reach here
   * mutate an item in place and then say "persist" without naming it. The
   * difference from the file it replaces is that this is a transaction over an
   * indexed table rather than a re-serialisation of every record — and a
   * partial write can no longer truncate the queue to nothing.
   */
  private save(): void {
    try {
      const db = this.db();
      const upsert = db.prepare(
        `INSERT OR REPLACE INTO scheduled
           (id, to_jid, recipient_name, message, reply_to, file_path, file_name, mime_type,
            scheduled_at, created_at, status, error, sent_message_id, resend_count, last_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      db.exec('BEGIN');
      try {
        for (const item of this.items.values()) {
          upsert.run(
            item.id,
            item.to,
            item.recipientName ?? null,
            item.message,
            item.replyTo ?? null,
            item.filePath ?? null,
            item.fileName ?? null,
            item.mimeType ?? null,
            item.scheduledAt,
            item.createdAt,
            item.status,
            item.error ?? null,
            item.sentMessageId ?? null,
            item.resendCount ?? null,
            item.lastAttemptAt ?? null
          );
        }
        // discard() drops an item from the map; this is what makes that reach
        // the table. Deleting by "not in the map" rather than by id keeps save()
        // callers from having to say what they removed.
        const ids = [...this.items.keys()];
        const placeholders = ids.map(() => '?').join(', ');
        db.prepare(
          ids.length
            ? `DELETE FROM scheduled WHERE id NOT IN (${placeholders})`
            : 'DELETE FROM scheduled'
        ).run(...ids);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      logger.warn('send', 'Failed to persist scheduled messages', { err });
    }
  }

  public schedule(params: {
    to: string;
    recipientName?: string;
    message: string;
    replyTo?: string;
    filePath?: string;
    fileName?: string;
    mimeType?: string;
    scheduledAt: string;
  }): ScheduledMessage {
    this.ensureLoaded();
    const id = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const item: ScheduledMessage = {
      id,
      to: params.to,
      recipientName: params.recipientName,
      message: params.message,
      replyTo: params.replyTo,
      filePath: params.filePath,
      fileName: params.fileName,
      mimeType: params.mimeType,
      scheduledAt: params.scheduledAt,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    this.items.set(id, item);
    this.save();
    logger.info('send', 'Message scheduled', { id, to: item.to, scheduledAt: item.scheduledAt });

    this.broadcastUpdate(item);

    return item;
  }

  public cancel(id: string): boolean {
    this.ensureLoaded();
    const item = this.items.get(id);
    if (!item || item.status !== 'pending') {
      return false;
    }

    item.status = 'cancelled';
    this.save();
    logger.info('send', 'Scheduled message cancelled', { id });

    this.broadcastUpdate(item);

    return true;
  }

  /**
   * Puts a failed message back in the queue, either immediately or at a new
   * time. Reuses the same record rather than creating a second one, which is
   * what makes a double send impossible: 'failed' is the only status this will
   * act on, and the record leaves that status synchronously below, so a second
   * click, a duplicated request, or a tick firing mid-flight all find a record
   * that no longer qualifies and are turned away before reaching wacli.
   */
  public async resend(id: string, opts: { scheduledAt?: string } = {}): Promise<ResendOutcome> {
    this.ensureLoaded();
    const item = this.items.get(id);
    if (!item) {
      return { ok: false, error: 'Scheduled message not found.' };
    }

    if (this.inFlight.has(id)) {
      return { ok: false, error: 'This message is being sent right now. Wait for it to finish.' };
    }

    if (item.status !== 'failed') {
      return {
        ok: false,
        error: `Only a failed message can be resent; this one is already "${item.status}".`,
      };
    }

    if (modeManager.isReadOnly()) {
      return {
        ok: false,
        error: 'Safe read-only mode is active. Unlock live sends before resending.',
      };
    }

    const sendNow = opts.scheduledAt === undefined;
    let dueAt: string;
    if (sendNow) {
      dueAt = new Date().toISOString();
    } else {
      const parsed = new Date(opts.scheduledAt as string).getTime();
      if (Number.isNaN(parsed)) {
        return { ok: false, error: `Invalid scheduledAt value: ${opts.scheduledAt}` };
      }
      dueAt = new Date(parsed).toISOString();
    }

    // Claim the record before the first await. Everything from here to the
    // dispatch call is synchronous on purpose, so no tick and no second request
    // can observe this message as loose pending work in between.
    if (sendNow) {
      this.inFlight.add(id);
    }
    item.status = 'pending';
    delete item.error;
    item.scheduledAt = dueAt;
    item.resendCount = (item.resendCount ?? 0) + 1;
    item.lastAttemptAt = new Date().toISOString();
    this.save();
    this.broadcastUpdate(item);

    if (!sendNow) {
      logger.info('send', 'Failed message requeued', { id, to: item.to, dueAt });
      return { ok: true, item: this.decorate(item) };
    }

    logger.info('send', 'Operator resend', { id, to: item.to, resendCount: item.resendCount });
    try {
      await this.dispatch(item);
    } finally {
      this.inFlight.delete(id);
    }

    return { ok: true, item: this.decorate(item) };
  }

  /**
   * Drops a failed message the operator has given up on. Restricted to failed
   * records: deleting anything with a live dispatch behind it would leave that
   * dispatch writing back into a record that no longer exists.
   */
  public discard(id: string): boolean {
    this.ensureLoaded();
    const item = this.items.get(id);
    if (!item || item.status !== 'failed' || this.inFlight.has(id)) {
      return false;
    }

    // dispatch() only unlinks an attachment after a successful send, so a
    // failed file message still owns its temp file. This is the last owner of
    // that path; if we drop the record without it, the file leaks.
    if (item.filePath) {
      try {
        fs.unlinkSync(item.filePath);
      } catch {
        // Already gone, or never made it to disk.
      }
    }

    this.items.delete(id);
    this.save();
    logger.info('send', 'Failed scheduled message discarded', { id });
    this.broadcastUpdate(item);

    return true;
  }

  public getList(chatJid?: string): ScheduledMessage[] {
    this.ensureLoaded();
    const list = Array.from(this.items.values()).map((item) => this.decorate(item));
    if (chatJid) {
      return list.filter((i) => i.to === chatJid);
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Copies an item for the wire and answers the one question the operator
   * cannot see from the UI: is the attachment still there? dispatch() silently
   * falls back to a plain text send when the file has gone, so the resend
   * confirmation has to be able to say that out loud rather than promise a file
   * it will not send. Only failed items are stat'd, so the poll stays cheap.
   */
  private decorate(item: ScheduledMessage): ScheduledMessage {
    if (item.status !== 'failed' || !item.filePath) {
      return { ...item };
    }
    return { ...item, attachmentMissing: !fs.existsSync(item.filePath) };
  }

  public start(intervalMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkDueMessages();
    }, intervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public async checkDueMessages(): Promise<void> {
    this.ensureLoaded();
    // A send can take up to two minutes while the 3s timer keeps firing. Without
    // this guard a slow dispatch is re-entered and the message goes out twice.
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      const now = Date.now();
      for (const item of this.items.values()) {
        if (item.status !== 'pending') continue;
        if (this.inFlight.has(item.id)) continue;

        const dueTime = new Date(item.scheduledAt).getTime();
        if (Number.isNaN(dueTime)) {
          this.fail(item, `Invalid scheduledAt value: ${item.scheduledAt}`);
          continue;
        }

        if (dueTime <= now) {
          if (modeManager.isReadOnly()) {
            this.fail(
              item,
              'Not sent: safe read-only mode was active when this message came due. Unlock live sends and reschedule.'
            );
            continue;
          }
          this.inFlight.add(item.id);
          try {
            await this.dispatch(item);
          } finally {
            this.inFlight.delete(item.id);
          }
        }
      }
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * Marks a due message failed and says so everywhere the operator might be
   * looking: the log, the persisted record, and the live scheduled list. A
   * message that silently does not go out is worse than one that visibly fails.
   */
  private fail(item: ScheduledMessage, error: string): void {
    item.status = 'failed';
    item.error = error;
    this.save();
    logger.error('send', 'Scheduled message failed', { id: item.id, to: item.to, reason: error });
    this.broadcastUpdate(item);
  }

  private broadcastUpdate(item: ScheduledMessage): void {
    if (!this.eventBridge) return;
    this.eventBridge.broadcast({
      type: 'scheduled.update',
      data: item,
      ts: new Date().toISOString(),
    });
  }

  private async dispatch(item: ScheduledMessage): Promise<void> {
    logger.info('send', 'Dispatching due scheduled message', { id: item.id, to: item.to });

    try {
      let result: Record<string, unknown>;

      if (item.filePath && fs.existsSync(item.filePath)) {
        const args = ['send', 'file', '--to', item.to, '--file', item.filePath, '--post-send-wait', POST_SEND_WAIT];
        if (item.fileName) {
          args.push('--filename', item.fileName);
        }
        if (item.message) {
          args.push('--caption', item.message);
        }
        if (item.replyTo) {
          args.push('--reply-to', item.replyTo);
        }

        result = await this.exclusively(() =>
          execWacli<Record<string, unknown>>(args, {
            allowMutation: true,
            timeoutMs: 120000,
          })
        );

        // Clean up scheduled attachment file
        try {
          fs.unlinkSync(item.filePath);
        } catch {
          // ignore
        }
      } else {
        const args = ['send', 'text', '--to', item.to, '--message', item.message, '--post-send-wait', POST_SEND_WAIT];
        if (item.replyTo) {
          args.push('--reply-to', item.replyTo);
        }

        result = await this.exclusively(() =>
          execWacli<Record<string, unknown>>(args, {
            allowMutation: true,
            timeoutMs: 60000,
          })
        );
      }

      item.status = 'sent';
      // Only a real WhatsApp ID goes on the record. The old fallback stamped
      // every sent item with `out-<now>`, so clicking the row in LATER asked
      // the thread to focus an ID the archive could never hold — and the
      // operator was told the message was not in the local archive when it
      // plainly was. No ID is better than an invented one: the thread then
      // just opens the conversation.
      const sentId = sentMessageIdFrom(result);
      if (sentId) {
        item.sentMessageId = sentId;
      }
      this.save();
      logger.info('send', 'Scheduled message sent', { id: item.id });

      this.broadcastUpdate(item);

      if (this.eventBridge) {
        this.eventBridge.broadcast({
          type: 'message.new',
          data: {
            chatJid: item.to,
            chatName: item.recipientName || item.to,
            // The optimistic bubble needs some key; when wacli reported no ID
            // a local one keeps React from collapsing rows, and the next
            // refetch replaces it with the archive's own row.
            msgId: sentId ?? `out-${item.id}`,
            senderJid: '',
            senderName: 'Me',
            ts: new Date().toISOString(),
            fromMe: true,
            text: item.message,
            displayText: item.message,
            isForwarded: false,
            reactionToId: null,
            reactionEmoji: null,
            mediaType: item.filePath ? 'document' : null,
            mediaCaption: item.message || null,
            filename: item.fileName || null,
            mimeType: item.mimeType || null,
            localPath: null,
            starred: false,
            bookmarked: false,
            edited: false,
            revoked: false,
            deliveryStatus: 'sent',
          },
          ts: new Date().toISOString(),
        });
      }
    } catch (err: unknown) {
      this.fail(item, err instanceof Error ? err.message : String(err));
    }
  }
}

export const scheduler = new Scheduler();
