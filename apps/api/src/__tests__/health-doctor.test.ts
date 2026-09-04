import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import * as commands from '../wacli/commands.js';

/** A doctor payload for a store whose lock is held by somebody else. */
const lockedDoctor = {
  store_dir: '/mock/.wacli',
  authenticated: true,
  connected: false,
  connection_state: 'locked_by_other_process',
  lock_held: true,
  linked_jid: '15551234567@s.whatsapp.net',
  store: {},
};

describe('Health doctor probe', () => {
  let installedSpy: ReturnType<typeof vi.spyOn>;
  let execSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    installedSpy = vi.spyOn(commands, 'checkWacliInstalled').mockResolvedValue({
      installed: true,
      version: 'wacli 0.17.1',
      binPath: 'wacli',
      error: null,
    });
    execSpy = vi.spyOn(commands, 'execWacli').mockResolvedValue(lockedDoctor);
  });

  afterEach(() => {
    installedSpy.mockRestore();
    execSpy.mockRestore();
  });

  /** A manager pretending to own a live, connected daemon. */
  function connectedManager() {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    vi.spyOn(pm, 'getPid').mockReturnValue(4242);
    vi.spyOn(pm, 'isDaemonConnected').mockReturnValue(true);
    vi.spyOn(pm, 'getState').mockReturnValue('running');
    return pm;
  }

  it('reports connected when the lock belongs to our own healthy daemon', async () => {
    const app = createApp(connectedManager());

    const res = await request(app).get('/api/health?fresh=1');

    // wacli doctor said locked_by_other_process, but that "other process" is
    // our daemon refusing the probe — the daemon itself is connected.
    expect(res.body.data.doctor.connected).toBe(true);
    expect(res.body.data.doctor.connectionState).toBe('connected');
    expect(res.body.data.statusSummary).toBe('ok');
  });

  it('reports connecting when our daemon holds the lock but is not up yet', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    vi.spyOn(pm, 'getPid').mockReturnValue(4242);
    vi.spyOn(pm, 'isDaemonConnected').mockReturnValue(false);
    vi.spyOn(pm, 'getState').mockReturnValue('running');
    const app = createApp(pm);

    const res = await request(app).get('/api/health?fresh=1');

    expect(res.body.data.doctor.connected).toBe(false);
    expect(res.body.data.doctor.connectionState).toBe('connecting');
  });

  it('still reports a genuine external lock when we have no daemon running', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    vi.spyOn(pm, 'getPid').mockReturnValue(null);
    vi.spyOn(pm, 'getState').mockReturnValue('stopped');
    const app = createApp(pm);

    const res = await request(app).get('/api/health?fresh=1');

    // Nothing of ours is running, so somebody else really does hold the lock
    // and the operator must be told.
    expect(res.body.data.doctor.connectionState).toBe('locked_by_other_process');
    expect(res.body.data.statusSummary).toBe('store_locked_external');
  });

  it('reuses a cached doctor result instead of probing the store every poll', async () => {
    const app = createApp(connectedManager());

    await request(app).get('/api/health?fresh=1');
    const afterFirst = execSpy.mock.calls.length;

    await request(app).get('/api/health');
    await request(app).get('/api/health');
    await request(app).get('/api/health');

    // Each probe is a store-touching command competing with the sync daemon,
    // and every open tab polls on its own timer.
    expect(execSpy.mock.calls.length).toBe(afterFirst);
  });

  it('collapses polls arriving during a slow probe into one', async () => {
    // A real `wacli doctor` is not instant, and that window is exactly when
    // several tabs' polls pile up on a cold cache.
    let releaseProbe: (value: unknown) => void = () => {};
    execSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve;
        })
    );

    const app = createApp(connectedManager());
    // .map forces supertest to actually dispatch: its Test object is lazy and
    // sends nothing until something calls .then on it.
    const polls = [
      request(app).get('/api/health'),
      request(app).get('/api/health'),
      request(app).get('/api/health'),
    ].map((pending) => pending.then((res) => res));

    // Let all three reach the handler before the probe answers.
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseProbe(lockedDoctor);
    await Promise.all(polls);

    const doctorCalls = execSpy.mock.calls.filter((call) =>
      (call[0] as string[]).join(' ').startsWith('doctor')
    );
    expect(doctorCalls.length).toBe(1);
  });

  it('bypasses the cache when the operator asks for a fresh check', async () => {
    const app = createApp(connectedManager());

    await request(app).get('/api/health');
    execSpy.mockClear();

    await request(app).get('/api/health?fresh=1');

    const doctorCalls = execSpy.mock.calls.filter((call) =>
      (call[0] as string[]).join(' ').startsWith('doctor')
    );
    expect(doctorCalls.length).toBe(1);
  });
});
