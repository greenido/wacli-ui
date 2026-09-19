import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../index.js';
import { logger } from '../logger.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';

vi.mock('../wacli/commands.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../wacli/commands.js')>()),
  execWacli: vi.fn().mockRejectedValue(new Error('no rows in result set')),
}));

/**
 * `pipe()` does not forward errors, and an unhandled `error` on a read stream is
 * an uncaught exception — so a file that went away mid-body took the whole API
 * down with it, and the sync daemon and every other pane with that.
 */
describe('media streaming survives a file that goes away', () => {
  let store: string;
  let pm: WacliProcessManager;
  let app: ReturnType<typeof createApp>;
  let mediaPath: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-media-'));
    fs.mkdirSync(path.join(store, 'media'), { recursive: true });
    mediaPath = path.join(store, 'media', 'clip.mp4');
    // Big enough that the body arrives in more than one chunk, so there is a
    // window in which the file can be pulled out from under the stream.
    fs.writeFileSync(mediaPath, Buffer.alloc(4 * 1024 * 1024, 7));

    modeManager.updateSettings({ storeDir: store });
    pm = new WacliProcessManager({ apiPort: 0 });
    app = createApp(pm);
  });

  afterEach(() => {
    pm.dispose();
    fs.rmSync(store, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('serves a file inside the store', async () => {
    const res = await request(app).get('/api/media/content').query({ path: mediaPath });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body.length).toBe(4 * 1024 * 1024);
  });

  it('serves a byte range', async () => {
    const res = await request(app)
      .get('/api/media/content')
      .query({ path: mediaPath })
      .set('Range', 'bytes=0-1023');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-1023/${4 * 1024 * 1024}`);
  });

  /**
   * Reads fail the way an unmounted volume or a file deleted under the stream
   * does, after `chunks` good ones. Modelled rather than raced: a real 4 MB
   * file is flushed to a loopback socket faster than any timer could interrupt
   * it.
   */
  function failReadsAfter(chunks: number): void {
    vi.spyOn(fs, 'createReadStream').mockImplementation((() => {
      let delivered = 0;
      return new Readable({
        read() {
          if (delivered++ < chunks) this.push(Buffer.alloc(64 * 1024, 7));
          else this.destroy(new Error('EIO: i/o error, read'));
        },
      });
    }) as unknown as typeof fs.createReadStream);
  }

  it('stays up when the read fails mid-body', async () => {
    failReadsAfter(1);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    // Headers are out by then, so there is no status left to send, only a body
    // that stops. The assertion is that this rejects rather than killing the
    // process: an unhandled 'error' here used to be an uncaught exception, and
    // the suite would go down with the server rather than report a failed
    // request.
    await expect(
      request(app).get('/api/media/content').query({ path: mediaPath })
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith('media', 'Media stream failed mid-body', expect.anything());

    // Still serving, which is the whole point.
    vi.mocked(fs.createReadStream).mockRestore();
    const after = await request(app).get('/api/media/content').query({ path: mediaPath });
    expect(after.status).toBe(200);
  });

  it('answers a read that fails before the first byte as an error, not as the file', async () => {
    failReadsAfter(0);
    vi.spyOn(logger, 'error').mockImplementation(() => {});

    const res = await request(app)
      .get('/api/media/content')
      .query({ path: mediaPath })
      .set('Range', 'bytes=0-1023');

    // Nothing had gone out, so there is still a status to send, and it is not
    // the 206 or the video/mp4 that were set up for the file.
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-range']).toBeUndefined();
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body.success).toBe(false);

    vi.mocked(fs.createReadStream).mockRestore();
    const after = await request(app).get('/api/media/content').query({ path: mediaPath });
    expect(after.status).toBe(200);
  });

  it('serves a store under a dot-directory, as ~/.wacli is', async () => {
    const dotStore = path.join(store, '.wacli');
    fs.mkdirSync(path.join(dotStore, 'media'), { recursive: true });
    const clip = path.join(dotStore, 'media', 'clip.mp4');
    fs.writeFileSync(clip, Buffer.alloc(1024, 7));
    modeManager.updateSettings({ storeDir: dotStore });

    const res = await request(app).get('/api/media/content').query({ path: clip });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1024);
  });

  it('refuses a path outside the store', async () => {
    const outside = path.join(os.tmpdir(), 'wacli-not-media.txt');
    fs.writeFileSync(outside, 'not yours');

    try {
      const res = await request(app).get('/api/media/content').query({ path: outside });
      expect(res.status).toBe(403);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
