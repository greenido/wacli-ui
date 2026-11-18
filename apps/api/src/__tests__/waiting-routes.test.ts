import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { getDb } from '../db/index.js';
import { resetChatPreviewCache } from '../routes/chats.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import type { RawMessage } from '../types.js';

const ADA = '15550100001@s.whatsapp.net';
const GRACE = '15550100002@s.whatsapp.net';

const archive = vi.hoisted(() => ({ messages: [] as RawMessage[] }));

const execWacli = vi.hoisted(() =>
  vi.fn(async (args: string[]) => {
    const cmd = args.join(' ');
    if (cmd.startsWith('chats list')) return [{ jid: ADA, name: 'Ada Lovelace' }];
    if (cmd.startsWith('messages list')) return { messages: archive.messages };
    return [];
  })
);

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli };
});

function scans(): number {
  return execWacli.mock.calls.filter(([args]) => args.join(' ').startsWith('messages list')).length;
}

/** Newest first, the way wacli lists them. */
const toAda: RawMessage = {
  ChatJID: ADA,
  ChatName: 'Ada Lovelace',
  MsgID: 'ADA-1',
  Timestamp: '2026-11-16T10:00:00Z',
  FromMe: true,
  Text: 'Did the engine run?',
  DeliveredTo: 1,
  ReadBy: 1,
};
const toGrace: RawMessage = {
  ChatJID: GRACE,
  ChatName: 'Grace Hopper',
  MsgID: 'GRACE-1',
  Timestamp: '2026-11-15T10:00:00Z',
  FromMe: true,
  Text: 'Found the moth yet?',
  DeliveredTo: 1,
  ReadBy: 0,
};

describe('waiting routes', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    resetChatPreviewCache();
    execWacli.mockClear();
    archive.messages = [toAda, toGrace];
    getDb().exec('DELETE FROM waiting_marks');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-11-18T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    modeManager.setReadOnly(false);
  });

  it('lists unanswered messages, longest wait first', async () => {
    const res = await request(app).get('/api/waiting');

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(2);
    expect(res.body.data.snoozed).toBe(0);
    expect(res.body.data.items.map((i: { message: { msgId: string } }) => i.message.msgId)).toEqual([
      'GRACE-1',
      'ADA-1',
    ]);
    expect(res.body.data.items[1]).toMatchObject({
      chatJid: ADA,
      chatName: 'Ada Lovelace',
      snoozedUntil: null,
      message: { deliveryStatus: 'read', text: 'Did the engine run?' },
    });
  });

  it('drops a chat once the reply is in the archive', async () => {
    archive.messages = [
      { ChatJID: ADA, MsgID: 'ADA-2', Timestamp: '2026-11-16T11:00:00Z', FromMe: false, Text: 'It did.' },
      toAda,
      toGrace,
    ];
    const res = await request(app).get('/api/waiting');
    expect(res.body.data.items.map((i: { chatJid: string }) => i.chatJid)).toEqual([GRACE]);
  });

  it('shares one scan with the chat rail rather than running its own', async () => {
    await request(app).get('/api/chats');
    await request(app).get('/api/waiting');
    expect(scans()).toBe(1);
  });

  it('caps the page but still reports the full count', async () => {
    const res = await request(app).get('/api/waiting?limit=1');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.total).toBe(2);
  });

  it('refuses a malformed limit instead of reaching wacli', async () => {
    const res = await request(app).get('/api/waiting?limit=abc');
    expect(res.status).toBe(400);
    expect(scans()).toBe(0);
  });

  it('answers a failed scan as an error, not as nothing waiting', async () => {
    execWacli.mockImplementationOnce(async () => {
      throw new Error('store is locked by another process');
    });
    const res = await request(app).get('/api/waiting');
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('hides a dismissed message for good', async () => {
    const done = await request(app).post('/api/waiting/dismiss').send({ chat: ADA, id: 'ADA-1' });
    expect(done.status).toBe(200);

    resetChatPreviewCache();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z'));
    const res = await request(app).get('/api/waiting');
    expect(res.body.data.items.map((i: { chatJid: string }) => i.chatJid)).toEqual([GRACE]);
    expect(res.body.data.snoozed).toBe(0);
  });

  it('hides a snoozed message until its reminder, then brings it back marked', async () => {
    const snooze = await request(app)
      .post('/api/waiting/snooze')
      .send({ chat: ADA, id: 'ADA-1', until: '2026-11-19T09:00:00+02:00' });
    expect(snooze.status).toBe(200);
    expect(snooze.body.data.snoozedUntil).toBe('2026-11-19T07:00:00.000Z');

    const hidden = await request(app).get('/api/waiting');
    expect(hidden.body.data.items.map((i: { chatJid: string }) => i.chatJid)).toEqual([GRACE]);
    expect(hidden.body.data.snoozed).toBe(1);

    vi.setSystemTime(new Date('2026-11-19T07:00:01Z'));
    resetChatPreviewCache();
    const back = await request(app).get('/api/waiting');
    expect(back.body.data.items.map((i: { chatJid: string }) => i.chatJid)).toEqual([GRACE, ADA]);
    expect(back.body.data.items[1].snoozedUntil).toBe('2026-11-19T07:00:00.000Z');
    expect(back.body.data.snoozed).toBe(0);
  });

  it('returns a new message in a dismissed chat, since it is a new question', async () => {
    await request(app).post('/api/waiting/dismiss').send({ chat: ADA, id: 'ADA-1' });
    archive.messages = [
      { ...toAda, MsgID: 'ADA-3', Timestamp: '2026-11-17T10:00:00Z', Text: 'Ping?' },
      toAda,
      toGrace,
    ];
    resetChatPreviewCache();
    const res = await request(app).get('/api/waiting');
    expect(res.body.data.items.map((i: { message: { msgId: string } }) => i.message.msgId)).toEqual([
      'GRACE-1',
      'ADA-3',
    ]);
  });

  it.each([
    [{ id: 'ADA-1', until: '2026-11-19T09:00:00Z' }, 'no chat'],
    [{ chat: ADA, until: '2026-11-19T09:00:00Z' }, 'no id'],
    [{ chat: ADA, id: 'ADA-1' }, 'no time'],
    [{ chat: ADA, id: 'ADA-1', until: 'tomorrow-ish' }, 'an unreadable time'],
    [{ chat: ADA, id: 'ADA-1', until: '2026-11-18T11:00:00Z' }, 'a time already past'],
    [{ chat: ADA, id: 'ADA-1', until: '2028-01-01T00:00:00Z' }, 'a time over a year out'],
  ])('refuses a snooze with %j (%s)', async (body) => {
    const res = await request(app).post('/api/waiting/snooze').send(body);
    expect(res.status).toBe(400);
  });

  it('refuses a dismissal that names no message', async () => {
    const res = await request(app).post('/api/waiting/dismiss').send({ chat: ADA });
    expect(res.status).toBe(400);
  });

  it('keeps dismiss and snooze open in safe read-only mode, since nothing is sent', async () => {
    modeManager.setReadOnly(true);
    const dismissed = await request(app).post('/api/waiting/dismiss').send({ chat: ADA, id: 'ADA-1' });
    const snoozed = await request(app)
      .post('/api/waiting/snooze')
      .send({ chat: GRACE, id: 'GRACE-1', until: '2026-11-19T09:00:00Z' });
    expect(dismissed.status).toBe(200);
    expect(snoozed.status).toBe(200);
  });
});
