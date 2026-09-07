import { describe, it, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST } from '../index.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CLI = path.join(REPO_ROOT, 'bin/cli.js');

/**
 * `--host` was parsed and then used only for the banner and the browser it
 * opened, while the server went on binding 127.0.0.1 — so `--host 0.0.0.0`
 * printed a URL nothing was listening on. `HOST` was documented in the README
 * as an environment variable too, and never read.
 *
 * The flag is gone rather than wired up: the loopback bind is what stands in
 * for authentication on a console holding a live WhatsApp session, so there was
 * no correct behaviour to implement.
 */
describe('the bind address is not configurable', () => {
  it('is loopback', () => {
    expect(HOST).toBe('127.0.0.1');
  });

  it('ignores a HOST environment variable', async () => {
    const before = process.env.HOST;
    process.env.HOST = '0.0.0.0';

    try {
      // Re-evaluated with the variable set: nothing reads it, so nothing moves.
      vi.resetModules();
      const fresh = await import('../index.js');
      expect(fresh.HOST).toBe('127.0.0.1');
    } finally {
      if (before === undefined) delete process.env.HOST;
      else process.env.HOST = before;
    }
  });

  it('does not offer a --host flag', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--help']);

    expect(stdout).not.toContain('--host');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('always binds 127.0.0.1');
  });

  it('still takes a port', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, '--help']);
    expect(stdout).toMatch(/-p, --port/);
  });
});
