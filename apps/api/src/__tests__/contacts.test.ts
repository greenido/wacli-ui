import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

const execWacli = vi.hoisted(() =>
  vi.fn(async (args: string[]) => {
    const cmd = args.join(' ');
    if (cmd.startsWith('contacts show')) {
      if (cmd.includes('99999999999')) {
        throw new Error('sql: no rows in result set');
      }
      return {
        jid: 'alice@s.whatsapp.net',
        phone: '15551234567',
        name: 'Alice',
        alias: 'Alice (work)',
        system_name: 'Alice Anderson',
        updated_at: '2026-09-01T10:00:00Z',
      };
    }
    if (cmd.startsWith('contacts alias')) return { ok: true };
    if (cmd.startsWith('groups list')) {
      return [
        {
          JID: 'team@g.us',
          Name: 'Ops Team',
          OwnerJID: 'boss@s.whatsapp.net',
          CreatedAt: '2025-01-05T09:00:00Z',
          LeftAt: null,
          UpdatedAt: '2026-08-01T09:00:00Z',
        },
      ];
    }
    return [];
  })
);

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli };
});

function argsFor(prefix: string): string[] | undefined {
  return execWacli.mock.calls.map(([args]) => args).find((args) => args.join(' ').startsWith(prefix));
}

describe('Contact metadata and aliases', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    execWacli.mockClear();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    modeManager.setReadOnly(false);
  });

  it('returns a contact with its local metadata', async () => {
    const res = await request(app).get('/api/contacts/show?jid=alice@s.whatsapp.net');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      jid: 'alice@s.whatsapp.net',
      phone: '15551234567',
      name: 'Alice',
      alias: 'Alice (work)',
      systemName: 'Alice Anderson',
      known: true,
    });
  });

  it('requires a jid', async () => {
    const res = await request(app).get('/api/contacts/show');
    expect(res.status).toBe(400);
  });

  it('answers plainly for a JID wacli has never synced, rather than failing', async () => {
    const res = await request(app).get('/api/contacts/show?jid=99999999999@s.whatsapp.net');

    expect(res.status).toBe(200);
    expect(res.body.data.known).toBe(false);
    expect(res.body.data.phone).toBe('99999999999');
    expect(res.body.data.tags).toEqual([]);
  });

  it('sets an alias in the wacli store', async () => {
    const res = await request(app)
      .post('/api/contacts/alias')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', alias: 'Alice W' });

    expect(res.status).toBe(200);
    expect(argsFor('contacts alias')).toEqual([
      'contacts', 'alias', 'set', '--jid', 'alice@s.whatsapp.net', '--alias', 'Alice W',
    ]);
  });

  it('clears the alias when an empty one is saved', async () => {
    await request(app)
      .post('/api/contacts/alias')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', alias: '   ' });

    expect(argsFor('contacts alias')).toEqual([
      'contacts', 'alias', 'rm', '--jid', 'alice@s.whatsapp.net',
    ]);
  });

  it('writes the alias as a mutation, not under wacli read-only', async () => {
    await request(app)
      .post('/api/contacts/alias')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', alias: 'Alice W' });

    const call = execWacli.mock.calls.find(([args]) => args.join(' ').startsWith('contacts alias'))!;
    expect(call[1]).toMatchObject({ allowMutation: true });
  });

  it('refuses an alias while safe read-only mode is on', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app)
      .post('/api/contacts/alias')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', alias: 'Alice W' });

    expect(res.status).toBe(403);
    expect(argsFor('contacts alias')).toBeUndefined();
  });

  it('lists local group metadata', async () => {
    const res = await request(app).get('/api/groups');

    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      jid: 'team@g.us',
      name: 'Ops Team',
      ownerJid: 'boss@s.whatsapp.net',
    });
  });
});

describe('Local chat tags', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    execWacli.mockClear();
    modeManager.setReadOnly(false);
  });

  afterEach(async () => {
    modeManager.setReadOnly(false);
    // Leave the shared store clean for whichever test runs next.
    for (const tag of ['work', 'family', 'follow-up']) {
      await request(app)
        .post('/api/tags')
        .set('X-Mission-Control-Request', '1')
        .send({ jid: 'alice@s.whatsapp.net', tag, add: false });
    }
  });

  it('adds a tag and reads it back', async () => {
    const added = await request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', tag: 'Work', add: true });

    expect(added.status).toBe(200);
    expect(added.body.data.tags).toEqual(['work']);

    const listed = await request(app).get('/api/tags');
    expect(listed.body.data.tags).toContain('work');
    expect(listed.body.data.byJid['alice@s.whatsapp.net']).toEqual(['work']);
  });

  it('surfaces the tag on the contact record', async () => {
    await request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', tag: 'work', add: true });

    const res = await request(app).get('/api/contacts/show?jid=alice@s.whatsapp.net');
    expect(res.body.data.tags).toEqual(['work']);
  });

  it('removes a tag', async () => {
    await request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', tag: 'work', add: true });

    const removed = await request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', tag: 'work', add: false });

    expect(removed.body.data.tags).toEqual([]);
  });

  it('requires both a jid and a tag', async () => {
    const res = await request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net' });

    expect(res.status).toBe(400);
  });

  it('still works in safe read-only mode, because it never reaches wacli', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid: 'alice@s.whatsapp.net', tag: 'work', add: true });

    expect(res.status).toBe(200);
    expect(res.body.data.tags).toEqual(['work']);
    // Nothing was handed to the CLI at all.
    expect(execWacli).not.toHaveBeenCalled();
  });
});

