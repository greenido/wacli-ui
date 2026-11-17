import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { createApp } from '../index.js';
import {
  accessPolicy,
  isAllowedHost,
  isAllowedOrigin,
  namesMappedToBindAddress,
} from '../net/loopback.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import { modeManager } from '../wacli/mode.js';
import { callRoute, registeredApiRoutes } from './api-routes.js';

/**
 * Mission Control authenticates nothing, so which pages may call it is the
 * whole of its access control. It used to trust every loopback origin on any
 * port, which let any other local app — a dev server, a notebook, a MAMP site
 * with one bad script — read the WhatsApp session keys and send as the
 * operator.
 */
const PORT = 3002;
const HOSTS_FILE = [
  '##',
  '# Host Database',
  '127.0.0.1\tlocalhost',
  '255.255.255.255\tbroadcasthost',
  '::1             localhost',
  '127.0.0.1   wacli-ui   # the console',
  '',
].join('\n');

function appWith(options: { devUi?: boolean; hostsFile?: string } = {}) {
  const access = accessPolicy({ port: PORT, hostsFile: HOSTS_FILE, ...options });
  return createApp(new WacliProcessManager({ apiPort: PORT }), undefined, access);
}

describe('which pages may call the API', () => {
  const app = appWith();

  it('refuses a page on another local port', async () => {
    const res = await request(app).get('/api/mode').set('Origin', 'http://localhost:8888');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_ORIGIN');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('refuses a write from another local port before it runs', async () => {
    const before = modeManager.isReadOnly();

    const res = await request(app)
      .post('/api/mode')
      .set('Origin', 'http://127.0.0.1:8888')
      .send({ readOnly: !before });

    expect(res.status).toBe(403);
    // A simple cross-origin POST runs even when the browser hides its answer,
    // so refusing it is the only thing that keeps the switch where it was.
    expect(modeManager.isReadOnly()).toBe(before);
  });

  it('refuses the preflight from another local port', async () => {
    const res = await request(app)
      .options('/api/send/text')
      .set('Origin', 'http://localhost:8888')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the pages this app serves', async () => {
    for (const origin of [
      `http://127.0.0.1:${PORT}`,
      `http://localhost:${PORT}`,
      `http://wacli-ui:${PORT}`,
    ]) {
      const res = await request(app).get('/api/mode').set('Origin', origin);
      expect(res.status, origin).toBe(200);
      expect(res.headers['access-control-allow-origin'], origin).toBe(origin);
    }
  });

  it('serves a client that sends no Origin', async () => {
    // curl, a test, wacli's own webhook. Browsers always send Origin on a
    // write, so a page cannot pass itself off as one of these.
    const res = await request(app).get('/api/mode');
    expect(res.status).toBe(200);
  });

  it('refuses origins that are not a page it served', async () => {
    for (const origin of [
      'null',
      `https://127.0.0.1:${PORT}`,
      `http://127.0.0.1:${PORT}/`,
      'https://evil.example',
      `http://192.168.1.50:${PORT}`,
    ]) {
      const res = await request(app).get('/api/mode').set('Origin', origin);
      expect(res.status, origin).toBe(403);
    }
  });

  it('trusts the Vite dev server only when started with --dev-ui', async () => {
    const devOrigin = 'http://127.0.0.1:5174';

    const production = await request(app).get('/api/mode').set('Origin', devOrigin);
    expect(production.status).toBe(403);

    const dev = await request(appWith({ devUi: true })).get('/api/mode').set('Origin', devOrigin);
    expect(dev.status).toBe(200);
  });
});

/**
 * Refusing the call is not refusing the frame. Another page that frames the
 * console reads nothing through it — but the operator's clicks land inside,
 * and safe mode's unlock button is one of them, so a framed console routes
 * around the origin check by using the operator's own trusted page.
 */
