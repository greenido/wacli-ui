import type { UseQueryOptions } from '@tanstack/react-query';
import { ApiClientError } from '../api/client.ts';

/**
 * Polling intervals, in one place so the panes cannot drift apart — several
 * components observe the same query key, and React Query polls such a key at
 * the shortest interval any observer asks for.
 *
 * Every wacli read spawns a subprocess that opens the SQLite store, and
 * `/api/health` costs a `wacli doctor` on top. The WebSocket bridge already
 * pushes new messages, receipts, presence, scheduled updates and connection
 * state, so polling is the safety net for what the socket misses rather than
 * the primary transport. Store contention is not free: it is what the
 * STORE_LOCKED retry path exists to absorb.
 */
export const POLL_HEALTH_MS = 20_000;
export const POLL_CHATS_MS = 30_000;
export const POLL_MESSAGES_MS = 30_000;
export const POLL_SCHEDULED_MS = 15_000;
export const POLL_MODE_MS = 15_000;

export function wacliReadQueryOptions<T>(
  enabled: boolean
): Pick<UseQueryOptions<T, ApiClientError>, 'enabled' | 'retry' | 'retryDelay'> {
  return {
    enabled,
    retry: (failureCount, error) => {
      if (error instanceof ApiClientError && error.code === 'STORE_LOCKED' && failureCount < 4) {
        return true;
      }
      return failureCount < 1;
    },
    retryDelay: (attempt) => Math.min(400 * attempt, 2000),
  };
}
