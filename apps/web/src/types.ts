export interface UnifiedChat {
  jid: string;
  kind: 'dm' | 'group' | 'broadcast' | 'newsletter' | 'unknown';
  name: string;
  lastMessageTs: string | null;
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
  starred: boolean;
  edited: boolean;
  revoked: boolean;
  snippet?: string | null;
  deliveryStatus?: 'sent' | 'delivered' | 'read' | 'played';
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

export interface SendLogEntry {
  id: string;
  timestamp: string;
  to: string;
  chatName?: string;
  message: string;
  status: 'pending' | 'success' | 'error';
  error?: string;
}
