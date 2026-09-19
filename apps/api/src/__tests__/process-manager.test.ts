import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  redactArgs,
  WacliProcessManager,
  type DelegationOptions,
} from '../wacli/process-manager.js';
import { StoreLockedError } from '../wacli/store-lock.js';

describe('redactArgs', () => {
  it('keeps the secret out of the spawn line while leaving the flags readable', () => {
    const line = redactArgs([
      'sync',
      '--follow',
      '--webhook',
      'http://127.0.0.1:3002/internal/wacli/webhook',
      '--webhook-secret',
      '7b3ce35ad5693a826c2e809214129d73',
    ]);

    expect(line).not.toContain('7b3ce35ad5693a826c2e809214129d73');
    expect(line).toContain('--webhook-secret <redacted>');
    expect(line).toContain('--webhook http://127.0.0.1:3002/internal/wacli/webhook');
  });

  it('does not redact a value that merely looks like a flag name', () => {
    expect(redactArgs(['sync', '--follow'])).toBe('sync --follow');
  });
});

describe('WacliProcessManager', () => {
  it('generates random HMAC secret and starts in stopped state', () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    expect(pm.getState()).toBe('stopped');
    expect(pm.getWebhookSecret()).toHaveLength(64); // 32 bytes in hex
    expect(pm.getPid()).toBeNull();
  });

  it('notifies on state change', () => {
    const stateCallback = vi.fn();
    const pm = new WacliProcessManager({
      apiPort: 3002,
      onStateChange: stateCallback,
    });

    expect(pm.getState()).toBe('stopped');
  });

  it('handles pause/resume exclusive execution gracefully when child is not running', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    let actionExecuted = false;

    // Mock spawnSyncProcess to avoid actually starting wacli in this unit test
    vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(() => {});

    const result = await pm.executeExclusive(async () => {
      actionExecuted = true;
      return 'done';
    });

    expect(actionExecuted).toBe(true);
    expect(result).toBe('done');
  });

  it('captures error event and updates lastError', () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    (pm as unknown as { handleStderrLine: (line: string) => void }).handleStderrLine(
      JSON.stringify({ event: 'error', data: { message: 'store is locked by pid 1234' } })
    );

    expect(pm.getLastError()).toBe('store is locked by pid 1234');
  });

  it('handles connected and logged_out events', () => {
    const states: string[] = [];
    const pm = new WacliProcessManager({
      apiPort: 3002,
      onStateChange: (state) => states.push(state),
    });

    (pm as unknown as { handleStderrLine: (line: string) => void }).handleStderrLine(
      JSON.stringify({ event: 'connected', ts: Date.now() })
    );
    expect(pm.getState()).toBe('running');

    (pm as unknown as { handleStderrLine: (line: string) => void }).handleStderrLine(
      JSON.stringify({ event: 'logged_out', ts: Date.now() })
    );
    expect(pm.getState()).toBe('logged_out');
  });

  it('announces a pause once, carrying its reason', () => {
    const events: Array<{ state: string; reason?: string }> = [];
    const pm = new WacliProcessManager({
      apiPort: 3002,
      onStateChange: (state, reason) => events.push({ state, reason }),
    });

    const internals = pm as unknown as {
      state: string;
      isPaused: boolean;
      child: unknown;
      handleProcessExit: (child: unknown, code: number | null, signal: NodeJS.Signals | null) => void;
      setState: (state: string, reason?: string) => void;
    };

    const daemon = {};
    internals.child = daemon;
    internals.state = 'running';
    internals.isPaused = true;

    // Both of these run off the *same* `close` event: handleProcessExit was
    // wired at spawn so it fires first, and executeExclusive's own listener
    // follows. It used to announce `paused` with no reason before the real one
    // landed, so every exclusive command emitted the transition twice.
    internals.handleProcessExit(daemon, 0, null);
    internals.setState('paused', 'Paused for exclusive command');

    expect(events).toEqual([{ state: 'paused', reason: 'Paused for exclusive command' }]);
  });

  it('does not re-announce a state it is already in', () => {
    const events: Array<{ state: string; reason?: string }> = [];
    const pm = new WacliProcessManager({
      apiPort: 3002,
      onStateChange: (state, reason) => events.push({ state, reason }),
    });

    const internals = pm as unknown as { setState: (state: string, reason?: string) => void };

    internals.setState('paused', 'Paused for exclusive command');
    internals.setState('paused', 'Paused for exclusive command');
    expect(events).toHaveLength(1);

    // A changed reason is still news: same state, different thing to say.
    internals.setState('paused', 'Paused for something else');
    expect(events).toHaveLength(2);
  });

  it('remembers a daemon PID after that daemon is gone', async () => {
    // The health route asks this to tell a lock held by one of ours from one
    // held by somebody else's wacli. A cached `wacli doctor` result can still
    // name a daemon that has since exited, so forgetting the PID on exit would
    // report an ordinary restart as an external process taking the store.
    const previousBin = process.env.WACLI_BIN;
    process.env.WACLI_BIN = '/bin/sleep';

    const pm = new WacliProcessManager({ apiPort: 3002 });
    try {
      pm.start();
      const pid = pm.getPid();
      expect(pid).toBeGreaterThan(0);
      expect(pm.hasSpawnedPid(pid!)).toBe(true);

      // stop() pauses first, so the exit does not schedule a restart.
      await pm.stop();

      expect(pm.getPid()).toBeNull();
      expect(pm.hasSpawnedPid(pid!)).toBe(true);
      expect(pm.hasSpawnedPid(pid! + 1)).toBe(false);
    } finally {
      pm.dispose();
      if (previousBin === undefined) {
        delete process.env.WACLI_BIN;
      } else {
        process.env.WACLI_BIN = previousBin;
      }
    }
  });

  it('supports restart method', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const spawnSpy = vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(() => {});
    await pm.restart();
    expect(spawnSpy).toHaveBeenCalled();
  });
});

