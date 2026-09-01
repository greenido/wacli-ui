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

    if (this.eventBridge) {
      this.eventBridge.broadcast({
        type: 'scheduled.update',
        data: item,
        ts: new Date().toISOString(),
      });
    }

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

    if (this.eventBridge) {
      this.eventBridge.broadcast({
        type: 'scheduled.update',
        data: item,
        ts: new Date().toISOString(),
      });
    }

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
    const now = Date.now();
    for (const item of this.items.values()) {
      if (item.status !== 'pending') continue;

      const dueTime = new Date(item.scheduledAt).getTime();
      if (dueTime <= now) {
        await this.dispatch(item);
      }
    }
  }

  private async dispatch(item: ScheduledMessage): Promise<void> {
    logger.info('send', `Executing due scheduled dispatch ${item.id} to ${item.to}`);

    try {
      // If safe mode is engaged, unlock for scheduled execution
      if (modeManager.isReadOnly()) {
        modeManager.setReadOnly(false);
      }

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

      if (this.eventBridge) {
        this.eventBridge.broadcast({
          type: 'scheduled.update',
          data: item,
          ts: new Date().toISOString(),
        });
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
            edited: false,
            revoked: false,
            deliveryStatus: 'sent',
          },
          ts: new Date().toISOString(),
        });
      }
    } catch (err: unknown) {
      item.status = 'failed';
      item.error = err instanceof Error ? err.message : String(err);
      this.save();
      logger.error('send', `Scheduled message ${item.id} failed: ${item.error}`);

      if (this.eventBridge) {
        this.eventBridge.broadcast({
          type: 'scheduled.update',
          data: item,
          ts: new Date().toISOString(),
        });
      }
    }
  }
}

export const scheduler = new Scheduler();
