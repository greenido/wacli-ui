import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

/**
 * A query string the caller got wrong is answered 400, with what was wrong,
 * before wacli is asked anything. Cast `as string`, a repeated parameter
 * arrived as an array (`q.trim` threw) and a limit of "abc" went to wacli,
 * which refused it: either way a 500, telling the caller to retry something
 * that could only fail again.
 */
describe('query parameters', () => {
  const app = createApp(new WacliProcessManager({ apiPort: 3002 }));

  beforeEach(() => {
    execWacliMock.mockReset();
    execWacliMock.mockResolvedValue([]);
  });

  it.each([
    '/api/search?q=a&q=b',
    '/api/messages?chat=a@s.whatsapp.net&chat=b@s.whatsapp.net',
    '/api/chats?query=x&query=y',
    '/api/groups?query=a&query=b',
  ])('refuses a repeated parameter: %s', async (url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be given once/);
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it.each([
    '/api/search?q=hello&limit=abc',
    '/api/messages?limit=-5',
    '/api/chats?limit=1.5',
  ])('refuses a limit that is not a positive whole number: %s', async (url) => {
    const res = await request(app).get(url);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Query parameter "limit" must be a positive whole number.');
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it('passes a good limit through to wacli as given', async () => {
    const res = await request(app).get('/api/messages?chat=a@s.whatsapp.net&limit=25');

    expect(res.status).toBe(200);
    const args = execWacliMock.mock.calls[0][0] as string[];
    expect(args.slice(args.indexOf('--limit'), args.indexOf('--limit') + 2)).toEqual(['--limit', '25']);
  });
});
