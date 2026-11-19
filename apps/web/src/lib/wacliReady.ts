import type { MissionControlStatus } from '../types.ts';

export function isWacliReadyForReads(health?: MissionControlStatus | null): boolean {
  if (!health?.wacliInstalled || !health.wacliWorking) {
    return false;
  }

  if (
    health.statusSummary === 'sync_starting' ||
    health.statusSummary === 'store_locked_external'
  ) {
    return false;
  }

  const state = health.processState;

  // Reads are one-shot read-only commands and never needed the daemon. A
  // stopped one is held against them because, normally, stopped means not up
  // yet or down unexpectedly. Started with `--no-sync` it means neither, and
  // holding reads back left the whole console empty.
  if (state === 'stopped' && health.syncDisabled) {
    return true;
  }

  if (
    state === 'starting' ||
    state === 'restarting' ||
    state === 'stopped' ||
    state === 'failed' ||
    state === 'logged_out'
  ) {
    return false;
  }

  return true;
}

export function isStoreLockApiError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as { code?: string }).code === 'STORE_LOCKED';
}
