import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
 */
export class TagStore {
  private filePath: string;
  private byJid: Map<string, string[]> = new Map();

  constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else if (process.env.WACLI_TAGS_FILE) {
      this.filePath = process.env.WACLI_TAGS_FILE;
    } else {
      let configDir = path.join(os.homedir(), '.wacli-mission-control');
      try {
        if (!fs.existsSync(configDir)) {
          fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        }
      } catch {
        configDir = os.tmpdir();
      }
      this.filePath = path.join(configDir, 'tags.json');
    }

    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

      for (const [jid, tags] of Object.entries(parsed)) {
        if (!Array.isArray(tags)) continue;
        const clean = this.clean(tags.filter((t): t is string => typeof t === 'string'));
        if (clean.length > 0) this.byJid.set(jid, clean);
      }
    } catch (err) {
      logger.warn('api', 'Failed to load tags', { file: this.filePath, err });
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(this.byJid), null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch (err) {
      logger.warn('api', 'Failed to persist tags', { file: this.filePath, err });
    }
  }

  private clean(tags: string[]): string[] {
    const seen = new Set<string>();
    for (const tag of tags) {
      const normalized = normalizeTag(tag);
      if (normalized) seen.add(normalized);
    }
    return Array.from(seen).sort();
  }

  public get(jid: string): string[] {
    return this.byJid.get(jid) ?? [];
  }

  /** Every tag in use, for the rail's filter row. */
  public allTags(): string[] {
    const seen = new Set<string>();
    for (const tags of this.byJid.values()) {
      for (const tag of tags) seen.add(tag);
    }
    return Array.from(seen).sort();
  }

  public all(): Record<string, string[]> {
    return Object.fromEntries(this.byJid);
  }

  public add(jid: string, tag: string): string[] {
    const normalized = normalizeTag(tag);
    if (!normalized) return this.get(jid);

    const next = this.clean([...this.get(jid), normalized]);
    this.byJid.set(jid, next);
    this.save();
    return next;
  }

  /** How many chats carry a tag — the blast radius of renaming or deleting it. */
  public countFor(tag: string): number {
    const normalized = normalizeTag(tag);
    if (!normalized) return 0;

    let count = 0;
    for (const tags of this.byJid.values()) {
      if (tags.includes(normalized)) count += 1;
    }
    return count;
  }

  /**
   * Renames a tag on every chat carrying it, so a vocabulary that drifted can
   * be corrected in one place instead of chat by chat.
   *
   * Renaming onto a name already in use merges the two: `clean` dedupes, so a
   * chat that held both ends up with one chip rather than a doubled one. That
   * is a decision, not a detail — the caller confirms it first, and the
   * returned `merged` flag says whether it happened.
   */
  public rename(from: string, to: string): { renamed: number; merged: boolean } {
    const before = normalizeTag(from);
    const after = normalizeTag(to);
    if (!before || !after || before === after) return { renamed: 0, merged: false };

    // Read before the write: afterwards every renamed chat carries `after` and
    // the question of whether it pre-existed can no longer be asked.
    const merged = this.allTags().includes(after);
    let renamed = 0;

    for (const [jid, tags] of [...this.byJid]) {
      if (!tags.includes(before)) continue;
      this.byJid.set(jid, this.clean([...tags.filter((t) => t !== before), after]));
      renamed += 1;
    }

    if (renamed > 0) this.save();
    return { renamed, merged };
  }

  /** Drops a tag from every chat carrying it. Returns how many were touched. */
  public deleteTag(tag: string): number {
    const normalized = normalizeTag(tag);
    if (!normalized) return 0;

    let removed = 0;
    for (const [jid, tags] of [...this.byJid]) {
      if (!tags.includes(normalized)) continue;

      const next = tags.filter((t) => t !== normalized);
      if (next.length > 0) {
        this.byJid.set(jid, next);
      } else {
        // Same reasoning as remove(): absence says what an empty array says.
        this.byJid.delete(jid);
      }
      removed += 1;
    }

    if (removed > 0) this.save();
    return removed;
  }

  public remove(jid: string, tag: string): string[] {
    const normalized = normalizeTag(tag);
    const next = this.get(jid).filter((t) => t !== normalized);

    if (next.length > 0) {
      this.byJid.set(jid, next);
    } else {
      // An empty array is noise in the file; absence says the same thing.
      this.byJid.delete(jid);
    }
    this.save();
    return next;
  }
}

export const tagStore = new TagStore();
