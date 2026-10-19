import type { UnifiedMessage } from '../types.ts';

type DeliveryStatus = NonNullable<UnifiedMessage['deliveryStatus']>;

/** How far along each tick is. A message with no status yet is plainly sent. */
const RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
};

function rankOf(status: UnifiedMessage['deliveryStatus']): number {
  return RANK[status ?? 'sent'];
}

/**
 * A message with a live receipt folded in, never moved backwards.
 *
 * Receipts arrive per recipient and out of order: in a group one member's
 * "delivered" routinely lands after another's "read", and taking each as the
 * message's new state turned blue ticks grey again. The thread now also opens
 * on the state wacli stored, so a late "delivered" for a message the archive
 * already has as read is the common case, not the odd one.
 *
 * The stored counts describe the state before this receipt, and a tooltip
 * saying "read by 0" under blue ticks is worse than no count at all, so an
 * upgrade drops them until the next read of the archive brings fresh ones.
 */
export function withReceipt(msg: UnifiedMessage, status: DeliveryStatus): UnifiedMessage {
  if (rankOf(status) <= rankOf(msg.deliveryStatus)) return msg;
  return { ...msg, deliveryStatus: status, deliveredTo: undefined, readBy: undefined };
}

/**
 * The tick's tooltip. In a group the counts are the useful part — blue means
 * somebody read it, and only the count says whether that was one member or
 * all of them.
 */
export function deliveryTitle(msg: UnifiedMessage, isGroup: boolean): string {
  if (msg.deliveryStatus === 'pending') return 'sending';
  const status = msg.deliveryStatus ?? 'sent';
  if (!isGroup || msg.deliveredTo === undefined || msg.readBy === undefined) return status;
  if (msg.deliveredTo === 0 && msg.readBy === 0) return `${status} · no reports yet`;
  return `delivered to ${msg.deliveredTo} · read by ${msg.readBy}`;
}
