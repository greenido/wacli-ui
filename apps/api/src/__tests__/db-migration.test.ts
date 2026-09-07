import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabaseAt, DatabaseUnavailableError } from '../db/index.js';
import { migrateJsonStores } from '../db/migrate-json.js';
import { applySchema, SCHEMA_VERSION } from '../db/schema.js';

/**
 * The legacy env vars are the only thing that still points at the JSON files,
 * so pointing them at a sandbox is what keeps this suite off the developer's
 * real ~/.wacli-mission-control.
 */
const LEGACY_VARS = [
  'WACLI_SETTINGS_FILE',
  'WACLI_SCHEDULED_FILE',
  'WACLI_BOOKMARKS_FILE',
  'WACLI_TAGS_FILE',
] as const;

describe('legacy JSON migration', () => {
  let dir: string;
  let db: DatabaseSync;
  const saved: Record<string, string | undefined> = {};

  const legacyFile = (name: string) => path.join(dir, name);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-migrate-'));
    for (const v of LEGACY_VARS) saved[v] = process.env[v];
    process.env.WACLI_SETTINGS_FILE = legacyFile('settings.json');
    process.env.WACLI_SCHEDULED_FILE = legacyFile('scheduled.json');
    process.env.WACLI_BOOKMARKS_FILE = legacyFile('bookmarks.json');
    process.env.WACLI_TAGS_FILE = legacyFile('tags.json');
    db = openDatabaseAt(path.join(dir, 'mission-control.db'));
  });

  afterEach(() => {
    db.close();
    for (const v of LEGACY_VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rowCount = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  it('imports each store and renames the file it consumed', () => {
    fs.writeFileSync(legacyFile('settings.json'), JSON.stringify({ readOnly: false }));
    fs.writeFileSync(
      legacyFile('bookmarks.json'),
      JSON.stringify([{ msgId: 'MSG-1', chatJid: 'alice@s.whatsapp.net', createdAt: 'then' }])
    );
    fs.writeFileSync(
      legacyFile('tags.json'),
      JSON.stringify({ 'alice@s.whatsapp.net': ['work', 'family'] })
    );

    migrateJsonStores(db);

    expect(rowCount('bookmarks')).toBe(1);
    expect(rowCount('tags')).toBe(2);
    expect(db.prepare("SELECT value FROM settings WHERE key = 'readOnly'").get()).toEqual({
      value: 'false',
    });

    // Renamed, not deleted: the operator keeps a copy of what moved.
    expect(fs.existsSync(legacyFile('tags.json'))).toBe(false);
    expect(fs.existsSync(legacyFile('tags.json.migrated'))).toBe(true);
  });

  it('keeps a stored false as a boolean rather than the string "false"', () => {
    // A settings table of raw strings would answer isReadOnly() with "false",
    // which is truthy — locking sends on every machine that had unlocked them.
    fs.writeFileSync(legacyFile('settings.json'), JSON.stringify({ readOnly: false }));
    migrateJsonStores(db);

    const row = db.prepare("SELECT value FROM settings WHERE key = 'readOnly'").get() as {
      value: string;
    };
    expect(JSON.parse(row.value)).toBe(false);
  });

  it('leaves a table that already has rows alone, so a stale file cannot resurrect data', () => {
    db.prepare('INSERT INTO bookmarks (msg_id, chat_jid, created_at) VALUES (?, ?, ?)').run(
      'MSG-KEPT',
      'alice@s.whatsapp.net',
      'now'
    );
    fs.writeFileSync(
      legacyFile('bookmarks.json'),
      JSON.stringify([{ msgId: 'MSG-DELETED', chatJid: 'alice@s.whatsapp.net', createdAt: 'then' }])
    );

    migrateJsonStores(db);

    expect(rowCount('bookmarks')).toBe(1);
    expect(db.prepare('SELECT msg_id FROM bookmarks').get()).toEqual({ msg_id: 'MSG-KEPT' });
    // And the file stays put rather than being renamed as though it was read.
    expect(fs.existsSync(legacyFile('bookmarks.json'))).toBe(true);
  });

  it('is a no-op on the second run', () => {
    fs.writeFileSync(
      legacyFile('tags.json'),
      JSON.stringify({ 'alice@s.whatsapp.net': ['work'] })
    );

    migrateJsonStores(db);
    migrateJsonStores(db);

    expect(rowCount('tags')).toBe(1);
  });

  it('ignores a file whose shape is wrong instead of trusting it', () => {
    fs.writeFileSync(legacyFile('tags.json'), JSON.stringify(['not', 'a', 'map']));

    migrateJsonStores(db);

    expect(rowCount('tags')).toBe(0);
  });

  it('drops non-string tags while keeping the usable ones', () => {
    fs.writeFileSync(
      legacyFile('tags.json'),
      JSON.stringify({ 'alice@s.whatsapp.net': ['work', 42, null, 'family'] })
    );

    migrateJsonStores(db);

    expect(
      (db.prepare('SELECT tag FROM tags ORDER BY tag').all() as Array<{ tag: string }>).map(
        (r) => r.tag
      )
    ).toEqual(['family', 'work']);
  });

  it('leaves a corrupt file in place rather than emptying the table it maps to', () => {
    fs.writeFileSync(legacyFile('tags.json'), '{ this is not json');

    expect(() => migrateJsonStores(db)).not.toThrow();

    expect(rowCount('tags')).toBe(0);
    // Still there, so a hand-repaired file is picked up on the next boot.
    expect(fs.existsSync(legacyFile('tags.json'))).toBe(true);
  });
});

describe('schema versioning', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-schema-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the file with the version it wrote', () => {
    const db = openDatabaseAt(path.join(dir, 'v.db'));
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
    db.close();
  });

  it('refuses a file written by a newer build instead of half-reading it', () => {
    const file = path.join(dir, 'future.db');
    const db = openDatabaseAt(file);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    expect(() => applySchema(db)).toThrow(/newer version/);
    db.close();
  });

  it('reports a file that is not a database at all', () => {
    const file = path.join(dir, 'garbage.db');
    fs.writeFileSync(file, 'definitely not sqlite');

    expect(() => openDatabaseAt(file)).toThrow(DatabaseUnavailableError);
  });
});
