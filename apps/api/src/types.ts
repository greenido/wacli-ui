export interface UnifiedChat {
  jid: string;
  kind: 'dm' | 'group' | 'broadcast' | 'newsletter' | 'unknown';
  name: string;
  lastMessageTs: string | null;
  /** Preview text for the most recent message in this chat, or null if unknown. */
  lastMessage: string | null;
  /** True when the previewed message was sent by the operator. */
  lastMessageFromMe: boolean;
  archived: boolean;
  pinned: boolean;
  mutedUntil: number;
  unread: boolean;
  unreadCount: number;
}

export interface UnifiedMessage {
  chatJid: string;
  chatName: string;
  msgId: string;
  senderJid: string;
  senderName: string;
  ts: string;
  fromMe: boolean;
  text: string;
  displayText: string;
  isForwarded: boolean;
  reactionToId: string | null;
  reactionEmoji: string | null;
  mediaType: string | null;
  mediaCaption: string | null;
  filename: string | null;
  mimeType: string | null;
  localPath: string | null;
  /** WhatsApp's own star, as synced by wacli. Read-only: wacli cannot write it. */
  starred: boolean;
  /** Mission Control's local bookmark. Stored here, never sent to WhatsApp. */
  bookmarked: boolean;
  edited: boolean;
  revoked: boolean;
  snippet?: string | null;
  deliveryStatus?: 'sent' | 'delivered' | 'read' | 'played';
}

/**
 * How far back the local archive actually reaches for one chat. Paging the
 * thread stops at whatever sync happened to pull; this is what says whether
 * there is more on the phone worth asking for.
 */
export interface ChatCoverage {
  chatJid: string;
  name: string;
  kind: string;
  messageCount: number;
  oldestTs: string | null;
  newestTs: string | null;
  lastMessageTs: string | null;
  /** wacli's own verdict, e.g. "ready" when a backfill can be anchored. */
  status: string;
}

export interface UnifiedDoctor {
  storeDir: string;
  lockHeld: boolean;
  authenticated: boolean;
  linkedJid: string | null;
  connected: boolean;
  connectionState: string;
  ftsEnabled: boolean;
  store: {
    messages: number;
    chats: number;
    contacts: number;
    groups: number;
    lastSyncAt: string | null;
    lastActivityAt: string | null;
  };
}

export interface MissionControlStatus {
  readOnly: boolean;
  processState: 'stopped' | 'starting' | 'running' | 'paused' | 'restarting' | 'logged_out' | 'failed';
  processPid: number | null;
  heartbeatAgeSeconds: number | null;
  lastError: string | null;
  reconnectAttempts: number;
  doctor: UnifiedDoctor | null;
  wacliInstalled: boolean;
  wacliWorking: boolean;
  wacliVersion: string | null;
  wacliBinaryPath: string | null;
  statusSummary:
    | 'ok'
    | 'not_installed'
    | 'not_authenticated'
    | 'error'
    | 'daemon_error'
    | 'sync_starting'
    | 'store_locked_external';
  statusMessage: string | null;
  storeLockHeld: boolean;
  storeLockHolderPid: number | null;
}

export interface ScheduledMessage {
  id: string;
  to: string;
  recipientName?: string;
  message: string;
  replyTo?: string;
  filePath?: string;
  fileName?: string;
  mimeType?: string;
  scheduledAt: string;
  createdAt: string;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  error?: string;
  sentMessageId?: string;
}

export type MissionControlEvent =
  | { type: 'message.new'; data: UnifiedMessage; ts: string }
  | { type: 'message.receipt'; data: { chatJid: string; messageIds: string[]; status: 'delivered' | 'read' | 'played'; sender: string; isFromMe: boolean }; ts: string }
  | { type: 'chat.presence'; data: { chatJid: string; senderJid: string; state: 'composing' | 'paused'; media: 'audio' | '' }; ts: string }
  | { type: 'chat.update'; data: UnifiedChat; ts: string }
  | { type: 'scheduled.update'; data: ScheduledMessage; ts: string }
  | { type: 'sync.progress'; data: { phase: string; detail?: string }; ts: string }
  | { type: 'connection.status'; data: { state: MissionControlStatus['processState'] | 'connected' | 'disconnected'; reason?: string }; ts: string };

// Raw wacli JSON shapes
export interface RawWacliResponse<T> {
  success: boolean;
  data: T | null;
  error: string | null;
}

export interface RawChat {
  jid: string;
  kind?: string;
  name?: string;
  last_message_ts?: string;
  archived?: boolean;
  pinned?: boolean;
  muted_until?: number;
  unread?: boolean;
  unread_count?: number;
}

export interface RawChatCoverage {
  chat_jid?: string;
  kind?: string;
  name?: string;
  last_message_ts?: string | null;
  message_count?: number;
  oldest_ts?: string | null;
  newest_ts?: string | null;
  status?: string;
}

export interface RawMessage {
  ChatJID?: string;
  ChatName?: string;
  MsgID?: string;
  SenderJID?: string;
  SenderName?: string;
  Timestamp?: string;
  FromMe?: boolean;
  Text?: string;
  DisplayText?: string;
  IsForwarded?: boolean;
  ForwardingScore?: number;
  ReactionToID?: string | null;
  ReactionEmoji?: string | null;
  MediaType?: string | null;
  MediaCaption?: string | null;
  Filename?: string | null;
  MimeType?: string | null;
  DirectPath?: string | null;
  LocalPath?: string | null;
  DownloadedAt?: string | null;
  Starred?: boolean;
  StarredAt?: string | null;
  Edited?: boolean;
  Revoked?: boolean;
  DeletedForMe?: boolean;
  Snippet?: string | null;
}

export interface RawWebhookMessage {
  EventType?: string;
  Chat: string;
  ID: string;
  SenderJID?: string;
  Timestamp: string;
  FromMe: boolean;
  Text?: string;
  ChatName?: string;
  SenderName?: string;
  MediaType?: string;
  MediaCaption?: string;
  Filename?: string;
}

export interface RawWebhookReceipt {
  EventType: 'receipt';
  Chat: string;
  Sender: string;
  MessageIDs: string[];
  Timestamp: string;
  Type: 'delivered' | 'read' | 'played' | string;
  IsFromMe: boolean;
}

export interface RawWebhookChatPresence {
  EventType: 'chat_presence';
  Chat: string;
  Sender: string;
  State: 'composing' | 'paused' | string;
  Media?: 'audio' | string;
}
