import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

/**
 * The end-to-end version of the store-lock problem: HTTP requests arriving the
 * way a browser sends them, through the real routes, down to the daemon
 * lifecycle. The unit tests prove the guard; these prove it is actually wired
 * into the path the UI uses.
 */
describe('Store lock contention through the routes', () => {
  let pm: WacliProcessManager;
  let spawn: ReturnType<typeof vi.spyOn>;

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue(null);
    modeManager.setReadOnly(false);

    pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 5 });
    spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
  });

  afterEach(() => {
    modeManager.setReadOnly(false);
  });

  it('respawns the daemon once for a single mark-read', async () => {
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15551234567@s.whatsapp.net' });
    await settle();

    expect(res.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('respawns once for a burst of mark-reads, not once per request', async () => {
    const app = createApp(pm);

    // Opening several chats quickly, which is what produced the restart storm.
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app)
          .post('/api/chats/mark-read')
          .send({ chat: `1555000${i}@s.whatsapp.net` })
      )
    );
    await settle();

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(execWacliMock).toHaveBeenCalledTimes(6);
    // The bug: six spawns, each killed milliseconds later by the next request,
    // so the daemon never survived long enough to connect.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('caps how long a read receipt may hold the daemon down', async () => {
    const app = createApp(pm);

    await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15551234567@s.whatsapp.net' });
    await settle();

    // The default 30s is a downtime budget here, not a patience setting: the
    // daemon is dead for the whole of it, so the console receives nothing.
    expect(execWacliMock).toHaveBeenCalledWith(
      ['chats', 'mark-read', '--chat', '15551234567@s.whatsapp.net'],
      expect.objectContaining({ allowMutation: true, timeoutMs: 10_000 })
    );
  });

  it('still respawns when the exclusive command fails', async () => {
    execWacliMock.mockRejectedValue(new Error('wacli chats mark-read failed'));
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15551234567@s.whatsapp.net' });
    await settle();

    // A receipt that did not land is reported, not raised: the badge is already
    // cleared in the UI and nothing reads this response. It used to be a 500,
    // which filed every slow WhatsApp connect as an unhandled server error.
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ marked: false });
    expect(res.body.data.reason).toContain('mark-read failed');

    // A failed command must never leave the store without a daemon.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pm.hasPendingExclusiveWork()).toBe(false);
  });

  it('does not pause the daemon at all when safe mode rejects the command', async () => {
    modeManager.setReadOnly(true);
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15551234567@s.whatsapp.net' });
    await settle();

    expect(res.status).toBe(403);
    // Blocked before executeExclusive, so the daemon is never disturbed.
    expect(spawn).not.toHaveBeenCalled();
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it('leaves the daemon down while commands are still queued', async () => {
    let releaseFirst: () => void = () => {};
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    execWacliMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) await firstRunning;
      return null;
    });

    const app = createApp(pm);
    const first = request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550001@s.whatsapp.net' })
      .then((r) => r);
    // Let the first command take the lock before the second queues behind it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550002@s.whatsapp.net' })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(pm.hasPendingExclusiveWork()).toBe(true);
    expect(spawn).not.toHaveBeenCalled();

    releaseFirst();
    await Promise.all([first, second]);
    await settle();

    expect(spawn).toHaveBeenCalledTimes(1);
  });
  /**
   * The regression these were written for: sends called `execWacli` directly
   * while every other mutation went through `executeExclusive`, so a send fired
   * against a running daemon lost the store lock race and came back 503 —
   * `store is locked (another wacli is running?)`. The assertion that matters is
   * that the daemon is paused and respawned, because that is the only thing
   * that frees the lock.
   */
  it('pauses the daemon for a text send instead of racing it for the lock', async () => {
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', message: 'hi', confirm: true });
    await settle();

    expect(res.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('pauses the daemon for a reaction send', async () => {
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/send/react')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', id: 'ABC123', reaction: '\u2764\ufe0f', confirm: true });
    await settle();

    expect(res.status).toBe(200);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('queues a send behind an in-flight mark-read rather than colliding with it', async () => {
    let releaseMarkRead: () => void = () => {};
    const markReadRunning = new Promise<void>((resolve) => {
      releaseMarkRead = resolve;
    });
    const order: string[] = [];
    execWacliMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'chats') {
        order.push('mark-read');
        await markReadRunning;
        return null;
      }
      order.push('send');
      return null;
    });

    const app = createApp(pm);
    const markRead = request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15550001@s.whatsapp.net' })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const send = request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15550001@s.whatsapp.net', message: 'hi', confirm: true })
      .then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The send is waiting on the mutex, not running against a held lock.
    expect(order).toEqual(['mark-read']);

    releaseMarkRead();
    const [, sendRes] = await Promise.all([markRead, send]);
    await settle();

    expect(order).toEqual(['mark-read', 'send']);
    expect(sendRes.status).toBe(200);
    // Both ran under one pause: the daemon comes back once, at the end.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not pause the daemon when safe mode blocks a send', async () => {
    modeManager.setReadOnly(true);
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', message: 'hi', confirm: true });
    await settle();

    expect(res.status).toBe(403);
    expect(spawn).not.toHaveBeenCalled();
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it('still respawns the daemon when a send fails', async () => {
    execWacliMock.mockRejectedValue(new Error('wacli send text failed'));
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', message: 'hi', confirm: true });
    await settle();

    expect(res.status).toBeGreaterThanOrEqual(400);
    // A failed send must never leave the store without a daemon.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pm.hasPendingExclusiveWork()).toBe(false);
  });
});
