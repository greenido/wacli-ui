import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modeManager } from './mode.js';
import { logger } from '../logger.js';
import type { RawWacliResponse } from '../types.js';
import { isStoreLockMessage, sleep, toStoreLockedError } from './store-lock.js';
import { compactUrls } from './failures.js';

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
  /** Internal retries for transient store lock contention (default 3). */
  lockRetryAttempts?: number;
  /** Delay between lock retries in ms (default 400). */
  lockRetryDelayMs?: number;
}

export interface WacliInstallStatus {
  installed: boolean;
  version: string | null;
  binPath: string;
  error: string | null;
}

/**
 * `/api/health` is polled by every open pane, and each call used to spawn
 * `wacli --version` on top of `wacli doctor`. The binary's version does not
 * change while the app is running, so it is cached. A missing binary expires
 * quickly, so installing wacli is noticed without a restart.
 */
const INSTALLED_TTL_MS = 60_000;
const MISSING_TTL_MS = 5_000;

/**
 * A read the operator is waiting on should not take this long. Past it the
 * command names itself in the log without anyone having to raise the level
 * first — the rail feeling sluggish is otherwise a hunch with no evidence.
 */
const SLOW_COMMAND_MS = 1_000;

/**
 * `wacli send` holds its connection open for --post-send-wait after the message
 * is on the wire (default 2s) so a retry receipt can be served. With the sync
 * daemon up, sends are delegated to it over the store's .send.sock and that
 * connection stays alive regardless, so the default is dead time on every send:
 * it was the whole gap between a message acked at 1.8s and a POST /send/text
 * that only returned at 3.4s.
 *
 * Short rather than 0, because the delegate socket is not always there. While
 * an exclusive command holds the daemon down, or during a reconnect, the CLI
 * dials its own connection, and hanging up the instant the send lands would
 * leave an immediate retry receipt unanswered.
 */
export const POST_SEND_WAIT = process.env.WACLI_POST_SEND_WAIT ?? '500ms';

let installCache: { status: WacliInstallStatus; bin: string; expiresAt: number } | null = null;

export function resetWacliInstallCache(): void {
  installCache = null;
}

export async function checkWacliInstalled(): Promise<WacliInstallStatus> {
  const bin = process.env.WACLI_BIN ?? 'wacli';

  if (installCache && installCache.bin === bin && Date.now() < installCache.expiresAt) {
    return installCache.status;
  }

  const status = await probeWacliInstalled(bin);
  installCache = {
    status,
    bin,
    expiresAt: Date.now() + (status.installed ? INSTALLED_TTL_MS : MISSING_TTL_MS),
  };
  return status;
}

