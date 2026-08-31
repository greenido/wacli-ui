import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp, isLoopbackOrigin } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return {
    ...actual,
    execWacli: vi.fn(async (args: string[]) => {
      if (args[0] === 'doctor') {
        return {
          store_dir: '/mock/.wacli',
          authenticated: true,
          connected: true,
          connection_state: 'connected',
          linked_jid: '15551234567@s.whatsapp.net',
          store: {
            messages: 100,
            chats: 10,
          },
        };
      }
      return {};
    }),
  };
});

describe('Express Server Foundation', () => {
  it('identifies loopback origins accurately', () => {
    expect(isLoopbackOrigin('http://localhost:5174')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:5174')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:5174')).toBe(true);
    expect(isLoopbackOrigin('https://example.com')).toBe(false);
    expect(isLoopbackOrigin('http://192.168.1.50:5174')).toBe(false);
  });

  it('GET /api/health returns unified health structure', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('readOnly');
    expect(res.body.data).toHaveProperty('processState');
  });

  it('GET /api/mode and POST /api/mode manage read-only toggle', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const getRes = await request(app).get('/api/mode');
    expect(getRes.status).toBe(200);
    expect(typeof getRes.body.data.readOnly).toBe('boolean');

    const postRes = await request(app)
      .post('/api/mode')
      .send({ readOnly: false });
    expect(postRes.status).toBe(200);
    expect(postRes.body.data.readOnly).toBe(false);

    // Toggle back to true
    await request(app).post('/api/mode').send({ readOnly: true });
  });

  it('POST /internal/wacli/webhook rejects requests with missing or invalid signature', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const noSigRes = await request(app)
      .post('/internal/wacli/webhook')
      .send({ Text: 'Hello' });
    expect(noSigRes.status).toBe(401);

    const badSigRes = await request(app)
      .post('/internal/wacli/webhook')
      .set('X-Wacli-Signature', 'sha256=invalidhex')
      .send({ Text: 'Hello' });
    expect(badSigRes.status).toBe(403);
  });

  it('POST /internal/wacli/webhook accepts valid HMAC signatures', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const payload = JSON.stringify({
      Chat: '15551234567@s.whatsapp.net',
      ID: 'TEST-MSG-1',
      Timestamp: '2026-08-31T12:00:00Z',
      FromMe: false,
      Text: 'Valid signed message',
    });

    const secret = pm.getWebhookSecret();
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const res = await request(app)
      .post('/internal/wacli/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Wacli-Signature', `sha256=${hmac}`)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
