import type { UnifiedMessage } from '../types.ts';

/** What can be done to a message that already exists. */
export type MessageActionKind = 'edit' | 'delete' | 'forward';

/**
 * How long WhatsApp lets you edit a text after sending it (whatsmeow's
 * `EditWindow`). wacli refuses an older one itself; the console hides the
 * button rather than offering something that can only fail.
 */
export const EDIT_WINDOW_MS = 20 * 60 * 1000;

/**
 * How long "Delete for everyone" works for, about two and a half days. wacli
 * does not check it, and WhatsApp past it can accept the request and leave the
 * message on the other phone anyway, so the console stops offering it here.
 */
export const UNSEND_WINDOW_MS = 60 * 60 * 60 * 1000;

/** A timestamp ahead of this clock (the phone's clock is not ours) counts as just sent. */
function ageMs(msg: UnifiedMessage, nowMs: number): number {
  const sent = Date.parse(msg.ts);
  return Number.isNaN(sent) ? Infinity : Math.max(0, nowMs - sent);
}

/** A real message that is still there: not a reaction, a deletion, or one still on its way out. */
function isActionable(msg: UnifiedMessage): boolean {
  return !msg.revoked && !msg.reactionToId && msg.deliveryStatus !== 'pending' && Boolean(msg.msgId);
}

export function canEdit(msg: UnifiedMessage, nowMs: number = Date.now()): boolean {
  return (
    isActionable(msg) &&
    msg.fromMe &&
    !msg.mediaType &&
    Boolean((msg.text || msg.displayText).trim()) &&
    ageMs(msg, nowMs) < EDIT_WINDOW_MS
  );
}

/** Minutes of the edit window left, rounded up so "1" means "hurry", not "gone". */
export function editMinutesLeft(msg: UnifiedMessage, nowMs: number = Date.now()): number {
  return Math.max(0, Math.ceil((EDIT_WINDOW_MS - ageMs(msg, nowMs)) / 60_000));
}

export function canUnsend(msg: UnifiedMessage, nowMs: number = Date.now()): boolean {
  return isActionable(msg) && msg.fromMe && ageMs(msg, nowMs) < UNSEND_WINDOW_MS;
}

export function canDeleteForMe(msg: UnifiedMessage): boolean {
  return isActionable(msg);
}

/** Text, or media wacli still has the keys for; anything else it refuses itself. */
export function canForward(msg: UnifiedMessage): boolean {
  return isActionable(msg) && (Boolean(msg.mediaType) || Boolean((msg.text || msg.displayText).trim()));
}
