import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp, startSyncAtBoot } from '../index.js';
import { logger } from '../logger.js';
import { ModeManager, modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { Scheduler } from '../wacli/scheduler.js';
import { SleepController } from '../wacli/sleep.js';
import type { EventBridge } from '../ws/event-bridge.js';
import type { MissionControlEvent } from '../types.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A running manager whose daemon spawn is a spy, so no wacli ever starts. */
function makeDaemon() {
  const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
  const spawn = vi
    .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
    .mockImplementation(() => {});
  pm.start();
  spawn.mockClear();
  return { pm, spawn };
}

function makeBridge() {
  const events: MissionControlEvent[] = [];
  const bridge = { broadcast: (event: MissionControlEvent) => events.push(event) };
  return { bridge: bridge as unknown as EventBridge, events };
}

function tmpDbFile(): string {
  return path.join(
    os.tmpdir(),
    `wacli-test-sleep-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
}

beforeEach(() => {
  modeManager.setSleeping(false);
  execWacliMock.mockReset();
});

describe('sleep state persistence', () => {
  it('survives a restart with the time it began', () => {
    const file = tmpDbFile();
    try {
      const asleep = new ModeManager(file).setSleeping(true);
      expect(asleep.sleeping).toBe(true);
      expect(Number.isNaN(Date.parse(asleep.since ?? ''))).toBe(false);

      // A second manager on the same file is the process after a restart.
      expect(new ModeManager(file).getSleepState()).toEqual(asleep);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it('keeps the original time when told to sleep again, and clears it on wake', () => {
    const file = tmpDbFile();
    try {
      const mode = new ModeManager(file);
      const first = mode.setSleeping(true);
      expect(mode.setSleeping(true)).toEqual(first);

      expect(mode.setSleeping(false)).toEqual({ sleeping: false, since: null });
      expect(new ModeManager(file).getSleepState()).toEqual({ sleeping: false, since: null });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});

describe('SleepController', () => {
  it('persists and announces sleep, then stops the daemon', async () => {
    const { pm } = makeDaemon();
    const stop = vi.spyOn(pm, 'stop');
    const { bridge, events } = makeBridge();

    const state = await new SleepController({ daemon: pm, bridge }).sleep('test');

    expect(state.sleeping).toBe(true);
    expect(modeManager.isSleeping()).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(pm.getState()).toBe('stopped');
    expect(events).toEqual([expect.objectContaining({ type: 'sleep.changed', data: state })]);
  });

  it('treats a repeated sleep or wake as a no-op', async () => {
    const { pm } = makeDaemon();
    const stop = vi.spyOn(pm, 'stop');
    const startSoon = vi.spyOn(pm, 'startSoon');
    const { bridge, events } = makeBridge();
    const sleep = new SleepController({ daemon: pm, bridge });

    const first = await sleep.sleep('test');
    expect(await sleep.sleep('again')).toEqual(first);
    expect(stop).toHaveBeenCalledTimes(1);

    sleep.wake('test');
    sleep.wake('again');
    expect(startSoon).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(2);
  });

  it('brings the daemon back on wake', async () => {
    const { pm, spawn } = makeDaemon();
    const sleep = new SleepController({ daemon: pm });

    await sleep.sleep('test');
    sleep.wake('test');
    await tick();

    expect(modeManager.isSleeping()).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('never starts a daemon on wake under --no-sync', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    const sleep = new SleepController({ daemon: pm, syncDisabled: true });

    await sleep.sleep('test');
    sleep.wake('test');
    await tick();

    expect(modeManager.isSleeping()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('logs every change with its reason', async () => {
    const info = vi.spyOn(logger, 'info');
    const sleep = new SleepController({ daemon: makeDaemon().pm });

    await sleep.sleep('moon button');
    sleep.wake('open chat');

    expect(info).toHaveBeenCalledWith('process', 'Sleep mode on', { reason: 'moon button' });
    expect(info).toHaveBeenCalledWith('process', 'Sleep mode off', { reason: 'open chat' });
    info.mockRestore();
  });
});

describe('/api/sleep', () => {
  it('reports awake by default', async () => {
    const res = await request(createApp(makeDaemon().pm)).get('/api/sleep');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sleeping: false, since: null });
  });

  it('puts the app to sleep, stops the daemon, and tells every tab', async () => {
    const { pm } = makeDaemon();
    const { bridge, events } = makeBridge();
    const app = createApp(pm, bridge);

    const res = await request(app).post('/api/sleep').send({ sleeping: true, reason: 'moon' });

    expect(res.status).toBe(200);
    expect(res.body.data.sleeping).toBe(true);
    expect(pm.getState()).toBe('stopped');
    expect(events.filter((e) => e.type === 'sleep.changed')).toHaveLength(1);
    expect((await request(app).get('/api/sleep')).body.data).toEqual(res.body.data);
  });

  it('answers a repeated request with the original state', async () => {
    const app = createApp(makeDaemon().pm);

    const first = await request(app).post('/api/sleep').send({ sleeping: true });
    const second = await request(app).post('/api/sleep').send({ sleeping: true });

    expect(second.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
  });

  it('wakes the app and brings the daemon back', async () => {
    const { pm, spawn } = makeDaemon();
    const app = createApp(pm);

    await request(app).post('/api/sleep').send({ sleeping: true });
    const res = await request(app).post('/api/sleep').send({ sleeping: false });
    await tick();

    expect(res.body.data).toEqual({ sleeping: false, since: null });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects anything but a boolean', async () => {
    const res = await request(createApp(makeDaemon().pm))
      .post('/api/sleep')
      
      .send({ sleeping: 'yes' });

    expect(res.status).toBe(400);
    expect(modeManager.isSleeping()).toBe(false);
  });

  it('will not be put to sleep by another page', async () => {
    // Sleep stops the daemon, and a simple cross-origin POST runs even when the
    // browser hides its answer.
    const res = await request(createApp(makeDaemon().pm))
      .post('/api/sleep')
      .set('Origin', 'https://evil.example')
      .send({ sleeping: true });

    expect(res.status).toBe(403);
    expect(modeManager.isSleeping()).toBe(false);
  });
});

describe('startSyncAtBoot', () => {
  const previousDisable = process.env.WACLI_DISABLE_SYNC;

  afterEach(() => {
    if (previousDisable === undefined) {
      delete process.env.WACLI_DISABLE_SYNC;
    } else {
      process.env.WACLI_DISABLE_SYNC = previousDisable;
    }
  });

  it('starts the daemon when the app is awake', () => {
    const start = vi.fn();
    startSyncAtBoot({ start });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('leaves it off when the app was asleep at shutdown', () => {
    modeManager.setSleeping(true);
    const start = vi.fn();
    startSyncAtBoot({ start });
    expect(start).not.toHaveBeenCalled();
  });

  it('leaves it off under --no-sync', () => {
    process.env.WACLI_DISABLE_SYNC = '1';
    const start = vi.fn();
    startSyncAtBoot({ start });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('a scheduled message that comes due while asleep', () => {
  it('is sent, and leaves the daemon stopped', async () => {
    const { pm, spawn } = makeDaemon();
    await new SleepController({ daemon: pm }).sleep('test');

    const file = tmpDbFile();
    const scheduler = new Scheduler(file);
    scheduler.setExclusiveRunner(pm);
    modeManager.setReadOnly(false);
    execWacliMock.mockResolvedValue({ id: 'STUBMSG0001' });

    try {
      const item = scheduler.schedule({
        to: '15550100001@s.whatsapp.net',
        message: 'Good morning',
        scheduledAt: new Date(Date.now() - 1000).toISOString(),
      });
      await scheduler.checkDueMessages();
      await tick();

      expect(execWacliMock).toHaveBeenCalledWith(
        expect.arrayContaining(['send', 'text']),
        expect.anything()
      );
      expect(scheduler.getPage().history.find((i) => i.id === item.id)?.status).toBe('sent');
      expect(spawn).not.toHaveBeenCalled();
      expect(pm.getState()).toBe('stopped');
      expect(modeManager.isSleeping()).toBe(true);
    } finally {
      modeManager.setReadOnly(true);
      fs.rmSync(file, { force: true });
    }
  });
});
