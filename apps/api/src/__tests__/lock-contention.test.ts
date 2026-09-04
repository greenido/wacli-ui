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

  it('still respawns when the exclusive command fails', async () => {
    execWacliMock.mockRejectedValue(new Error('wacli chats mark-read failed'));
    const app = createApp(pm);

    const res = await request(app)
      .post('/api/chats/mark-read')
      .send({ chat: '15551234567@s.whatsapp.net' });
    await settle();

    expect(res.status).toBeGreaterThanOrEqual(500);
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
});