describe('Managing the tag vocabulary', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  const tag = (jid: string, name: string) =>
    request(app)
      .post('/api/tags')
      .set('X-Mission-Control-Request', '1')
      .send({ jid, tag: name, add: true });

  beforeEach(() => {
    execWacli.mockClear();
    modeManager.setReadOnly(false);
  });

  afterEach(async () => {
    modeManager.setReadOnly(false);
    // The store is shared across this file, so clear the whole vocabulary
    // rather than guessing which chats a test happened to touch.
    const { body } = await request(app).get('/api/tags');
    for (const name of body.data.tags as string[]) {
      await request(app)
        .post('/api/tags/delete')
        .set('X-Mission-Control-Request', '1')
        .send({ tag: name });
    }
  });

  it('renames a tag on every chat carrying it', async () => {
    await tag('alice@s.whatsapp.net', 'work');
    await tag('bob@s.whatsapp.net', 'work');

    const res = await request(app)
      .post('/api/tags/rename')
      .set('X-Mission-Control-Request', '1')
      .send({ from: 'work', to: 'Clients' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ from: 'work', to: 'clients', renamed: 2, merged: false });

    const listed = await request(app).get('/api/tags');
    expect(listed.body.data.tags).toEqual(['clients']);
    expect(listed.body.data.byJid['bob@s.whatsapp.net']).toEqual(['clients']);
  });

  it('flags the merge when the new name is already in use', async () => {
    await tag('alice@s.whatsapp.net', 'work');
    await tag('bob@s.whatsapp.net', 'clients');

    const res = await request(app)
      .post('/api/tags/rename')
      .set('X-Mission-Control-Request', '1')
      .send({ from: 'work', to: 'clients' });

    expect(res.body.data).toMatchObject({ renamed: 1, merged: true });
    expect((await request(app).get('/api/tags')).body.data.tags).toEqual(['clients']);
  });

  it('requires both ends of the rename', async () => {
    const res = await request(app)
      .post('/api/tags/rename')
      .set('X-Mission-Control-Request', '1')
      .send({ from: 'work' });

    expect(res.status).toBe(400);
  });

  it('refuses a new name that folds away to nothing', async () => {
    await tag('alice@s.whatsapp.net', 'work');

    const res = await request(app)
      .post('/api/tags/rename')
      .set('X-Mission-Control-Request', '1')
      .send({ from: 'work', to: '   ' });

    expect(res.status).toBe(400);
    expect((await request(app).get('/api/tags')).body.data.tags).toEqual(['work']);
  });

  it('deletes a tag from every chat and reports the reach', async () => {
    await tag('alice@s.whatsapp.net', 'work');
    await tag('bob@s.whatsapp.net', 'work');
    await tag('bob@s.whatsapp.net', 'family');

    const res = await request(app)
      .post('/api/tags/delete')
      .set('X-Mission-Control-Request', '1')
      .send({ tag: 'Work' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ tag: 'work', removed: 2 });

    const listed = await request(app).get('/api/tags');
    expect(listed.body.data.tags).toEqual(['family']);
    expect(listed.body.data.byJid['alice@s.whatsapp.net']).toBeUndefined();
  });

  it('requires a tag to delete', async () => {
    const res = await request(app)
      .post('/api/tags/delete')
      .set('X-Mission-Control-Request', '1')
      .send({});

    expect(res.status).toBe(400);
  });

  it('still manages tags in safe read-only mode, because none of it reaches wacli', async () => {
    await tag('alice@s.whatsapp.net', 'work');
    modeManager.setReadOnly(true);

    const renamed = await request(app)
      .post('/api/tags/rename')
      .set('X-Mission-Control-Request', '1')
      .send({ from: 'work', to: 'clients' });
    expect(renamed.status).toBe(200);

    const deleted = await request(app)
      .post('/api/tags/delete')
      .set('X-Mission-Control-Request', '1')
      .send({ tag: 'clients' });
    expect(deleted.status).toBe(200);

    expect(execWacli).not.toHaveBeenCalled();
  });
});
