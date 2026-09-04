import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import type { UnifiedChat } from '../types.ts';

/**
 * How long to hold a read receipt open, coalescing anything that arrives in the
 * meantime into the same call.
 *
 * `POST /chats/mark-read` is not a cheap write: it runs as an exclusive command,
 * which kills the sync daemon, shells out to a wacli that must now dial WhatsApp
 * from cold, and respawns the daemon afterwards. Sitting in a busy chat fired
 * one of those per incoming message — a console that spent much of its time
 * tearing down and rebuilding the very connection delivering those messages.
 *
 * The receipt is idempotent and means "read up to now", so a burst only ever
 * needed one. Trailing edge, because the last message in a burst is the one the
 * receipt should cover.
 */
export const MARK_READ_DEBOUNCE_MS = 3000;

const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function clearChatUnreadInCache(queryClient: QueryClient, jid: string): void {
  queryClient.setQueriesData<UnifiedChat[]>({ queryKey: ['chats'] }, (old) => {
    if (!old) return old;
    return old.map((c) =>
      c.jid === jid ? { ...c, unread: false, unreadCount: 0 } : c
    );
  });
}

export function chatWithUnreadCleared(chat: UnifiedChat): UnifiedChat {
  if (!chat.unread && chat.unreadCount === 0) return chat;
  return { ...chat, unread: false, unreadCount: 0 };
}

/**
 * Clears the badge immediately and tells WhatsApp once the burst has settled.
 *
 * The cache clear is deliberately not debounced: it is local, free, and the
 * operator has in fact read the chat. Only the daemon-disturbing half waits.
 */
export function markChatAsRead(queryClient: QueryClient, jid: string): void {
  clearChatUnreadInCache(queryClient, jid);

  const existing = pending.get(jid);
  if (existing) clearTimeout(existing);

  pending.set(
    jid,
    setTimeout(() => {
      pending.delete(jid);
      void api.markChatRead(jid).catch(() => {
        // Keep the optimistic cache clear; refetching would restore a stale
        // unread count, and the receipt is retried by the next message anyway.
      });
    }, MARK_READ_DEBOUNCE_MS)
  );
}

/** Sends any receipt still waiting out its debounce. For tests and teardown. */
export function flushPendingReads(): void {
  for (const [jid, timer] of pending) {
    clearTimeout(timer);
    void api.markChatRead(jid).catch(() => {});
  }
  pending.clear();
}
