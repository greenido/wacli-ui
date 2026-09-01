import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { TEST_MEDIA_DIR } from './setup.js';

describe('Media Routes', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  let tmpFile: string;

  beforeEach(() => {
    // Fixtures live inside the sandboxed wacli store so they pass containment.
    tmpFile = path.join(TEST_MEDIA_DIR, `test-audio-${Date.now()}.ogg`);
    fs.writeFileSync(tmpFile, 'OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00FakeAudioBytesDataForTest');
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  });

  it('GET /api/media/content streams local file with correct content type', async () => {
    const res = await request(app)
      .get(`/api/media/content?path=${encodeURIComponent(tmpFile)}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('audio/ogg');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('GET /api/media/content supports HTTP byte range requests', async () => {
    const res = await request(app)
      .get(`/api/media/content?path=${encodeURIComponent(tmpFile)}`)
      .set('Range', 'bytes=0-10');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toContain('bytes 0-10/');
    expect(res.headers['content-type']).toContain('audio/ogg');
  });

  it('GET /api/media/content returns 404 for nonexistent path when chat/id not given', async () => {
    const missing = path.join(TEST_MEDIA_DIR, 'does-not-exist.jpg');
    const res = await request(app).get(`/api/media/content?path=${encodeURIComponent(missing)}`);
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/media/content refuses to stream files outside the wacli store', async () => {
    const secret = path.join(os.tmpdir(), `wacli-outside-${Date.now()}.txt`);
    fs.writeFileSync(secret, 'TOP SECRET KEY MATERIAL');

    try {
      const res = await request(app).get(`/api/media/content?path=${encodeURIComponent(secret)}`);

      expect(res.status).toBe(403);
      expect(res.text).not.toContain('TOP SECRET');
    } finally {
      fs.unlinkSync(secret);
    }
  });

  it('GET /api/media/content refuses traversal out of the media dir', async () => {
    const traversal = path.join(TEST_MEDIA_DIR, '..', '..', '..', '..', 'etc', 'passwd');
    const res = await request(app).get(`/api/media/content?path=${encodeURIComponent(traversal)}`);
    expect(res.status).toBe(403);
  });

  it('GET /api/media/content serves SVG as an attachment, never inline', async () => {
    const svgPath = path.join(TEST_MEDIA_DIR, `payload-${Date.now()}.svg`);
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

    try {
      const res = await request(app).get(`/api/media/content?path=${encodeURIComponent(svgPath)}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      fs.unlinkSync(svgPath);
    }
  });

  it('GET /api/media/content sanitizes the download filename header', async () => {
    const res = await request(app).get(
      `/api/media/content?path=${encodeURIComponent(tmpFile)}&download=1&filename=${encodeURIComponent('ev"il.ogg')}`
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="ev_il.ogg"');
  });

  it('GET /api/media/content handles a suffix byte range', async () => {
    const res = await request(app)
      .get(`/api/media/content?path=${encodeURIComponent(tmpFile)}`)
      .set('Range', 'bytes=-10');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes \d+-\d+\/\d+$/);
  });

  it('GET /api/media/content falls back to 200 for an unsatisfiable range', async () => {
    const res = await request(app)
      .get(`/api/media/content?path=${encodeURIComponent(tmpFile)}`)
      .set('Range', 'bytes=99999-100000');

    expect(res.status).toBe(200);
  });

  it('POST /api/media/download rejects request without chat or id', async () => {
    const res = await request(app).post('/api/media/download').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });
});
