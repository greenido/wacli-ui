import type { UnifiedMessage } from '../types.ts';

/** One reactor's reaction to a message, as a thread row shows it. */
export interface ThreadReaction {
  emoji: string;
  fromMe: boolean;
  sender: string;
}

/**
 * WhatsApp allows one reaction per person per message. Our own reactions fold
 * under a fixed key because an outbound row carries no sender JID.
 */
export const MY_REACTION_KEY = '@me';

/** A reaction sent from here that the local archive has not caught up with. */
export interface PendingReaction {
  /** What we sent. */
  emoji: string;
  /**
   * What the archive said our reaction to that message was at the moment we
   * clicked. The stand-in stops applying as soon as the archive says something
   * else — which is how it retires itself, with no timer and no bookkeeping.
   */
  was: string;
}

export interface FoldedThread {
  /** The messages a thread draws: everything but reaction rows, oldest first. */
  messages: UnifiedMessage[];
  /** Live reactions by the id of the message they react to. */
  reactionsMap: Map<string, ThreadReaction[]>;
  /** What the archive says our own reaction to each message is, '' for none. */
  myArchivedReactions: Map<string, string>;
}

/**
 * Maps reaction rows onto the messages they react to.
 *
 * Folding by reactor rather than appending is what lets an optimistic reaction
 * sit in the same slot the archive's own row will occupy, instead of doubling
 * the emoji up the moment the real one arrives.
 */
export function foldReactions(
  rawMessages: UnifiedMessage[],
  pendingReactions: Record<string, PendingReaction>
): FoldedThread {
  const byTarget = new Map<string, Map<string, ThreadReaction & { at: number }>>();
  const visibleMsgs: UnifiedMessage[] = [];

  for (const msg of rawMessages) {
    if (msg.reactionToId) {
      const reactor = msg.fromMe ? MY_REACTION_KEY : msg.senderJid || msg.senderName || msg.msgId;
      const parsed = new Date(msg.ts).getTime();
      const at = Number.isNaN(parsed) ? 0 : parsed;
      const perTarget = byTarget.get(msg.reactionToId) ?? new Map();
      const seen = perTarget.get(reactor);
      // An empty emoji is a reaction being taken back, so it has to be able
      // to win too — it is only dropped once the newest one per reactor is known.
      if (!seen || at >= seen.at) {
        perTarget.set(reactor, {
          emoji: msg.reactionEmoji ?? '',
          fromMe: msg.fromMe,
          sender: msg.senderName || msg.senderJid,
          at,
        });
      }
      byTarget.set(msg.reactionToId, perTarget);
    } else {
      visibleMsgs.push(msg);
    }
  }

  // What the archive currently believes we reacted with, before our own
  // unconfirmed clicks are laid over it. That is the comparison that retires
  // a pending reaction.
  const mine = new Map<string, string>();
  for (const [target, perTarget] of byTarget) {
    mine.set(target, perTarget.get(MY_REACTION_KEY)?.emoji ?? '');
  }

  for (const [target, pending] of Object.entries(pendingReactions)) {
    // The archive has moved on: it has either caught up with this reaction or
    // learned of a newer one from another device. Either way it is now the
    // better answer, and the stand-in steps aside.
    if ((mine.get(target) ?? '') !== pending.was) continue;
    const perTarget = byTarget.get(target) ?? new Map();
    perTarget.set(MY_REACTION_KEY, {
      emoji: pending.emoji,
      fromMe: true,
      sender: 'Me',
      at: Number.MAX_SAFE_INTEGER,
    });
    byTarget.set(target, perTarget);
  }

  const rxMap = new Map<string, ThreadReaction[]>();
  for (const [target, perTarget] of byTarget) {
    const folded = [...perTarget.values()]
      .filter((rx) => rx.emoji)
      .map(({ emoji, fromMe, sender }) => ({ emoji, fromMe, sender }));
    if (folded.length > 0) {
      rxMap.set(target, folded);
    }
  }

  // Sort chronologically ascending for display
  visibleMsgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return { messages: visibleMsgs, reactionsMap: rxMap, myArchivedReactions: mine };
}
