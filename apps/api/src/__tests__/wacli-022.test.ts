import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());
const checkInstalledMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock, checkWacliInstalled: checkInstalledMock };
});

import { createApp } from '../index.js';
import { resetMarkReadReceipts } from '../routes/chats.js';
import { versionAtLeast } from '../wacli/capabilities.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

const CHAT = '15550100001@s.whatsapp.net';

function installed(version: string) {
  checkInstalledMock.mockResolvedValue({ installed: true, version: `wacli ${version}`, binPath: 'wacli', error: null });
}

/** Up, connected, and counting any attempt to take it down. */
function connectedDaemon() {
  const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
  vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(
    () => {}
  );
  const child = Object.assign(new EventEmitter(), {
    killed: false,
    kill: vi.fn(function (this: EventEmitter) {
      setImmediate(() => this.emit('close', 0, 'SIGINT'));
      return true;
    }),
  });
  const internals = pm as unknown as { child: unknown; handleStderrLine: (line: string) => void };
  internals.child = child;
  pm.start();
  internals.handleStderrLine(JSON.stringify({ event: 'connected' }));
  return { pm, child };
}

const handedOver = expect.objectContaining({ allowMutation: true, lockRetryAttempts: 1 });

describe('versionAtLeast', () => {
  it('compares wacli --version output against a release', () => {
    expect(versionAtLeast('wacli 0.22.0', [0, 22, 0])).toBe(true);
    expect(versionAtLeast('wacli 0.22.3', [0, 22, 0])).toBe(true);
    expect(versionAtLeast('wacli 1.0.0', [0, 22, 0])).toBe(true);
    expect(versionAtLeast('wacli 0.21.9', [0, 22, 0])).toBe(false);
    // A build that prints no number gets none of the newer flags.
    expect(versionAtLeast('wacli dev', [0, 22, 0])).toBe(false);
    expect(versionAtLeast(null, [0, 22, 0])).toBe(false);
  });
});

