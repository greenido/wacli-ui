import { localDayKey } from './messageDates.ts';
import type { CallRecord, UnifiedMessage } from '../types.ts';

/** One line of a thread: a message, or a call between messages. */
export type TimelineItem =
  | { kind: 'message'; key: string; ts: string; msg: UnifiedMessage }
  | { kind: 'call'; key: string; ts: string; call: CallRecord };

/**
 * Messages and calls in the order they happened. Messages come in sorted, and
 * so do calls, so this is a merge rather than a sort; a call and a message at
 * the same second put the message first.
 */
export function mergeTimeline(messages: UnifiedMessage[], calls: CallRecord[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let c = 0;
  for (const msg of messages) {
    const at = Date.parse(msg.ts);
    while (c < calls.length && Date.parse(calls[c].ts) < at) {
      items.push(callItem(calls[c++]));
    }
    items.push({ kind: 'message', key: msg.msgId, ts: msg.ts, msg });
  }
  while (c < calls.length) items.push(callItem(calls[c++]));
  return items;
}

function callItem(call: CallRecord): TimelineItem {
  return { kind: 'call', key: `call:${call.callId}`, ts: call.ts, call };
}

/** The key of the first item of each local day, which is where a divider goes. */
export function dayStartKeys(items: TimelineItem[]): Set<string> {
  const starts = new Set<string>();
  let previous: string | null = null;
  for (const item of items) {
    const day = localDayKey(item.ts);
    if (day !== previous) starts.add(item.key);
    previous = day;
  }
  return starts;
}

/** 2267 → "37m 47s"; 3725 → "1h 2m". */
export function formatCallDuration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  const s = secs % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

/** What a call row says, and whether it is one the operator missed. */
export function describeCall(call: CallRecord): { label: string; missed: boolean } {
  const kind = `${call.group ? 'group ' : ''}${call.video ? 'video' : 'voice'} call`;
  const missed = call.direction === 'inbound' && call.outcome === 'missed';

  let label: string;
  if (call.direction === 'outbound') {
    label = {
      answered: `Outgoing ${kind}`,
      missed: `Outgoing ${kind} · no answer`,
      declined: `Outgoing ${kind} · declined`,
      unknown: `Outgoing ${kind}`,
    }[call.outcome];
  } else {
    label = {
      answered: `Incoming ${kind}`,
      missed: `Missed ${kind}`,
      declined: `Declined ${kind}`,
      // Ringing, or a group call: there was no telling whether we joined.
      unknown: call.group ? kind : `Incoming ${kind} · outcome unknown`,
    }[call.outcome];
  }
  // In a group, who rang is half the news.
  if (call.group && call.direction === 'inbound' && call.callerName) {
    label = label.replace(kind, `${kind} from ${call.callerName}`);
  }
  if (call.durationSecs) label += ` · ${formatCallDuration(call.durationSecs)}`;
  // Sentence case, whichever word ended up first.
  return { label: label[0].toUpperCase() + label.slice(1), missed };
}
