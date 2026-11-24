import type { UnifiedChat } from '../types.ts';

/**
 * Pin, mute, archive and mark unread, and their inverses: each one a
 * `wacli chats <action>`. WhatsApp syncs them to every linked device.
 */
export type ChatStateAction =
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'archive'
  | 'unarchive'
  | 'mark-unread';

export interface ChatStateChange {
  action: ChatStateAction;
  /** Mute only: whole hours as wacli spells them (`8h`), or `0` for always. */
  duration?: string;
}

/** The lengths WhatsApp's own apps offer, which is what people expect here. */
export const MUTE_OPTIONS = [
  { label: '8 hours', duration: '8h', hours: 8 },
  { label: '1 week', duration: '168h', hours: 168 },
  { label: 'Always', duration: '0', hours: 0 },
] as const;

/**
 * Whether a chat is muted right now.
 *
 * wacli stores "always" as -1 and a timed mute as the Unix second it ends, so
 * neither `> 0` (which missed always) nor any nonzero value (which kept an
 * expired mute forever) is the test.
 */
export function isChatMuted(chat: Pick<UnifiedChat, 'mutedUntil'>, nowMs: number = Date.now()): boolean {
  if (chat.mutedUntil < 0) return true;
  return chat.mutedUntil * 1000 > nowMs;
}

/** Marked unread by hand: WhatsApp's dot, which carries no count. */
export function isMarkedUnread(chat: Pick<UnifiedChat, 'unread' | 'unreadCount'>): boolean {
  return chat.unread && chat.unreadCount === 0;
}

/** The chat as it will be once `change` lands, for showing it before it has. */
export function applyChatState(
  chat: UnifiedChat,
  change: ChatStateChange,
  nowMs: number = Date.now()
): UnifiedChat {
  switch (change.action) {
    case 'pin':
      return { ...chat, pinned: true };
    case 'unpin':
      return { ...chat, pinned: false };
    case 'archive':
      return { ...chat, archived: true };
    case 'unarchive':
      return { ...chat, archived: false };
    case 'unmute':
      return { ...chat, mutedUntil: 0 };
    case 'mark-unread':
      return { ...chat, unread: true };
    case 'mute': {
      const hours = Number.parseInt(change.duration ?? '0', 10) || 0;
      return {
        ...chat,
        mutedUntil: hours > 0 ? Math.floor(nowMs / 1000) + hours * 3600 : -1,
      };
    }
  }
}

/** What happened, in the words the status line uses: "Pinned Ada Lovelace". */
export function describeChatState(change: ChatStateChange, name: string): string {
  switch (change.action) {
    case 'pin':
      return `Pinned ${name}`;
    case 'unpin':
      return `Unpinned ${name}`;
    case 'archive':
      return `Archived ${name}`;
    case 'unarchive':
      return `Unarchived ${name}`;
    case 'unmute':
      return `Unmuted ${name}`;
    case 'mark-unread':
      return `Marked ${name} unread`;
    case 'mute': {
      const option = MUTE_OPTIONS.find((o) => o.duration === (change.duration ?? '0'));
      return option && option.hours > 0
        ? `Muted ${name} for ${option.label}`
        : `Muted ${name}`;
    }
  }
}

/** The toggle a shortcut means for this chat as it stands. */
export function togglePin(chat: UnifiedChat): ChatStateChange {
  return { action: chat.pinned ? 'unpin' : 'pin' };
}

export function toggleArchive(chat: UnifiedChat): ChatStateChange {
  return { action: chat.archived ? 'unarchive' : 'archive' };
}
