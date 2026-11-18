import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../index.js';
import { accessPolicy } from '../net/loopback.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { EventBridge } from '../ws/event-bridge.js';
import type { MissionControlEvent } from '../types.js';

describe('WebSocket Event Bridge & Webhook Pipeline', () => {
  it('broadcasts incoming webhook messages to connected WebSocket clients', async () => {
    const pm = new WacliProcessManager({ apiPort: 3099 });
    const bridge = new EventBridge();
    const app = createApp(pm, bridge);
    const server = http.createServer(app);
    bridge.initialize(server, accessPolicy({ port: 0, hostsFile: '' }));

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const receivedEvents: MissionControlEvent[] = [];
    const waiters: Array<() => void> = [];
    ws.on('message', (data) => {
      receivedEvents.push(JSON.parse(data.toString()) as MissionControlEvent);
      waiters.splice(0).forEach((wake) => wake());
    });

    /**
     * Resolves once an event of this type has arrived. Waiting on `open`, or a
     * fixed sleep, raced the frames: under load the greeting landed after the
     * socket opened and the check found nothing.
     */
    async function eventOfType(type: MissionControlEvent['type']): Promise<MissionControlEvent> {
      const deadline = Date.now() + 2000;
      for (;;) {
        const found = receivedEvents.find((e) => e.type === type);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${type} event within 2s`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    }

    await eventOfType('connection.status');
    expect(receivedEvents[0].type).toBe('connection.status');

    // Simulate wacli posting a webhook message
    const payload = JSON.stringify({
      Chat: '15551234567@s.whatsapp.net',
      ID: 'LIVE-MSG-100',
      Timestamp: '2026-08-31T12:00:00Z',
      FromMe: false,
      Text: 'Live real-time message via webhook',
    });

    const secret = pm.getWebhookSecret();
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const res = await request(app)
      .post('/internal/wacli/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Wacli-Signature', `sha256=${hmac}`)
      .send(payload);

    expect(res.status).toBe(200);

    const newMsgEvent = await eventOfType('message.new');
    if (newMsgEvent.type === 'message.new') {
      expect(newMsgEvent.data.msgId).toBe('LIVE-MSG-100');
      expect(newMsgEvent.data.text).toBe('Live real-time message via webhook');
    }

    ws.close();
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
