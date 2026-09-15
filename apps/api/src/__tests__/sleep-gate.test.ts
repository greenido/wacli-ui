import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { Scheduler } from '../wacli/scheduler.js';
import { ASLEEP_CODE, SLEEP_ROUTES, SleepController } from '../wacli/sleep.js';

const UI = { 'X-Mission-Control-Request': '1' };

/** A manager whose daemon spawn is a spy, so no wacli ever starts. */
function makeDaemon() {
  const pm = new WacliProcessManager({ apiPort: 3002, respawnDebounceMs: 0 });
  const spawn = vi
    .spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess')
    .mockImplementation(() => {});
  return { pm, spawn };
}

interface RouteLayer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
}

interface AppLayer {
  handle?: { stack?: RouteLayer[] };
  match(path: string): boolean;
}

/**
 * Every route the app serves under /api, as "METHOD /api/path", read off the
 * app itself rather than a list someone keeps: a route added tomorrow shows up
 * here whether or not anyone remembered sleep.
 */
function registeredApiRoutes(app: ReturnType<typeof createApp>): string[] {
  const stack = (app as unknown as { router: { stack: AppLayer[] } }).router.stack;
  const keys: string[] = [];
  for (const layer of stack) {
    const routes = layer.handle?.stack;
    if (!routes || !layer.match('/api/__probe__')) continue;
    for (const { route } of routes) {
      if (!route) continue;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const method of Object.keys(route.methods)) {
        for (const p of paths) keys.push(`${method.toUpperCase()} /api${p}`);
      }
    }
  }
  return keys;
}

/** Sends `METHOD /api/...` with a harmless body, filling in any `:id`. */
function call(app: ReturnType<typeof createApp>, key: string) {
  const [method, rawPath] = key.split(' ');
  const url = rawPath.replace(':id', 'sched-does-not-exist');
  const agent = request(app);
  switch (method) {
    case 'GET':
      return agent.get(url).set(UI);
    case 'DELETE':
      return agent.delete(url).set(UI);
    default:
      return agent.post(url).set(UI).send({});
  }
}

let pm: WacliProcessManager;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  modeManager.setSleeping(false);
  modeManager.setReadOnly(false);
  execWacliMock.mockReset();
  execWacliMock.mockResolvedValue({});
  ({ pm } = makeDaemon());
  app = createApp(pm);
});

afterEach(() => {
  pm.dispose();
  modeManager.setSleeping(false);
});

describe('sleep gate route table', () => {
  it('puts every /api route in exactly one class, and names none that does not exist', () => {
    const registered = registeredApiRoutes(app);
    const classes = Object.entries(SLEEP_ROUTES) as [string, readonly string[]][];

    const unclassified = registered.filter(
      (key) => classes.filter(([, keys]) => keys.includes(key)).length !== 1
    );
    const unknown = classes.flatMap(([, keys]) => keys).filter((key) => !registered.includes(key));

    expect(unclassified).toEqual([]);
    expect(unknown).toEqual([]);
  });
});

