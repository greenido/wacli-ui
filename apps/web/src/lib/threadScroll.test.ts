import { describe, it, expect } from 'vitest';
import {
  NEAR_BOTTOM_PX,
  distanceFromBottom,
  shouldFollowNewest,
} from './threadScroll.ts';

/** A scroll container of `content` pixels, `viewport` tall, scrolled to `top`. */
const at = (top: number, content = 5000, viewport = 800) => ({
  scrollTop: top,
  scrollHeight: content,
  clientHeight: viewport,
});

describe('distanceFromBottom', () => {
  it('is zero at the bottom', () => {
    expect(distanceFromBottom(at(4200))).toBe(0);
  });

  it('grows as the operator reads back', () => {
    expect(distanceFromBottom(at(4100))).toBe(100);
    expect(distanceFromBottom(at(2000))).toBe(2200);
    expect(distanceFromBottom(at(0))).toBe(4200);
  });

  it('does not go negative on an elastic overscroll', () => {
    // Trackpads scroll past the end and settle back; a negative distance would
    // read as "further from the bottom than the bottom".
    expect(distanceFromBottom(at(4260))).toBe(0);
  });

  it('is zero for a thread shorter than its viewport', () => {
    expect(distanceFromBottom(at(0, 300, 800))).toBe(0);
  });

  it('is zero before layout has happened', () => {
    // jsdom, and a pane that has not been measured yet, report zeroes.
    expect(distanceFromBottom(at(0, 0, 0))).toBe(0);
  });
});

/**
 * The thread used to jump to the bottom on every arrival, unconditionally, so
 * reading back through an active conversation was interrupted by every incoming
 * message — most reliably in the threads busy enough to be worth reading back
 * through.
 */
describe('shouldFollowNewest', () => {
  it('follows when the operator is at the newest message', () => {
    expect(shouldFollowNewest(0)).toBe(true);
  });

  it('still follows from a few pixels off the floor', () => {
    // A partly-scrolled last bubble or a reaction row that grew afterwards is
    // not the operator going looking for history.
    expect(shouldFollowNewest(1)).toBe(true);
    expect(shouldFollowNewest(NEAR_BOTTOM_PX - 1)).toBe(true);
    expect(shouldFollowNewest(NEAR_BOTTOM_PX)).toBe(true);
  });

  it('leaves a reader alone once they have scrolled up', () => {
    expect(shouldFollowNewest(NEAR_BOTTOM_PX + 1)).toBe(false);
    expect(shouldFollowNewest(2200)).toBe(false);
  });

  it('reads straight off a measured container', () => {
    expect(shouldFollowNewest(distanceFromBottom(at(4200)))).toBe(true);
    expect(shouldFollowNewest(distanceFromBottom(at(2000)))).toBe(false);
  });
});
