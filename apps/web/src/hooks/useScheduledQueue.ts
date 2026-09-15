import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { POLL_SCHEDULED_MS } from '../lib/queryOptions.ts';

/**
 * The queue: every pending message on the first page, history a page at a
 * time. Only page one is polled — the pages behind it are settled history and
 * refetching them on a timer would fight the operator's own scrolling.
 *
 * A hook rather than a copy per component because every observer of an
 * infinite query's key has to be the same infinite query.
 */
export function useScheduledQueue() {
  return useInfiniteQuery({
    queryKey: ['scheduled'],
    queryFn: ({ pageParam }) => api.getScheduled({ before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_SCHEDULED_MS,
  });
}
