import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * supertest (7.3.2+) starts the app's server on 127.0.0.1, the address it
 * sends requests to. Older versions listened on every interface and then
 * connected to 127.0.0.1; on macOS that wildcard socket could be given a port
 * another program held on 127.0.0.1, and the request landed in that program.
 * This file used to patch supertest to bind loopback; the dependency now does
 * it itself, and the patch broke its new way of filling in the port. The
 * version floor in apps/api/package.json is what keeps that fix in place.
 */

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
