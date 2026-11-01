import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BookmarkStore } from '../wacli/bookmarks.js';
import { DatabaseUnavailableError, openDatabaseAt } from '../db/index.js';

describe('BookmarkStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-bookmarks-'));
    file = path.join(dir, 'bookmarks.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a restart, which the in-memory star map never did', () => {
    const first = new BookmarkStore(file);
    first.set('MSG-1', 'alice@s.whatsapp.net', true);

    const second = new BookmarkStore(file);
    expect(second.has('MSG-1')).toBe(true);
  });

  it('removes a bookmark and keeps the removal', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);
    store.set('MSG-1', 'alice@s.whatsapp.net', false);

    expect(store.has('MSG-1')).toBe(false);
    expect(new BookmarkStore(file).has('MSG-1')).toBe(false);
  });

  it('is idempotent, so re-bookmarking does not duplicate the record', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);

    const rows = openDatabaseAt(file).prepare('SELECT COUNT(*) AS n FROM bookmarks').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('keeps the first createdAt when a message is bookmarked twice', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);
    const db = openDatabaseAt(file);
    const first = db.prepare('SELECT created_at FROM bookmarks WHERE msg_id = ?').get('MSG-1');

    store.set('MSG-1', 'alice@s.whatsapp.net', true);

    expect(db.prepare('SELECT created_at FROM bookmarks WHERE msg_id = ?').get('MSG-1')).toEqual(
      first
    );
  });

  it('writes the file with owner-only permissions', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);

    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('refuses to open a corrupt database rather than starting empty', () => {
    // Silently starting empty is how an operator loses a store without being
    // told: every bookmark reads as absent, and the first write makes that the
    // truth. Refusing is the whole reason startup treats this as fatal.
    fs.writeFileSync(file, 'this is not a database');

    expect(() => new BookmarkStore(file)).toThrow(DatabaseUnavailableError);
  });

  it('batch-checks many message IDs in a single query instead of N+1 queries', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);
    store.set('MSG-3', 'alice@s.whatsapp.net', true);
    store.set('MSG-99', 'bob@s.whatsapp.net', true);

    const prepareSpy = vi.spyOn(DatabaseSync.prototype, 'prepare');
    try {
      const matched = store.getBookmarkedIds(
        ['MSG-1', 'MSG-2', 'MSG-3', 'MSG-4'],
        'alice@s.whatsapp.net'
      );
      expect([...matched].sort()).toEqual(['MSG-1', 'MSG-3']);
      expect(prepareSpy).toHaveBeenCalledTimes(1);

      // Empty input does not touch SQLite at all.
      prepareSpy.mockClear();
      expect(store.getBookmarkedIds([]).size).toBe(0);
      expect(prepareSpy).not.toHaveBeenCalled();
    } finally {
      prepareSpy.mockRestore();
    }
  });

  it('lists saved bookmarks with optional metadata and chat filtering', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true, {
      chatName: 'Alice',
      senderName: 'Alice',
      text: 'Remember the door code 4821',
      ts: '2026-09-01T10:00:00Z',
    });
    store.set('MSG-2', 'bob@s.whatsapp.net', true, {
      chatName: 'Bob',
      senderName: 'Me',
      text: 'Signed contract attached',
      ts: '2026-09-02T12:00:00Z',
    });

    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.find((b) => b.msgId === 'MSG-1')).toMatchObject({
      msgId: 'MSG-1',
      chatJid: 'alice@s.whatsapp.net',
      chatName: 'Alice',
      senderName: 'Alice',
      text: 'Remember the door code 4821',
      ts: '2026-09-01T10:00:00Z',
    });

    const aliceOnly = store.list({ chat: 'alice@s.whatsapp.net' });
    expect(aliceOnly.map((b) => b.msgId)).toEqual(['MSG-1']);
  });
});
