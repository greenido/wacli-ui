import type { CallOutcome, CallRecord, RawCallEvent } from '../types.js';

/**
 * Folds `wacli calls list` rows into one record per call.
 *
 * wacli stores a call as the events this linked device saw, not as an answer.
 * Read against the archive, they mean:
 *
 * - `offer`: it rang. Its chat is the caller's, or the group's.
 * - `accept` / `reject`: the phone answered or declined. These carry our own
 *   JID as their chat, which is why calls are grouped by id, never by chat.
 * - `terminate` with `accepted_elsewhere` / `rejected_elsewhere`: the same,
 *   seen from here, seconds after the offer.
 * - `terminate` with no reason: it stopped ringing and nobody picked up.
 * - `terminate` with `group_call_ended`: a group call ended. Joining one from
 *   the phone sends no `accept` here, so this says nothing about whether we
 *   were in it.
 * - `call_log`: the phone's own call history, from history sync. It says
 *   outright how the call went, so when a call has one, it wins.
 *
 * A call with no ending that says how it went is `unknown`: still ringing,
 * ended while sync was not running, or a group call.
 */
export function collapseCallEvents(rows: RawCallEvent[]): CallRecord[] {
  const byCall = new Map<string, RawCallEvent[]>();
  for (const row of rows) {
    if (!row.call_id) continue;
    const events = byCall.get(row.call_id) ?? [];
    events.push(row);
    byCall.set(row.call_id, events);
  }

  const records: CallRecord[] = [];
  for (const [callId, events] of byCall) {
    const log = events.find((e) => e.event_type === 'call_log');
    const offer = events.find((e) => e.event_type === 'offer');
    const origin =
      log ??
      offer ??
      // Without an offer, the terminate is the one that names the caller's chat.
      events.find((e) => e.event_type === 'terminate') ??
      events[0];

    const outcome = log ? logOutcome(log.outcome) : liveOutcome(events);
    const chatJid = origin.chat_jid;

    records.push({
      callId,
      chatJid,
      callerName: origin.sender_name || origin.sender_jid || '',
      ts: origin.timestamp,
      direction: origin.direction === 'outbound' ? 'outbound' : 'inbound',
      video: events.some((e) => e.media === 'video'),
      group: chatJid.endsWith('@g.us') || events.some((e) => e.reason === 'group_call_ended'),
      outcome,
      durationSecs: log && outcome === 'answered' && log.duration_secs ? log.duration_secs : null,
    });
  }

  return records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

function logOutcome(outcome: string | undefined): CallOutcome {
  if (outcome === 'connected') return 'answered';
  if (outcome === 'missed') return 'missed';
  if (outcome === 'rejected') return 'declined';
  return 'unknown';
}

function liveOutcome(events: RawCallEvent[]): CallOutcome {
  if (events.some((e) => e.event_type === 'accept' || e.reason === 'accepted_elsewhere')) {
    return 'answered';
  }
  if (events.some((e) => e.event_type === 'reject' || e.reason === 'rejected_elsewhere')) {
    return 'declined';
  }
  if (events.some((e) => e.event_type === 'terminate' && !e.reason)) return 'missed';
  return 'unknown';
}
