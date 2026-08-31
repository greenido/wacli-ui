import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { EventBridge } from '../ws/event-bridge.js';
import type { MissionControlEvent } from '../types.js';

describe('WebSocket Event Bridge & Webhook Pipeline', () => {
  it('broadcasts incoming webhook messages to connected WebSocket clients', async () => {
    const pm = new WacliProcessManager({ apiPort: 3099 });
    const bridge = new EventBridge();
    const app = createApp(pm, bridge);
    const server = http.createServer(app);
    bridge.initialize(server);

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const port = (server.address() as { port: number }).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

    const receivedEvents: MissionControlEvent[] = [];
    ws.on('message', (data) => {
      receivedEvents.push(JSON.parse(data.toString()) as MissionControlEvent);
    });

    await new Promise<void>((resolve) => {
      ws.on('open', () => resolve());
    });

    expect(receivedEvents.length).toBeGreaterThanOrEqual(1);
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

    // Wait a tick for WS broadcast
    await new Promise((r) => setTimeout(r, 100));

    const newMsgEvent = receivedEvents.find((e) => e.type === 'message.new');
    expect(newMsgEvent).toBeDefined();
    if (newMsgEvent && newMsgEvent.type === 'message.new') {
      expect(newMsgEvent.data.msgId).toBe('LIVE-MSG-100');
      expect(newMsgEvent.data.text).toBe('Live real-time message via webhook');
    }

    ws.close();
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
