import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile, spawn } from 'node:child_process';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { WacliProcessManager } from '../wacli/process-manager.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

const execFileMock = vi.mocked(execFile);
const spawnMock = vi.mocked(spawn);

/** Just enough of a child process for the manager to attach its listeners. */
function stubChild() {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.pid = 4242;
  child.killed = false;
  child.stdout = null;
  child.stderr = null;
  child.kill = () => true;
  return child as never;
}

/**
 * Drives the promisified execFile callback with a successful wacli reply.
 *
 * The real `execFile` carries a `promisify.custom` that resolves to
 * `{ stdout, stderr }`; a bare mock does not, so promisify falls back to
 * resolving the first callback value. Handing it the pair as one object is
 * what makes the mock destructure the way the real thing does.
 */
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

/** The value wacli was given for a flag, or undefined when it was not passed. */
function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * `--store` says which database to open; `--account` says which of the sessions
 * inside it to act as. They were chained with `else if`, so configuring a store
 * silently dropped the account and every command ran as whichever session wacli
 * picked by default — against the right database, as the wrong person.
 */
describe('store directory and account are independent flags', () => {
  /**
   * Both values fall back to saved settings and then to the environment, so a
   * test that did not pin them would read whatever this machine happens to have
   * configured. Stated here instead, so each case says exactly what wacli was
   * told and nothing leaks in from outside.
   */
  function configure(settings: { storeDir?: string; account?: string }): void {
    vi.spyOn(modeManager, 'getSettings').mockReturnValue({ readOnly: false, ...settings });
    delete process.env.WACLI_STORE_DIR;
    delete process.env.WACLI_ACCOUNT;
  }

  beforeEach(() => {
    execFileMock.mockReset();
    resolveOk();
    configure({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes both when both are configured', async () => {
    await execWacli(['chats', 'list'], { storeDir: '/tmp/store-a', account: '15550100' });

    const args = lastArgs();
    expect(flagValue(args, '--store')).toBe('/tmp/store-a');
    expect(flagValue(args, '--account')).toBe('15550100');
  });

  it('passes the account alone when no store is configured', async () => {
    await execWacli(['chats', 'list'], { account: '15550100' });

    const args = lastArgs();
    expect(args).not.toContain('--store');
    expect(flagValue(args, '--account')).toBe('15550100');
  });

  it('passes the store alone when no account is configured', async () => {
    await execWacli(['chats', 'list'], { storeDir: '/tmp/store-a' });

    const args = lastArgs();
    expect(flagValue(args, '--store')).toBe('/tmp/store-a');
    expect(args).not.toContain('--account');
  });

  it('reads both from saved settings', async () => {
    configure({ storeDir: '/tmp/store-b', account: '15550199' });

    await execWacli(['chats', 'list']);

    const args = lastArgs();
    expect(flagValue(args, '--store')).toBe('/tmp/store-b');
    expect(flagValue(args, '--account')).toBe('15550199');
  });

  /**
   * The daemon has to open the same store as the reads do, as the same
   * account. It carried its own copy of the same `else if`, so a configured
   * store meant the console followed one session while every command ran
   * against another.
   */
  it('gives the sync daemon both as well', () => {
    configure({ storeDir: '/tmp/store-c', account: '15550123' });

    const pm = new WacliProcessManager({ apiPort: 0 });
    spawnMock.mockReturnValue(stubChild());
    pm.start();
    pm.dispose();

    const args = spawnMock.mock.calls.at(-1)![1] as string[];
    expect(flagValue(args, '--store')).toBe('/tmp/store-c');
    expect(flagValue(args, '--account')).toBe('15550123');
  });

  it('leaves a flag the caller already spelled out alone', async () => {
    await execWacli(['chats', 'list', '--store', '/tmp/explicit', '--account', '15550111'], {
      storeDir: '/tmp/store-a',
      account: '15550100',
    });

    const args = lastArgs();
    expect(args.filter((a) => a === '--store')).toHaveLength(1);
    expect(args.filter((a) => a === '--account')).toHaveLength(1);
    expect(flagValue(args, '--store')).toBe('/tmp/explicit');
    expect(flagValue(args, '--account')).toBe('15550111');
  });
});