describe('WacliProcessManager exclusive-command respawn', () => {
  /**
   * A running manager whose daemon spawn is a spy, so no real wacli is ever
   * started. Started first because only a daemon somebody wants is brought
   * back; the spy is cleared so counts cover the respawn alone.
   */
  function makeManager(respawnDebounceMs = 0) {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    pm.start();
    spawn.mockClear();
    return { pm, spawn };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('respawns the daemon once after a burst, not once per command', async () => {
    const { pm, spawn } = makeManager();

    // Five commands queued together, as a thread view opening produces.
    await Promise.all(
      Array.from({ length: 5 }, () => pm.executeExclusive(async () => 'ok'))
    );
    await tick();

    // The bug this guards: one spawn per command, each killed microseconds
    // later by the next caller, so the daemon never survives to connect.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not respawn while another exclusive command is still queued', async () => {
    const { pm, spawn } = makeManager();

    let releaseFirst: () => void = () => {};
    const firstRunning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = pm.executeExclusive(async () => {
      await firstRunning;
      return 'first';
    });
    const second = pm.executeExclusive(async () => 'second');


    releaseFirst();
    await first;
    // The second command is still queued here, so the daemon must stay down.
    expect(spawn).not.toHaveBeenCalled();

    await second;
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending respawn when a new command arrives inside the debounce', async () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager(750);

      await pm.executeExclusive(async () => 'one');
      // Respawn is scheduled but has not fired yet.
      vi.advanceTimersByTime(300);
      expect(spawn).not.toHaveBeenCalled();

      // A command landing mid-window must cancel it, or it would kill a daemon
      // that had no time to connect.
      const second = pm.executeExclusive(async () => 'two');
      await vi.advanceTimersByTimeAsync(0);
      await second;

      vi.advanceTimersByTime(749);
      expect(spawn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks the daemon connection from its own events', () => {
    const { pm } = makeManager();
    const internals = pm as unknown as {
      handleStderrLine: (l: string) => void;
      child: unknown;
    };
    // Stand in for a spawned daemon; isDaemonConnected requires a live child.
    internals.child = {};

    expect(pm.isDaemonConnected()).toBe(false);

    internals.handleStderrLine(JSON.stringify({ event: 'connected', ts: Date.now() }));
    expect(pm.isDaemonConnected()).toBe(true);
    expect(pm.getState()).toBe('running');

    internals.handleStderrLine(JSON.stringify({ event: 'disconnected', ts: Date.now() }));
    expect(pm.isDaemonConnected()).toBe(false);

    // A dead child is never "connected", whatever the last event said.
    internals.handleStderrLine(JSON.stringify({ event: 'connected', ts: Date.now() }));
    expect(pm.isDaemonConnected()).toBe(true);
    internals.child = null;
    expect(pm.isDaemonConnected()).toBe(false);
  });
});

describe('WacliProcessManager exclusive-command failures', () => {
  it('still brings the daemon back when an exclusive command throws', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    pm.start();
    spawn.mockClear();

    await expect(
      pm.executeExclusive(async () => {
        throw new Error('mark-read failed');
      })
    ).rejects.toThrow('mark-read failed');

    await new Promise((resolve) => setTimeout(resolve, 5));

    // A failed command must not leave the store permanently daemon-less.
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('recovers the waiter count when one command in a queue fails', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    pm.start();
    spawn.mockClear();

    const results = await Promise.allSettled([
      pm.executeExclusive(async () => 'ok'),
      pm.executeExclusive(async () => {
        throw new Error('boom');
      }),
      pm.executeExclusive(async () => 'ok'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('WacliProcessManager respawn cancellation', () => {
  /** Started, so an exclusive command really does leave a respawn pending. */
  function makeManager(respawnDebounceMs = 750) {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    pm.start();
    spawn.mockClear();
    return { pm, spawn };
  }

  it('does not respawn after a deliberate stop', async () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();

      await pm.executeExclusive(async () => 'done');
      // A respawn is now pending inside the debounce window.
      await pm.stop();
      vi.advanceTimersByTime(5000);

      // Stopping must win: a queued respawn firing afterwards would resurrect
      // a daemon the operator explicitly shut down.
      expect(spawn).not.toHaveBeenCalled();
      expect(pm.getState()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not double-spawn when start() lands inside the debounce window', async () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();

      await pm.executeExclusive(async () => 'done');
      pm.start();
      vi.advanceTimersByTime(5000);

      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips the respawn when a daemon is somehow already running', async () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();
      const internals = pm as unknown as { child: unknown };

      await pm.executeExclusive(async () => 'done');
      // A restart timer beat the debounce to it.
      internals.child = {};
      vi.advanceTimersByTime(5000);

      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a crash backoff stand down when a daemon is already back', () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();
      const internals = pm as unknown as {
        child: unknown;
        handleProcessExit: (child: unknown, code: number | null, signal: NodeJS.Signals | null) => void;
      };

      const crashed = {};
      internals.child = crashed;
      internals.handleProcessExit(crashed, 1, null);
      // Brought back some other way before the 1s backoff fired. Spawning
      // regardless put a second daemon beside it, and one went untracked.
      internals.child = {};
      vi.advanceTimersByTime(5000);

      expect(spawn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WacliProcessManager desired state', () => {
  function makeManager() {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    return { pm, spawn };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('keeps a deliberately stopped daemon down after an exclusive command', async () => {
    const { pm, spawn } = makeManager();
    pm.start();
    await pm.stop();
    spawn.mockClear();

    // Every send runs exclusive. Ending one used to respawn the daemon
    // unconditionally, so a stop lasted exactly until the next send.
    await pm.executeExclusive(async () => 'sent');
    await tick();

    expect(spawn).not.toHaveBeenCalled();
    expect(pm.getState()).toBe('stopped');
  });

  it('never starts a daemon that was never started, however many sends run', async () => {
    // `--no-sync` never starts the supervisor; the first send used to.
    const { pm, spawn } = makeManager();

    await Promise.all(
      Array.from({ length: 3 }, () => pm.executeExclusive(async () => 'sent'))
    );
    await tick();

    expect(spawn).not.toHaveBeenCalled();
    expect(pm.getState()).toBe('stopped');
  });

  it('stays down when stopped while an exclusive command is running', async () => {
    const { pm, spawn } = makeManager();
    pm.start();
    spawn.mockClear();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = pm.executeExclusive(async () => {
      await gate;
      return 'sent';
    });
    await tick();

    await pm.stop();
    release();
    await running;
    await tick();

    expect(spawn).not.toHaveBeenCalled();
    expect(pm.getState()).toBe('stopped');
  });

  it('leaves a start() during an exclusive command to the command to finish', async () => {
    // Restart is stop() then start(), and the button is there mid-send. A
    // daemon spawned then either takes the store from the send or loses it and
    // arms a crash backoff that later runs beside the real daemon.
    const { pm, spawn } = makeManager();
    pm.start();
    spawn.mockClear();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = pm.executeExclusive(async () => {
      await gate;
      return 'sent';
    });
    await tick();

    await pm.restart();
    await tick();
    expect(spawn).not.toHaveBeenCalled();
    expect(pm.getState()).toBe('paused');

    release();
    await running;
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('WacliProcessManager startSoon', () => {
  function makeManager(respawnDebounceMs = 750) {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    return { pm, spawn };
  }

  it('brings a stopped daemon up once, after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();
      await pm.stop();

      pm.startSoon();
      vi.advanceTimersByTime(749);
      expect(spawn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a send that lands inside the window go first, then spawns once', async () => {
    // Waking because of a send: spawning at once would only have the send kill
    // a daemon that never got to connect.
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();
      await pm.stop();

      pm.startSoon();
      vi.advanceTimersByTime(300);
      const send = pm.executeExclusive(async () => 'sent');
      await vi.advanceTimersByTimeAsync(0);
      await send;

      vi.advanceTimersByTime(749);
      expect(spawn).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the respawn to exclusive work that is already running', async () => {
    const { pm, spawn } = makeManager(0);
    await pm.stop();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = pm.executeExclusive(async () => {
      await gate;
      return 'sent';
    });
    await new Promise((resolve) => setTimeout(resolve, 5));

    pm.startSoon();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Nothing may spawn while the store is still held for the command.
    expect(spawn).not.toHaveBeenCalled();

    release();
    await running;
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by a stop inside the window', async () => {
    vi.useFakeTimers();
    try {
      const { pm, spawn } = makeManager();

      pm.startSoon();
      await pm.stop();
      vi.advanceTimersByTime(5000);

      expect(spawn).not.toHaveBeenCalled();
      expect(pm.getState()).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WacliProcessManager handing commands to the daemon', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  /** A promise and the function that settles it, for a command held mid-flight. */
  function gate() {
    let release: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { opened, release };
  }

  /**
   * A manager whose daemon is up and has said it is connected. Its kill() ends
   * it the way a real one ends, with `close`; spawns are a spy.
   */
  function connectedManager() {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
    const child = Object.assign(new EventEmitter(), {
      killed: false,
      kill: vi.fn(function (this: EventEmitter & { killed: boolean }) {
        this.killed = true;
        setImmediate(() => this.emit('close', 0, 'SIGINT'));
        return true;
      }),
    });
    const internals = pm as unknown as {
      child: unknown;
      handleStderrLine: (line: string) => void;
    };
    internals.child = child;
    pm.start();
    internals.handleStderrLine(JSON.stringify({ event: 'connected' }));
    return { pm, spawn, child, internals };
  }

  const refusedOnTheLock = () =>
    new StoreLockedError('store is locked (another wacli is running?)', null);

  it('hands a command to a connected daemon and leaves it up', async () => {
    const { pm, spawn, child } = connectedManager();
    const action = vi.fn(async () => 'sent');

    await expect(pm.runDelegated(action)).resolves.toBe('sent');

    // One lock attempt: wacli only tries the socket once the lock refuses it.
    expect(action).toHaveBeenCalledExactlyOnceWith({ lockRetryAttempts: 1 });
    expect(child.kill).not.toHaveBeenCalled();
    expect(pm.getState()).toBe('running');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('runs it again with the daemon paused when the daemon would not take it', async () => {
    const { pm, spawn, child } = connectedManager();
    const action = vi
      .fn<(lock: DelegationOptions) => Promise<string>>()
      .mockRejectedValueOnce(refusedOnTheLock())
      .mockResolvedValueOnce('sent');

    await expect(pm.runDelegated(action)).resolves.toBe('sent');
    await tick();

    // wacli reports the lock only when it could not hand the command over, so
    // nothing went out the first time.
    expect(action).toHaveBeenNthCalledWith(1, { lockRetryAttempts: 1 });
    expect(action).toHaveBeenNthCalledWith(2, {});
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('never runs a command twice when it failed after the hand-over', async () => {
    const { pm, child } = connectedManager();
    const action = vi.fn(async () => {
      throw new Error('send delegate: unexpected EOF');
    });

    await expect(pm.runDelegated(action)).rejects.toThrow('unexpected EOF');

    // The daemon had it, so the message may be out already.
    expect(action).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('pauses the daemon as before when it is not connected', async () => {
    const { pm, child, internals } = connectedManager();
    internals.handleStderrLine(JSON.stringify({ event: 'disconnected' }));
    const action = vi.fn(async () => 'sent');

    await pm.runDelegated(action);

    expect(action).toHaveBeenCalledExactlyOnceWith({});
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('queues behind an exclusive command instead of handing over', async () => {
    const { pm } = connectedManager();
    const alias = gate();
    const exclusive = pm.executeExclusive(() => alias.opened);
    const action = vi.fn(async () => 'sent');

    const sending = pm.runDelegated(action);
    await tick();
    expect(action).not.toHaveBeenCalled();

    alias.release();
    await Promise.all([exclusive, sending]);
    expect(action).toHaveBeenCalledExactlyOnceWith({});
  });

  it('lets a command the daemon is carrying finish before an exclusive one takes it down', async () => {
    const { pm, child } = connectedManager();
    const send = gate();
    const sending = pm.runDelegated(() => send.opened);
    const alias = vi.fn(async () => 'aliased');

    const exclusive = pm.executeExclusive(alias);
    await tick();
    expect(child.kill).not.toHaveBeenCalled();
    expect(alias).not.toHaveBeenCalled();

    send.release();
    await Promise.all([sending, exclusive]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(alias).toHaveBeenCalledTimes(1);
  });

  it('lets a command the daemon is carrying finish before Restart takes it down', async () => {
    const { pm, spawn, child } = connectedManager();
    const send = gate();
    const sending = pm.runDelegated(() => send.opened);

    const restarting = pm.restart();
    await tick();
    expect(child.kill).not.toHaveBeenCalled();

    send.release();
    await Promise.all([sending, restarting]);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('hands nothing new to a daemon that is being stopped', async () => {
    const { pm } = connectedManager();
    const send = gate();
    const sending = pm.runDelegated(() => send.opened);
    const stopping = pm.stop();
    const later = vi.fn(async () => 'sent');

    const second = pm.runDelegated(later);
    send.release();
    await Promise.all([sending, stopping, second]);

    expect(later).toHaveBeenCalledExactlyOnceWith({});
  });

  it('keeps the daemon when it is started again while a stop waits', async () => {
    // Sleep, then Wake before the send finished: the later request stands.
    const { pm, child } = connectedManager();
    const send = gate();
    const sending = pm.runDelegated(() => send.opened);

    const stopping = pm.stop();
    pm.start();
    send.release();
    await Promise.all([sending, stopping]);

    expect(child.kill).not.toHaveBeenCalled();
    const next = vi.fn(async () => 'sent');
    await pm.runDelegated(next);
    expect(next).toHaveBeenCalledExactlyOnceWith({ lockRetryAttempts: 1 });
  });
});

describe('WacliProcessManager shutdown hooks', () => {
  /** A fresh module copy, so the hook registry starts empty whatever ran before. */
  async function loadFreshModule() {
    vi.resetModules();
    return import('../wacli/process-manager.js');
  }

  const listenerCounts = () => ({
    exit: process.listenerCount('exit'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  });

  /**
   * The hook the module copy under test registered, identified by diffing the
   * process's listeners around its first construction. Tests invoke it directly:
   * emitting a real SIGINT would also reach vitest's own handler and tear the
   * run down.
   */
  function shutdownHookAddedBy(before: readonly unknown[]): () => void {
    const added = process.listeners('SIGINT').filter((l) => !before.includes(l));
    expect(added, 'exactly one shutdown hook was registered').toHaveLength(1);
    return added[0] as () => void;
  }

  it('registers one listener per signal however many managers exist', async () => {
    const { WacliProcessManager: Manager } = await loadFreshModule();
    const before = listenerCounts();

    // Twelve managers, as a single test file easily builds. Registering the
    // hooks per instance put 36 listeners on the process here and produced
    // "MaxListenersExceededWarning: 11 exit listeners added to [process]".
    const managers = Array.from({ length: 12 }, () => new Manager({ apiPort: 3002 }));

    expect(listenerCounts()).toEqual({
      exit: before.exit + 1,
      SIGINT: before.SIGINT + 1,
      SIGTERM: before.SIGTERM + 1,
    });

    for (const pm of managers) pm.dispose();
    expect(listenerCounts()).toEqual(before);
  });

  it('SIGINTs the daemon of every live manager when the process goes down', async () => {
    const { WacliProcessManager: Manager } = await loadFreshModule();
    const before = process.listeners('SIGINT');
    const first = new Manager({ apiPort: 3002 });
    const second = new Manager({ apiPort: 3003 });
    const firstKill = vi.fn();
    const secondKill = vi.fn();
    (first as unknown as { child: unknown }).child = { killed: false, kill: firstKill };
    (second as unknown as { child: unknown }).child = { killed: false, kill: secondKill };

    shutdownHookAddedBy(before)();

    expect(firstKill).toHaveBeenCalledWith('SIGINT');
    expect(secondKill).toHaveBeenCalledWith('SIGINT');

    first.dispose();
    second.dispose();
  });

  it('leaves a disposed manager out of the shutdown', async () => {
    const { WacliProcessManager: Manager } = await loadFreshModule();
    const before = process.listeners('SIGINT');
    const disposed = new Manager({ apiPort: 3002 });
    const live = new Manager({ apiPort: 3003 });
    const disposedKill = vi.fn();
    const liveKill = vi.fn();
    (disposed as unknown as { child: unknown }).child = { killed: false, kill: disposedKill };
    (live as unknown as { child: unknown }).child = { killed: false, kill: liveKill };

    const hook = shutdownHookAddedBy(before);
    disposed.dispose();
    hook();

    expect(disposedKill).not.toHaveBeenCalled();
    expect(liveKill).toHaveBeenCalledWith('SIGINT');

    live.dispose();
  });
});
