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
      logger.warn('api', `Failed to load tags from ${this.filePath}: ${String(err)}`);
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
      logger.warn('api', `Failed to persist tags: ${String(err)}`);
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
