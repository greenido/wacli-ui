import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../index.js';
import { getDb, openDatabaseAt } from '../db/index.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import {
  TemplateStore,
  TEMPLATE_BODY_MAX,
  TEMPLATE_NAME_MAX,
  parseTemplateInput,
} from '../wacli/templates.js';

describe('TemplateStore', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-templates-'));
    file = path.join(dir, 'templates.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a template across a restart', () => {
    const created = new TemplateStore(file).create({ name: 'Late', body: 'Running 10 min late.' });

    const reopened = new TemplateStore(file).list();
    expect(reopened).toEqual([created]);
    expect(created.lastUsedAt).toBeNull();
  });

  it('lists the most recently used first, then the rest by name', () => {
    const store = new TemplateStore(file);
    const zed = store.create({ name: 'zed', body: 'z' });
    store.create({ name: 'Bravo', body: 'b' });
    store.create({ name: 'alpha', body: 'a' });
    const used = store.create({ name: 'Charlie', body: 'c' });

    store.markUsed(zed.id);
    // A later use outranks an earlier one, whatever the clock's resolution.
    openDatabaseAt(file).prepare('UPDATE templates SET last_used_at = ? WHERE id = ?').run(
      '2999-01-01T00:00:00.000Z',
      used.id
    );

    expect(store.list().map((t) => t.name)).toEqual(['Charlie', 'zed', 'alpha', 'Bravo']);
  });

  it('updates a template in place, and says when there was none to update', () => {
    const store = new TemplateStore(file);
    const created = store.create({ name: 'Late', body: 'old' });

    const updated = store.update(created.id, { name: 'Late', body: 'new' });
    expect(updated).toMatchObject({ id: created.id, body: 'new', createdAt: created.createdAt });
    expect(store.update('no-such-id', { name: 'x', body: 'y' })).toBeNull();
  });

  it('removes a template, and says when there was none to remove', () => {
    const store = new TemplateStore(file);
    const created = store.create({ name: 'Late', body: 'Running late.' });

    expect(store.remove(created.id)).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove(created.id)).toBe(false);
    expect(store.markUsed(created.id)).toBe(false);
  });
});

describe('parseTemplateInput', () => {
  it('trims the name and keeps the body exactly as written', () => {
    expect(parseTemplateInput({ name: '  Late  ', body: '  Running late.\n' })).toEqual({
      name: 'Late',
      body: '  Running late.\n',
    });
  });

  it('refuses a missing, blank or oversized field', () => {
    for (const body of [
      {},
      { name: 'x' },
      { body: 'x' },
      { name: '   ', body: 'x' },
      { name: 'x', body: ' \n ' },
      { name: 7, body: 'x' },
      { name: 'x'.repeat(TEMPLATE_NAME_MAX + 1), body: 'x' },
      { name: 'x', body: 'x'.repeat(TEMPLATE_BODY_MAX + 1) },
    ]) {
      expect(typeof parseTemplateInput(body), JSON.stringify(body).slice(0, 60)).toBe('string');
    }
    expect(typeof parseTemplateInput(null)).toBe('string');
  });
});

describe('/api/templates', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);
  const wasReadOnly = modeManager.isReadOnly();

  beforeEach(() => {
    getDb().exec('DELETE FROM templates');
  });

  afterAll(() => {
    modeManager.setReadOnly(wasReadOnly);
    pm.dispose();
  });

  it('creates, lists, updates and deletes', async () => {
    const created = await request(app).post('/api/templates').send({ name: 'Late', body: 'Running late.' });
    expect(created.status).toBe(201);
    const { id } = created.body.data;

    const listed = await request(app).get('/api/templates');
    expect(listed.body.data).toEqual([expect.objectContaining({ id, name: 'Late', body: 'Running late.' })]);

    const updated = await request(app).post(`/api/templates/${id}`).send({ name: 'Late', body: 'Ten minutes.' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.body).toBe('Ten minutes.');

    const deleted = await request(app).delete(`/api/templates/${id}`);
    expect(deleted.status).toBe(200);
    expect((await request(app).get('/api/templates')).body.data).toEqual([]);
  });

  it('records a use, which moves the template to the top', async () => {
    const a = (await request(app).post('/api/templates').send({ name: 'A', body: 'a' })).body.data;
    const b = (await request(app).post('/api/templates').send({ name: 'B', body: 'b' })).body.data;

    expect((await request(app).post(`/api/templates/${b.id}/use`)).status).toBe(200);

    const names = (await request(app).get('/api/templates')).body.data.map((t: { id: string }) => t.id);
    expect(names).toEqual([b.id, a.id]);
  });

  it('answers 400 for a bad body and 404 for an unknown id', async () => {
    expect((await request(app).post('/api/templates').send({ name: 'x' })).status).toBe(400);
    expect((await request(app).post('/api/templates/nope').send({ name: 'x', body: 'y' })).status).toBe(404);
    expect((await request(app).delete('/api/templates/nope')).status).toBe(404);
    expect((await request(app).post('/api/templates/nope/use')).status).toBe(404);
  });

  it('stays open in safe read-only mode: nothing here reaches WhatsApp', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app).post('/api/templates').send({ name: 'Late', body: 'Running late.' });
    expect(res.status).toBe(201);
  });
});
