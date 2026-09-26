import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../index.js';
import { WacliProcessManager } from '../wacli/process-manager.js';
import * as commands from '../wacli/commands.js';
import {
  checkForWacliUpdate,
  fetchLatestRelease,
  isNewerVersion,
  parseVersion,
  resetWacliUpdateCheck,
  startWacliUpdateChecks,
  upgradeCommandFor,
  wacliUpdateFor,
} from '../wacli/update-check.js';

/** GitHub's latest-release answer, as much of it as the check reads. */
function releaseFetch(tag: string, status = 200) {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({ tag_name: tag, html_url: `https://github.com/openclaw/wacli/releases/tag/${tag}` }),
      { status }
    )
  ) as unknown as typeof fetch;
}

function installed(version: string, binPath = '/nonexistent/wacli') {
  return vi.spyOn(commands, 'checkWacliInstalled').mockResolvedValue({
    installed: true,
    version,
    binPath,
    error: null,
  });
}

beforeEach(() => resetWacliUpdateCheck());
afterEach(() => {
  vi.restoreAllMocks();
  resetWacliUpdateCheck();
});

describe('wacli versions', () => {
  it('reads the number out of however the version is spelled', () => {
    expect(parseVersion('wacli 0.19.0')).toEqual([0, 19, 0]);
    expect(parseVersion('v0.18.2')).toEqual([0, 18, 2]);
    expect(parseVersion('dev')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares numerically, part by part', () => {
    expect(isNewerVersion('0.19.1', 'wacli 0.19.0')).toBe(true);
    expect(isNewerVersion('0.20.0', 'wacli 0.19.9')).toBe(true);
    // As strings, "0.10.0" sorts before "0.9.0".
    expect(isNewerVersion('0.10.0', 'wacli 0.9.0')).toBe(true);
    expect(isNewerVersion('1.0.0', 'wacli 0.99.99')).toBe(true);
    expect(isNewerVersion('0.19.0', 'wacli 0.19.0')).toBe(false);
    expect(isNewerVersion('0.19.0', 'wacli 0.20.0')).toBe(false);
  });

  it('does not tell a build it cannot read the version of to replace itself', () => {
    expect(isNewerVersion('0.19.0', 'wacli dev')).toBe(false);
    expect(isNewerVersion('0.19.0', null)).toBe(false);
  });
});

describe('the upgrade command', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-upgrade-'));
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A wacli the way Homebrew lays one out: a link on PATH into the Cellar. */
  function brewInstall(): string {
    const cellar = path.join(dir, 'Cellar', 'wacli', '0.19.0', 'bin');
    fs.mkdirSync(cellar, { recursive: true });
    fs.writeFileSync(path.join(cellar, 'wacli'), '');
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.symlinkSync(path.join(cellar, 'wacli'), path.join(dir, 'bin', 'wacli'));
    return path.join(dir, 'bin');
  }

  it('is brew upgrade for a Homebrew install, found by name on PATH', () => {
    process.env.PATH = brewInstall();
    expect(upgradeCommandFor('wacli')).toBe('brew upgrade wacli');
  });

  it('is brew upgrade for a Homebrew install given by path', () => {
    expect(upgradeCommandFor(path.join(brewInstall(), 'wacli'))).toBe('brew upgrade wacli');
  });

  it('is nothing for a binary brew does not own, or none at all', () => {
    const own = path.join(dir, 'wacli');
    fs.writeFileSync(own, '');
    expect(upgradeCommandFor(own)).toBeNull();
    expect(upgradeCommandFor(path.join(dir, 'missing'))).toBeNull();
  });
});

describe('the latest release', () => {
  it('is read from the tag, without its v', async () => {
    await expect(fetchLatestRelease(releaseFetch('v0.19.1'))).resolves.toEqual({
      version: '0.19.1',
      url: 'https://github.com/openclaw/wacli/releases/tag/v0.19.1',
    });
  });

  it('fails on an error status or a tag that is not a version', async () => {
    await expect(fetchLatestRelease(releaseFetch('v0.19.1', 403))).rejects.toThrow('403');
    await expect(fetchLatestRelease(releaseFetch('nightly'))).rejects.toThrow('Unexpected release tag');
  });
});

describe('the update check', () => {
  it('offers the newer release to an older install, and nothing to a current one', async () => {
    installed('wacli 0.19.0');
    await checkForWacliUpdate(releaseFetch('v0.19.1'));

    expect(wacliUpdateFor('wacli 0.19.0', '/nonexistent/wacli')).toEqual({
      latestVersion: '0.19.1',
      releaseUrl: 'https://github.com/openclaw/wacli/releases/tag/v0.19.1',
      upgradeCommand: null,
    });
    // Upgraded while running: the next health poll sees the new version.
    expect(wacliUpdateFor('wacli 0.19.1', '/nonexistent/wacli')).toBeNull();
  });

  it('offers nothing when GitHub could not be asked', async () => {
    installed('wacli 0.18.2');
    await checkForWacliUpdate(vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);

    expect(wacliUpdateFor('wacli 0.18.2', '/nonexistent/wacli')).toBeNull();
  });

  it('asks GitHub at startup, unless WACLI_UPDATE_CHECK=0 says not to', async () => {
    installed('wacli 0.19.0');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(releaseFetch('v0.19.0'));
    const saved = process.env.WACLI_UPDATE_CHECK;
    try {
      process.env.WACLI_UPDATE_CHECK = '0';
      startWacliUpdateChecks();
      expect(fetchSpy).not.toHaveBeenCalled();

      delete process.env.WACLI_UPDATE_CHECK;
      startWacliUpdateChecks();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      if (saved === undefined) delete process.env.WACLI_UPDATE_CHECK;
      else process.env.WACLI_UPDATE_CHECK = saved;
    }
  });

  it('reaches the console through /api/health', async () => {
    installed('wacli 0.19.0');
    vi.spyOn(commands, 'execWacli').mockResolvedValue({ authenticated: true, connected: true });
    const pm = new WacliProcessManager({ apiPort: 3002 });
    vi.spyOn(pm, 'getState').mockReturnValue('running');
    pm.dispose();

    const before = await request(createApp(pm)).get('/api/health?fresh=1');
    expect(before.body.data.wacliUpdate).toBeNull();

    await checkForWacliUpdate(releaseFetch('v0.19.1'));
    const after = await request(createApp(pm)).get('/api/health?fresh=1');
    expect(after.body.data.wacliUpdate).toMatchObject({ latestVersion: '0.19.1', upgradeCommand: null });
  });
});
