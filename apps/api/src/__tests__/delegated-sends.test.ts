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
import { activityStore } from '../wacli/activity.js';
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

/**
 * Pin, mute, archive and mark unread change the account on every linked
 * device. They go to the daemon like a send, and are refused like one in safe
 * mode.
 */
describe('Chat state changes', () => {
  const chat = '15550100001@s.whatsapp.net';
  let pm: WacliProcessManager;
  let child: ReturnType<typeof connectedDaemon>['child'];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ pm, child } = connectedDaemon());
    app = createApp(pm);
    modeManager.setReadOnly(false);
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue({ ok: true, action: 'pin', chat });
  });

  afterEach(() => {
    modeManager.setReadOnly(true);
    pm.dispose();
  });

  it.each(['pin', 'unpin', 'archive', 'unarchive', 'unmute', 'mark-unread'])(
    '%s is handed to the daemon',
    async (action) => {
      const res = await request(app).post('/api/chats/state').send({ chat, action });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ chat, action });
      expect(execWacliMock).toHaveBeenCalledWith(['chats', action, '--chat', chat], handedOver);
      expect(child.kill).not.toHaveBeenCalled();
    }
  );

  it('mutes for as long as asked', async () => {
    await request(app).post('/api/chats/state').send({ chat, action: 'mute', duration: '8h' });
    expect(execWacliMock).toHaveBeenCalledWith(
      ['chats', 'mute', '--chat', chat, '--duration', '8h'],
      handedOver
    );
  });

  it('mutes for always when no length is given', async () => {
    await request(app).post('/api/chats/state').send({ chat, action: 'mute' });
    expect(execWacliMock.mock.calls[0][0]).toEqual(['chats', 'mute', '--chat', chat, '--duration', '0']);
  });

  it('runs exclusive when an older daemon will not take it', async () => {
    execWacliMock
      .mockRejectedValueOnce(new StoreLockedError('store is locked (another wacli is running?)', null))
      .mockResolvedValueOnce({ ok: true });

    const res = await request(app).post('/api/chats/state').send({ chat, action: 'pin' });

    expect(res.status).toBe(200);
    expect(execWacliMock).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenCalled();
  });

  it('reports a failure, so the UI can take back what it showed', async () => {
    execWacliMock.mockRejectedValue(new Error('pin chat: connection lost'));

    const res = await request(app).post('/api/chats/state').send({ chat, action: 'pin' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('connection lost');
  });

  it('is refused in safe mode without reaching wacli', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app).post('/api/chats/state').send({ chat, action: 'pin' });

    expect(res.status).toBe(403);
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: 'pin' }, 'chat'],
    [{ chat: ` ${chat}`, action: 'pin' }, 'chat'],
    [{ chat, action: 'delete' }, 'action'],
    [{ chat, action: 'mark-read' }, 'action'],
    [{ chat, action: 'pin', duration: '8h' }, 'duration'],
    [{ chat, action: 'mute', duration: '8 hours' }, 'duration'],
    [{ chat, action: 'mute', duration: '--help' }, 'duration'],
    [{ chat, action: 'mute', duration: 8 }, 'duration'],
  ])('refuses %j', async (body, field) => {
    const res = await request(app).post('/api/chats/state').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`"${field}"`);
    expect(execWacliMock).not.toHaveBeenCalled();
  });
});

/**
 * Editing, unsending and forwarding reach other people's phones, so they are
 * gated like sends: safe mode refuses them and each needs confirm: true.
 */
