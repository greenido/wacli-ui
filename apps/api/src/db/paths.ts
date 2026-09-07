import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const CONFIG_DIR_NAME = '.wacli-mission-control';
export const DB_FILE_NAME = 'mission-control.db';

/**
 * The directory Mission Control keeps its own state in.
 *
 * Every store used to resolve this for itself, with three slightly different
 * fallback chains between them — one of which quietly landed in `os.tmpdir()`
 * while its neighbour landed in the cwd, so a home directory that could not be
 * written left the app with its state split across two places. One database
 * means one directory, resolved once.
 */
export function resolveConfigDir(): string {
  const candidates = [
    path.join(os.homedir(), CONFIG_DIR_NAME),
    path.join(process.cwd(), CONFIG_DIR_NAME),
    path.join(os.tmpdir(), CONFIG_DIR_NAME),
  ];

  for (const dir of candidates) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // Try the next one down.
    }
  }

  // Nothing was writable. Returning the first candidate lets openDatabase fail
  // with the real filesystem error and a path the operator recognises, rather
  // than this function inventing a diagnosis of its own.
  return candidates[0];
}

/** Where the database lives. `WACLI_DB_FILE` overrides it, tests included. */
export function resolveDbPath(): string {
  const override = process.env.WACLI_DB_FILE;
  if (override) return override;
  return path.join(resolveConfigDir(), DB_FILE_NAME);
}
