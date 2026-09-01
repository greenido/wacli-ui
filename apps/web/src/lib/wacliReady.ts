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
