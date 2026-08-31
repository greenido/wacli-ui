import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

describe('API Read Endpoints', () => {
  const pm = new WacliProcessManager({ apiPort: 3002 });
  const app = createApp(pm);

  it('GET /api/chats returns chat list array', async () => {
    const res = await request(app).get('/api/chats?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('GET /api/search with empty query returns empty results', async () => {
    const res = await request(app).get('/api/search?q=');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.results).toEqual([]);
  });

  it('GET /api/messages returns messages payload', async () => {
    const res = await request(app).get('/api/messages?limit=5');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('messages');
    expect(Array.isArray(res.body.data.messages)).toBe(true);
  });
});
