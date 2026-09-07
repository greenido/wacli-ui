import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp, shutdown } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { EventBridge } from '../ws/event-bridge.js';

/**
 * `http.Server.close()` waits for every connection still standing, and an
 * upgraded WebSocket closes only when told to. With a browser tab open — which
 * on this console is always — that callback never ran and Ctrl+C appeared to do
 * nothing. This is the guarantee the shutdown path depends on.
 */
describe('Shutdown with a live WebSocket client', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function startWithClient() {
    const pm = new WacliProcessManager({ apiPort: 0 });
    const bridge = new EventBridge();
    const server = http.createServer(createApp(pm, bridge));
    bridge.initialize(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    cleanups.push(() => {
      try { ws.terminate(); } catch { /* already gone */ }
      server.close();
      pm.dispose();
    });

    return { server, bridge, ws };
  }

  /** Whether `server.close()` actually reaches its callback, within a bound. */
  function closesWithin(server: http.Server, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      server.close(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  it('hangs on an open socket when the bridge is not closed', async () => {
    const { server } = await startWithClient();
    // The bug, pinned: nothing here closes the upgraded socket, so the close
    // callback has something to wait for and never arrives.
    expect(await closesWithin(server, 300)).toBe(false);
  });

  it('completes once the bridge drops its clients', async () => {
    const { server, bridge } = await startWithClient();
    bridge.close();
    expect(await closesWithin(server, 2000)).toBe(true);
  });

  it('tells the client the socket is gone', async () => {
    const { bridge, ws } = await startWithClient();
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    bridge.close();
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(bridge.getConnectedClientCount()).toBe(0);
  });
});

/**
 * The wiring itself, rather than the pieces. Every part below was already
 * correct in isolation while `gracefulShutdown` failed to call any of it —
 * which is exactly the shape the original bug had.
 */
describe('the shutdown sequence', () => {
  /** Records the order things were put down in, which is the whole guarantee. */
  function deps(overrides: Partial<Parameters<typeof shutdown>[1]> = {}) {
    const order: string[] = [];
    const exit = vi.fn(() => order.push('exit'));

    return {
      order,
      exit,
      built: {
        jobs: { stop: vi.fn(() => order.push('jobs.stop')) },
        bridge: { close: vi.fn(() => order.push('bridge.close')) },
        processManager: {
          stop: vi.fn(async () => {
            order.push('daemon.stop');
          }),
        },
        server: {
          close: vi.fn((cb?: () => void) => {
            order.push('server.close');
            cb?.();
            return undefined as never;
          }),
        },
        exit,
        graceMs: 50,
        ...overrides,
      } as Parameters<typeof shutdown>[1],
    };
  }

  it('releases the socket bridge and the scheduler before waiting on the server', async () => {
    const { built, order } = deps();

    await shutdown('SIGINT', built);

    // Asserted present before being ordered: `indexOf` answers -1 for a call
    // that never happened, which would sail through the comparison below and
    // let the original bug back in unnoticed.
    expect(order).toContain('jobs.stop');
    expect(order).toContain('bridge.close');
    expect(order).toContain('server.close');

    // Releasing them after server.close() would be releasing them after the
    // very wait they cause.
    expect(order.indexOf('jobs.stop')).toBeLessThan(order.indexOf('server.close'));
    expect(order.indexOf('bridge.close')).toBeLessThan(order.indexOf('server.close'));
  });

  it('stops the sync daemon and exits once the server closes', async () => {
    const { built, order, exit } = deps();

    await shutdown('SIGINT', built);

    expect(order).toEqual([
      'jobs.stop',
      'bridge.close',
      'daemon.stop',
      'server.close',
      'exit',
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('leaves anyway when something never lets the server close', async () => {
    // A media stream mid-body, or a wacli read that never came back: the close
    // callback never arrives, and a Ctrl+C must not wait on it forever.
    const { built, exit } = deps({
      server: { close: vi.fn(() => undefined as never) },
    });

    await shutdown('SIGINT', built);
    expect(exit).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits once, not twice, when the close beats the backstop', async () => {
    const { built, exit } = deps();

    await shutdown('SIGINT', built);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('still shuts down when the daemon refuses to stop', async () => {
    const { built, exit } = deps({
      processManager: { stop: vi.fn().mockRejectedValue(new Error('SIGKILL failed')) },
    });

    await shutdown('SIGINT', built);

    expect(exit).toHaveBeenCalledTimes(1);
  });
});
