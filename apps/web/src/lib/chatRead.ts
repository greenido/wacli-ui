import type { QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import type { UnifiedChat } from '../types.ts';

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

export async function markChatAsRead(queryClient: QueryClient, jid: string): Promise<void> {
  clearChatUnreadInCache(queryClient, jid);
  try {
    await api.markChatRead(jid);
  } catch {
    // Keep optimistic cache clear; refetch would restore stale wacli unread counts.
  }
}
