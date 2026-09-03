import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { UnifiedChat } from '../types.ts';

/** Title the page carries when nothing is waiting. */
export const BASE_TITLE = 'wacli Mission Control';

/**
 * Total unread across every chat the app currently knows about.
 *
 * The rail caches one list per filter and search term, and those entries can
 * disagree — a two-minute-old `unread` list still shows a chat the fresh `all`
 * list has since seen read. Reading newest-entry-first per JID keeps the badge
 * honest without a dedicated request: the count is derived from data the rail
 * already fetched, never from one of its own.
 */
export function readUnreadTotal(queryClient: QueryClient): number {
  const lists = queryClient
    .getQueryCache()
    .findAll({ queryKey: ['chats'] })
    .filter((query) => Array.isArray(query.state.data))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);

  const counted = new Map<string, number>();
  for (const query of lists) {
    for (const chat of query.state.data as UnifiedChat[]) {
      if (counted.has(chat.jid) || chat.archived) continue;
      counted.set(chat.jid, Math.max(0, chat.unreadCount));
    }
  }

  let total = 0;
  for (const count of counted.values()) total += count;
  return total;
}

export function useUnreadTotal(): number {
  const queryClient = useQueryClient();
  return useSyncExternalStore(
    (onChange) => queryClient.getQueryCache().subscribe(onChange),
    () => readUnreadTotal(queryClient),
    () => 0
  );
}

export function unreadTitle(total: number): string {
  return total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
}

/**
 * Puts the unread count in the tab title, so a backgrounded console still says
 * whether anything is waiting.
 */
export function useUnreadTitle(): number {
  const total = useUnreadTotal();

  useEffect(() => {
    document.title = unreadTitle(total);
    return () => {
      document.title = BASE_TITLE;
    };
  }, [total]);

  return total;
}
