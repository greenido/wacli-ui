/**
 * How old the daemon's heartbeat has to be before it is worth flagging.
 *
 * wacli writes `~/.wacli/HEARTBEAT` when something happens on the account, not
 * on a fixed tick — its value tracks `lastActivityAt` exactly. So the age is
 * "time since the last WhatsApp event", and on a personal account a quiet
 * stretch of several minutes is routine, not a fault.
 *
 * The old threshold of 120s did not know that, and painted the readout amber
 * through every ordinary lull: a connected, healthy daemon with nothing to do
 * looked identical to a wedged one. Fifteen minutes is long enough that even a
 * quiet account should have seen *something* — a receipt, a presence update —
 * so crossing it is worth a second look rather than a reflex.
 */
export const HEARTBEAT_STALE_SECONDS = 15 * 60;

/** True when the heartbeat is old enough to be worth the operator's attention. */
export function isHeartbeatStale(ageSeconds: number): boolean {
  return ageSeconds >= HEARTBEAT_STALE_SECONDS;
}
