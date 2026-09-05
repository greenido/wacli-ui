import { describe, it, expect } from 'vitest';
import { HEARTBEAT_STALE_SECONDS, isHeartbeatStale } from './heartbeat.ts';

describe('isHeartbeatStale', () => {
  it('treats an ordinary quiet stretch as healthy', () => {
    // wacli writes HEARTBEAT on account activity, not on a timer, so minutes of
    // silence on a connected daemon are routine. The old 120s threshold flagged
    // every one of them.
    expect(isHeartbeatStale(0)).toBe(false);
    expect(isHeartbeatStale(121)).toBe(false);
    expect(isHeartbeatStale(296)).toBe(false); // an age observed on a healthy daemon
    expect(isHeartbeatStale(HEARTBEAT_STALE_SECONDS - 1)).toBe(false);
  });

  it('flags a silence long enough to be worth a look', () => {
    expect(isHeartbeatStale(HEARTBEAT_STALE_SECONDS)).toBe(true);
    expect(isHeartbeatStale(HEARTBEAT_STALE_SECONDS * 4)).toBe(true);
  });
});