describe('wacli 0.22 features', () => {
  let pm: WacliProcessManager;
  let child: ReturnType<typeof connectedDaemon>['child'];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ pm, child } = connectedDaemon());
    app = createApp(pm);
    modeManager.setReadOnly(false);
    resetMarkReadReceipts();
    execWacliMock.mockReset();
    installed('0.22.0');
  });

  afterEach(() => {
    modeManager.setReadOnly(true);
    pm.dispose();
  });

  describe('mark-read through a message', () => {
    const markRead = (body: Record<string, unknown>) =>
      request(app).post('/api/chats/mark-read').send({ chat: CHAT, ...body });

    it('stops at the message the operator last had on screen', async () => {
      execWacliMock.mockResolvedValue({ receipts: 2 });

      const res = await markRead({ through: 'MSG-SEEN' });

      expect(execWacliMock).toHaveBeenCalledExactlyOnceWith(
        ['chats', 'mark-read', '--chat', CHAT, '--receipts', '--through-message-id', 'MSG-SEEN'],
        handedOver
      );
      expect(res.body.data).toMatchObject({ marked: true, through: 'MSG-SEEN', localOnly: false });
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('says when nothing was there to acknowledge, so no sender heard of it', async () => {
      execWacliMock.mockResolvedValue({ receipts: 0, local_only: true });

      const res = await markRead({ through: 'MSG-SEEN' });

      expect(res.body.data.localOnly).toBe(true);
    });

    it('marks the whole chat, as before, on a wacli without boundaries', async () => {
      installed('0.21.0');
      execWacliMock.mockResolvedValue({});

      const res = await markRead({ through: 'MSG-SEEN' });

      expect(execWacliMock.mock.calls[0][0]).not.toContain('--through-message-id');
      expect(res.body.data.through).toBeNull();
    });

    it('marks the whole chat when wacli will not stop at that message', async () => {
      execWacliMock
        .mockRejectedValueOnce(
          new Error(`read boundary "MSG-NOTICE" must be a stored inbound message in chat ${CHAT}: sql: no rows in result set`)
        )
        .mockResolvedValue({});

      const res = await markRead({ through: 'MSG-NOTICE' });

      expect(execWacliMock.mock.calls.map(([args]) => args)).toEqual([
        ['chats', 'mark-read', '--chat', CHAT, '--receipts', '--through-message-id', 'MSG-NOTICE'],
        ['chats', 'mark-read', '--chat', CHAT, '--receipts'],
      ]);
      expect(res.body.data).toMatchObject({ marked: true, through: null });
    });

    it('marks the whole chat when the running daemon predates the flag', async () => {
      execWacliMock
        .mockRejectedValueOnce(
          new Error(
            'the running sync process does not support --through-message-id and left the chat unread; ' +
              'restart `wacli sync` after upgrading, then run this again'
          )
        )
        .mockResolvedValue({});

      const res = await markRead({ through: 'MSG-SEEN' });

      expect(execWacliMock).toHaveBeenCalledTimes(2);
      expect(res.body.data.marked).toBe(true);
    });

    it('does not retry a boundary that failed for another reason', async () => {
      execWacliMock.mockRejectedValue(new Error('send read receipts: connection lost'));

      const res = await markRead({ through: 'MSG-SEEN' });

      expect(execWacliMock).toHaveBeenCalledTimes(1);
      expect(res.body.data.marked).toBe(false);
    });

    it('never hands wacli an id it would refuse', async () => {
      execWacliMock.mockResolvedValue({});

      await markRead({ through: ' MSG-SEEN ' });
      await markRead({ through: 42 });

      for (const [args] of execWacliMock.mock.calls) {
        expect(args).not.toContain('--through-message-id');
      }
    });
  });

  describe('media WhatsApp no longer has', () => {
    const download = (body: Record<string, unknown> = {}) =>
      request(app).post('/api/media/download').send({ chat: CHAT, id: 'MSG-PHOTO', ...body });

    it('answers a plain retry with what to try next, not a server error', async () => {
      execWacliMock.mockRejectedValue(
        new Error('failed to download media: unexpected status code 403 Forbidden')
      );

      const res = await download();

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('MEDIA_EXPIRED');
      expect(res.body.error).toMatch(/phone may still have it/);
    });

    it('still reports any other failure as one', async () => {
      execWacliMock.mockRejectedValue(new Error('failed to download media: i/o timeout'));

      const res = await download();

      expect(res.status).toBe(500);
    });

    it('asks the phone through the running daemon, without taking it down', async () => {
      execWacliMock.mockResolvedValue({ path: '/store/media/MSG-PHOTO.jpg', source: 'phone' });

      const res = await download({ fromPhone: true });

      expect(res.status).toBe(200);
      expect(res.body.data.source).toBe('phone');
      const [args, options] = execWacliMock.mock.calls[0];
      expect(args).toContain('--retry-on-phone');
      expect(options).toEqual(handedOver);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it('does not ask the phone in safe mode', async () => {
      modeManager.setReadOnly(true);

      const res = await download({ fromPhone: true });

      expect(res.status).toBe(403);
      expect(execWacliMock).not.toHaveBeenCalled();
    });

    it('says which wacli it takes, rather than passing an unknown flag', async () => {
      installed('0.21.0');

      const res = await download({ fromPhone: true });

      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/0\.22/);
      expect(execWacliMock).not.toHaveBeenCalled();
    });

    it('treats a phone that did not answer as silence, not deletion', async () => {
      execWacliMock.mockRejectedValue(
        new Error(`media recovery no_response for ${CHAT}/MSG-PHOTO: no notification before deadline`)
      );

      const res = await download({ fromPhone: true });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PHONE_RECOVERY_FAILED');
      expect(res.body.error).toMatch(/did not answer/);
    });
  });

  describe('paging', () => {
    const page = (hasMore: boolean) => ({
      fts: false,
      messages: [{ ChatJID: CHAT, MsgID: 'MSG-1', Timestamp: '2026-09-01T10:00:00Z', Text: 'hi' }],
      page: { has_more: hasMore, next_cursor: hasMore ? 'opaque' : '' },
    });

    it("takes wacli's word for whether there is more", async () => {
      execWacliMock.mockResolvedValue(page(false));
      // A full page that wacli says is the last one.
      const res = await request(app).get(`/api/messages?chat=${CHAT}&limit=1`);
      expect(res.body.data.hasMore).toBe(false);

      execWacliMock.mockResolvedValue(page(true));
      const more = await request(app).get(`/api/messages?chat=${CHAT}&limit=5`);
      expect(more.body.data.hasMore).toBe(true);
    });

    it('does not call an export truncated when it ends exactly at the limit', async () => {
      execWacliMock.mockResolvedValue(page(false));

      const res = await request(app).get(`/api/messages/export?chat=${CHAT}&limit=1`);

      expect(res.body.data.truncated).toBe(false);
    });
  });
});
