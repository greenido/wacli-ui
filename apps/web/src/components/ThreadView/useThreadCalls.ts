import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { POLL_CALLS_MS, wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import type { CallRecord, UnifiedMessage } from '../../types.ts';

const NO_CALLS: CallRecord[] = [];

interface ThreadCallsOptions {
  chatJid: string | null;
  readsReady: boolean;
  /** The thread's messages, oldest first. Calls are fetched for the stretch they span. */
  messages: UnifiedMessage[];
  /** Whether older messages remain: if not, every earlier call belongs here too. */
  canLoadOlder: boolean;
  /** Whether newer messages remain past the window: if not, so does every later call. */
  canLoadNewer: boolean;
}

/**
 * The calls that fall within the messages a thread has loaded, so a call is
 * never drawn above history that has not been fetched yet.
 */
export function useThreadCalls({ chatJid, readsReady, messages, canLoadOlder, canLoadNewer }: ThreadCallsOptions) {
  const after = canLoadOlder && messages.length > 0 ? messages[0].ts : undefined;
  const before = canLoadNewer && messages.length > 0 ? messages[messages.length - 1].ts : undefined;

  const { data } = useQuery({
    queryKey: ['calls', chatJid ?? undefined, after, before],
    queryFn: () => api.getCalls({ chat: chatJid!, after, before }),
    // Settled history is not polled; the live end is.
    refetchInterval: before ? false : POLL_CALLS_MS,
    // Paging older moves `after`; the calls already shown stay meanwhile.
    placeholderData: keepPreviousData,
    ...wacliReadQueryOptions(readsReady && Boolean(chatJid)),
  });

  // Held-over data can be the previous chat's.
  return useMemo(
    () => data?.calls.filter((call) => call.chatJid === chatJid) ?? NO_CALLS,
    [data, chatJid]
  );
}
