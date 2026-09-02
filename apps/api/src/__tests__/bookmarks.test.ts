import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BookmarkStore } from '../wacli/bookmarks.js';

describe('BookmarkStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-bookmarks-'));
    file = path.join(dir, 'bookmarks.json');
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

    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown[];
    expect(written).toHaveLength(1);
  });

  it('writes the file with owner-only permissions', () => {
    const store = new BookmarkStore(file);
    store.set('MSG-1', 'alice@s.whatsapp.net', true);

    expect(fs.statSync(file).mode & 0o077).toBe(0);
  });

  it('starts empty rather than throwing when the file is corrupt', () => {
    fs.writeFileSync(file, '{ not json');

    const store = new BookmarkStore(file);
    expect(store.has('MSG-1')).toBe(false);
  });
});
