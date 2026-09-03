import { messagePreviewText } from './messagePreview.ts';
import type { UnifiedChat, UnifiedMessage } from '../types.ts';

/**
 * Builds the rail row a message implies, for the moments the real one is not in
 * hand: a search hit in a chat the rail has filtered away, or a notification
 * click for a conversation that has never been listed. The next `/api/chats`
 * replaces it with the store's own record.
 */
export function chatFromMessage(msg: UnifiedMessage): UnifiedChat {
  return {
    jid: msg.chatJid,
    name: msg.chatName || msg.chatJid.split('@')[0],
    kind: msg.chatJid.endsWith('@g.us') ? 'group' : 'dm',
    lastMessageTs: msg.ts,
    lastMessage: messagePreviewText(msg) || null,
    lastMessageFromMe: msg.fromMe,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: false,
    unreadCount: 0,
  };
}
