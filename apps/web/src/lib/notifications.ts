import type { UnifiedChat, UnifiedMessage } from '../types.ts';
import { messagePreviewText } from './messagePreview.ts';

export const NOTIFICATIONS_STORAGE_KEY = 'wacli_notifications_enabled';

/**
 * Why a message did or did not raise a desktop notification. Kept explicit so
 * the settings pane can explain a silent console rather than leaving the
 * operator wondering whether the bridge is down.
 */
export type NotifySkipReason =
  | 'disabled'
  | 'unsupported'
  | 'permission'
  | 'own-message'
  | 'reaction'
  | 'muted'
  | 'already-watching';

export type NotifyDecision = { show: true } | { show: false; reason: NotifySkipReason };

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission(): NotificationPermission {
  return notificationsSupported() ? Notification.permission : 'denied';
}

/** Opt-in: a console that starts pinging without being asked is a bad neighbour. */
export function notificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setNotificationsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, String(enabled));
  } catch {
    // A console that cannot remember the preference should still run.
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!notificationsSupported()) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

/**
 * The whole suppression policy, as a pure function so it can be tested without
 * a browser. The ordering matters: the cheapest and most absolute reasons come
 * first, so a disabled console never inspects chat state at all.
 */
export function shouldNotify(params: {
  msg: UnifiedMessage;
  chat: UnifiedChat | undefined;
  isViewingChat: boolean;
  documentVisible: boolean;
  enabled: boolean;
  supported: boolean;
  permission: NotificationPermission;
}): NotifyDecision {
  const { msg, chat, isViewingChat, documentVisible, enabled, supported, permission } = params;

  if (!enabled) return { show: false, reason: 'disabled' };
  if (!supported) return { show: false, reason: 'unsupported' };
  if (permission !== 'granted') return { show: false, reason: 'permission' };
  if (msg.fromMe) return { show: false, reason: 'own-message' };
  // Reactions are not conversation content anywhere else in this app either.
  if (msg.reactionToId) return { show: false, reason: 'reaction' };
  // Mirrors the rail's own Muted filter, so the two never disagree.
  if (chat && chat.mutedUntil > 0) return { show: false, reason: 'muted' };
  // The operator is already looking at the message land.
  if (isViewingChat && documentVisible) return { show: false, reason: 'already-watching' };

  return { show: true };
}

export interface MessageNotification {
  title: string;
  body: string;
  tag: string;
}

/** The notification's own copy, separated from the decision to show one. */
export function messageNotificationContent(msg: UnifiedMessage): MessageNotification {
  const isGroup = msg.chatJid.endsWith('@g.us');
  const chatName = msg.chatName || msg.chatJid.split('@')[0];
  const sender = msg.senderName || msg.senderJid.split('@')[0];
  const preview = messagePreviewText(msg) || 'New message';

  return {
    title: isGroup ? chatName : sender || chatName,
    // In a group the row header is the group, so the body has to name the speaker.
    body: isGroup && sender ? `${sender}: ${preview}` : preview,
    // One notification per chat: a chatty thread replaces its own, it does not stack.
    tag: `wacli-chat-${msg.chatJid}`,
  };
}

/**
 * Raises the notification and returns a disposer, or null when policy or the
 * browser said no. Focusing the window is left to the caller's `onClick` so
 * this module never has to know about routing.
 */
export function showMessageNotification(
  msg: UnifiedMessage,
  onClick: () => void
): (() => void) | null {
  if (!notificationsSupported() || Notification.permission !== 'granted') return null;

  const { title, body, tag } = messageNotificationContent(msg);

  try {
    const notification = new Notification(title, { body, tag, silent: false });
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Focus is best-effort; the click still selects the chat.
      }
      onClick();
      notification.close();
    };
    return () => notification.close();
  } catch {
    // Some browsers throw when constructing notifications outside a user
    // gesture. A missing ping must never break message ingestion.
    return null;
  }
}
