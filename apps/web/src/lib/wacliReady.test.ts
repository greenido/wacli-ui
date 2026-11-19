import { describe, it, expect } from 'vitest';
import { isWacliReadyForReads } from './wacliReady.ts';
import type { MissionControlStatus } from '../types.ts';

function health(over: Partial<MissionControlStatus>): MissionControlStatus {
  return {
    wacliInstalled: true,
    wacliWorking: true,
    statusSummary: 'ok',
    processState: 'running',
    syncDisabled: false,
    ...over,
  } as MissionControlStatus;
}

describe('isWacliReadyForReads', () => {
  it('reads with a running daemon', () => {
    expect(isWacliReadyForReads(health({}))).toBe(true);
  });

  it('holds reads while a daemon is on its way up, or down when it should not be', () => {
    for (const processState of ['starting', 'restarting', 'stopped', 'failed', 'logged_out'] as const) {
      expect(isWacliReadyForReads(health({ processState }))).toBe(false);
    }
  });

  it('reads with the daemon off on purpose, which reads never needed', () => {
    // `--no-sync` used to leave the whole console empty.
    expect(isWacliReadyForReads(health({ processState: 'stopped', syncDisabled: true }))).toBe(true);
  });

  it('still holds reads for what --no-sync does not explain', () => {
    // Another wacli holding the store is a problem with or without a daemon.
    expect(
      isWacliReadyForReads(
        health({ processState: 'stopped', syncDisabled: true, statusSummary: 'store_locked_external' })
      )
    ).toBe(false);
    // A daemon started by hand under --no-sync is judged like any other.
    expect(isWacliReadyForReads(health({ processState: 'starting', syncDisabled: true }))).toBe(false);
    expect(isWacliReadyForReads(health({ processState: 'stopped', syncDisabled: true, wacliWorking: false }))).toBe(false);
  });
});
