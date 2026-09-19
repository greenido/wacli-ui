import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt, resolveDbPath } from '../db/index.js';
import { activityStore } from './activity.js';
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
  /**
   * `sending` is written just before wacli is asked and replaced when it
   * answers, so a record still saying it after a restart is one whose fate
   * nobody knows.
   */
  status: 'pending' | 'sending' | 'sent' | 'cancelled' | 'failed';
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

/** One view of the queue: all of what is pending, a page of what is done. */
export interface ScheduledPage {
  pending: ScheduledMessage[];
  history: ScheduledMessage[];
  /** Pass back as `before` to continue the history. Null at the end of it. */
  nextCursor: string | null;
  totalPending: number;
  totalHistory: number;
}

/** The default history page. Ten rows is what the strip shows unscrolled. */
export const SCHEDULED_PAGE_SIZE = 10;

/** A page nobody should be able to ask past, however the query is crafted. */
const MAX_SCHEDULED_PAGE = 200;

/**
 * Sortable and comparable as one string, so a cursor is a single value.
 * The id breaks ties, since two messages can share a createdAt millisecond.
 */
function cursorFor(item: ScheduledMessage): string {
  return `${item.createdAt}|${item.id}`;
}

export type ResendOutcome =
  | { ok: true; item: ScheduledMessage }
  | { ok: false; error: string };

export type CancelOutcome = { ok: true } | { ok: false; error: string };

/**
 * Where Send-later attachments wait for their time: beside the database, in
 * Mission Control's own directory.
 *
 * They used to wait in the system temp directory, which the OS clears on
 * reboot or after a few days — so a file scheduled over a weekend was gone by
 * Monday. On Linux that was also `/tmp/wacli-scheduled-files`, a fixed name in
 * a directory every local user can write to.
 */
export function scheduledFilesDir(): string {
  return path.join(path.dirname(resolveDbPath()), 'scheduled-files');
}

/**
 * Moves an upload into the attachments directory and returns where it went.
 *
 * Only the extension survives into the name on disk. The name the recipient
 * sees travels in the record and goes to wacli as --filename, and an
 * operator's own filename can be too long to create at all.
 */
export function keepScheduledAttachment(uploadPath: string, originalName: string): string {
  const dir = scheduledFilesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const extension = path.extname(originalName).replace(/[^A-Za-z0-9.]/g, '').slice(0, 16);
  const target = path.join(dir, `${crypto.randomUUID()}${extension}`);
  try {
    fs.renameSync(uploadPath, target);
  } catch (err) {
    // The upload lands in the system temp dir, often another filesystem.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    try {
      fs.copyFileSync(uploadPath, target);
    } catch (copyErr) {
      fs.rmSync(target, { force: true });
      throw copyErr;
    }
    fs.rmSync(uploadPath, { force: true });
  }
  fs.chmodSync(target, 0o600);
  return target;
}

function missingAttachment(item: ScheduledMessage): string {
  const name = item.fileName ? `"${item.fileName}"` : 'The attachment';
  return `${name} is no longer on disk.`;
}

/** What a restart says about a message it finds still marked `sending`. */
export const INTERRUPTED_SEND =
  'Interrupted: Mission Control stopped while this was being sent, so it may or may not ' +
  'have gone out. Check the conversation before resending.';

