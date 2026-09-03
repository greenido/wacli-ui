import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { resetChatPreviewCache } from '../routes/chats.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

const execWacli = vi.hoisted(() =>
  vi.fn(async (args: string[]) => {
    const cmd = args.join(' ');
    if (cmd.startsWith('chats list')) {
      return [{ jid: 'alice@s.whatsapp.net', name: 'Alice', last_message_ts: '2026-09-01T10:00:00Z' }];
    }
    if (cmd.startsWith('messages list')) {
      return {
        messages: [
          {
            ChatJID: 'alice@s.whatsapp.net',
            MsgID: 'MSG-1',
            Timestamp: '2026-09-01T10:00:00Z',
            FromMe: false,
            Text: 'preview line',
          },
        ],
      };
    }
    return [];
  })
);

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli };
});

/** How many times the ~300 KB preview scan actually ran. */
function previewScans(): number {
  return execWacli.mock.calls.filter(([args]) => args.join(' ').startsWith('messages list')).length;
}

describe('chat preview cache', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    resetChatPreviewCache();
    execWacli.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('scans once for a burst of chat-list requests', async () => {
    for (let i = 0; i < 4; i++) {
      const res = await request(app).get('/api/chats');
      expect(res.status).toBe(200);
      expect(res.body.data[0].lastMessage).toBe('preview line');
    }

    expect(previewScans()).toBe(1);
  });

  it('rescans once the cache has expired, so the rail does not go stale', async () => {
    await request(app).get('/api/chats');
    expect(previewScans()).toBe(1);

    vi.setSystemTime(new Date('2026-09-01T12:00:06Z'));

    const res = await request(app).get('/api/chats');
    expect(res.body.data[0].lastMessage).toBe('preview line');
    expect(previewScans()).toBe(2);
  });

  it('does not cache a failed scan, so the next request tries again', async () => {
    const healthy = execWacli.getMockImplementation()!;
    execWacli.mockImplementation(async (args: string[]) => {
      if (args.join(' ').startsWith('messages list')) {
        throw new Error('store is locked by another process');
      }
      return healthy(args);
    });

    const failed = await request(app).get('/api/chats');
    expect(failed.status).toBe(200);
    expect(failed.body.data[0].lastMessage).toBeNull();

    execWacli.mockImplementation(healthy);

    const recovered = await request(app).get('/api/chats');
    expect(recovered.body.data[0].lastMessage).toBe('preview line');
    expect(previewScans()).toBe(2);
  });

  it('still lists the chat itself on every request, cached previews or not', async () => {
    await request(app).get('/api/chats');
    await request(app).get('/api/chats');

    const listCalls = execWacli.mock.calls.filter(([args]) => args.join(' ').startsWith('chats list'));
    expect(listCalls).toHaveLength(2);
    expect(previewScans()).toBe(1);
  });
});
