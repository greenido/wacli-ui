import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());
const checkInstalledMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock, checkWacliInstalled: checkInstalledMock };
});

import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

const ADA = '15550100001@s.whatsapp.net';
const ENGINE_CLUB = '120363000000000001@g.us';

function installed(version: string) {
  checkInstalledMock.mockResolvedValue({ installed: true, version: `wacli ${version}`, binPath: 'wacli', error: null });
}

function app() {
  return createApp(new WacliProcessManager({ apiPort: 3002 }));
}

function page(changes: Array<Record<string, string>>, next: string, more = false) {
  return { store_id: 'store-1', changes, has_more: more, next_checkpoint: next };
}

const args = () => execWacliMock.mock.calls.map(([a]) => a as string[]);

describe('GET /api/changes', () => {
  beforeEach(() => {
    execWacliMock.mockReset();
    installed('0.26.1');
  });

  it('starts from a fresh checkpoint when asked without one', async () => {
    execWacliMock.mockResolvedValue(page([], 'CKPT0'));

    const res = await request(app()).get('/api/changes');

    expect(res.body.data).toEqual({ supported: true, checkpoint: 'CKPT0', chats: [], reset: true });
    expect(args()).toEqual([['messages', 'changes', '--checkpoint']]);
  });

  it('names each changed chat once, and where to read from next', async () => {
    execWacliMock.mockResolvedValue(
      page(
        [
          { operation: 'upsert', chat_jid: ADA, msg_id: 'MSG000001' },
          { operation: 'upsert', chat_jid: ADA, msg_id: 'MSG000002' },
          { operation: 'delete', chat_jid: ENGINE_CLUB, msg_id: 'MSG000003' },
        ],
        'CKPT2'
      )
    );

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(res.body.data).toEqual({ supported: true, checkpoint: 'CKPT2', chats: [ADA, ENGINE_CLUB], reset: false });
    // `=`, so a checkpoint starting with "-" cannot read as a flag.
    expect(args()).toEqual([['messages', 'changes', '--since=CKPT1', '--limit', '1000']]);
  });

  it('counts both ends of a message that moved chats', async () => {
    execWacliMock.mockResolvedValue(
      page([{ operation: 'identity_move', chat_jid: 'old@lid', new_chat_jid: ADA, msg_id: 'M' }], 'CKPT2')
    );

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(res.body.data.chats).toEqual(['old@lid', ADA]);
  });

  it('reads on while wacli has more, from each next checkpoint', async () => {
    execWacliMock
      .mockResolvedValueOnce(page([{ chat_jid: ADA }], 'CKPT2', true))
      .mockResolvedValueOnce(page([{ chat_jid: ENGINE_CLUB }], 'CKPT3'));

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(res.body.data).toMatchObject({ checkpoint: 'CKPT3', chats: [ADA, ENGINE_CLUB], reset: false });
    expect(args()[1]).toContain('--since=CKPT2');
  });

  it('gives up listing past three pages and says refresh everything', async () => {
    execWacliMock.mockResolvedValue(page([{ chat_jid: ADA }], 'CKPTN', true));

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(execWacliMock).toHaveBeenCalledTimes(3);
    expect(res.body.data).toEqual({ supported: true, checkpoint: 'CKPTN', chats: [], reset: true });
  });

  it.each([
    'expired checkpoint: obtain a fresh --checkpoint before a full export',
    'checkpoint belongs to another store',
    'malformed cursor/checkpoint; restart the read',
  ])('starts over when wacli says: %s', async (refusal) => {
    execWacliMock.mockRejectedValueOnce(new Error(refusal)).mockResolvedValueOnce(page([], 'FRESH'));

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(res.body.data).toEqual({ supported: true, checkpoint: 'FRESH', chats: [], reset: true });
    expect(args()[1]).toEqual(['messages', 'changes', '--checkpoint']);
  });

  it('says unsupported on a wacli older than 0.22, without asking it', async () => {
    installed('0.21.0');

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(res.body.data).toEqual({ supported: false, checkpoint: null, chats: [], reset: false });
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it('says unsupported on a store no writable wacli has migrated yet', async () => {
    execWacliMock.mockRejectedValue(new Error('changes requires a writable store migration before read-only use'));

    const res = await request(app()).get('/api/changes');

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
  });

  it('reports any other failure', async () => {
    execWacliMock.mockRejectedValue(new Error('database is locked'));

    const res = await request(app()).get('/api/changes').query({ since: 'CKPT1' });

    expect(res.status).toBe(500);
  });

  it.each(['beginning', 'a b', '--help=1', 'x'.repeat(2049)])('refuses %s as a checkpoint', async (since) => {
    // `beginning` is a real wacli spelling, for a replay of every change ever.
    const res = await request(app()).get('/api/changes').query({ since });

    expect(res.status).toBe(400);
    expect(execWacliMock).not.toHaveBeenCalled();
  });
});
