import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { execWacli, WacliCommandError } from '../wacli/commands.js';
import { isTransientFailure } from '../wacli/failures.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);

/**
 * What `promisify(execFile)` rejects with once its `timeout` elapses: the child
 * is killed, so there is no stdout to explain anything and the message is a
 * bare `Command failed`.
 */
function killedByTimeout(cmd: string) {
  return Object.assign(new Error(`Command failed: ${cmd}`), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
    stdout: '',
    stderr: '',
  });
}

/** Drives the promisified execFile callback with the given failure. */
function rejectWith(err: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileMock.mockImplementation(((_bin: string, _args: string[], _opts: unknown, cb: any) => {
    process.nextTick(() => cb(err, '', ''));
    return {} as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

/** The args the last execFile call actually received. */
function lastArgs(): string[] {
  return execFileMock.mock.calls.at(-1)![1] as string[];
}

describe('wacli command timeouts', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives wacli a deadline inside our own', async () => {
    rejectWith(killedByTimeout('wacli chats mark-read'));

    await expect(
      execWacli(['chats', 'mark-read', '--chat', 'a@s.whatsapp.net'], { timeoutMs: 10_000 })
    ).rejects.toThrow();

    // wacli's own --timeout defaults to 5m, so without this our execFile timer
    // always won and SIGTERMed it mid-command instead of letting it unwind.
    const args = lastArgs();
    expect(args).toContain('--timeout');
    expect(args[args.indexOf('--timeout') + 1]).toBe('8s');
  });

  it('does not override a --timeout the caller already set', async () => {
    rejectWith(killedByTimeout('wacli doctor'));

    await expect(
      execWacli(['doctor', '--timeout', '2s'], { timeoutMs: 30_000 })
    ).rejects.toThrow();

    expect(lastArgs().filter((a) => a === '--timeout')).toHaveLength(1);
  });

  it('says a command timed out instead of that it merely failed', async () => {
    rejectWith(killedByTimeout('wacli chats mark-read --chat a@s.whatsapp.net --json'));

    const err = await execWacli(['chats', 'mark-read'], { timeoutMs: 10_000 }).catch(
      (e: unknown) => e as WacliCommandError
    );

    // The log line that prompted this read `Command failed: wacli chats
    // mark-read …` — thirty seconds of waiting described as an unexplained
    // failure, with no hint that we were the ones who stopped it.
    expect(err).toBeInstanceOf(WacliCommandError);
    expect(err.message).toContain('timed out');
    expect(err.message).toContain('10000ms');
    expect(err.message).toContain('SIGTERM');
  });

  it('treats a command we killed as transient, since it never got an answer', () => {
    expect(
      isTransientFailure('Command timed out after 10000ms (killed with SIGTERM): wacli chats mark-read')
    ).toBe(true);
  });

  it('still reports a real wacli error rather than calling it a timeout', async () => {
    rejectWith(
      Object.assign(new Error('Command failed: wacli chats mark-read'), {
        code: 1,
        stdout: JSON.stringify({ success: false, error: 'chat not found: nope@s.whatsapp.net' }),
        stderr: '',
      })
    );

    const err = await execWacli(['chats', 'mark-read'], { timeoutMs: 10_000 }).catch(
      (e: unknown) => e as WacliCommandError
    );

    expect(err.message).toBe('chat not found: nope@s.whatsapp.net');
    expect(err.exitCode).toBe(1);
  });

  it('keeps a non-numeric exit code out of exitCode', async () => {
    rejectWith(
      Object.assign(new Error('spawn wacli ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        stdout: '',
        stderr: '',
      })
    );

    const err = await execWacli(['chats', 'list'], { timeoutMs: 10_000 }).catch(
      (e: unknown) => e as WacliCommandError
    );

    expect(err.message).toContain('timed out');
    expect(err.exitCode).toBeUndefined();
  });
});
