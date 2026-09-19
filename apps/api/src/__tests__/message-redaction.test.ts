import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { execWacli, redactCommand, WacliCommandError } from '../wacli/commands.js';
import { StoreLockedError } from '../wacli/store-lock.js';
import { logger } from '../logger.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const execFileMock = vi.mocked(execFile);

/** Two lines, because an Error's stack repeats a multi-line message past its first line. */
const BODY = 'PRIVATE BODY: meet at 7\ndoor code 4417';
const CAPTION = 'the signed contract, final';

const sendText = ['send', 'text', '--to', 'a@s.whatsapp.net', '--message', BODY, '--post-send-wait', '500ms'];
const sendFile = ['send', 'file', '--to', 'a@s.whatsapp.net', '--file', '/tmp/c.pdf', '--caption', CAPTION];

type Outcome = { err: Error | null; stdout: string; elapsedMs?: number };

/**
 * Answers every execFile call with `outcome`. A failure gets the message Node
 * itself builds, `Command failed: <file> <args joined>`, from the args the call
 * actually received, because that string is where the text used to leak from.
 */
function answer(outcome: (bin: string, args: string[]) => Outcome): void {
  let now = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileMock.mockImplementation(((bin: string, args: string[], _opts: unknown, cb: any) => {
    const { err, stdout, elapsedMs = 0 } = outcome(bin, args);
    now += elapsedMs;
    process.nextTick(() => (err ? cb(err, stdout, '') : cb(null, { stdout, stderr: '' })));
    return {} as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

function nodeFailure(bin: string, args: string[], extra: Record<string, unknown>): Error {
  return Object.assign(new Error(`Command failed: ${[bin, ...args].join(' ')}\nboom`), extra);
}

/** Everything handed to the logger, errors included as the log file writes them. */
function everythingLogged(): string {
  const calls = (['debug', 'info', 'warn', 'error'] as const).flatMap(
    (level) => vi.mocked(logger[level]).mock.calls
  );
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error ? `${value.name}: ${value.message}\n${value.stack}` : value
  );
}

/** Neither the message nor any line of it. */
function expectNoText(text: string, secret: string): void {
  for (const piece of [secret, ...secret.split('\n')]) {
    expect(text).not.toContain(piece);
  }
}

async function failureOf(args: string[], options = {}): Promise<Error> {
  return execWacli(args, { timeoutMs: 10_000, ...options }).then(
    () => {
      throw new Error('expected the command to fail');
    },
    (err: unknown) => err as Error
  );
}

describe('Message text stays out of logs and errors', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      vi.spyOn(logger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redacts only the text, keeping the rest of the command line readable', () => {
    expect(redactCommand(sendText).join(' ')).toBe(
      'send text --to a@s.whatsapp.net --message <redacted> --post-send-wait 500ms'
    );
    expect(redactCommand(sendFile)).toContain('<redacted>');
    expect(redactCommand(sendFile)).not.toContain(CAPTION);
    // A flag name is not a value.
    expect(redactCommand(['send', 'text', '--message'])).toEqual(['send', 'text', '--message']);
  });

  it('logs a slow send without its text', async () => {
    answer(() => ({ err: null, stdout: JSON.stringify({ success: true, data: {} }), elapsedMs: 2_400 }));

    await execWacli(sendText, { timeoutMs: 30_000 });

    expect(logger.warn).toHaveBeenCalledWith(
      'api',
      'wacli command was slow',
      expect.objectContaining({ cmd: expect.stringContaining('--message <redacted>') })
    );
    expectNoText(everythingLogged(), BODY);
  });

  it('keeps the text out of a failed send, its error and its stack', async () => {
    answer((bin, args) => ({ err: nodeFailure(bin, args, { code: 1, stdout: '', stderr: 'boom' }), stdout: '' }));

    const err = await failureOf(sendText);

    // Still says which command failed.
    expect(err).toBeInstanceOf(WacliCommandError);
    expect(err.message).toContain('Command failed:');
    expect(err.message).toContain('send text --to a@s.whatsapp.net --message <redacted>');
    expectNoText(`${err.message}\n${err.stack}\n${(err as WacliCommandError).command}`, BODY);
    expectNoText(everythingLogged(), BODY);
  });

  it('keeps the caption out of a failed file send', async () => {
    answer((bin, args) => ({ err: nodeFailure(bin, args, { code: 1, stdout: '', stderr: 'boom' }), stdout: '' }));

    const err = await failureOf(sendFile);

    expectNoText(`${err.message}\n${err.stack}`, CAPTION);
    expectNoText(everythingLogged(), CAPTION);
  });

  it('keeps the text out of a send that timed out', async () => {
    answer((bin, args) => ({
      err: nodeFailure(bin, args, { killed: true, signal: 'SIGTERM', code: null, stdout: '', stderr: '' }),
      stdout: '',
    }));

    const err = await failureOf(sendText);

    expect(err.message).toContain('timed out');
    expectNoText(`${err.message}\n${err.stack}`, BODY);
    expectNoText(everythingLogged(), BODY);
  });

  it('keeps the text out of lock retries and the error that ends them', async () => {
    answer((bin, args) => ({
      err: nodeFailure(bin, args, {
        code: 1,
        stdout: JSON.stringify({ success: false, error: 'store is locked (pid=4242)' }),
        stderr: '',
      }),
      stdout: '',
    }));

    const err = await failureOf(sendText, { lockRetryDelayMs: 0 });

    expect(err).toBeInstanceOf(StoreLockedError);
    expect(logger.warn).toHaveBeenCalledWith(
      'api',
      'Store locked; retrying',
      expect.objectContaining({ cmd: expect.stringContaining('--message <redacted>') })
    );
    expectNoText(`${err.message}\n${(err as StoreLockedError).command}`, BODY);
    expectNoText(everythingLogged(), BODY);
  });
});
