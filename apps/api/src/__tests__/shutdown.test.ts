import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../index.js';
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
