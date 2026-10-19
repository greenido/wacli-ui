import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { flattenMessagePages, type MessagePages } from './messagePages.ts';
import type { UnifiedChat, UnifiedMessage } from '../types.ts';

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

/**
 * Whether wacli would accept `msg` as where a mark-read stops: a message from
 * the other side that is still there and says something. Reactions, deletions
 * and content-free system rows are refused as anchors.
 */
function isReadAnchor(msg: UnifiedMessage): boolean {
  if (msg.fromMe || msg.revoked || msg.reactionToId) return false;
  if (msg.deliveryStatus === 'pending') return false;
  return Boolean(msg.text.trim()) || msg.displayText !== '(message)';
}

/**
 * The newest message the operator has had in front of them in `jid`, for the
 * receipt to stop at — or nothing, which marks the whole chat as before.
 *
 * The receipt goes out a few seconds after the chat was read, and whatever
 * arrived in between used to be acknowledged with the rest. Bounded, it stays
 * unread until it has actually been on screen.
 *
 * Read from the live thread at the moment the receipt fires. A thread still
 * being fetched may be older than what is now on screen, and a boundary short
 * of what was read would leave the chat unread, so it gets none.
 */
export function readBoundary(queryClient: QueryClient, jid: string): string | undefined {
  const key = ['messages', jid];
  if (queryClient.getQueryState(key)?.fetchStatus === 'fetching') return undefined;
  const data = queryClient.getQueryData<MessagePages>(key);
  // Newest first, the order the pages are held in.
  return flattenMessagePages(data).find(isReadAnchor)?.msgId;
}

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
      void api.markChatRead(jid, readBoundary(queryClient, jid)).catch(() => {
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
