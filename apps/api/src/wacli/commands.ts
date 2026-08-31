import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modeManager } from './mode.js';
import { logger } from '../logger.js';
import type { RawWacliResponse } from '../types.js';

const execFileAsync = promisify(execFile);

export class WacliCommandError extends Error {
  constructor(
    message: string,
    public exitCode?: number,
    public rawOutput?: string,
    public command?: string
  ) {
    super(message);
    this.name = 'WacliCommandError';
  }
}

export interface ExecWacliOptions {
  allowMutation?: boolean;
  timeoutMs?: number;
  storeDir?: string;
  account?: string;
}

export interface WacliInstallStatus {
  installed: boolean;
  version: string | null;
  binPath: string;
  error: string | null;
}

export async function checkWacliInstalled(): Promise<WacliInstallStatus> {
  const bin = process.env.WACLI_BIN ?? 'wacli';
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
      timeout: 5000,
    });
    const versionOutput = (stdout.trim() || stderr.trim()).split('\n')[0] || 'unknown';
    return {
      installed: true,
      version: versionOutput,
      binPath: bin,
      error: null,
    };
  } catch (err: unknown) {
    const execErr = err as { code?: string | number; message?: string };
    const isNotFound =
      execErr.code === 'ENOENT' ||
      (typeof execErr.message === 'string' &&
        (execErr.message.includes('ENOENT') || execErr.message.includes('not found')));

    return {
      installed: false,
      version: null,
      binPath: bin,
      error: isNotFound
        ? `wacli binary '${bin}' was not found in PATH.`
        : (execErr.message || 'Failed to execute wacli binary'),
    };
  }
}

export async function execWacli<T>(
  args: string[],
  options: ExecWacliOptions = {}
): Promise<T> {
  const bin = process.env.WACLI_BIN ?? 'wacli';
  const fullArgs = [...args];

  // Append store / account if configured and not already provided
  const settings = modeManager.getSettings();
  const storeDir = options.storeDir ?? settings.storeDir ?? process.env.WACLI_STORE_DIR;
  const account = options.account ?? settings.account ?? process.env.WACLI_ACCOUNT;

  if (storeDir && !fullArgs.includes('--store')) {
    fullArgs.push('--store', storeDir);
  } else if (account && !fullArgs.includes('--account')) {
    fullArgs.push('--account', account);
  }

  // Always ensure --json is passed if not present
  if (!fullArgs.includes('--json')) {
    fullArgs.push('--json');
  }

  // Read-only safety guard:
  // Inject WACLI_READONLY=1 unless allowMutation is explicitly true
  const env: NodeJS.ProcessEnv = {
    ...process.env,
  };

  if (!options.allowMutation || modeManager.isReadOnly()) {
    env.WACLI_READONLY = '1';
  }

  const timeout = options.timeoutMs ?? 30000;

  try {
    const { stdout, stderr } = await execFileAsync(bin, fullArgs, {
      env,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const output = stdout.trim() || stderr.trim();
    if (!output) {
      throw new WacliCommandError('Empty output from wacli command', undefined, undefined, `${bin} ${args.join(' ')}`);
    }

    try {
      const parsed = JSON.parse(output) as RawWacliResponse<T>;
      if (!parsed.success) {
        throw new WacliCommandError(
          parsed.error || 'wacli returned unsuccessful response',
          undefined,
          output,
          `${bin} ${args.join(' ')}`
        );
      }
      return parsed.data as T;
    } catch (parseErr) {
      if (parseErr instanceof WacliCommandError) {
        throw parseErr;
      }
      throw new WacliCommandError(
        `Failed to parse wacli JSON output: ${output.slice(0, 200)}`,
        undefined,
        output,
        `${bin} ${args.join(' ')}`
      );
    }
  } catch (err: unknown) {
    const execErr = err as { code?: number; message?: string; stdout?: string; stderr?: string };
    const rawOut = (execErr.stdout || '') + (execErr.stderr || '');

    // Attempt to extract structured error from json output
    if (rawOut) {
      try {
        const parsed = JSON.parse(rawOut.trim()) as RawWacliResponse<unknown>;
        if (parsed.error) {
          throw new WacliCommandError(parsed.error, execErr.code, rawOut, `${bin} ${args.join(' ')}`);
        }
      } catch (pErr) {
        if (pErr instanceof WacliCommandError) {
          throw pErr;
        }
      }
    }

    if (err instanceof WacliCommandError) {
      throw err;
    }

    logger.error('api', `Command failed [${bin} ${args.join(' ')}]: ${execErr.message || String(err)}`);
    throw new WacliCommandError(
      execErr.message || 'Unknown execution error',
      execErr.code,
      rawOut,
      `${bin} ${args.join(' ')}`
    );
  }
}
