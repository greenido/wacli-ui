import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../../store/appStore.ts';
import { usableMessageId } from '../../lib/messageJump.ts';
import type { MessageJumpHint } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

/**
 * Opens a chat from a row in the strip, and points the thread at one message
 * in it. Every tab does this: activity rows, the scheduled queue, bookmarks.
 */
export function useOpenMessage() {
  const queryClient = useQueryClient();
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const chatFilter = useAppStore((s) => s.chatFilter);

  return (
    toJid: string,
    name?: string,
    msgId?: string,
    hint?: MessageJumpHint,
    at?: string | null
  ) => {
    if (!toJid) return;
    const cachedChats =
      queryClient.getQueryData<UnifiedChat[]>(['chats', searchQuery, chatFilter]) ||
      queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all']) ||
      [];
    const existing = cachedChats.find((c) => c.jid === toJid);

    const targetChat: UnifiedChat = existing || {
      jid: toJid,
      name: name || toJid.split('@')[0],
      kind: toJid.endsWith('@g.us') ? 'group' : 'dm',
      lastMessageTs: null,
      lastMessage: null,
      lastMessageFromMe: false,
      archived: false,
      pinned: false,
      mutedUntil: 0,
      unread: false,
      unreadCount: 0,
    };

    setSelectedChat(targetChat);
    try {
      localStorage.setItem('wacli_selected_chat', targetChat.jid);
    } catch {
      // ignore
    }

    // Always assign, never only on a hit. Leaving the previous target set sent
    // the newly opened thread hunting for a message from the chat before it,
    // which it then reported as missing from the local archive.
    //
    // The hint goes along with the id because most rows have no usable id at
    // all: everything sent before wacli's id was recorded, which is every
    // scheduled message already on disk.
    setHighlightedMessageId(usableMessageId(msgId), hint ?? null, at ?? null);
  };
}

export type OpenMessage = ReturnType<typeof useOpenMessage>;
