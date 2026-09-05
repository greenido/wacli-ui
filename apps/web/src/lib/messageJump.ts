import type { MessageJumpHint } from '../store/appStore.ts';
import type { UnifiedMessage } from '../types.ts';

/**
 * Clock slack between this machine and the timestamp WhatsApp puts on a
 * message. The hint's own moment is when the console decided to send, so the
 * message lands after it — but not reliably by that machine's clock.
 */
const SENT_AFTER_SLACK_MS = 5 * 60_000;

/** The body of a message as the operator would recognise it. */
function bodyOf(msg: UnifiedMessage): string {
  return (msg.displayText || msg.text || msg.mediaCaption || msg.filename || '').trim();
}

/**
 * Which message a jump should land on.
 *
 * An id is used whenever the thread actually holds it. Otherwise the hint is
 * consulted, which is what makes rows recorded before ids were kept — every
 * scheduled send already on disk — land on their message instead of reporting
 * it missing from the archive.
 *
 * Returns null when neither can be satisfied by what is loaded, which is a
 * genuine miss and worth telling the operator about.
 */
export function resolveJumpTarget(
  messages: UnifiedMessage[],
  msgId: string | null,
  hint: MessageJumpHint | null
): string | null {
  if (msgId && messages.some((m) => m.msgId === msgId)) {
    return msgId;
  }

  if (!hint) return null;

  const wanted = hint.text.trim();
  if (!wanted) return null;

  const parsed = new Date(hint.sentAfter).getTime();
  const notBefore = Number.isNaN(parsed) ? -Infinity : parsed - SENT_AFTER_SLACK_MS;

  // Oldest first: a scheduled send is the *first* message matching its body
  // after it was queued, not whatever repetition of it came later.
  let best: { msgId: string; at: number } | null = null;
  for (const msg of messages) {
    if (!msg.fromMe || msg.reactionToId) continue;
    if (bodyOf(msg) !== wanted) continue;

    const at = new Date(msg.ts).getTime();
    if (Number.isNaN(at) || at < notBefore) continue;
    if (!best || at < best.at) {
      best = { msgId: msg.msgId, at };
    }
  }

  return best?.msgId ?? null;
}

/**
 * wacli's own message ids look like `3EB0626F...`. Mission Control used to
 * stamp sends it could not get an id for with `out-<epoch millis>`, which no
 * archive will ever contain — a jump to one could only ever report the message
 * as missing.
 */
export function isSynthesisedMessageId(id: string | undefined | null): boolean {
  return typeof id === 'string' && /^out-\d+$/.test(id);
}

/** The id to jump to, or nothing when all that was recorded was a placeholder. */
export function usableMessageId(id: string | undefined | null): string | null {
  if (!id || isSynthesisedMessageId(id)) return null;
  return id;
}
