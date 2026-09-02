import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  private filePath: string;
  private items: Map<string, Bookmark> = new Map();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else if (process.env.WACLI_BOOKMARKS_FILE) {
      this.filePath = process.env.WACLI_BOOKMARKS_FILE;
    } else {
      let configDir = path.join(os.homedir(), '.wacli-mission-control');
      try {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        }
      } catch {
        configDir = os.tmpdir();
      }
      this.filePath = path.join(configDir, 'bookmarks.json');
    }

    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Bookmark[];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && typeof item.msgId === 'string') {
            this.items.set(item.msgId, item);
          }
        }
      }
    } catch (err) {
      logger.warn('api', `Failed to load bookmarks from ${this.filePath}: ${String(err)}`);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(Array.from(this.items.values()), null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      logger.warn('api', `Failed to persist bookmarks: ${String(err)}`);
    }
  }

  public has(msgId: string): boolean {
    return this.items.has(msgId);
  }

  public set(msgId: string, chatJid: string, bookmarked: boolean): boolean {
    if (bookmarked) {
      if (!this.items.has(msgId)) {
        this.items.set(msgId, { msgId, chatJid, createdAt: new Date().toISOString() });
        this.save();
      }
    } else if (this.items.delete(msgId)) {
      this.save();
    }
    return bookmarked;
  }
}

export const bookmarkStore = new BookmarkStore();
