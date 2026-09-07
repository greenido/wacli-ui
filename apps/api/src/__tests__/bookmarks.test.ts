import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
});
