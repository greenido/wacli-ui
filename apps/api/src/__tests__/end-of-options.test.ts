import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const execFileMock = vi.mocked(execFile);

/** Answers every wacli call with success, the way store-and-account.test.ts does. */
function resolveOk(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execFileMock.mockImplementation(((_bin: string, _args: string[], _opts: unknown, cb: any) => {
    process.nextTick(() =>
      cb(null, { stdout: JSON.stringify({ success: true, data: {} }), stderr: '' })
    );
    return {} as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
}

/** The args the last execFile call actually received. */
function lastArgs(): string[] {
  return execFileMock.mock.calls.at(-1)![1] as string[];
}

/**
 * A search query is an operand, so the route hands it over behind `--`. The
 * flags execWacli adds of its own — store, account, --json, --timeout — used to
 * be appended at the end, which behind a `--` would have made them part of the
 * query instead of options.
 */
describe('execWacli with an end-of-options marker', () => {
  beforeEach(() => {
    execFileMock.mockReset();
    resolveOk();
    vi.spyOn(modeManager, 'getSettings').mockReturnValue({
      readOnly: false,
      storeDir: '/tmp/wacli-store',
      account: 'work',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds its own flags in front of "--" and leaves the operand last', async () => {
    await execWacli(['messages', 'search', '--', '-x']);

    const args = lastArgs();
    const marker = args.indexOf('--');
    expect(args.slice(marker)).toEqual(['--', '-x']);

    const options = args.slice(0, marker);
    expect(options).toEqual(
      expect.arrayContaining(['--store', '--account', '--json', '--timeout'])
    );
  });

  it('does not take an operand spelled like a flag as that flag', async () => {
    // Judged across the whole argv, a search for the word "--store" looked like
    // a store already chosen, and the configured one was left off.
    await execWacli(['messages', 'search', '--', '--store']);

    const args = lastArgs();
    const options = args.slice(0, args.indexOf('--'));
    expect(options[options.indexOf('--store') + 1]).toBe('/tmp/wacli-store');
    expect(args.at(-1)).toBe('--store');
  });

  it('still appends its flags at the end when there is no marker', async () => {
    await execWacli(['chats', 'list']);

    const args = lastArgs();
    expect(args.slice(0, 2)).toEqual(['chats', 'list']);
    expect(args).not.toContain('--');
    expect(args).toContain('--json');
  });
});
