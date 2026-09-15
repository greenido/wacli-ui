import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../index.js';
import { resetChatPreviewCache } from '../routes/chats.js';
import { resetGroupNameCache } from '../wacli/group-names.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { EventBridge } from '../ws/event-bridge.js';
import type { MissionControlEvent, UnifiedChat } from '../types.js';

const OPS = '120363111111111111@g.us';
const UNNAMED = '120363222222222222@g.us';
const BOB = '15550100002@s.whatsapp.net';

/** A message Bob sent to the group, stamped the way wacli stamps it: with Bob's name. */
const bobInOps = {
  ChatJID: OPS,
  ChatName: 'Bob',
  MsgID: 'MSG-OPS-1',
  SenderJID: BOB,
  SenderName: 'Bob',
  Timestamp: '2026-09-01T10:00:00Z',
  FromMe: false,
  Text: 'standup moved to 10',
};

/**
 * What wacli holds for an active group: its chat row renamed after whoever
 * spoke last, and only the group table still carrying the subject.
 */
function wacli(args: string[]): unknown {
  const cmd = args.join(' ');
  if (cmd.startsWith('chats list')) {
    return [
      { jid: OPS, kind: 'group', name: 'Bob', last_message_ts: '2026-09-01T10:00:00Z' },
      { jid: UNNAMED, kind: 'group', name: '', last_message_ts: '2026-09-01T09:00:00Z' },
      { jid: BOB, kind: 'dm', name: 'Bob', last_message_ts: '2026-09-01T08:00:00Z' },
    ];
  }
  if (cmd.startsWith('groups list')) {
    return [
      { JID: OPS, Name: 'Ops Team' },
      { JID: UNNAMED, Name: '' },
    ];
  }
  if (cmd.startsWith('messages search') || cmd.startsWith('messages export')) {
    return { messages: [bobInOps] };
  }
  return { messages: [] };
}

const execWacli = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli };
});

function groupReads(): string[][] {
  return execWacli.mock.calls.map(([args]) => args as string[]).filter((args) => args[0] === 'groups');
}

function nameOf(chats: UnifiedChat[], jid: string): string | undefined {
  return chats.find((chat) => chat.jid === jid)?.name;
}

describe('group names', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const bridge = new EventBridge();
  const app = createApp(pm, bridge);

  beforeEach(() => {
    resetChatPreviewCache();
    resetGroupNameCache();
    execWacli.mockReset();
    execWacli.mockImplementation(async (args: string[]) => wacli(args));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('lists a group under its subject, not the member wacli named its chat after', async () => {
    const res = await request(app).get('/api/chats');

    expect(res.status).toBe(200);
    expect(nameOf(res.body.data, OPS)).toBe('Ops Team');
  });

  it('leaves a group with no subject on record, and every DM, named as before', async () => {
    const res = await request(app).get('/api/chats');

    expect(nameOf(res.body.data, UNNAMED)).toBe('Group 222222');
    expect(nameOf(res.body.data, BOB)).toBe('Bob');
  });

  it('asks for every group rather than the first fifty wacli returns by default', async () => {
    await request(app).get('/api/chats');

    const [args] = groupReads();
    const limit = Number(args[args.indexOf('--limit') + 1]);
    expect(limit).toBeGreaterThanOrEqual(10_000);
  });

  it('reads the group table once for a burst of chat-list requests', async () => {
    for (let i = 0; i < 3; i++) {
      await request(app).get('/api/chats');
    }

    expect(groupReads()).toHaveLength(1);
  });

  it('still serves the rail when the group table cannot be read, and tries again next time', async () => {
    execWacli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'groups') throw new Error('store is locked by another process');
      return wacli(args);
    });

    const failed = await request(app).get('/api/chats');
    expect(failed.status).toBe(200);
    // Degraded to wacli's own name, not broken.
    expect(nameOf(failed.body.data, OPS)).toBe('Bob');

    execWacli.mockImplementation(async (args: string[]) => wacli(args));

    const recovered = await request(app).get('/api/chats');
    expect(nameOf(recovered.body.data, OPS)).toBe('Ops Team');
  });

  it('keeps the last subjects it read when a later read fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'));
    await request(app).get('/api/chats');

    vi.setSystemTime(new Date('2026-09-01T12:05:00Z'));
    execWacli.mockImplementation(async (args: string[]) => {
      if (args[0] === 'groups') throw new Error('store is locked by another process');
      return wacli(args);
    });

    const res = await request(app).get('/api/chats');
    expect(groupReads()).toHaveLength(2);
    expect(nameOf(res.body.data, OPS)).toBe('Ops Team');
  });

  it('names the chat of a search hit in a group by its subject', async () => {
    const res = await request(app).get('/api/search?q=standup');

    expect(res.status).toBe(200);
    expect(res.body.data.results[0].chatName).toBe('Ops Team');
  });

  it('names an exported group conversation by its subject', async () => {
    const res = await request(app).get(`/api/messages/export?chat=${encodeURIComponent(OPS)}`);

    expect(res.status).toBe(200);
    expect(res.body.data.chatName).toBe('Ops Team');
    expect(res.body.data.messages[0].chatName).toBe('Ops Team');
  });

  it('names a live group message by its subject without holding the webhook for wacli', async () => {
    const broadcast = vi.spyOn(bridge, 'broadcast');
    // The rail's own poll is what keeps the subjects in hand.
    await request(app).get('/api/chats');
    execWacli.mockClear();

    const payload = JSON.stringify({
      Chat: OPS,
      ChatName: 'Bob',
      ID: 'LIVE-OPS-1',
      SenderJID: BOB,
      SenderName: 'Bob',
      Timestamp: '2026-09-01T10:05:00Z',
      FromMe: false,
      Text: 'running late',
    });
    const signature = crypto.createHmac('sha256', pm.getWebhookSecret()).update(payload).digest('hex');

    const res = await request(app)
      .post('/internal/wacli/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Wacli-Signature', `sha256=${signature}`)
      .send(payload);

    expect(res.status).toBe(200);
    const event = broadcast.mock.calls
      .map(([sent]) => sent as MissionControlEvent)
      .find((sent) => sent.type === 'message.new');
    expect(event?.type === 'message.new' && event.data.chatName).toBe('Ops Team');
    expect(execWacli).not.toHaveBeenCalled();
  });
});
