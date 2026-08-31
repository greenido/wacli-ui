import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

describe('Media Routes', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test-audio-${Date.now()}.ogg`);
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
    const res = await request(app).get('/api/media/content?path=/nonexistent/path/file.jpg');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/media/download rejects request without chat or id', async () => {
    const res = await request(app).post('/api/media/download').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });
});
