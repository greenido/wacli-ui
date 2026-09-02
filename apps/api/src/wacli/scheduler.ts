import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execWacli } from './commands.js';
import { modeManager } from './mode.js';
import { logger } from '../logger.js';
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
}

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
          for (const item of list) {
            this.items.set(item.id, item);
          }
        }
      }
    } catch (err) {
      logger.warn('send', `Failed to load scheduled messages from ${this.filePath}: ${String(err)}`);
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
      logger.warn('send', `Failed to persist scheduled messages: ${String(err)}`);
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
    logger.info('send', `Scheduled message ${id} to ${item.to} for ${item.scheduledAt}`);

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
    logger.info('send', `Cancelled scheduled message ${id}`);

    this.broadcastUpdate(item);

    return true;
  }

  public getList(chatJid?: string): ScheduledMessage[] {
    const list = Array.from(this.items.values());
    if (chatJid) {
      return list.filter((i) => i.to === chatJid);
    }
    return list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
    logger.error('send', `Scheduled message ${item.id} to ${item.to} failed: ${error}`);
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
    logger.info('send', `Executing due scheduled dispatch ${item.id} to ${item.to}`);

    try {
      let result: Record<string, unknown>;

      if (item.filePath && fs.existsSync(item.filePath)) {
        const args = ['send', 'file', '--to', item.to, '--file', item.filePath];
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
        const args = ['send', 'text', '--to', item.to, '--message', item.message];
        if (item.replyTo) {
          args.push('--reply-to', item.replyTo);
        }

        result = await execWacli<Record<string, unknown>>(args, {
          allowMutation: true,
          timeoutMs: 60000,
        });
      }

      item.status = 'sent';
      item.sentMessageId = (result?.messageId as string) || `out-${Date.now()}`;
      this.save();
      logger.info('send', `Scheduled message ${item.id} sent successfully`);

      this.broadcastUpdate(item);

      if (this.eventBridge) {
        this.eventBridge.broadcast({
          type: 'message.new',
          data: {
            chatJid: item.to,
            chatName: item.recipientName || item.to,
            msgId: item.sentMessageId,
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
