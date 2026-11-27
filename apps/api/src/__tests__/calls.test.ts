import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { WacliCommandError } from '../wacli/commands.js';
import { collapseCallEvents } from '../wacli/calls.js';
import type { RawCallEvent } from '../types.js';

const ADA = '15550100@s.whatsapp.net';
const ME = '15550199@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

function ev(callId: string, event_type: string, at: string, extra: Partial<RawCallEvent> = {}): RawCallEvent {
  return {
    call_id: callId,
    event_type,
    chat_jid: ADA,
    sender_jid: ADA,
    sender_name: 'Ada Lovelace',
    direction: 'inbound',
    timestamp: `2026-11-20T${at}Z`,
    ...extra,
  };
}

const execWacli = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli };
});

describe('collapseCallEvents', () => {
  it('reads each way a live call can end', () => {
    const calls = collapseCallEvents([
      // Answered on the phone: the accept is filed under our own JID.
      ev('A', 'offer', '10:00:00', { media: 'video' }),
      ev('A', 'accept', '10:00:04', { chat_jid: ME }),
      ev('A', 'terminate', '10:00:04', { reason: 'accepted_elsewhere' }),
      // Declined on the phone.
      ev('B', 'offer', '11:00:00'),
      ev('B', 'reject', '11:00:05', { chat_jid: ME }),
      // The caller gave up.
      ev('C', 'offer', '12:00:00'),
      ev('C', 'relay_latency', '12:00:01'),
      ev('C', 'terminate', '12:00:20'),
      // Rang, and nothing more was seen.
      ev('D', 'offer', '13:00:00'),
    ]);

    expect(calls.map((c) => [c.callId, c.outcome, c.chatJid])).toEqual([
      ['A', 'answered', ADA],
      ['B', 'declined', ADA],
      ['C', 'missed', ADA],
      ['D', 'unknown', ADA],
    ]);
    expect(calls[0]).toMatchObject({ video: true, callerName: 'Ada Lovelace', ts: '2026-11-20T10:00:00Z' });
    expect(calls[1].video).toBe(false);
  });

  it('files a group call under its group, not knowing whether we joined', () => {
    const [call] = collapseCallEvents([
      ev('G', 'offer', '09:00:00', { chat_jid: GROUP }),
      ev('G', 'terminate', '09:30:00', { chat_jid: 'G@call', reason: 'group_call_ended' }),
    ]);
    expect(call).toMatchObject({ chatJid: GROUP, group: true, outcome: 'unknown' });
  });

  it("trusts the phone's call log, with its duration and direction", () => {
    const calls = collapseCallEvents([
      ev('L1', 'call_log', '08:00:00', {
        direction: 'outbound',
        outcome: 'connected',
        duration_secs: 125,
        sender_jid: ME,
        sender_name: 'Me',
      }),
      ev('L2', 'call_log', '08:30:00', { direction: 'outbound', outcome: 'missed', duration_secs: 0 }),
      ev('L3', 'call_log', '07:00:00', { outcome: 'rejected' }),
    ]);
    expect(calls.map((c) => [c.callId, c.direction, c.outcome, c.durationSecs])).toEqual([
      ['L3', 'inbound', 'declined', null],
      ['L1', 'outbound', 'answered', 125],
      ['L2', 'outbound', 'missed', null],
    ]);
  });

  it('lets a call log overrule the live events of the same call', () => {
    const [call] = collapseCallEvents([
      ev('X', 'offer', '10:00:00'),
      ev('X', 'terminate', '10:00:20'),
      ev('X', 'call_log', '10:00:00', { outcome: 'connected', duration_secs: 60 }),
    ]);
    expect(call).toMatchObject({ outcome: 'answered', durationSecs: 60 });
  });
});

describe('GET /api/calls', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    execWacli.mockReset();
  });

  it("returns one chat's calls in the window, reading events past its edges", async () => {
    execWacli.mockResolvedValue({
      calls: [
        ev('IN', 'offer', '10:00:00'),
        ev('IN', 'accept', '10:00:03', { chat_jid: ME }),
        ev('EARLY', 'offer', '08:00:00'),
        ev('OTHER', 'offer', '10:00:00', { chat_jid: GROUP }),
      ],
    });

    const res = await request(app)
      .get('/api/calls')
      .query({ chat: ADA, after: '2026-11-20T09:00:00Z', before: '2026-11-20T11:00:00Z' });

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(true);
    expect(res.body.data.calls.map((c: { callId: string; outcome: string }) => [c.callId, c.outcome])).toEqual([
      ['IN', 'answered'],
    ]);

    const args = execWacli.mock.calls[0][0] as string[];
    expect(args.slice(0, 2)).toEqual(['calls', 'list']);
    expect(args).not.toContain('--chat');
    expect(args[args.indexOf('--after') + 1]).toBe('2026-11-20T08:00:00.000Z');
    expect(args[args.indexOf('--before') + 1]).toBe('2026-11-20T12:00:00.000Z');
  });

  it('answers with no calls when wacli predates the calls command', async () => {
    execWacli.mockRejectedValue(new WacliCommandError('Error: unknown command "calls" for "wacli"'));
    const res = await request(app).get('/api/calls').query({ chat: ADA });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ calls: [], supported: false });
  });

  it('refuses a missing chat or an unreadable time', async () => {
    expect((await request(app).get('/api/calls')).status).toBe(400);
    expect((await request(app).get('/api/calls').query({ chat: ADA, after: 'soon' })).status).toBe(400);
    expect(execWacli).not.toHaveBeenCalled();
  });
});
