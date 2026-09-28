import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import { resetMarkReadReceipts } from '../routes/chats.js';
import { POST_SEND_WAIT } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { Scheduler } from '../wacli/scheduler.js';
import { StoreLockedError } from '../wacli/store-lock.js';

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

/** The --post-send-wait the first call to wacli was given. */
function postSendWait(): string | undefined {
  const args = execWacliMock.mock.calls[0][0] as string[];
  const index = args.indexOf('--post-send-wait');
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Every caller that sends through wacli hands the send to a connected daemon,
 * which stays up. Any one of them left on executeExclusive would take the
 * daemon off WhatsApp for its sends, and nothing else would notice.
 */
describe('Sends handed to the running daemon', () => {
  let pm: WacliProcessManager;
  let child: ReturnType<typeof connectedDaemon>['child'];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ pm, child } = connectedDaemon());
    app = createApp(pm);
    modeManager.setReadOnly(false);
    resetMarkReadReceipts();
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue({ sent: true, id: 'STUBMSG0001' });
  });

  afterEach(() => {
    modeManager.setReadOnly(true);
    pm.dispose();
  });

  it('a text', async () => {
    const res = await request(app)
      .post('/api/send/text')
      .send({ to: '15550100001@s.whatsapp.net', message: 'Good morning', confirm: true });

    expect(res.status).toBe(200);
    expect(execWacliMock).toHaveBeenCalledWith(expect.arrayContaining(['send', 'text']), handedOver);
    expect(child.kill).not.toHaveBeenCalled();
  });

  /**
   * The daemon sits out --post-send-wait before it answers, and runs nothing
   * else it was handed meanwhile, while staying connected for retry receipts
   * either way. Any wait here is only delay on every send.
   */
  it('without waiting after the send', async () => {
    await request(app)
      .post('/api/send/text')
      .send({ to: '15550100001@s.whatsapp.net', message: 'Good morning', confirm: true });
    expect(postSendWait()).toBe('0s');

    execWacliMock.mockClear();
    await request(app)
      .post('/api/send/file')
      .field('to', '15550100001@s.whatsapp.net')
      .field('confirm', 'true')
      .attach('file', Buffer.from('%PDF-1.7 minutes'), 'minutes.pdf');
    expect(postSendWait()).toBe('0s');

    execWacliMock.mockClear();
    await request(app)
      .post('/api/send/react')
      .send({ to: '15550100001@s.whatsapp.net', id: 'STUBMSG0002', reaction: '👍', confirm: true });
    expect(postSendWait()).toBe('0s');
  });

  it('but waits when the daemon would not take the send and the CLI sends it itself', async () => {
    execWacliMock
      .mockRejectedValueOnce(new StoreLockedError('store is locked (another wacli is running?)', null))
      .mockResolvedValueOnce({ sent: true, id: 'STUBMSG0001' });

    const res = await request(app)
      .post('/api/send/text')
      .send({ to: '15550100001@s.whatsapp.net', message: 'Good morning', confirm: true });

    expect(res.status).toBe(200);
    const waits = execWacliMock.mock.calls.map(([args]) => {
      const list = args as string[];
      return list[list.indexOf('--post-send-wait') + 1];
    });
    expect(waits).toEqual(['0s', POST_SEND_WAIT]);
  });

  it('a file', async () => {
    const res = await request(app)
      .post('/api/send/file')
      .field('to', '15550100001@s.whatsapp.net')
      .field('confirm', 'true')
      .attach('file', Buffer.from('%PDF-1.7 minutes'), 'minutes.pdf');

    expect(res.status).toBe(200);
    expect(execWacliMock).toHaveBeenCalledWith(expect.arrayContaining(['send', 'file']), handedOver);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('a reaction', async () => {
    const res = await request(app)
      .post('/api/send/react')
      .send({ to: '15550100001@s.whatsapp.net', id: 'STUBMSG0002', reaction: '👍', confirm: true });

    expect(res.status).toBe(200);
    expect(execWacliMock).toHaveBeenCalledWith(expect.arrayContaining(['send', 'react']), handedOver);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('a read receipt', async () => {
    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550100001@s.whatsapp.net' });

    expect(res.body.data.marked).toBe(true);
    expect(execWacliMock).toHaveBeenCalledWith(
      ['chats', 'mark-read', '--chat', '15550100001@s.whatsapp.net', '--receipts'],
      handedOver
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('a read receipt the daemon is too old to send as receipts goes the chat-state way', async () => {
    execWacliMock
      .mockRejectedValueOnce(
        new Error(
          'the running sync process does not support --receipts and left the chat unread; ' +
            'restart `wacli sync` after upgrading, then run this again'
        )
      )
      .mockResolvedValue(null);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550100001@s.whatsapp.net' });

    expect(res.body.data.marked).toBe(true);
    expect(execWacliMock.mock.calls.map(([args]) => args)).toEqual([
      ['chats', 'mark-read', '--chat', '15550100001@s.whatsapp.net', '--receipts'],
      ['chats', 'mark-read', '--chat', '15550100001@s.whatsapp.net'],
    ]);

    // A restarted daemon may take it, so the next one asks again.
    execWacliMock.mockClear();
    await request(app).post('/api/chats/mark-read').send({ chat: '15550100001@s.whatsapp.net' });
    expect(execWacliMock.mock.calls[0][0]).toContain('--receipts');
  });

  it('a wacli without --receipts is not asked for it again', async () => {
    execWacliMock
      .mockRejectedValueOnce(new Error('unknown flag: --receipts'))
      .mockResolvedValue(null);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550100001@s.whatsapp.net' });
    expect(res.body.data.marked).toBe(true);

    execWacliMock.mockClear();
    await request(app).post('/api/chats/mark-read').send({ chat: '15550100001@s.whatsapp.net' });
    expect(execWacliMock.mock.calls.map(([args]) => args)).toEqual([
      ['chats', 'mark-read', '--chat', '15550100001@s.whatsapp.net'],
    ]);
  });

  it('a read receipt that failed for any other reason is not retried', async () => {
    execWacliMock.mockRejectedValue(new Error('send read receipts: connection lost'));

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550100001@s.whatsapp.net' });

    expect(res.body.data.marked).toBe(false);
    expect(execWacliMock).toHaveBeenCalledTimes(1);
  });

  it('a scheduled message', async () => {
    const dbFile = path.join(os.tmpdir(), `wacli-test-handed-over-${Date.now()}-${Math.random()}.db`);
    const scheduler = new Scheduler(dbFile);
    scheduler.setSendRunner(pm);

    try {
      const item = scheduler.schedule({
        to: '15550100001@s.whatsapp.net',
        message: 'Good morning',
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      });
      await scheduler.checkDueMessages();

      expect(scheduler.getPage().history.find((i) => i.id === item.id)?.status).toBe('sent');
      expect(execWacliMock).toHaveBeenCalledWith(expect.arrayContaining(['send', 'text']), handedOver);
      expect(postSendWait()).toBe('0s');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dbFile, { force: true });
    }
  });
});
