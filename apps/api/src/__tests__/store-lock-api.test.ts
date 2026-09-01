import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { StoreLockedError } from '../wacli/store-lock.js';

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return {
    ...actual,
    execWacli: vi.fn(async (args: string[]) => {
      if (args[0] === 'doctor') {
        return {
          store_dir: '/mock/.wacli',
          lock_held: true,
          authenticated: true,
          connected: true,
          connection_state: 'connected',
          linked_jid: '15551234567@s.whatsapp.net',
          store: { messages: 1, chats: 1 },
        };
      }
      if (args[0] === 'chats') {
        throw new StoreLockedError(
          'store is locked (another wacli is running?): store locked (pid=99999)',
          99999,
          'wacli chats list'
        );
      }
      return {};
    }),
  };
});

describe('Store lock API handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/chats returns 503 with STORE_LOCKED code', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const res = await request(app).get('/api/chats?limit=5');
    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('STORE_LOCKED');
    expect(res.body.lockHolderPid).toBe(99999);
    expect(res.body.error).toContain('store is locked');
  });

  it('GET /api/health includes store lock fields', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const app = createApp(pm);

    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('storeLockHeld');
    expect(res.body.data).toHaveProperty('storeLockHolderPid');
  });
});
