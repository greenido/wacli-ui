import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TagStore, normalizeTag } from '../wacli/tags.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-tags-'));
  file = path.join(dir, 'tags.json');
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
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
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

  it('starts empty rather than crashing on a corrupt file', () => {
    fs.writeFileSync(file, '{ this is not json');
    const store = new TagStore(file);

    expect(store.allTags()).toEqual([]);
    expect(() => store.add('alice@s.whatsapp.net', 'work')).not.toThrow();
    expect(store.get('alice@s.whatsapp.net')).toEqual(['work']);
  });

  it('ignores a file whose shape is wrong instead of trusting it', () => {
    fs.writeFileSync(file, JSON.stringify(['not', 'a', 'map']));
    expect(new TagStore(file).allTags()).toEqual([]);
  });

  it('drops non-string entries while keeping the usable ones', () => {
    fs.writeFileSync(file, JSON.stringify({ 'alice@s.whatsapp.net': ['work', 42, null, 'family'] }));
    expect(new TagStore(file).get('alice@s.whatsapp.net')).toEqual(['family', 'work']);
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

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('does not touch the file for a tag nobody carries', () => {
    const store = new TagStore(file);
    expect(store.deleteTag('nope')).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('survives a restart', () => {
    const store = new TagStore(file);
    store.add('alice@s.whatsapp.net', 'work');
    store.add('alice@s.whatsapp.net', 'urgent');
    store.deleteTag('work');

    expect(new TagStore(file).get('alice@s.whatsapp.net')).toEqual(['urgent']);
  });
});
