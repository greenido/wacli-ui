import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { TEST_MEDIA_DIR, TEST_STORE_DIR } from './setup.js';

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

  describe('the store root beside the media dir', () => {
    // session.db is the linked device's keys and wacli.db the whole archive.
    // Both sit in the store, one level above media, and the route used to
    // serve anything in the store.
    const files = ['session.db', 'wacli.db'].map((name) => path.join(TEST_STORE_DIR, name));

    beforeEach(() => {
      for (const file of files) fs.writeFileSync(file, 'SECRET-IDENTITY-KEYS');
    });

    afterEach(() => {
      for (const file of files) fs.rmSync(file, { force: true });
    });

    it('refuses the session keys and the archive', async () => {
      for (const file of files) {
        const res = await request(app).get('/api/media/content').query({ path: file });

        expect(res.status, file).toBe(403);
        expect(res.text).not.toContain('SECRET-IDENTITY-KEYS');
      }
    });

    it('refuses them by way of the media dir', async () => {
      const res = await request(app)
        .get('/api/media/content')
        .query({ path: path.join(TEST_MEDIA_DIR, '..', 'session.db') });

      expect(res.status).toBe(403);
    });

    it('refuses a link inside the media dir that points at them', async () => {
      const link = path.join(TEST_MEDIA_DIR, `photo-${Date.now()}.jpg`);
      fs.symlinkSync(files[0], link);

      try {
        const res = await request(app).get('/api/media/content').query({ path: link });

        expect(res.status).toBe(403);
        expect(res.text).not.toContain('SECRET-IDENTITY-KEYS');
      } finally {
        fs.rmSync(link, { force: true });
      }
    });
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

  describe('the name a download is given', () => {
    // The caller chooses it, so it may be anything, and it lands in a header.
    it.each([
      ['invoice.pdf', 'attachment; filename="invoice.pdf"'],
      // Written into the header raw, this failed the whole download with a 500.
      [
        'חשבונית.pdf',
        `attachment; filename="???????.pdf"; filename*=UTF-8''${encodeURIComponent('חשבונית.pdf')}`,
      ],
      ['café.pdf', 'attachment; filename="café.pdf"'],
      ['ev"il.ogg', 'attachment; filename="ev\\"il.ogg"'],
    ])('downloads under %s', async (filename, disposition) => {
      const res = await request(app)
        .get('/api/media/content')
        .query({ path: tmpFile, download: '1', filename });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe(disposition);
    });

    it('cannot add a header of its own', async () => {
      const res = await request(app)
        .get('/api/media/content')
        .query({ path: tmpFile, download: '1', filename: 'a\r\nSet-Cookie: session=stolen.ogg' });

      expect(res.status).toBe(200);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.headers['content-disposition']).not.toMatch(/[\r\n]/);
    });

    it('does not decide what the file is', async () => {
      const res = await request(app)
        .get('/api/media/content')
        .query({ path: tmpFile, download: '1', filename: 'evil.html' });

      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toBe('attachment; filename="evil.html"');
      expect(res.headers['content-type']).toMatch(/^audio\/ogg\b/);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });

  it('GET /api/media/content serves a type it does not list as opaque bytes', async () => {
    const page = path.join(TEST_MEDIA_DIR, `page-${Date.now()}.html`);
    fs.writeFileSync(page, '<script>alert(1)</script>');

    try {
      const res = await request(app).get('/api/media/content').query({ path: page });

      // Not text/html, which `send` would have guessed from the extension.
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    } finally {
      fs.rmSync(page, { force: true });
    }
  });

  // `send` takes the path as a URL path; a name that means something in a URL
  // must still reach the file it names.
  it.each(['a b.ogg', 'a%20b.ogg', '100%.ogg', 'a#b.ogg', 'a?b.ogg', 'הקלטה.ogg'])(
    'GET /api/media/content serves a file named %s',
    async (name) => {
      const file = path.join(TEST_MEDIA_DIR, name);
      fs.writeFileSync(file, `bytes of ${name}`);

      try {
        const res = await request(app).get('/api/media/content').query({ path: file });

        expect(res.status).toBe(200);
        expect(res.headers['content-length']).toBe(String(Buffer.byteLength(`bytes of ${name}`)));
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
  );

  it('GET /api/media/content answers a folder under media with 404', async () => {
    const folder = fs.mkdtempSync(path.join(TEST_MEDIA_DIR, 'chat-'));

    try {
      const res = await request(app).get('/api/media/content').query({ path: folder });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('GET /api/media/content handles a suffix byte range', async () => {
    const size = fs.statSync(tmpFile).size;
    const res = await request(app)
      .get(`/api/media/content?path=${encodeURIComponent(tmpFile)}`)
      .set('Range', 'bytes=-10');

    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
  });

  it('GET /api/media/content answers a range past the end with 416 and the real size', async () => {
    const size = fs.statSync(tmpFile).size;
    const res = await request(app)
      .get('/api/media/content')
      .query({ path: tmpFile, download: '1' })
      .set('Range', 'bytes=99999-100000');

    expect(res.status).toBe(416);
    // What a player needs to ask again for something that exists.
    expect(res.headers['content-range']).toBe(`bytes */${size}`);
    // An answer about the request, not a piece of the file, and not a download.
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['content-disposition']).toBeUndefined();
    expect(res.body).toEqual({ success: false, data: null, error: 'Range Not Satisfiable' });
  });

  it('GET /api/media/content answers a repeat load with 304', async () => {
    const first = await request(app).get('/api/media/content').query({ path: tmpFile });
    expect(first.headers['cache-control']).toBe('no-cache');

    const again = await request(app)
      .get('/api/media/content')
      .query({ path: tmpFile })
      .set('If-None-Match', first.headers.etag);

    expect(again.status).toBe(304);
  });

  it('POST /api/media/download rejects request without chat or id', async () => {
    const res = await request(app).post('/api/media/download').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });
});