async function probeWacliInstalled(bin: string): Promise<WacliInstallStatus> {
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

function classifyCommandError(
  err: unknown,
  commandLabel: string,
  timeoutMs?: number
): WacliCommandError {
  if (err instanceof WacliCommandError) {
    return err;
  }
  const execErr = err as {
    code?: number | string;
    killed?: boolean;
    signal?: string;
    message?: string;
    stdout?: string;
    stderr?: string;
  };
  const rawOut = (execErr.stdout || '') + (execErr.stderr || '');
  const exitCode = typeof execErr.code === 'number' ? execErr.code : undefined;

  // `rawOutput` keeps whatever wacli actually printed; the message is compacted
  // because it is what gets logged and classified, and a 250-character media URL
  // inside it pushes the real cause past the log's per-field cap.
  if (rawOut) {
    try {
      const parsed = JSON.parse(rawOut.trim()) as RawWacliResponse<unknown>;
      if (parsed.error) {
        return new WacliCommandError(compactUrls(parsed.error), exitCode, rawOut, commandLabel);
      }
    } catch (pErr) {
      if (pErr instanceof WacliCommandError) {
        return pErr;
      }
    }
  }

  // execFile kills the child once `timeout` elapses, and the error it raises
  // then says only `Command failed: <cmd>` — the process was stopped before it
  // could print a reason, so there is nothing in the output to classify. Naming
  // it here is the difference between a log line that says what happened and
  // one that says a command failed, somehow, after thirty seconds.
  if (execErr.killed || execErr.code === 'ETIMEDOUT') {
    const budget = timeoutMs ? ` after ${timeoutMs}ms` : '';
    const signal = execErr.signal ? ` (killed with ${execErr.signal})` : '';
    return new WacliCommandError(
      `Command timed out${budget}${signal}: ${commandLabel}`,
      exitCode,
      rawOut,
      commandLabel
    );
  }

  return new WacliCommandError(
    compactUrls(execErr.message || 'Unknown execution error'),
    exitCode,
    rawOut,
    commandLabel
  );
}

async function execWacliOnce<T>(
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

  // wacli's own --timeout defaults to five minutes, so our execFile timer always
  // won and killed it with SIGTERM: no JSON error to report, and a command
  // stopped mid-flight rather than unwound. A deadline inside ours lets wacli
  // give up on its own terms, print a reason, and release the store lock.
  if (!fullArgs.includes('--timeout')) {
    fullArgs.push('--timeout', `${Math.max(1, Math.round((timeout * 0.8) / 1000))}s`);
  }

  const commandLabel = `${bin} ${args.join(' ')}`;
  const cmd = args.join(' ');
  const startedAt = Date.now();

  try {
    const { stdout, stderr } = await execFileAsync(bin, fullArgs, {
      env,
      timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    const durationMs = Date.now() - startedAt;
    const output = stdout.trim() || stderr.trim();

    // Every read spawns a subprocess against SQLite, so this is where the app's
    // latency actually goes. At DEBUG it is the trace that names the slow read;
    // past the threshold it is worth saying out loud without being asked.
    if (durationMs >= SLOW_COMMAND_MS) {
      logger.warn('api', 'wacli command was slow', { cmd, durationMs, bytes: output.length });
    } else {
      logger.debug('api', 'wacli command completed', { cmd, durationMs, bytes: output.length });
    }

    if (!output) {
      throw new WacliCommandError('Empty output from wacli command', undefined, undefined, commandLabel);
    }

    try {
      const parsed = JSON.parse(output) as RawWacliResponse<T>;
      if (!parsed.success) {
        throw new WacliCommandError(
          parsed.error || 'wacli returned unsuccessful response',
          undefined,
          output,
          commandLabel
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
        commandLabel
      );
    }
  } catch (err: unknown) {
    const cmdErr = classifyCommandError(err, commandLabel, timeout);

    // Only the caller knows whether a failure is expected — expired media, a
    // chat with no rows — so the severity is theirs to choose. Logging it as an
    // ERROR here too is what used to write every failure to the log twice, once
    // at a severity that made routine outcomes look like incidents.
    logger.debug('api', 'wacli command failed', {
      cmd,
      durationMs: Date.now() - startedAt,
      exitCode: cmdErr.exitCode,
      err: cmdErr,
    });

    throw cmdErr;
  }
}

export async function execWacli<T>(
  args: string[],
  options: ExecWacliOptions = {}
): Promise<T> {
  const maxAttempts = options.lockRetryAttempts ?? 3;
  const retryDelayMs = options.lockRetryDelayMs ?? 400;
  const commandLabel = `${process.env.WACLI_BIN ?? 'wacli'} ${args.join(' ')}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await execWacliOnce<T>(args, options);
    } catch (err: unknown) {
      const cmdErr = classifyCommandError(err, commandLabel);
      const isLock = isStoreLockMessage(cmdErr.message);
      const isLastAttempt = attempt >= maxAttempts;

      if (isLock && !isLastAttempt) {
        logger.warn('api', 'Store locked; retrying', {
          cmd: args.join(' '),
          attempt,
          maxAttempts,
          retryInMs: retryDelayMs,
        });
        await sleep(retryDelayMs);
        continue;
      }

      if (isLock) {
        throw toStoreLockedError(cmdErr.message, commandLabel);
      }

      throw cmdErr;
    }
  }

  throw new WacliCommandError('Unexpected execWacli retry exhaustion', undefined, undefined, commandLabel);
}
