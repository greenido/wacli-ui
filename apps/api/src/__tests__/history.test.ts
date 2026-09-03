import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

const execWacli = vi.hoisted(() =>
  vi.fn(async (args: string[]) => {
    const cmd = args.join(' ');
    if (cmd.startsWith('history coverage')) {
      return {
        coverage: [
          {
            chat_jid: 'alice@s.whatsapp.net',
            kind: 'dm',
            name: 'Alice',
            last_message_ts: '2026-09-03T18:08:52Z',
            message_count: 54,
            oldest_ts: '2026-06-08T15:35:32Z',
            newest_ts: '2026-09-03T18:08:52Z',
            status: 'ready',
          },
        ],
      };
    }
    if (cmd.startsWith('history backfill')) {
      return { requested: 200, delivered: 137 };
    }
    if (cmd.startsWith('messages export')) {
      return {
        messages: Array.from({ length: 3 }, (_unused, i) => ({
          ChatJID: 'alice@s.whatsapp.net',
          ChatName: 'Alice',
          MsgID: `MSG-${i}`,
          SenderJID: 'alice@s.whatsapp.net',
          SenderName: 'Alice',
          Timestamp: '2026-09-01T10:00:00Z',
          FromMe: false,
          Text: `line ${i}`,
        })),
      };
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

describe('History coverage and backfill', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    execWacli.mockClear();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    modeManager.setReadOnly(false);
  });

  it('reports how far back the local archive reaches', async () => {
    const res = await request(app).get('/api/history/coverage?chat=alice@s.whatsapp.net');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      chatJid: 'alice@s.whatsapp.net',
      messageCount: 54,
      oldestTs: '2026-06-08T15:35:32Z',
      status: 'ready',
    });
    expect(argsFor('history coverage')).toContain('--chat');
  });

  it('refuses a backfill while safe read-only mode is on', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app)
      .post('/api/history/backfill')
      .set('X-Mission-Control-Request', '1')
      .send({ chat: 'alice@s.whatsapp.net' });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('read-only');
    expect(argsFor('history backfill')).toBeUndefined();
  });

  it('requires a chat to backfill', async () => {
    const res = await request(app)
      .post('/api/history/backfill')
      .set('X-Mission-Control-Request', '1')
      .send({});

    expect(res.status).toBe(400);
    expect(argsFor('history backfill')).toBeUndefined();
  });

  it('asks the primary device for older messages', async () => {
    const res = await request(app)
      .post('/api/history/backfill')
      .set('X-Mission-Control-Request', '1')
      .send({ chat: 'alice@s.whatsapp.net', count: 200 });

    expect(res.status).toBe(200);
    expect(res.body.data.requested).toBe(200);

    const args = argsFor('history backfill')!;
    expect(args).toEqual(
      expect.arrayContaining(['--chat', 'alice@s.whatsapp.net', '--count', '200', '--requests', '1'])
    );
  });

  it('clamps an absurd backfill request instead of tying up the store lock', async () => {
    const res = await request(app)
      .post('/api/history/backfill')
      .set('X-Mission-Control-Request', '1')
      .send({ chat: 'alice@s.whatsapp.net', count: 999999 });

    expect(res.status).toBe(200);
    expect(res.body.data.requested).toBe(500);
    expect(argsFor('history backfill')).toEqual(expect.arrayContaining(['--count', '500']));
  });

  it('runs a backfill as a mutation, so wacli is not started in read-only', async () => {
    await request(app)
      .post('/api/history/backfill')
      .set('X-Mission-Control-Request', '1')
      .send({ chat: 'alice@s.whatsapp.net' });

    const call = execWacli.mock.calls.find(([args]) => args.join(' ').startsWith('history backfill'))!;
    expect(call[1]).toMatchObject({ allowMutation: true });
  });
});

describe('Conversation export', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    execWacli.mockClear();
  });

  it('exports a conversation', async () => {
    const res = await request(app).get('/api/messages/export?chat=alice@s.whatsapp.net');

    expect(res.status).toBe(200);
    expect(res.body.data.chatJid).toBe('alice@s.whatsapp.net');
    expect(res.body.data.chatName).toBe('Alice');
    expect(res.body.data.count).toBe(3);
    expect(res.body.data.messages).toHaveLength(3);
    expect(res.body.data.truncated).toBe(false);
  });

  it('requires a chat', async () => {
    const res = await request(app).get('/api/messages/export');

    expect(res.status).toBe(400);
    expect(argsFor('messages export')).toBeUndefined();
  });

  it('says so when the export hit its cap rather than implying it is complete', async () => {
    const res = await request(app).get('/api/messages/export?chat=alice@s.whatsapp.net&limit=3');

    expect(res.status).toBe(200);
    expect(res.body.data.truncated).toBe(true);
  });

  it('clamps the limit to keep the response inside the output buffer', async () => {
    await request(app).get('/api/messages/export?chat=alice@s.whatsapp.net&limit=100000');

    expect(argsFor('messages export')).toEqual(expect.arrayContaining(['--limit', '5000']));
  });
});
