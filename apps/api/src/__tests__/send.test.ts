import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

describe('Send Endpoints & Guardrails', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  beforeEach(() => {
    modeManager.setReadOnly(true);
  });

  it('rejects send requests when read-only mode is active (403)', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({
        to: '15551234567@s.whatsapp.net',
        message: 'Hello',
        confirm: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Safe read-only mode is active');
  });

  it('rejects send requests when confirm: true is missing (400)', async () => {
    modeManager.setReadOnly(false);

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({
        to: '15551234567@s.whatsapp.net',
        message: 'Hello',
        // confirm omitted
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('confirm: true');
  });

  it('rejects file send when no file is uploaded (400)', async () => {
    modeManager.setReadOnly(false);

    const res = await request(app)
      .post('/api/send/file')
      .set('X-Mission-Control-Request', '1')
      .field('to', '15551234567@s.whatsapp.net')
      .field('confirm', 'true');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No file attachment provided');
  });
});
