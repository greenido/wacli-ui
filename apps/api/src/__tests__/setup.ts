import fs from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import supertest from 'supertest';

/**
 * supertest's servers listen on 127.0.0.1, the address it sends requests to.
 *
 * Left alone, supertest starts one server per request with `app.listen(0)`,
 * which binds every interface, then connects to 127.0.0.1. On macOS the kernel
 * will give that wildcard socket a port another program already holds on
 * 127.0.0.1 (a desktop app's local server, say), and a connection to
 * 127.0.0.1 goes to the more specific socket: the request lands in that
 * program. Measured here: 12 of 40,000 wildcard binds got such a port, none of
 * 40,000 loopback ones. With a few hundred requests a run, about one run in
 * four failed a test picked at random: a 404 from a route that exists, a 5s
 * timeout, a socket that never heard from the bridge. Linux refuses that bind,
 * which is why CI never saw it.
 *
 * Binding a named host is asynchronous (Node looks the address up first), but
 * supertest reads the port synchronously to build the URL. So the URL is
 * written once the server is listening, before `end()` sends anything.
 */
interface PatchableTest {
  url: string;
  _server?: http.Server;
  serverAddress(app: http.Server, urlPath: string): string;
  end(fn?: (err: unknown, res?: unknown) => void): unknown;
}

const testProto = (supertest as unknown as { Test: { prototype: PatchableTest } }).Test.prototype;
const PATCHED = Symbol.for('wacli-test.supertest-loopback');

if (!(testProto as unknown as Record<symbol, boolean>)[PATCHED]) {
  (testProto as unknown as Record<symbol, boolean>)[PATCHED] = true;
  const serverAddress = testProto.serverAddress;
  const end = testProto.end;
  const pendingPath = new WeakMap<PatchableTest, string>();

  testProto.serverAddress = function (this: PatchableTest, app, urlPath) {
    if (app.address()) return serverAddress.call(this, app, urlPath);
    this._server = app.listen(0, '127.0.0.1');
    pendingPath.set(this, urlPath);
    return `http://127.0.0.1:0${urlPath}`;
  };

  testProto.end = function (this: PatchableTest, fn) {
    const server = this._server;
    const urlPath = pendingPath.get(this);
    if (!server || urlPath === undefined) return end.call(this, fn);
    pendingPath.delete(this);

    const send = () => {
      this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${urlPath}`;
      end.call(this, fn);
    };
    if (server.listening) send();
    else {
      server.once('listening', send);
      server.once('error', (err) => fn?.(err));
    }
    return this;
  };
}

/**
 * Point every on-disk singleton at a throwaway directory before the modules that
 * read them are imported. Without this the suite loads — and `setReadOnly`
 * rewrites — the developer's real ~/.wacli-mission-control database.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-test-'));

process.env.WACLI_DB_FILE = path.join(sandbox, 'mission-control.db');
process.env.WACLI_STORE_DIR = path.join(sandbox, 'store');

fs.mkdirSync(path.join(sandbox, 'store', 'media'), { recursive: true });

/** Media fixtures must live inside the store to pass path containment. */
export const TEST_STORE_DIR = path.join(sandbox, 'store');
export const TEST_MEDIA_DIR = path.join(sandbox, 'store', 'media');
