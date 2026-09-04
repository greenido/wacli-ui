import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

/**
 * The media path as the thread view drives it: many <img> tags resolving at
 * once, each one a potential `wacli media download` competing for the store.
 */
describe('Media download contention through the routes', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);
  const chat = '15551234567@s.whatsapp.net';

  /** Unique per test: the coordinator's caches are process-wide. */
  const freshId = () => `MSG${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  const contentUrl = (id: string) =>
    `/api/media/content?chat=${encodeURIComponent(chat)}&id=${id}`;

  beforeEach(() => {
    execWacliMock.mockReset();
  });

  it('downloads once when the same media is requested concurrently', async () => {
    const id = freshId();
    execWacliMock.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { path: '/nonexistent/after-download.jpg' };
    });

    // Three <img> tags for the same message, as a re-render produces.
    await Promise.all([
      request(app).get(contentUrl(id)),
      request(app).get(contentUrl(id)),
      request(app).get(contentUrl(id)),
    ].map((pending) => pending.then((r) => r)));

    expect(execWacliMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-run a download that already failed', async () => {
    const id = freshId();
    execWacliMock.mockRejectedValue(new Error('download failed with status code 403'));

    const first = await request(app).get(contentUrl(id));
    expect(first.status).toBe(404);
    expect(execWacliMock).toHaveBeenCalledTimes(1);

    // Scrolling past the same expired attachment again must not spawn wacli.
    const second = await request(app).get(contentUrl(id));
    expect(second.status).toBe(404);
    expect(execWacliMock).toHaveBeenCalledTimes(1);
  });

  it('lets the explicit download endpoint through a remembered failure', async () => {
    const id = freshId();
    execWacliMock.mockRejectedValue(new Error('download failed with status code 403'));

    await request(app).get(contentUrl(id));
    expect(execWacliMock).toHaveBeenCalledTimes(1);

    // The MediaViewer Retry button must actually retry.
    execWacliMock.mockResolvedValue({ path: '/nonexistent/retried.jpg' });
    const retry = await request(app).post('/api/media/download').send({ chat, id });

    expect(retry.status).toBe(200);
    expect(execWacliMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a thread full of attachments from stampeding the store', async () => {
    let active = 0;
    let peak = 0;
    execWacliMock.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { path: '/nonexistent/x.jpg' };
    });

    await Promise.all(
      Array.from({ length: 24 }, () => request(app).get(contentUrl(freshId()))).map((p) =>
        p.then((r) => r)
      )
    );

    expect(execWacliMock).toHaveBeenCalledTimes(24);
    // Before the cap this was one wacli process per attachment, all at once.
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('retries a store-lock failure rather than remembering it', async () => {
    const id = freshId();
    execWacliMock.mockRejectedValue(
      new Error('store is locked (another wacli is running?): store locked')
    );

    await request(app).get(contentUrl(id));
    const callsAfterFirst = execWacliMock.mock.calls.length;

    await request(app).get(contentUrl(id));

    // A lock clash is transient; caching it would strand recoverable media.
    expect(execWacliMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
