import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import { POST_SEND_WAIT } from '../wacli/commands.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

describe('Send Endpoints & Guardrails', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  beforeEach(() => {
    modeManager.setReadOnly(true);
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue({ id: 'msg-1' });
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

  /**
   * wacli send holds its connection open for --post-send-wait after the message
   * is on the wire, and its 2s default was two thirds of the latency of a send
   * the operator sits watching. Dropping the flag again would put it straight
   * back without anything failing, so the args are asserted rather than trusted.
   */
  it('passes an explicit --post-send-wait so a send does not idle on the default', async () => {
    modeManager.setReadOnly(false);

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({
        to: '15551234567@s.whatsapp.net',
        message: 'Hello',
        confirm: true,
      });

    expect(res.status).toBe(200);
    const args = execWacliMock.mock.calls[0][0] as string[];
    expect(args).toContain('--post-send-wait');
    expect(args[args.indexOf('--post-send-wait') + 1]).toBe(POST_SEND_WAIT);
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

  it('POST /api/send/schedule is blocked while read-only mode is active (403)', async () => {
    modeManager.setReadOnly(true);

    const res = await request(app)
      .post('/api/send/schedule')
      .set('X-Mission-Control-Request', '1')
      .send({
        to: '15559876543@s.whatsapp.net',
        message: 'Should not be queued',
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        confirm: true,
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Safe read-only mode is active');
  });

  it('POST /api/send/schedule schedules a message and lists it', async () => {
    modeManager.setReadOnly(false);
    const scheduledAt = new Date(Date.now() + 3600000).toISOString();

    const res = await request(app)
      .post('/api/send/schedule')
      .set('X-Mission-Control-Request', '1')
      .send({
        to: '15559876543@s.whatsapp.net',
        recipientName: 'Bob',
        message: 'Reminder for meeting tomorrow',
        scheduledAt,
        confirm: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.item.status).toBe('pending');
    expect(res.body.data.item.message).toBe('Reminder for meeting tomorrow');

    // List scheduled
    const listRes = await request(app).get('/api/send/scheduled?chat=15559876543@s.whatsapp.net');
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data.some((i: { id: string }) => i.id === res.body.data.item.id)).toBe(true);

    // Cancel scheduled
    const cancelRes = await request(app).delete(`/api/send/scheduled/${res.body.data.item.id}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.cancelled).toBe(true);
  });

  /** Queues a pending message through the API and hands back its id. */
  async function schedulePending(): Promise<string> {
    modeManager.setReadOnly(false);
    const res = await request(app)
      .post('/api/send/schedule')
      .set('X-Mission-Control-Request', '1')
      .send({
        to: '15550001111@s.whatsapp.net',
        message: 'Queued',
        scheduledAt: new Date(Date.now() + 3600000).toISOString(),
        confirm: true,
      });
    return res.body.data.item.id as string;
  }

  it('POST resend rejects a request without confirm: true (400)', async () => {
    const id = await schedulePending();

    const res = await request(app)
      .post(`/api/send/scheduled/${id}/resend`)
      .set('X-Mission-Control-Request', '1')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('confirm: true');
  });

  it('POST resend is blocked while safe read-only mode is active (403)', async () => {
    const id = await schedulePending();
    modeManager.setReadOnly(true);

    const res = await request(app)
      .post(`/api/send/scheduled/${id}/resend`)
      .set('X-Mission-Control-Request', '1')
      .send({ confirm: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Safe read-only mode is active');
  });

  it('POST resend refuses a message that has not failed (409)', async () => {
    const id = await schedulePending();

    const res = await request(app)
      .post(`/api/send/scheduled/${id}/resend`)
      .set('X-Mission-Control-Request', '1')
      .send({ confirm: true });

    // The guard that makes a double send impossible, seen from the API.
    expect(res.status).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toContain('Only a failed message can be resent');
  });

  it('POST resend reports an unknown id rather than inventing one (409)', async () => {
    modeManager.setReadOnly(false);

    const res = await request(app)
      .post('/api/send/scheduled/sched-does-not-exist/resend')
      .set('X-Mission-Control-Request', '1')
      .send({ confirm: true });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('not found');
  });

  it('POST discard refuses a pending message', async () => {
    const id = await schedulePending();

    const res = await request(app).post(`/api/send/scheduled/${id}/discard`);

    expect(res.status).toBe(200);
    expect(res.body.data.discarded).toBe(false);
    expect(res.body.error).toContain('not in failed state');
  });
});

describe('Send responses carry the ID the console needs to jump', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  beforeEach(() => {
    modeManager.setReadOnly(false);
    execWacliMock.mockReset();
  });

  it('hoists wacli\'s message ID out of the raw result', async () => {
    execWacliMock.mockResolvedValue({ sent: true, to: '15551234567@s.whatsapp.net', id: '3EB0A1B2C3' });

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', message: 'Hello', confirm: true });

    expect(res.status).toBe(200);
    // Buried in `details` this was never read, so the ACTIVITY rail had no ID
    // to focus and could only reopen the conversation.
    expect(res.body.data.messageId).toBe('3EB0A1B2C3');
  });

  it('reports no ID rather than a placeholder when wacli gave none', async () => {
    execWacliMock.mockResolvedValue({ sent: true, to: '15551234567@s.whatsapp.net' });

    const res = await request(app)
      .post('/api/send/text')
      .set('X-Mission-Control-Request', '1')
      .send({ to: '15551234567@s.whatsapp.net', message: 'Hello', confirm: true });

    expect(res.status).toBe(200);
    expect(res.body.data.sent).toBe(true);
    expect(res.body.data.messageId).toBeNull();
  });
});
