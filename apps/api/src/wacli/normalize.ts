import type {
  ChatCoverage,
  RawChat,
  RawChatCoverage,
  RawMessage,
  RawWebhookMessage,
  UnifiedChat,
  UnifiedDoctor,
  UnifiedMessage,
} from '../types.js';

/**
 * One-line preview of a message for the chat rail. Media carries no body text,
 * so it is described rather than shown blank — a row that says nothing is the
 * bug this replaces.
 *
 * Twin of `messagePreviewText` in `apps/web/src/lib/messagePreview.ts`, which
 * folds the same message when it arrives over the WebSocket. Keep them in step.
 */
export function messagePreviewText(msg: UnifiedMessage): string {
  if (msg.revoked) return 'This message was deleted.';

  const caption = (msg.mediaCaption || '').trim();
  const body = (msg.displayText || msg.text || '').trim();

  switch (msg.mediaType) {
    case 'image':
      return caption ? `\u{1F4F7} ${caption}` : '\u{1F4F7} Photo';
    case 'video':
      return caption ? `\u{1F3A5} ${caption}` : '\u{1F3A5} Video';
    case 'audio':
      return '\u{1F3A4} Voice message';
    case 'sticker':
      return 'Sticker';
    case 'document':
      return `\u{1F4C4} ${msg.filename || caption || 'Document'}`;
    default:
      break;
  }

  return body || caption || '';
}

export interface ChatPreview {
  text: string;
  fromMe: boolean;
}

export function normalizeCoverage(raw: RawChatCoverage): ChatCoverage {
  return {
    chatJid: raw.chat_jid ?? '',
    name: raw.name ?? '',
    kind: raw.kind ?? 'unknown',
    messageCount: Number(raw.message_count ?? 0),
    oldestTs: raw.oldest_ts ?? null,
    newestTs: raw.newest_ts ?? null,
    lastMessageTs: raw.last_message_ts ?? null,
    status: raw.status ?? 'unknown',
  };
}

export function normalizeChat(raw: RawChat, preview?: ChatPreview): UnifiedChat {
  let kind: UnifiedChat['kind'] = 'unknown';
  if (raw.kind === 'dm' || raw.kind === 'group' || raw.kind === 'broadcast' || raw.kind === 'newsletter') {
    kind = raw.kind;
  } else if (raw.jid.endsWith('@s.whatsapp.net')) {
    kind = 'dm';
  } else if (raw.jid.endsWith('@g.us')) {
    kind = 'group';
  } else if (raw.jid.endsWith('@newsletter')) {
    kind = 'newsletter';
  }

  return {
    jid: raw.jid,
    kind,
    name: raw.name || raw.jid.split('@')[0],
    lastMessageTs: raw.last_message_ts ?? null,
    lastMessage: preview?.text ?? null,
    lastMessageFromMe: preview?.fromMe ?? false,
    archived: Boolean(raw.archived),
    pinned: Boolean(raw.pinned),
    mutedUntil: Number(raw.muted_until ?? 0),
    unread: Boolean(raw.unread),
    unreadCount: Number(raw.unread_count ?? 0),
  };
}

export function normalizeMessage(raw: RawMessage): UnifiedMessage {
  const chatJid = raw.ChatJID ?? '';
  const text = raw.Text ?? '';
  const displayText = raw.DisplayText ?? text;

  return {
    chatJid,
    chatName: raw.ChatName ?? '',
    msgId: raw.MsgID ?? '',
    senderJid: raw.SenderJID ?? '',
    senderName: raw.SenderName ?? '',
    ts: raw.Timestamp ?? new Date().toISOString(),
    fromMe: Boolean(raw.FromMe),
    text,
    displayText,
    isForwarded: Boolean(raw.IsForwarded),
    reactionToId: raw.ReactionToID ?? null,
    reactionEmoji: raw.ReactionEmoji ?? null,
    mediaType: raw.MediaType ?? null,
    mediaCaption: raw.MediaCaption ?? null,
    filename: raw.Filename ?? null,
    mimeType: raw.MimeType ?? null,
    localPath: raw.LocalPath ?? null,
    starred: Boolean(raw.Starred),
    bookmarked: false,
    edited: Boolean(raw.Edited),
    revoked: Boolean(raw.Revoked || raw.DeletedForMe),
    snippet: raw.Snippet ?? null,
  };
}

export function normalizeWebhookMessage(raw: RawWebhookMessage): UnifiedMessage {
  const text = raw.Text ?? '';
  return {
    chatJid: raw.Chat,
    chatName: raw.ChatName ?? '',
    msgId: raw.ID,
    senderJid: raw.SenderJID ?? (raw.FromMe ? '' : raw.Chat),
    senderName: raw.SenderName ?? '',
    ts: raw.Timestamp || new Date().toISOString(),
    fromMe: Boolean(raw.FromMe),
    text,
    displayText: text,
    isForwarded: false,
    reactionToId: null,
    reactionEmoji: null,
    mediaType: raw.MediaType ?? null,
    mediaCaption: raw.MediaCaption ?? null,
    filename: raw.Filename ?? null,
    mimeType: null,
    localPath: null,
    starred: false,
    bookmarked: false,
    edited: false,
    revoked: false,
  };
}

interface DoctorRawStore {
  messages?: number;
  chats?: number;
  contacts?: number;
  groups?: number;
  last_sync_at?: string;
  last_activity_at?: string;
}

export function normalizeDoctor(raw: Record<string, unknown>): UnifiedDoctor {
  const store = (raw.store ?? {}) as DoctorRawStore;
  return {
    storeDir: String(raw.store_dir ?? ''),
    lockHeld: Boolean(raw.lock_held),
    authenticated: Boolean(raw.authenticated),
    linkedJid: raw.linked_jid ? String(raw.linked_jid) : null,
    connected: Boolean(raw.connected),
    connectionState: String(raw.connection_state ?? 'disconnected'),
    ftsEnabled: Boolean(raw.fts_enabled),
    store: {
      messages: Number(store.messages ?? 0),
      chats: Number(store.chats ?? 0),
      contacts: Number(store.contacts ?? 0),
      groups: Number(store.groups ?? 0),
      lastSyncAt: store.last_sync_at ?? null,
      lastActivityAt: store.last_activity_at ?? null,
    },
  };
}