describe('sleep gate while asleep', () => {
  beforeEach(() => {
    modeManager.setSleeping(true);
  });

  it.each(SLEEP_ROUTES.refuse)('refuses %s without running wacli', async (key) => {
    const res = await call(app, key);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ success: false, code: ASLEEP_CODE });
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(modeManager.isSleeping()).toBe(true);
  });

  it('cannot be walked past with another spelling of a refused read', async () => {
    // Express answers HEAD with the GET handler, and matches paths regardless
    // of case or a trailing slash. The gate has to read them the same way.
    for (const res of [
      await request(app).get('/api/CHATS/'),
      await request(app).head('/api/chats'),
      await request(app).get('/api/Health?fresh=1'),
    ]) {
      expect(res.status).toBe(409);
    }
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it.each(SLEEP_ROUTES.wake)('wakes the app for %s', async (key) => {
    await call(app, key);

    expect(modeManager.isSleeping()).toBe(false);
  });

  it('wakes before the send reaches wacli, not after', async () => {
    let asleepAtSend: boolean | null = null;
    execWacliMock.mockImplementation(async () => {
      asleepAtSend = modeManager.isSleeping();
      return { id: 'STUBMSG0001' };
    });

    const res = await request(app)
      .post('/api/send/text')
      .set(UI)
      .send({ to: '15550100001@s.whatsapp.net', message: 'Good morning', confirm: true });

    expect(res.status).toBe(200);
    expect(asleepAtSend).toBe(false);
  });

  it.each(SLEEP_ROUTES.allow)('lets %s through without waking or running wacli', async (key) => {
    const res = await call(app, key);

    expect(res.body?.code).not.toBe(ASLEEP_CODE);
    expect(modeManager.isSleeping()).toBe(true);
    expect(execWacliMock).not.toHaveBeenCalled();
  });

  it('leaves the internal webhook alone', async () => {
    const res = await request(app).post('/internal/wacli/webhook').send({});

    expect(res.body?.code).not.toBe(ASLEEP_CODE);
    expect(modeManager.isSleeping()).toBe(true);
  });
});

describe('sleep gate while awake', () => {
  it('lets a wacli read through', async () => {
    execWacliMock.mockResolvedValue({ query: 'hello', fts: true, results: [] });

    const res = await request(app).get('/api/search').query({ q: 'hello' });

    expect(res.body?.code).not.toBe(ASLEEP_CODE);
    expect(execWacliMock).toHaveBeenCalled();
  });
});

describe('media content while asleep', () => {
  let store: string;
  let onDisk: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-sleep-media-'));
    fs.mkdirSync(path.join(store, 'media'), { recursive: true });
    onDisk = path.join(store, 'media', 'photo.jpg');
    fs.writeFileSync(onDisk, Buffer.alloc(64, 1));
    modeManager.updateSettings({ storeDir: store });
    modeManager.setSleeping(true);
  });

  afterEach(() => {
    fs.rmSync(store, { recursive: true, force: true });
  });

  it('still serves a file that is already on disk', async () => {
    const res = await request(app).get('/api/media/content').query({ path: onDisk });

    expect(res.status).toBe(200);
    expect(res.body.length).toBe(64);
  });

  it('will not download one that is missing, and stays asleep', async () => {
    // Scrolling a frozen thread asks for every attachment on screen; asleep,
    // none of them may cost a wacli download, or a wake.
    const res = await request(app)
      .get('/api/media/content')
      .query({ chat: '15550100001@s.whatsapp.net', id: 'STUBMSG0002' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe(ASLEEP_CODE);
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(modeManager.isSleeping()).toBe(true);
  });
});

describe('resending while asleep', () => {
  let dbFile: string;

  beforeEach(() => {
    dbFile = path.join(os.tmpdir(), `wacli-test-sleep-resend-${Date.now()}-${Math.random()}.db`);
  });

  afterEach(() => {
    fs.rmSync(dbFile, { force: true });
  });

  it('sends the message and leaves the app asleep, with no daemon', async () => {
    const { pm: daemon, spawn } = makeDaemon();
    daemon.start();
    const sleep = new SleepController({ daemon });
    const scheduler = new Scheduler(dbFile);
    scheduler.setExclusiveRunner(daemon);

    execWacliMock.mockRejectedValueOnce(new Error('wacli exploded'));
    const item = scheduler.schedule({
      to: '15550100001@s.whatsapp.net',
      message: 'Good morning',
      scheduledAt: new Date(Date.now() - 1000).toISOString(),
    });
    await scheduler.checkDueMessages();
    expect(scheduler.getList()[0].status).toBe('failed');

    await sleep.sleep('test');
    spawn.mockClear();
    execWacliMock.mockResolvedValueOnce({ id: 'STUBMSG0003' });

    const outcome = await scheduler.resend(item.id);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(outcome.ok).toBe(true);
    expect(scheduler.getList()[0].status).toBe('sent');
    expect(modeManager.isSleeping()).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    daemon.dispose();
  });
});
