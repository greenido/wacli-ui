import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import type { UnifiedChat } from '../types.ts';

/**
 * How long to hold a read receipt open, coalescing anything that arrives in the
 * meantime into the same call.
 *
 * `POST /chats/mark-read` is not free. It is handed to the running sync daemon,
 * which carries out what it is handed one at a time, sends included, so a send
 * made meanwhile waits for the receipt to finish. The server sends it as read
 * receipts, which is quick, but a wacli older than 0.19.0 replays WhatsApp's
 * chat state in full instead, which takes seconds. Without this, sitting in a
 * busy chat would fire one per incoming message, and a reply typed there would
 * queue behind all of them.
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
