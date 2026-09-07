import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';
import { getDb } from '../db/index.js';

interface ActivityBody {
  items: Array<{ id: string; message: string; status: string; messageId?: string }>;
  nextCursor: string | null;
  total: number;
}

describe('GET /api/activity', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  beforeEach(() => {
    // The suite shares one sandbox database, so each case starts from a known
    // log rather than whatever the case before it sent.
    getDb().exec('DELETE FROM activity');
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue({ id: 'msg-1' });
    modeManager.setReadOnly(false);
  });

  /** Sends `count` messages through the API, which is what writes the log. */
  async function sendMany(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await request(app)
        .post('/api/send/text')
        .set('X-Mission-Control-Request', '1')
        .send({ to: '15551234567@s.whatsapp.net', message: `send ${i}`, confirm: true });
    }
  }

  it('records a send the API dispatched, without the browser reporting it', async () => {
    await sendMany(1);

    const res = await request(app).get('/api/activity');
    expect(res.status).toBe(200);
    const body = res.body.data as ActivityBody;
    expect(body.items).toHaveLength(1);
    expect(body.items[0].message).toBe('send 0');
    expect(body.items[0].status).toBe('success');
  });

  it('records a send that failed, with the reason', async () => {
    execWacliMock.mockRejectedValue(new Error('wacli exploded'));

    await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', message: 'doomed', confirm: true });

    const body = (await request(app).get('/api/activity')).body.data as ActivityBody;
    expect(body.items[0].status).toBe('error');
    expect(body.items[0].message).toBe('doomed');
  });

  it('answers with ten rows by default however many are on record', async () => {
    await sendMany(14);

    const body = (await request(app).get('/api/activity')).body.data as ActivityBody;
    expect(body.items).toHaveLength(10);
    expect(body.total).toBe(14);
    expect(body.nextCursor).not.toBeNull();
  });

  it('hands back the next page from the cursor it gave', async () => {
    await sendMany(14);

    const first = (await request(app).get('/api/activity')).body.data as ActivityBody;
    const second = (
      await request(app).get(`/api/activity?before=${encodeURIComponent(first.nextCursor!)}`)
    ).body.data as ActivityBody;

    expect(second.items).toHaveLength(4);
    expect(second.nextCursor).toBeNull();

    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(14);
  });

  it('honours an explicit limit', async () => {
    await sendMany(6);

    const body = (await request(app).get('/api/activity?limit=3')).body.data as ActivityBody;
    expect(body.items).toHaveLength(3);
  });

  it('falls back to the default rather than a page of NaN', async () => {
    await sendMany(12);

    const body = (await request(app).get('/api/activity?limit=abc')).body.data as ActivityBody;
    expect(body.items).toHaveLength(10);
  });

  it('does not let a caller ask for the whole log at once', async () => {
    await sendMany(3);

    const body = (await request(app).get('/api/activity?limit=100000')).body.data as ActivityBody;
    expect(body.items.length).toBeLessThanOrEqual(200);
  });
});
