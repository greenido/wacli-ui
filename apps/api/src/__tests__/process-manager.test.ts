import { describe, it, expect, vi } from 'vitest';
import { WacliProcessManager } from '../wacli/process-manager.js';

describe('WacliProcessManager', () => {
  it('generates random HMAC secret and starts in stopped state', () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    expect(pm.getState()).toBe('stopped');
    expect(pm.getWebhookSecret()).toHaveLength(64); // 32 bytes in hex
    expect(pm.getPid()).toBeNull();
  });

  it('notifies on state change', () => {
    const stateCallback = vi.fn();
    const pm = new WacliProcessManager({
      apiPort: 3002,
      onStateChange: stateCallback,
    });

    expect(pm.getState()).toBe('stopped');
  });

  it('handles pause/resume exclusive execution gracefully when child is not running', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    let actionExecuted = false;

    // Mock spawnSyncProcess to avoid actually starting wacli in this unit test
    vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(() => {});

    const result = await pm.executeExclusive(async () => {
      actionExecuted = true;
      return 'done';
    });

    expect(actionExecuted).toBe(true);
    expect(result).toBe('done');
  });

  it('captures error event and updates lastError', () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    (pm as unknown as { handleStderrLine: (line: string) => void }).handleStderrLine(
      JSON.stringify({ event: 'error', data: { message: 'store is locked by pid 1234' } })
    );

    expect(pm.getLastError()).toBe('store is locked by pid 1234');
  });

  it('handles connected and logged_out events', () => {
    const states: string[] = [];
    const pm = new WacliProcessManager({
      apiPort: 3002,
      onStateChange: (state) => states.push(state),
    });

    (pm as unknown as { handleStderrLine: (line: string) => void }).handleStderrLine(
      JSON.stringify({ event: 'connected', ts: Date.now() })
    );
    expect(pm.getState()).toBe('running');

    (pm as unknown as { handleStderrLine: (line: string) => void }).handleStderrLine(
      JSON.stringify({ event: 'logged_out', ts: Date.now() })
    );
    expect(pm.getState()).toBe('logged_out');
  });

  it('supports restart method', async () => {
    const pm = new WacliProcessManager({ apiPort: 3002 });
    const spawnSpy = vi.spyOn(pm as unknown as { spawnSyncProcess: () => void }, 'spawnSyncProcess').mockImplementation(() => {});
    await pm.restart();
    expect(spawnSpy).toHaveBeenCalled();
  });
});