const UPSERT_ROW = `INSERT OR REPLACE INTO scheduled
  (id, to_jid, recipient_name, message, reply_to, file_path, file_name, mime_type,
   scheduled_at, created_at, status, error, sent_message_id, resend_count, last_attempt_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

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

  /**
   * Records that the message is on its way, then sends it.
   *
   * `pending` on disk means "not sent yet", and a restart sends whatever is
   * pending and due. A crash after wacli sent but before `sent` was written
   * left exactly that, and the message went out again on the next boot. So
   * `sending` is written first, once the store is ours and just before wacli
   * is asked; if even that cannot be written, nothing is sent.
   */
  private sendClaimed(
    item: ScheduledMessage,
    args: string[],
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    return this.exclusively(async () => {
      item.status = 'sending';
      try {
        this.writeRow(item);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Not sent: could not record the send before starting it (${detail}).`, {
          cause: err,
        });
      }
      this.broadcastUpdate(item);
      return execWacli<Record<string, unknown>>(args, { allowMutation: true, timeoutMs });
    });
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
      const interrupted: string[] = [];
      for (const row of rows) {
        const item = Scheduler.fromRow(row);
        let changed = false;
        // Records written before wacli's id was read correctly carry a
        // placeholder no archive can match. Dropping it on the way in is
        // what stops every one of them answering a click with "that
        // message is not in the local archive".
        if (isSynthesisedMessageId(item.sentMessageId)) {
          delete item.sentMessageId;
          healed++;
          changed = true;
        }
        // The process stopped between asking wacli and hearing back. Back to
        // pending would send it again; failed, with the reason, leaves the
        // call to the operator.
        if (item.status === 'sending') {
          item.status = 'failed';
          item.error = INTERRUPTED_SEND;
          interrupted.push(item.id);
          changed = true;
        }
        this.items.set(item.id, item);
        if (changed) this.persist(item);
      }
      if (healed > 0) {
        logger.info('send', 'Dropped placeholder message ids from scheduled history', {
          count: healed,
        });
      }
      if (interrupted.length > 0) {
        logger.warn('send', 'Scheduled messages were interrupted mid-send; marked failed', {
          ids: interrupted.join(','),
        });
      }
    } catch (err) {
      logger.warn('send', 'Failed to load scheduled messages', { err });
    }
  }

  /**
   * Writes one record, and throws if it cannot.
   *
   * One row at a time. The whole map used to be rewritten in one transaction,
   * so a single record the table refused rolled back every save after it —
   * logged as a warning, and the queue on disk simply stopped changing. It
   * also deleted every row this process did not hold, so a second console on
   * the same file erased the first one's queue.
   */
  private writeRow(item: ScheduledMessage): void {
    this.db()
      .prepare(UPSERT_ROW)
      .run(
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

  /** Writes one record where carrying on without the write is still correct. */
  private persist(item: ScheduledMessage): void {
    try {
      this.writeRow(item);
    } catch (err) {
      logger.warn('send', 'Failed to persist a scheduled message', { id: item.id, err });
    }
  }

  private deleteRow(id: string): void {
    try {
      this.db().prepare('DELETE FROM scheduled WHERE id = ?').run(id);
    } catch (err) {
      logger.warn('send', 'Failed to delete a scheduled message', { id, err });
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

    // On disk before it is in the queue: a message that cannot be stored is
    // refused now, where the operator sees it, rather than kept only in memory
    // and lost at the next restart.
    this.writeRow(item);
    this.items.set(id, item);
    logger.info('send', 'Message scheduled', { id, to: item.to, scheduledAt: item.scheduledAt });

    this.broadcastUpdate(item);

    return item;
  }

  /**
   * Stops a pending message from going out, unless it already is.
   *
   * A message mid-dispatch still reads "pending": its status changes only once
   * wacli answers. So this used to cancel it, answer "cancelled", and then
   * watch the dispatch overwrite the record with "sent" as the message
   * reached the recipient. The in-flight set is the one thing that knows.
   */
  public cancel(id: string): CancelOutcome {
    this.ensureLoaded();
    const item = this.items.get(id);
    if (!item) {
      return { ok: false, error: 'Scheduled message not found.' };
    }

    if (this.inFlight.has(id)) {
      return { ok: false, error: 'Too late to cancel: this message is already being sent.' };
    }

    if (item.status !== 'pending') {
      return {
        ok: false,
        error: `Only a pending message can be cancelled; this one is already "${item.status}".`,
      };
    }

    item.status = 'cancelled';
    try {
      this.writeRow(item);
    } catch (err) {
      // Still pending on disk, so the next restart would send it. Refuse,
      // rather than report a cancel that would not survive one.
      item.status = 'pending';
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not record the cancellation, so the message is still scheduled: ${detail}`, {
        cause: err,
      });
    }
    // Nothing will ever send it now, and a private file should not outlive its
    // message. It used to sit in the temp directory until the OS cleared it.
    this.removeAttachment(item);
    logger.info('send', 'Scheduled message cancelled', { id });

    this.broadcastUpdate(item);

    return { ok: true };
  }

  private removeAttachment(item: ScheduledMessage): void {
    if (!item.filePath) return;
    try {
      fs.rmSync(item.filePath, { force: true });
    } catch (err) {
      logger.warn('send', 'Could not delete a scheduled attachment', { id: item.id, err });
    }
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

    if (item.filePath && !fs.existsSync(item.filePath)) {
      return { ok: false, error: `${missingAttachment(item)} Discard it and send the file again.` };
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
    this.persist(item);
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

    // dispatch() only deletes an attachment after a successful send, so a
    // failed file message still owns its file. This is the last owner of that
    // path; if we drop the record without it, the file leaks.
    this.removeAttachment(item);

    this.items.delete(id);
    this.deleteRow(id);
    logger.info('send', 'Failed scheduled message discarded', { id });
    this.broadcastUpdate(item);

    return true;
  }

  /**
   * The queue as the strip shows it: everything still pending, then a page of
   * what has already resolved.
   *
   * Pending is never paged. There are only ever a handful, and a queue that
   * hides what is about to go out because it fell past row ten is a queue the
   * operator cannot trust. Only the finished tail — sent, cancelled, failed —
   * is worth asking for ten at a time.
   *
   * This pages the in-memory map rather than issuing a LIMIT, because the map
   * is already the scheduler's working set and has to be complete for the tick
   * regardless. The table is what makes it durable, not what makes it readable.
   */
  public getPage(opts: { chat?: string; limit?: number; before?: string } = {}): ScheduledPage {
    this.ensureLoaded();
    const limit = Math.min(Math.max(1, opts.limit ?? SCHEDULED_PAGE_SIZE), MAX_SCHEDULED_PAGE);

    const all = Array.from(this.items.values())
      .filter((item) => !opts.chat || item.to === opts.chat)
      .map((item) => this.decorate(item));

    // Soonest first: this is a queue of what happens next, not a history. A
    // message on its way out has not finished, so it stays here until it has.
    const isOpen = (i: ScheduledMessage) => i.status === 'pending' || i.status === 'sending';
    const pending = all
      .filter(isOpen)
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());

    const finished = all
      .filter((i) => !isOpen(i))
      .sort((a, b) => cursorFor(b).localeCompare(cursorFor(a)));

    // A cursor rather than an offset: a message resolving mid-scroll shifts
    // every offset by one and would show the operator the same row twice.
    const start = opts.before ? finished.findIndex((i) => cursorFor(i) < opts.before!) : 0;
    const from = start === -1 ? finished.length : start;
    const page = finished.slice(from, from + limit);
    const last = page[page.length - 1];

    return {
      pending,
      history: page,
      nextCursor: from + limit < finished.length && last ? cursorFor(last) : null,
      totalPending: pending.length,
      totalHistory: finished.length,
    };
  }

  /**
   * Copies an item for the wire and answers the one question the operator
   * cannot see from the UI: is the attachment still there? A file message
   * whose file has gone cannot be resent, and the resend dialog has to say so
   * before the operator tries. Only failed items are stat'd, so the poll stays
   * cheap.
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
    this.persist(item);
    logger.error('send', 'Scheduled message failed', { id: item.id, to: item.to, reason: error });
    this.recordActivity(item, 'error', error);
    this.broadcastUpdate(item);
  }

  /**
   * Puts a dispatch on the activity log.
   *
   * This is the half the browser could never record: a due message fires on a
   * timer whether or not a console is open, so the sends least likely to be
   * watched were exactly the ones the old in-memory log never saw.
   */
  private recordActivity(item: ScheduledMessage, status: 'success' | 'error', error?: string): void {
    activityStore.record({
      to: item.to,
      chatName: item.recipientName,
      message: item.message || item.fileName || '',
      status,
      error,
      messageId: item.sentMessageId,
    });
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

    // A file message without its file is not a text message. This used to
    // send the caption alone and log it as sent: "Here is the signed
    // contract", without the contract.
    if (item.filePath && !fs.existsSync(item.filePath)) {
      this.fail(item, `${missingAttachment(item)} Nothing was sent.`);
      return;
    }

    try {
      let result: Record<string, unknown>;

      if (item.filePath) {
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

        result = await this.sendClaimed(item, args, 120000);

        this.removeAttachment(item);
      } else {
        const args = ['send', 'text', '--to', item.to, '--message', item.message, '--post-send-wait', POST_SEND_WAIT];
        if (item.replyTo) {
          args.push('--reply-to', item.replyTo);
        }

        result = await this.sendClaimed(item, args, 60000);
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
      // If this write fails the row still says `sending`, and the next restart
      // reports it as possibly sent — never as pending.
      this.persist(item);
      logger.info('send', 'Scheduled message sent', { id: item.id });

      this.recordActivity(item, 'success');
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
