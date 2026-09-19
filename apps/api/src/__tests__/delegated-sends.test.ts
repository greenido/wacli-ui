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
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { Scheduler } from '../wacli/scheduler.js';

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
    expect(execWacliMock).toHaveBeenCalledWith(['chats', 'mark-read', '--chat', '15550100001@s.whatsapp.net'], handedOver);
    expect(child.kill).not.toHaveBeenCalled();
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
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dbFile, { force: true });
    }
  });
});
