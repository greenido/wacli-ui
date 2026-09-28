import type { QueryClient } from '@tanstack/react-query';
import {
  hasMessage,
  patchMessages,
  prependMessage,
  removeMessage,
  type MessagePages,
} from './messagePages.ts';
import type { UnifiedChat, UnifiedMessage } from '../types.ts';

/**
 * A send shows in its thread from the moment it is confirmed, not from the
 * moment wacli answers.
 *
 * The answer can take a while even when nothing is wrong: the sync daemon
 * carries out what it is handed one at a time, so a send can queue behind a
 * read receipt or the send before it. Until it answers, the bubble carries a
 * local id and `pending`. Then it takes WhatsApp's id, or leaves the thread if
 * the send failed.
 */
export interface PendingSend {
  chatJid: string;
  chatName: string;
  text: string;
  file?: File;
}

/** Puts the send on the front of its thread and its chat on top of the rail. */
export function paintPendingSend(queryClient: QueryClient, pendingId: string, send: PendingSend): void {
  const now = new Date().toISOString();
  const msg: UnifiedMessage = {
    chatJid: send.chatJid,
    chatName: send.chatName,
    msgId: pendingId,
    senderJid: '',
    senderName: 'Me',
    ts: now,
    fromMe: true,
    text: send.text,
    displayText: send.text,
    isForwarded: false,
    reactionToId: null,
    reactionEmoji: null,
    mediaType: send.file ? 'document' : null,
    mediaCaption: send.text || null,
    filename: send.file?.name ?? null,
    mimeType: send.file?.type || null,
    localPath: null,
    starred: false,
    bookmarked: false,
    edited: false,
    revoked: false,
    deliveryStatus: 'pending',
  };

  // Prefix match: the thread cache is keyed by chat and window size, and the
  // chat list by chat, search text and filter. An exact-key write would land on
  // a key nothing is observing.
  queryClient.setQueriesData<MessagePages>({ queryKey: ['messages', send.chatJid] }, (old) =>
    prependMessage(old, msg)
  );

  queryClient.setQueriesData<UnifiedChat[]>({ queryKey: ['chats'] }, (old) => {
    const chats = old ? [...old] : [];
    const existing = chats.find((c) => c.jid === send.chatJid);
    const preview = send.text || send.file?.name || null;
    const updated: UnifiedChat = existing
      ? { ...existing, lastMessageTs: now, lastMessage: preview, lastMessageFromMe: true }
      : {
          jid: send.chatJid,
          name: send.chatName,
          kind: send.chatJid.endsWith('@g.us') ? 'group' : 'dm',
          lastMessageTs: now,
          lastMessage: preview,
          lastMessageFromMe: true,
          archived: false,
          pinned: false,
          mutedUntil: 0,
          unread: false,
          unreadCount: 0,
        };
    return [updated, ...chats.filter((c) => c.jid !== send.chatJid)];
  });
}

/**
 * The send went out: the stand-in takes WhatsApp's id, so receipts and a jump
 * to it find it. If the socket already brought the real message in, the
 * stand-in just goes, rather than showing the message twice.
 */
export function settlePendingSend(
  queryClient: QueryClient,
  chatJid: string,
  pendingId: string,
  sentId: string | undefined
): void {
  queryClient.setQueriesData<MessagePages>({ queryKey: ['messages', chatJid] }, (old) => {
    if (old && sentId && hasMessage(old, sentId)) return removeMessage(old, pendingId);
    return patchMessages(
      old,
      (m) => m.msgId === pendingId,
      (m) => ({ ...m, msgId: sentId ?? m.msgId, deliveryStatus: 'sent' })
    );
  });
}

/** The send failed: nothing went out, so nothing stays in the thread. */
export function dropPendingSend(queryClient: QueryClient, chatJid: string, pendingId: string): void {
  queryClient.setQueriesData<MessagePages>({ queryKey: ['messages', chatJid] }, (old) =>
    removeMessage(old, pendingId)
  );
}