describe('framing the console', () => {
  it('refuses to be framed, on the page and on the API', async () => {
    const app = appWith();

    // `/` is the console when the web UI is built and a 404 when it is not,
    // which is how CI meets it: tests run before the build. Both are
    // responses this server writes, and both carry the headers.
    for (const path of ['/', '/api/mode']) {
      const res = await request(app).get(path).set('Origin', `http://localhost:${PORT}`);

      expect(res.headers['x-frame-options'], path).toBe('DENY');
      expect(res.headers['content-security-policy'], path).toContain("frame-ancestors 'none'");
    }
  });

  it('carries them on a refusal too, which renders in a frame like anything else', async () => {
    const res = await request(appWith()).get('/api/mode').set('Origin', 'https://evil.example');

    expect(res.status).toBe(403);
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});

/**
 * Every message body, contact name and file name the console shows was written
 * by someone else. React's escaping is the first line; the policy is the
 * second, for the day something slips through it.
 */
describe('what the browser lets the console load', () => {
  function directives(res: request.Response): Map<string, string> {
    const header = String(res.headers['content-security-policy'] ?? '');
    return new Map(
      header.split(';').map((part) => {
        const [name, ...sources] = part.trim().split(/\s+/);
        return [name, sources.join(' ')] as const;
      })
    );
  }

  it('allows script, style and fonts from this server only', async () => {
    const res = await request(appWith()).get('/api/mode').set('Host', `127.0.0.1:${PORT}`);
    const csp = directives(res);

    expect(csp.get('default-src')).toBe("'self'");
    expect(csp.get('script-src')).toBe("'self'");
    expect(csp.get('style-src')).toBe("'self'");
    expect(csp.get('font-src')).toBe("'self'");
    expect(csp.get('object-src')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
  });

  it('lets the page open its live feed on the name it was loaded by', async () => {
    for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `wacli-ui:${PORT}`]) {
      const res = await request(appWith()).get('/api/mode').set('Host', host);
      expect(directives(res).get('connect-src'), host).toBe(`'self' ws://${host}`);
    }
  });

  it('puts nothing from a malformed Host into the policy', async () => {
    // Refused by the Host check anyway; the headers go out on the refusal.
    const res = await request(appWith())
      .get('/api/mode')
      .set('Host', "localhost:3002 'unsafe-inline'");

    expect(res.status).toBe(403);
    expect(directives(res).get('connect-src')).toBe("'self'");
    expect(String(res.headers['content-security-policy'])).not.toContain('unsafe-inline');
  });

  it('tells other sites nothing, by referrer or by embedding', async () => {
    const res = await request(appWith()).get('/api/mode');

    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
  });
});

describe('the Host header', () => {
  it('refuses a name this machine does not answer to', async () => {
    // What DNS rebinding looks like on arrival: a loopback socket, but a Host
    // the operator never typed. No test-mode bypass: this runs as shipped.
    const res = await request(appWith()).get('/api/mode').set('Host', 'evil.example');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_HOST');
  });

  it('accepts a name the hosts file maps to this machine', async () => {
    const res = await request(appWith()).get('/api/mode').set('Host', `wacli-ui:${PORT}`);
    expect(res.status).toBe(200);
  });

  it('refuses that same name on a machine whose hosts file does not map it', async () => {
    // There the name goes out to DNS, where somebody else can answer for it.
    const res = await request(appWith({ hostsFile: '' }))
      .get('/api/mode')
      .set('Host', `wacli-ui:${PORT}`);
    expect(res.status).toBe(403);
  });
});

describe('the settings route', () => {
  it('can no longer move the store the media route serves from', async () => {
    const before = modeManager.getSettings().storeDir;

    const res = await request(appWith()).post('/api/settings').send({ storeDir: '/' });

    expect(res.status).toBe(404);
    expect(modeManager.getSettings().storeDir).toBe(before);
  });
});

describe('access policy helpers', () => {
  it('takes only names the hosts file points at the address the server binds', () => {
    expect(
      namesMappedToBindAddress(
        [
          '127.0.0.1\tlocalhost',
          '127.0.0.1 wacli-ui Console.Local # two names on one line',
          '# 127.0.0.1 commented-out',
          '0.0.0.0 ads.example',
          '::1 v6-only',
          '127.0.0.2 other-loopback',
          '192.168.1.10 nas',
        ].join('\r\n')
      )
    ).toEqual(['localhost', 'wacli-ui', 'console.local']);
  });

  it('matches an origin exactly: scheme, name and port', () => {
    const access = accessPolicy({ port: PORT, hostsFile: HOSTS_FILE });

    expect(isAllowedOrigin(undefined, access)).toBe(true);
    expect(isAllowedOrigin(`http://wacli-ui:${PORT}`, access)).toBe(true);
    expect(isAllowedOrigin(`http://wacli-ui:${PORT + 1}`, access)).toBe(false);
    expect(isAllowedOrigin(`http://[::1]:${PORT}`, access)).toBe(false);
    expect(isAllowedOrigin('not a url', access)).toBe(false);
  });

  it('accepts an origin on port 80, which browsers send without a port', () => {
    const access = accessPolicy({ port: 80, hostsFile: '' });
    expect(isAllowedOrigin('http://localhost', access)).toBe(true);
  });

  it('reads the name from a Host header whatever its port', () => {
    const access = accessPolicy({ port: PORT, hostsFile: HOSTS_FILE });

    expect(isAllowedHost('127.0.0.1:5174', access)).toBe(true);
    expect(isAllowedHost('WACLI-UI:3002', access)).toBe(true);
    expect(isAllowedHost(undefined, access)).toBe(false);
    expect(isAllowedHost('evil.example:3002', access)).toBe(false);
  });
});

describe('the one check between another page and every route', () => {
  it('refuses another site on every route the app serves, before any of them runs', async () => {
    const pm = new WacliProcessManager({ apiPort: PORT });
    vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(
      () => {}
    );
    const app = createApp(pm, undefined, accessPolicy({ port: PORT, hostsFile: HOSTS_FILE }));

    // No route carries a guard of its own any more — the custom header each
    // write used to check is gone — so this check has to cover all of them.
    const routes = registeredApiRoutes(app);
    expect(routes).toEqual(
      expect.arrayContaining(['POST /api/send/text', 'POST /api/mode', 'POST /api/sleep', 'POST /api/tags'])
    );

    for (const key of routes) {
      const res = await callRoute(app, key).set('Origin', 'https://evil.example');
      expect(res.status, key).toBe(403);
      expect(res.body.code, key).toBe('FORBIDDEN_ORIGIN');
    }
    expect(execWacliMock).not.toHaveBeenCalled();
    pm.dispose();
  });
});