describe('Message changes', () => {
  const chat = '15550100001@s.whatsapp.net';
  const other = '15550100002@s.whatsapp.net';
  let pm: WacliProcessManager;
  let child: ReturnType<typeof connectedDaemon>['child'];
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    ({ pm, child } = connectedDaemon());
    app = createApp(pm);
    modeManager.setReadOnly(false);
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue({ edited: true, id: 'STUBMSG0009' });
  });

  afterEach(() => {
    modeManager.setReadOnly(true);
    pm.dispose();
  });

  /** The newest activity row, which each change here writes. */
  const latestActivity = () => activityStore.list({ limit: 1 }).items[0];

  it('edits through the daemon, and logs the new text against the original', async () => {
    const res = await request(app)
      .post('/api/messages/edit')
      .send({ chat, id: 'STUBMSG0001', message: 'Coffee at ten', chatName: 'Ada', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ edited: true, chat, id: 'STUBMSG0001' });
    expect(execWacliMock).toHaveBeenCalledWith(
      ['messages', 'edit', '--chat', chat, '--id', 'STUBMSG0001', '--message', 'Coffee at ten', '--post-send-wait', '0s'],
      handedOver
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(latestActivity()).toMatchObject({
      to: chat,
      chatName: 'Ada',
      message: 'Edited: Coffee at ten',
      status: 'success',
      messageId: 'STUBMSG0001',
    });
  });

  it('unsends with revoke, and logs it', async () => {
    const res = await request(app)
      .post('/api/messages/delete')
      .send({ chat, id: 'STUBMSG0001', forEveryone: true, preview: 'see you at 9', confirm: true });

    expect(res.status).toBe(200);
    expect(execWacliMock.mock.calls[0][0]).toEqual([
      'messages', 'revoke', '--chat', chat, '--id', 'STUBMSG0001', '--post-send-wait', '0s',
    ]);
    expect(latestActivity()).toMatchObject({ message: 'Deleted for everyone: see you at 9', status: 'success' });
  });

  it('deletes for me without a send-log row, since nobody else hears of it', async () => {
    const before = activityStore.list({ limit: 1 }).total;

    const res = await request(app)
      .post('/api/messages/delete')
      .send({ chat, id: 'STUBMSG0001', forEveryone: false, confirm: true });

    expect(res.status).toBe(200);
    expect(execWacliMock.mock.calls[0][0]).toEqual([
      'messages', 'delete', '--chat', chat, '--id', 'STUBMSG0001', '--for-me', '--post-send-wait', '0s',
    ]);
    expect(activityStore.list({ limit: 1 }).total).toBe(before);
  });

  it('forwards to another chat, and logs the new message id', async () => {
    execWacliMock.mockResolvedValue({ forwarded: true, id: 'STUBMSG0010' });

    const res = await request(app)
      .post('/api/messages/forward')
      .send({ chat, id: 'STUBMSG0001', to: other, toName: 'Charles', preview: 'minutes.pdf', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ forwarded: true, to: other, messageId: 'STUBMSG0010' });
    expect(execWacliMock.mock.calls[0][0]).toEqual([
      'messages', 'forward', '--chat', chat, '--id', 'STUBMSG0001', '--to', other, '--post-send-wait', '0s',
    ]);
    expect(latestActivity()).toMatchObject({
      to: other,
      chatName: 'Charles',
      message: 'Forwarded: minutes.pdf',
      messageId: 'STUBMSG0010',
    });
  });

  it('runs exclusive when the daemon will not take it, as wacli 0.26 does for revoke', async () => {
    execWacliMock
      .mockRejectedValueOnce(new StoreLockedError('store is locked (another wacli is running?)', null))
      .mockResolvedValueOnce({ revoked: true });

    const res = await request(app)
      .post('/api/messages/delete')
      .send({ chat, id: 'STUBMSG0001', forEveryone: true, confirm: true });

    expect(res.status).toBe(200);
    expect(child.kill).toHaveBeenCalled();
    // On its own connection the CLI has to wait for retry receipts.
    expect(execWacliMock.mock.calls[1][0]).toContain(POST_SEND_WAIT);
  });

  it("answers wacli's refusal as 409 in wacli's words, and logs the failure", async () => {
    execWacliMock.mockRejectedValue(
      new Error("message STUBMSG0001 is older than WhatsApp's 20m0s edit window")
    );

    const res = await request(app)
      .post('/api/messages/edit')
      .send({ chat, id: 'STUBMSG0001', message: 'too late', confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('edit window');
    expect(latestActivity()).toMatchObject({ status: 'error' });
  });

  it('answers any other failure as a server error', async () => {
    execWacliMock.mockRejectedValue(new Error('forward: connection lost'));

    const res = await request(app)
      .post('/api/messages/forward')
      .send({ chat, id: 'STUBMSG0001', to: other, confirm: true });

    expect(res.status).toBe(500);
  });

  it.each([
    ['/api/messages/edit', { chat, id: 'STUBMSG0001', message: 'hi', confirm: true }],
    ['/api/messages/delete', { chat, id: 'STUBMSG0001', forEveryone: true, confirm: true }],
    ['/api/messages/forward', { chat, id: 'STUBMSG0001', to: other, confirm: true }],
  ])('%s is refused in safe mode without reaching wacli', async (route, body) => {
    modeManager.setReadOnly(true);

    const res = await request(app).post(route).send(body);

    expect(res.status).toBe(403);
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it.each([
    ['/api/messages/edit', { chat, id: 'STUBMSG0001', message: 'hi' }],
    ['/api/messages/edit', { chat, id: 'STUBMSG0001', message: '   ', confirm: true }],
    ['/api/messages/edit', { chat, message: 'hi', confirm: true }],
    ['/api/messages/delete', { chat, id: 'STUBMSG0001', confirm: true }],
    ['/api/messages/delete', { chat, id: ' STUBMSG0001', forEveryone: true, confirm: true }],
    ['/api/messages/forward', { chat, id: 'STUBMSG0001', confirm: true }],
    ['/api/messages/forward', { chat, id: 'STUBMSG0001', to: other, confirm: 'true' }],
  ])('%s refuses %j', async (route, body) => {
    const res = await request(app).post(route).send(body);

    expect(res.status).toBe(400);
    expect(execWacliMock).not.toHaveBeenCalled();
  });
});
