import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return {
    ...actual,
    execWacli: vi.fn(async (args: string[]) => {
      const cmd = args.join(' ');
      if (cmd.startsWith('chats list')) {
        return [
          {
            jid: '15551234567@s.whatsapp.net',
            name: 'Alice',
            last_message_ts: '2026-08-31T01:00:00Z',
            unread_count: 2,
            archived: false,
            pinned: true,
          },
        ];
      }
      if (cmd.startsWith('chats mark-read')) {
        return null;
      }
      if (cmd.startsWith('messages list')) {
        return {
          fts: false,
          messages: [
            {
              ChatJID: '15551234567@s.whatsapp.net',
              MsgID: 'MSG-001',
              SenderJID: '15551234567@s.whatsapp.net',
              Timestamp: '2026-08-31T12:00:00Z',
              FromMe: false,
              Text: 'Hello from mock wacli',
            },
          ],
        };
      }
      if (cmd.startsWith('messages search')) {
        return {
          fts: true,
          messages: [
            {
              ChatJID: '15551234567@s.whatsapp.net',
              MsgID: 'MSG-SEARCH-1',
              Timestamp: '2026-08-31T12:00:00Z',
              FromMe: false,
              Text: 'Search result mock',
            },
          ],
        };
      }
      return [];
    }),
  };
});

describe('API Read Endpoints', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  it('GET /api/chats returns chat list array', async () => {
    const res = await request(app).get('/api/chats?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].name).toBe('Alice');
  });

  it('POST /api/chats/mark-read marks a chat as read', async () => {
    modeManager.setReadOnly(false);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15551234567@s.whatsapp.net' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.unread).toBe(false);
    expect(res.body.data.unreadCount).toBe(0);
  });

  it('GET /api/search with empty query returns empty results', async () => {
    const res = await request(app).get('/api/search?q=');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results).toEqual([]);
  });

  it('GET /api/search with valid query returns matching results', async () => {
    const res = await request(app).get('/api/search?q=hello');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results.length).toBe(1);
    expect(res.body.data.results[0].msgId).toBe('MSG-SEARCH-1');
  });

  it('GET /api/messages returns messages payload', async () => {
    const res = await request(app).get('/api/messages?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('messages');
    expect(Array.isArray(res.body.data.messages)).toBe(true);
    expect(res.body.data.messages.length).toBe(1);
    expect(res.body.data.messages[0].msgId).toBe('MSG-001');
  });

  it('POST /api/messages/bookmark records a bookmark the message list reports back', async () => {
    const res = await request(app)
      .post('/api/messages/bookmark')
      .send({
        chat: '15551234567@s.whatsapp.net',
        id: 'MSG-001',
        bookmarked: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.bookmarked).toBe(true);
    expect(res.body.data.id).toBe('MSG-001');

    // The old star endpoint kept a process-local map that nothing read back on
    // a fresh request. A bookmark has to survive the round trip to be real.
    const listed = await request(app).get('/api/messages?limit=5');
    expect(listed.body.data.messages[0].msgId).toBe('MSG-001');
    expect(listed.body.data.messages[0].bookmarked).toBe(true);

    const cleared = await request(app)
      .post('/api/messages/bookmark')
      .send({ chat: '15551234567@s.whatsapp.net', id: 'MSG-001', bookmarked: false });
    expect(cleared.body.data.bookmarked).toBe(false);

    const relisted = await request(app).get('/api/messages?limit=5');
    expect(relisted.body.data.messages[0].bookmarked).toBe(false);
  });

  it('GET /api/chats carries a last-message preview instead of only a timestamp', async () => {
    const res = await request(app).get('/api/chats');

    expect(res.status).toBe(200);
    const alice = res.body.data.find(
      (c: { jid: string }) => c.jid === '15551234567@s.whatsapp.net'
    );
    expect(alice).toBeDefined();
    expect(alice.lastMessage).toBe('Hello from mock wacli');
    expect(alice.lastMessageFromMe).toBe(false);
  });

  it('GET /api/chats still returns chats when previews cannot be built', async () => {
    const { execWacli } = await import('../wacli/commands.js');
    const mocked = vi.mocked(execWacli);
    const original = mocked.getMockImplementation()!;

    mocked.mockImplementation(async (args: string[]) => {
      if (args.join(' ').startsWith('messages list')) {
        throw new Error('store is locked by another process');
      }
      return original(args);
    });

    try {
      const res = await request(app).get('/api/chats');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].lastMessage).toBeNull();
    } finally {
      mocked.mockImplementation(original);
    }
  });

  it('POST /api/daemon/restart, /start, /stop endpoints operate on process manager', async () => {
    const resRestart = await request(app).post('/api/daemon/restart');
    expect(resRestart.status).toBe(200);
    expect(resRestart.body.success).toBe(true);

    const resStop = await request(app).post('/api/daemon/stop');
    expect(resStop.status).toBe(200);
    expect(resStop.body.success).toBe(true);

    const resStart = await request(app).post('/api/daemon/start');
    expect(resStart.status).toBe(200);
    expect(resStart.body.success).toBe(true);
  });
});
