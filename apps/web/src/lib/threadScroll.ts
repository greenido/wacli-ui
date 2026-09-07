/**
 * Whether the thread should follow the newest message, or leave the operator
 * where they are.
 *
 * The thread used to jump to the bottom on every arrival, unconditionally. Read
 * back through a conversation while it is active and each incoming message threw
 * the reading position away — most reliably in exactly the threads busy enough
 * to be worth reading back through.
 */

/**
 * How close to the bottom still counts as following the live edge.
 *
 * Generous rather than exact: an operator sitting at the newest message is
 * frequently a few pixels off the floor — a partly-scrolled last bubble, an
 * elastic overscroll settling, a reaction row that grew after they stopped
 * moving — and none of those mean they have gone looking for history.
 */
export const NEAR_BOTTOM_PX = 120;

/** The scroll geometry this module needs. Narrow, so a test can state it. */
export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How far the reading position sits above the bottom of the content. */
export function distanceFromBottom(el: ScrollGeometry): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}

/**
 * Whether a thread whose reading position was `distancePx` above the bottom
 * should be scrolled to the newest message.
 *
 * Deliberately takes the distance rather than the element: it has to be judged
 * on where the operator was *before* the new message was laid out. Appending
 * below grows `scrollHeight` without firing a scroll event, so the last value a
 * scroll handler recorded is the honest one, and re-measuring in the effect
 * would ask the question after the answer had already changed.
 */
export function shouldFollowNewest(distancePx: number): boolean {
  return distancePx <= NEAR_BOTTOM_PX;
}
