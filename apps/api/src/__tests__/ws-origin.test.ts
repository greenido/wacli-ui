import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp } from '../index.js';
import { isAllowedUpgrade } from '../net/loopback.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { EventBridge } from '../ws/event-bridge.js';

/**
 * A WebSocket handshake ignores the same-origin policy, so the CORS rules that
 * guard `/api` do not reach `/ws`. Before this check any page the operator had
 * open could connect and read the live message feed.
 */
describe('WebSocket upgrade origin check', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function startBridge(): Promise<{ port: number; bridge: EventBridge }> {
    const pm = new WacliProcessManager({ apiPort: 0 });
    const bridge = new EventBridge();
    const server = http.createServer(createApp(pm, bridge));
    bridge.initialize(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;

    cleanups.push(() => {
      bridge.close();
      server.close();
      pm.dispose();
    });

    return { port, bridge };
  }

  /** Resolves to how the server answered the handshake, however it answered. */
  function handshake(port: number, headers?: Record<string, string>): Promise<string> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
      ws.on('open', () => {
        ws.close();
        resolve('accepted');
      });
      ws.on('unexpected-response', (_req, res) => resolve(`rejected:${res.statusCode}`));
      ws.on('error', () => resolve('rejected'));
    });
  }

  it('refuses an upgrade from a foreign page', async () => {
    const { port } = await startBridge();
    expect(await handshake(port, { Origin: 'https://evil.example' })).toMatch(/^rejected/);
  });

  it('refuses an upgrade whose Host is somebody else’s name', async () => {
    const { port } = await startBridge();
    // What a rebound DNS name looks like on arrival: a loopback socket, but a
    // Host header the operator never typed.
    expect(await handshake(port, { Host: 'evil.example' })).toMatch(/^rejected/);
  });

  it('accepts the console served from this machine', async () => {
    const { port } = await startBridge();
    expect(await handshake(port, { Origin: `http://localhost:${port}` })).toBe('accepted');
  });

  it('accepts a client that sends no Origin at all', async () => {
    const { port } = await startBridge();
    // curl, a test, a native app: no web page can impersonate this, because a
    // browser always sends Origin on a handshake.
    expect(await handshake(port)).toBe('accepted');
  });

  it('keeps a refused caller out of the broadcast set', async () => {
    const { port, bridge } = await startBridge();
    await handshake(port, { Origin: 'https://evil.example' });
    expect(bridge.getConnectedClientCount()).toBe(0);
  });

  describe('isAllowedUpgrade', () => {
    it('judges origin and host independently', () => {
      expect(isAllowedUpgrade('http://localhost:5174', 'localhost:3002')).toBe(true);
      expect(isAllowedUpgrade('http://127.0.0.1:5174', '127.0.0.1:3002')).toBe(true);
      expect(isAllowedUpgrade('http://[::1]:5174', '[::1]:3002')).toBe(true);
      expect(isAllowedUpgrade(undefined, '127.0.0.1:3002')).toBe(true);
      // What Vite's rewriteWsOrigin would produce — a ws Origin is not a page.
      expect(isAllowedUpgrade('ws://127.0.0.1:3002', '127.0.0.1:5174')).toBe(false);

      expect(isAllowedUpgrade('https://evil.example', '127.0.0.1:3002')).toBe(false);
      expect(isAllowedUpgrade('http://192.168.1.50', '127.0.0.1:3002')).toBe(false);
      expect(isAllowedUpgrade('http://localhost:5174', 'evil.example')).toBe(false);
    });
  });
});
