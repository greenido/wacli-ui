import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { EventBridge } from '../ws/event-bridge.js';
import { logger } from '../logger.js';
import type { MissionControlEvent } from '../types.js';

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
  it('GET /api/health returns unified health structure', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('readOnly');
    expect(res.body.data).toHaveProperty('processState');
    expect(res.body.data).toHaveProperty('wacliInstalled');
    expect(res.body.data).toHaveProperty('wacliWorking');
    expect(res.body.data).toHaveProperty('statusSummary');
  });

  it('GET /api/health reports not_installed when wacli binary is missing', async () => {
    const commands = await import('../wacli/commands.js');
    const spy = vi.spyOn(commands, 'checkWacliInstalled').mockResolvedValueOnce({
      installed: false,
      version: null,
      binPath: 'wacli',
      error: "wacli binary 'wacli' was not found in PATH.",
    });

    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.wacliInstalled).toBe(false);
    expect(res.body.data.wacliWorking).toBe(false);
    expect(res.body.data.statusSummary).toBe('not_installed');
    expect(res.body.data.statusMessage).toContain('not found in PATH');

    spy.mockRestore();
  });

  it('GET /api/health reports not_authenticated when wacli doctor is unauthenticated', async () => {
    const commands = await import('../wacli/commands.js');
    const spyInstalled = vi.spyOn(commands, 'checkWacliInstalled').mockResolvedValueOnce({
      installed: true,
      version: 'wacli 0.17.1',
      binPath: 'wacli',
      error: null,
    });
    const spyExec = vi.spyOn(commands, 'execWacli').mockResolvedValueOnce({
      store_dir: '/mock/.wacli',
      authenticated: false,
      connected: false,
      connection_state: 'logged_out',
      linked_jid: null,
      store: {},
    });

    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data.wacliInstalled).toBe(true);
    expect(res.body.data.wacliWorking).toBe(false);
    expect(res.body.data.statusSummary).toBe('not_authenticated');

    spyInstalled.mockRestore();
    spyExec.mockRestore();
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

  it('POST /internal/wacli/webhook maps chat_presence states strictly', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const bridge = new EventBridge();
    const app = createApp(pm, bridge);
    const receivedEvents: MissionControlEvent[] = [];
    const broadcastSpy = vi.spyOn(bridge, 'broadcast').mockImplementation((event) => {
      receivedEvents.push(event);
    });

    const secret = pm.getWebhookSecret();

    async function postPresence(state: string) {
      const payload = JSON.stringify({
        EventType: 'chat_presence',
        Chat: '15551234567@s.whatsapp.net',
        Sender: '15559876543@s.whatsapp.net',
        State: state,
      });
      const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      return request(app)
        .post('/internal/wacli/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Wacli-Signature', `sha256=${hmac}`)
        .send(payload);
    }

    const composingRes = await postPresence('composing');
    expect(composingRes.status).toBe(200);
    expect(receivedEvents.at(-1)).toMatchObject({
      type: 'chat.presence',
      data: { state: 'composing' },
    });

    const pausedRes = await postPresence('paused');
    expect(pausedRes.status).toBe(200);
    expect(receivedEvents.at(-1)).toMatchObject({
      type: 'chat.presence',
      data: { state: 'paused' },
    });

    const beforeUnknownCount = receivedEvents.length;
    const unknownRes = await postPresence('recording');
    expect(unknownRes.status).toBe(200);
    expect(receivedEvents.length).toBe(beforeUnknownCount);

    broadcastSpy.mockRestore();
  });

  it('POST /internal/wacli/webhook turns a receipt into read, played or delivered ticks', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const bridge = new EventBridge();
    const app = createApp(pm, bridge);
    const receivedEvents: MissionControlEvent[] = [];
    vi.spyOn(bridge, 'broadcast').mockImplementation((event) => {
      receivedEvents.push(event);
    });

    try {
      for (const [type, status] of [
        ['read', 'read'],
        ['played', 'played'],
        ['delivered', 'delivered'],
        // wacli has more receipt kinds than the UI has ticks for.
        ['server-error', 'delivered'],
      ]) {
        const res = await postSigned(app, pm, {
          EventType: 'receipt',
          Chat: '15551234567@s.whatsapp.net',
          Sender: '15559876543@s.whatsapp.net',
          MessageIDs: ['MSG-1', 'MSG-2'],
          Timestamp: '2026-08-31T12:00:00Z',
          Type: type,
          IsFromMe: true,
        });
        expect(res.status).toBe(200);
        expect(receivedEvents.at(-1)).toMatchObject({
          type: 'message.receipt',
          data: {
            chatJid: '15551234567@s.whatsapp.net',
            messageIds: ['MSG-1', 'MSG-2'],
            status,
            isFromMe: true,
          },
        });
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('POST /internal/wacli/webhook keeps an incoming message body out of the log', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm, new EventBridge());
    const optIn = process.env.WACLI_LOG_WEBHOOK_PAYLOADS;
    delete process.env.WACLI_LOG_WEBHOOK_PAYLOADS;
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    for (const level of levels) vi.spyOn(logger, level).mockImplementation(() => {});

    try {
      const res = await postSigned(app, pm, {
        Chat: '15551234567@s.whatsapp.net',
        ID: 'TEST-MSG-2',
        Timestamp: '2026-08-31T12:00:00Z',
        FromMe: false,
        SenderName: 'Ada Lovelace',
        Text: 'PRIVATE BODY: door code 4417',
      });
      expect(res.status).toBe(200);

      const logged = JSON.stringify(levels.flatMap((level) => vi.mocked(logger[level]).mock.calls));
      expect(logged).toContain('Webhook event received');
      expect(logged).not.toContain('door code 4417');
      expect(logged).not.toContain('Ada Lovelace');
    } finally {
      if (optIn === undefined) delete process.env.WACLI_LOG_WEBHOOK_PAYLOADS;
      else process.env.WACLI_LOG_WEBHOOK_PAYLOADS = optIn;
      vi.restoreAllMocks();
    }
  });
});

/** Posts `body` to the webhook signed the way the sync daemon signs it. */
function postSigned(app: ReturnType<typeof createApp>, pm: WacliProcessManager, body: object) {
  const payload = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', pm.getWebhookSecret()).update(payload).digest('hex');
  return request(app)
    .post('/internal/wacli/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Wacli-Signature', `sha256=${hmac}`)
    .send(payload);
}
