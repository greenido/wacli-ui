import { describe, it, expect, vi } from 'vitest';
import { redactArgs, WacliProcessManager } from '../wacli/process-manager.js';

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

  it('supports restart method', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const spawnSpy = vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(() => {});
    await pm.restart();
    expect(spawnSpy).toHaveBeenCalled();
  });
});

describe('WacliProcessManager exclusive-command respawn', () => {
  /** A manager whose daemon spawn is a spy, so no real wacli is ever started. */
  function makeManager(respawnDebounceMs = 0) {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
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

    expect(pm.hasPendingExclusiveWork()).toBe(true);

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

    await expect(
      pm.executeExclusive(async () => {
        throw new Error('mark-read failed');
      })
    ).rejects.toThrow('mark-read failed');

    await new Promise((resolve) => setTimeout(resolve, 5));

    // A failed command must not leave the store permanently daemon-less.
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pm.hasPendingExclusiveWork()).toBe(false);
  });

  it('recovers the waiter count when one command in a queue fails', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});

    const results = await Promise.allSettled([
      pm.executeExclusive(async () => 'ok'),
      pm.executeExclusive(async () => {
        throw new Error('boom');
      }),
      pm.executeExclusive(async () => 'ok'),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(pm.hasPendingExclusiveWork()).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('WacliProcessManager respawn cancellation', () => {
  function makeManager(respawnDebounceMs = 750) {
    const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs });
    const spawn = vi
      .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
      .mockImplementation(() => {});
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
