import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import { logger } from '../logger.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { scheduler } from '../wacli/scheduler.js';

/** WhatsApp's limit, in a script that takes two bytes a character in UTF-8. */
const LONGEST_HEBREW_MESSAGE = 'א'.repeat(65_536);

/** Everything handed to the logger, errors included as the log file writes them. */
function everythingLogged(): string {
  const calls = (['debug', 'info', 'warn', 'error'] as const).flatMap(
    (level) => vi.mocked(logger[level]).mock.calls
  );
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}\n${value.stack}` : value
  );
}

/**
 * A request the caller got wrong used to come back as a 500: the error handler
 * knew only the store lock and "unhandled", so a body the JSON parser refused,
 * or one over the size limit, read as the server failing.
 */
describe('Requests the caller got wrong', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  beforeEach(() => {
    execWacliMock.mockReset();
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    modeManager.setReadOnly(true);
  });

  it('answers malformed JSON with 400, without quoting the body back', async () => {
    const res = await request(app)
      .post('/api/send/text')
      .set('Content-Type', 'application/json')
      .send('SECRET-TEXT, and not JSON');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      data: null,
      error: 'The request body is not valid JSON.',
    });
    // The parser's own message quotes the start of the body, which on this
    // route is the message someone meant to send.
    expect(everythingLogged()).not.toContain('SECRET-TEX');
    expect(logger.warn).toHaveBeenCalledWith(
      'api',
      'Refused a request it could not use',
      expect.objectContaining({ status: 400, type: 'entity.parse.failed' })
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('answers a body over the limit with 413', async () => {
    const res = await request(app)
      .post('/api/mode')
      .send({ readOnly: true, pad: 'x'.repeat(600 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('The request body is too large.');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('takes the longest message WhatsApp allows, in Hebrew', async () => {
    modeManager.setReadOnly(false);

    const res = await request(app)
      .post('/api/send/schedule')
      .send({
        to: '15550100001@s.whatsapp.net',
        message: LONGEST_HEBREW_MESSAGE,
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        confirm: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.item.message).toBe(LONGEST_HEBREW_MESSAGE);
    expect(scheduler.cancel(res.body.data.item.id)).toEqual({ ok: true });
  });

  it('does not take a status on an error of its own at its word', async () => {
    // Only http-errors marks a status as the caller's fault. A failure deeper
    // down that happens to carry one is still the server's, and still a 500.
    execWacliMock.mockRejectedValue(Object.assign(new Error('wacli fell over'), { status: 404 }));

    const res = await request(app).get('/api/contacts/show').query({ jid: '15550100001@s.whatsapp.net' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('wacli fell over');
    expect(logger.error).toHaveBeenCalledWith('api', 'Unhandled API error', expect.anything());
  });
});
