import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

export type ResendOutcome =
  | { ok: true; item: ScheduledMessage }
  | { ok: false; error: string };

export class Scheduler {
  private filePath: string;
  private items: Map<string, ScheduledMessage> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private eventBridge: EventBridge | null = null;
  /** Ids currently being dispatched, to prevent overlapping ticks double-sending. */
  private inFlight: Set<string> = new Set();
  private isChecking = false;

  constructor(customPath?: string, bridge?: EventBridge) {
    this.eventBridge = bridge ?? null;
    if (customPath) {
      this.filePath = customPath;
    } else if (process.env.WACLI_SCHEDULED_FILE) {
      this.filePath = process.env.WACLI_SCHEDULED_FILE;
    } else {
      let configDir = path.join(os.homedir(), '.wacli-mission-control');
      try {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        }
      } catch {
        configDir = path.join(process.cwd(), '.wacli-mission-control');
        try {
          if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
          }
        } catch {
          configDir = os.tmpdir();
        }
      }
      this.filePath = path.join(configDir, 'scheduled.json');
    }

    this.load();
  }

  public setEventBridge(bridge: EventBridge): void {
    this.eventBridge = bridge;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const list = JSON.parse(raw) as ScheduledMessage[];
        if (Array.isArray(list)) {
          let healed = 0;
          for (const item of list) {
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
        }
      }
    } catch (err) {
      logger.warn('send', 'Failed to load scheduled messages', { file: this.filePath, err });
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const list = Array.from(this.items.values());
      fs.writeFileSync(this.filePath, JSON.stringify(list, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      logger.warn('send', 'Failed to persist scheduled messages', { file: this.filePath, err });
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

        result = await execWacli<Record<string, unknown>>(args, {
          allowMutation: true,
          timeoutMs: 120000,
        });

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

        result = await execWacli<Record<string, unknown>>(args, {
          allowMutation: true,
          timeoutMs: 60000,
        });
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
