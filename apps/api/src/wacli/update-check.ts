import fs from 'node:fs';
import path from 'node:path';
import { checkWacliInstalled } from './commands.js';
import { logger } from '../logger.js';

/**
 * Where wacli publishes releases. Only this one request leaves the machine,
 * and only to GitHub: no identifier of this install or its account goes with it.
 */
const LATEST_RELEASE_URL = 'https://api.github.com/repos/openclaw/wacli/releases/latest';

/** Releases come every week or two; twice a day notices one without nagging GitHub. */
export const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS = 5_000;

export interface WacliRelease {
  version: string;
  url: string;
}

/** What the console shows when the installed wacli is behind the latest release. */
export interface WacliUpdate {
  latestVersion: string;
  releaseUrl: string;
  /** The command that upgrades this install, when it is one we know how to upgrade. */
  upgradeCommand: string | null;
}

/** `wacli 0.19.0`, `v0.19.0` or `0.19.0` as [major, minor, patch]; null for anything else. */
export function parseVersion(text: string | null | undefined): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether `latest` is a newer release than `installed`. A version either side
 * cannot be read from is not an update: a source build that prints no number
 * should not be told to replace itself.
 */
export function isNewerVersion(latest: string, installed: string | null): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The binary a command name resolves to on PATH, links followed; null when absent. */
function resolveBinary(bin: string): string | null {
  const candidates = bin.includes(path.sep)
    ? [bin]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      return fs.realpathSync(candidate);
    } catch {
      // not in this directory
    }
  }
  return null;
}

/**
 * `brew upgrade wacli` for a Homebrew install, which is the one kind that
 * command is right for. A `go install` build or an unpacked release archive
 * gets the release page instead of a command that would not touch it.
 */
export function upgradeCommandFor(bin: string): string | null {
  const resolved = resolveBinary(bin);
  return resolved && resolved.split(path.sep).join('/').includes('/Cellar/wacli/')
    ? 'brew upgrade wacli'
    : null;
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<WacliRelease> {
  const response = await fetchImpl(LATEST_RELEASE_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wacli-mission-control' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status}`);
  }
  const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
  const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
  if (!parseVersion(version)) {
    throw new Error(`Unexpected release tag ${JSON.stringify(body.tag_name)}`);
  }
  return {
    version,
    url: typeof body.html_url === 'string' ? body.html_url : 'https://github.com/openclaw/wacli/releases',
  };
}

let latestRelease: WacliRelease | null = null;
let timer: NodeJS.Timeout | null = null;

/**
 * The update the installed wacli is missing, or null when it is current, when
 * no check has succeeded yet, or when its version cannot be read. Compared on
 * every call rather than stored, so an upgrade made while the console runs
 * clears the notice as soon as the next health poll sees the new version.
 */
export function wacliUpdateFor(installedVersion: string | null, bin: string): WacliUpdate | null {
  if (!latestRelease || !isNewerVersion(latestRelease.version, installedVersion)) return null;
  return {
    latestVersion: latestRelease.version,
    releaseUrl: latestRelease.url,
    upgradeCommand: upgradeCommandFor(bin),
  };
}

/**
 * Asks GitHub for the latest release and says so in the log when the installed
 * wacli is behind. Never upgrades anything: a release can regress what the
 * console relies on, so taking one is the operator's call. A failed check is
 * quiet, because being offline is not a fault, and the next one tries again.
 */
export async function checkForWacliUpdate(fetchImpl: typeof fetch = fetch): Promise<void> {
  try {
    latestRelease = await fetchLatestRelease(fetchImpl);
  } catch (err) {
    logger.debug('process', 'Could not check for a newer wacli', { err });
    return;
  }

  const installed = await checkWacliInstalled();
  const update = installed.installed ? wacliUpdateFor(installed.version, installed.binPath) : null;
  if (update) {
    logger.warn('process', 'A newer wacli is available', {
      installed: parseVersion(installed.version)?.join('.') ?? installed.version,
      latest: update.latestVersion,
      upgrade: update.upgradeCommand ?? update.releaseUrl,
    });
  } else {
    logger.debug('process', 'wacli is up to date', { installed: installed.version, latest: latestRelease.version });
  }
}

/** Checks now and then twice a day, unless `WACLI_UPDATE_CHECK=0` turns it off. */
export function startWacliUpdateChecks(): void {
  if (process.env.WACLI_UPDATE_CHECK === '0' || timer) return;
  void checkForWacliUpdate();
  timer = setInterval(() => void checkForWacliUpdate(), UPDATE_CHECK_INTERVAL_MS);
  timer.unref();
}

/** Test seam: the last release seen is module state. */
export function resetWacliUpdateCheck(): void {
  latestRelease = null;
  if (timer) clearInterval(timer);
  timer = null;
}
