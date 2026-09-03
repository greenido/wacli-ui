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
