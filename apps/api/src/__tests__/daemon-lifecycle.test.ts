import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execWacli } from '../wacli/commands.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

const FAKE_WACLI = fileURLToPath(new URL('./fixtures/fake-wacli.sh', import.meta.url));
const FAKE_ENV = ['WACLI_BIN', 'FAKE_LOG', 'FAKE_LOCK', 'FAKE_PIDS', 'FAKE_DELEGATES'] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every `wacli sync` that took the store, in launch order. */
function syncPids(): number[] {
  const file = process.env.FAKE_PIDS!;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
}

const liveDaemons = () => syncPids().filter(isAlive);

/** Every `wacli <command>` started, including any refused by the lock. */
function launches(command: string): number {
  return fs
    .readFileSync(process.env.FAKE_LOG!, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith(`${command} `)).length;
}

const syncLaunches = () => launches('sync');

/** A text send through the supervisor, the way the send routes make one. */
function sendText(pm: WacliProcessManager) {
  return pm.runDelegated((lock) =>
    execWacli<{ sent: boolean; id: string }>(
      ['send', 'text', '--to', '15550100001@s.whatsapp.net', '--message', 'Good morning'],
      { allowMutation: true, timeoutMs: 10_000, ...lock }
    )
  );
}

/**
 * The supervisor against real processes. The unit tests stub the spawn, so
 * they cannot show a second `wacli sync` losing the store lock, exiting, and
 * what the supervisor does about that exit — which is where a daemon nothing
 * tracked used to come from, holding the store until someone found and killed
 * it by hand.
 */
describe('Sync daemon supervision with real processes', () => {
  let dir: string;
  let pm: WacliProcessManager;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(FAKE_ENV.map((name) => [name, process.env[name]]));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-daemon-'));
    process.env.WACLI_BIN = FAKE_WACLI;
    process.env.FAKE_LOG = path.join(dir, 'invocations.log');
    process.env.FAKE_LOCK = path.join(dir, 'store.lock');
    process.env.FAKE_PIDS = path.join(dir, 'sync.pids');
    pm = new WacliProcessManager({ apiPort: 1, respawnDebounceMs: 50 });
  });

  afterEach(async () => {
    await pm.stop();
    pm.dispose();
    // A failing test can leave a daemon nothing tracks; it must not outlive it.
    for (const pid of liveDaemons()) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
    for (const name of FAKE_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  it('comes back as one tracked daemon when Restart is pressed during a send', async () => {
    pm.start();
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to connect');

    // A send runs exclusive: the daemon is taken down, and the command holds
    // the store until it is done.
    let sending = false;
    const send = pm.executeExclusive(async () => {
      fs.mkdirSync(process.env.FAKE_LOCK!);
      sending = true;
      await sleep(500);
      fs.rmdirSync(process.env.FAKE_LOCK!);
    });
    await waitFor(() => sending, 'the send to take the store');

    // The status strip's Restart is always available, including now.
    await pm.restart();
    await send;
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to come back');
    // Past the 1s backoff a daemon refused by the send's lock would have armed.
    await sleep(1_300);

    expect(liveDaemons()).toEqual([pm.getPid()]);
    // The first daemon, then the one brought back after the send. None was
    // started only to lose the store to the send.
    expect(syncLaunches()).toBe(2);
    expect(pm.getReconnectAttempts()).toBe(0);

    await pm.stop();
    expect(liveDaemons()).toEqual([]);
  });

  it('brings back a daemon that died on its own, once', async () => {
    pm.start();
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to connect');
    const first = pm.getPid()!;

    process.kill(first, 'SIGTERM');
    await waitFor(() => pm.getState() === 'restarting', 'the backoff to be armed');
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to come back');

    expect(pm.getPid()).not.toBe(first);
    expect(liveDaemons()).toEqual([pm.getPid()]);
    expect(pm.getReconnectAttempts()).toBe(1);
  });

  it('hands a send to the connected daemon, which stays up', async () => {
    process.env.FAKE_DELEGATES = '1';
    pm.start();
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to connect');
    const daemon = pm.getPid()!;

    const result = await sendText(pm);

    expect(result).toEqual({ sent: true, id: 'FAKE-HANDED-OVER' });
    // The same daemon, never taken off WhatsApp for it.
    expect(pm.getPid()).toBe(daemon);
    expect(isAlive(daemon)).toBe(true);
    expect(pm.getState()).toBe('running');
    expect(syncLaunches()).toBe(1);
    expect(launches('send')).toBe(1);
  });

  it('still gets a send out with a wacli that cannot hand it over', async () => {
    pm.start();
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to connect');
    const first = pm.getPid()!;

    const result = await sendText(pm);

    // Refused on the lock, which means nothing went out, then sent with the
    // daemon paused: one message, from the second of two attempts.
    expect(result).toEqual({ sent: true, id: 'FAKE-DIRECT' });
    expect(launches('send')).toBe(2);
    expect(isAlive(first)).toBe(false);
    await waitFor(() => pm.isDaemonConnected(), 'the daemon to come back');
    expect(liveDaemons()).toEqual([pm.getPid()]);
    expect(syncLaunches()).toBe(2);
  });

  it('counts a daemon that could not start as one failure, not two', async () => {
    process.env.WACLI_BIN = path.join(dir, 'no-such-wacli');

    pm.start();
    await waitFor(() => pm.getState() === 'restarting', 'the spawn to fail');
    // Node follows a failed spawn's `error` with a `close` for the same child.
    // Counting both doubled the backoff after a single failure.
    await sleep(100);

    expect(pm.getReconnectAttempts()).toBe(1);
  });
});
