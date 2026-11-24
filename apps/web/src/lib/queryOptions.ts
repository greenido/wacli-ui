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
 * WAITING is worked out from the same message scan the chat rail reads, and
 * the server holds that scan for a few seconds, so polling at the rail's pace
 * lets the two share one wacli subprocess instead of each paying for its own.
 */
export const POLL_WAITING_MS = POLL_CHATS_MS;

/**
 * wacli's change feed (0.22+): one small read that names every chat whose
 * messages changed. While it answers, the console refetches exactly those
 * threads and the rail, so the blind polls above only have to catch what the
 * feed cannot see — receipts and chat state (pins, mutes, unread counts) — and
 * slow to POLL_BEHIND_FEED_MS.
 */
export const POLL_CHANGES_MS = 10_000;
export const POLL_BEHIND_FEED_MS = 120_000;

/** The blind poll for a read the change feed also covers. */
export function pollBehindFeed(intervalMs: number, feedLive: boolean): number {
  return feedLive ? Math.max(intervalMs, POLL_BEHIND_FEED_MS) : intervalMs;
}

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
      // Asleep is an answer, not a failure: asking again cannot wake the server.
      if (error instanceof ApiClientError && error.code === 'ASLEEP') {
        return false;
      }
      if (error instanceof ApiClientError && error.code === 'STORE_LOCKED' && failureCount < 4) {
        return true;
      }
      return failureCount < 1;
    },
    retryDelay: (attempt) => Math.min(400 * attempt, 2000),
  };
}
