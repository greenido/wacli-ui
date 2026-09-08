import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TagStore, normalizeTag } from '../wacli/tags.js';
import { DatabaseUnavailableError, openDatabaseAt } from '../db/index.js';

/** Reads the table directly, so a store bug cannot hide behind its own reader. */
function tagRowCount(file: string): number {
  return (openDatabaseAt(file).prepare('SELECT COUNT(*) AS n FROM tags').get() as { n: number }).n;
}

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-tags-'));
  file = path.join(dir, 'tags.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalizeTag', () => {
  it('folds case and spacing so one label does not become three', () => {
    expect(normalizeTag('  Follow Up ')).toBe('follow-up');
    expect(normalizeTag('WORK')).toBe('work');
  });

  it('rejects a tag that is only whitespace', () => {
    expect(normalizeTag('   ')).toBe('');
  });

  it('caps length rather than storing an essay', () => {
    expect(normalizeTag('x'.repeat(80))).toHaveLength(32);
  });
});

describe('TagStore', () => {
  it('survives a restart', () => {
    new TagStore(file).add('alice@s.whatsapp.net', 'work');
    expect(new TagStore(file).get('alice@s.whatsapp.net')).toEqual(['work']);
  });

  it('stores one tag once, however it was typed', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'Work');
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', '  WORK  ');
    expect(store.get('alice@s.whatsapp.net')).toEqual(['work']);
  });

  it('keeps tags sorted, so the rail order does not depend on typing order', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'family');
    expect(store.get('alice@s.whatsapp.net')).toEqual(['family', 'work']);
  });

  it('removes a tag and forgets the chat once its last one is gone', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.remove('alice@s.whatsapp.net', 'work');

    expect(store.get('alice@s.whatsapp.net')).toEqual([]);
    expect(tagRowCount(file)).toBe(0);
  });

  it('lists every tag in use across chats, deduplicated', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('bob@s.whatsapp.net', 'work');
    store.add('bob@s.whatsapp.net', 'family');

    expect(store.allTags()).toEqual(['family', 'work']);
  });

  it('ignores an empty tag instead of storing a blank chip', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', '   ');
    expect(store.get('alice@s.whatsapp.net')).toEqual([]);
  });

  it('writes the file owner-only, since it names who the operator talks to', () => {
    new TagStore(file).add('alice@s.whatsapp.net', 'work');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to open a corrupt database rather than starting empty', () => {
    // The shape guards these tests used to need now live in two places: the
    // schema, which will not hold a tag that is not text, and the JSON import,
    // covered in db-migration.test.ts. What is left to check here is that a
    // store which cannot be read says so instead of reading as empty.
    fs.writeFileSync(file, 'this is not a database');

    expect(() => new TagStore(file)).toThrow(DatabaseUnavailableError);
  });
});

describe('TagStore.countFor', () => {
  it('counts the chats carrying a tag, not the times it was typed', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'Work');
    store.add('bob@s.whatsapp.net', 'work');
    store.add('carol@s.whatsapp.net', 'family');

    expect(store.countFor('work')).toBe(2);
    expect(store.countFor('family')).toBe(1);
  });

  it('reports zero for a tag nobody carries', () => {
    expect(new TagStore(file).countFor('nope')).toBe(0);
  });
});

describe('TagStore.rename', () => {
  it('renames a tag on every chat carrying it, in one pass', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('bob@s.whatsapp.net', 'work');

    expect(store.rename('work', 'clients')).toEqual({ renamed: 2, merged: false });
    expect(store.get('alice@s.whatsapp.net')).toEqual(['clients']);
    expect(store.get('bob@s.whatsapp.net')).toEqual(['clients']);
    expect(store.allTags()).toEqual(['clients']);
  });

  it('leaves the chats that never carried it alone', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('bob@s.whatsapp.net', 'family');

    store.rename('work', 'clients');
    expect(store.get('bob@s.whatsapp.net')).toEqual(['family']);
  });

  it('keeps a chat\'s other tags through the rename', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'urgent');

    store.rename('work', 'clients');
    expect(store.get('alice@s.whatsapp.net')).toEqual(['clients', 'urgent']);
  });

  it('merges into a name already in use, and says that it did', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('bob@s.whatsapp.net', 'clients');

    expect(store.rename('work', 'clients')).toEqual({ renamed: 1, merged: true });
    expect(store.allTags()).toEqual(['clients']);
    expect(store.get('alice@s.whatsapp.net')).toEqual(['clients']);
    expect(store.get('bob@s.whatsapp.net')).toEqual(['clients']);
  });

  it('leaves one chip, not two, on a chat that carried both names', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'clients');

    store.rename('work', 'clients');
    expect(store.get('alice@s.whatsapp.net')).toEqual(['clients']);
  });

  it('folds the new name, so a rename cannot smuggle in a spelling add() would refuse', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');

    store.rename('work', '  Follow Up ');
    expect(store.get('alice@s.whatsapp.net')).toEqual(['follow-up']);
  });

  it('treats a rename to the same name as nothing to do', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');

    expect(store.rename('work', 'WORK')).toEqual({ renamed: 0, merged: false });
    expect(store.get('alice@s.whatsapp.net')).toEqual(['work']);
  });

  it('refuses a new name that folds away to nothing', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');

    expect(store.rename('work', '   ')).toEqual({ renamed: 0, merged: false });
    expect(store.get('alice@s.whatsapp.net')).toEqual(['work']);
  });

  it('survives a restart', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.rename('work', 'clients');

    expect(new TagStore(file).get('alice@s.whatsapp.net')).toEqual(['clients']);
  });
});

describe('TagStore.deleteTag', () => {
  it('drops a tag from every chat carrying it and reports how many', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('bob@s.whatsapp.net', 'work');
    store.add('carol@s.whatsapp.net', 'family');

    expect(store.deleteTag('work')).toBe(2);
    expect(store.allTags()).toEqual(['family']);
    expect(store.get('alice@s.whatsapp.net')).toEqual([]);
  });

  it('keeps the tags it was not asked about', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'urgent');

    store.deleteTag('work');
    expect(store.get('alice@s.whatsapp.net')).toEqual(['urgent']);
  });

  it('forgets a chat whose last tag it just took', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.deleteTag('work');

    expect(tagRowCount(file)).toBe(0);
  });

  it('changes nothing for a tag nobody carries', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');

    expect(store.deleteTag('nope')).toBe(0);
    expect(tagRowCount(file)).toBe(1);
  });

  it('survives a restart', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'urgent');
    store.deleteTag('work');

    expect(new TagStore(file).get('alice@s.whatsapp.net')).toEqual(['urgent']);
  });
});
