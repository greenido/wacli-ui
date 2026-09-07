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
/**
 * The activity log is served from Mission Control's own database rather than
 * through a wacli subprocess, so it costs no store contention and can be read
 * more often than the lists that do.
 */
export const POLL_ACTIVITY_MS = 10_000;
export const POLL_MODE_MS = 15_000;

/**
 * Spelled out rather than picked from `UseQueryOptions`, so the same options
 * spread into an infinite query too — those type `enabled` against paged data,
 * and a shape borrowed from the plain query would not fit. None of these three
 * fields depend on what the query returns, only on how it fails.
 */
export interface WacliReadQueryOptions {
  enabled: boolean;
  retry: (failureCount: number, error: ApiClientError) => boolean;
  retryDelay: (attempt: number) => number;
}

export function wacliReadQueryOptions(enabled: boolean): WacliReadQueryOptions {
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
