import type { MissionControlStatus } from '../types.ts';

/**
 * The daemon's traffic light, shared with the strip's header so a collapsed
 * panel still says whether sync is healthy.
 */
export function statusColor(
  processState: MissionControlStatus['processState'],
  wsConnected: boolean
): string {
  if (!wsConnected || processState === 'failed' || processState === 'logged_out') {
    return 'bg-mc-danger text-mc-danger';
  }
  if (processState === 'restarting' || processState === 'paused' || processState === 'starting') {
    return 'bg-mc-safe text-mc-safe';
  }
  return 'bg-mc-live text-mc-live';
}
