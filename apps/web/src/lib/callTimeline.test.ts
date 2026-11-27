import { describe, it, expect } from 'vitest';
import { dayStartKeys, describeCall, formatCallDuration, mergeTimeline } from './callTimeline.ts';
import type { CallRecord, UnifiedMessage } from '../types.ts';

function msg(id: string, ts: string): UnifiedMessage {
  return { msgId: id, ts } as UnifiedMessage;
}

function call(over: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: 'C',
    chatJid: 'ada@s.whatsapp.net',
    callerName: 'Ada Lovelace',
    ts: '2026-11-20T10:00:00Z',
    direction: 'inbound',
    video: false,
    group: false,
    outcome: 'missed',
    durationSecs: null,
    ...over,
  };
}

describe('mergeTimeline', () => {
  it('puts calls among messages by time, a message first on a tie', () => {
    const items = mergeTimeline(
      [msg('M1', '2026-11-20T09:00:00Z'), msg('M2', '2026-11-20T10:00:00Z')],
      [
        call({ callId: 'BEFORE', ts: '2026-11-20T08:00:00Z' }),
        call({ callId: 'TIE', ts: '2026-11-20T10:00:00Z' }),
        call({ callId: 'AFTER', ts: '2026-11-20T11:00:00Z' }),
      ]
    );
    expect(items.map((i) => i.key)).toEqual(['call:BEFORE', 'M1', 'M2', 'call:TIE', 'call:AFTER']);
  });

  it('marks the first line of each day, call or message', () => {
    const items = mergeTimeline(
      [msg('M1', '2026-11-20T12:00:00'), msg('M2', '2026-11-21T12:00:00')],
      [call({ callId: 'NEXT', ts: '2026-11-21T08:00:00' })]
    );
    expect([...dayStartKeys(items)]).toEqual(['M1', 'call:NEXT']);
  });
});

describe('describeCall', () => {
  it('says what happened, flagging only an inbound miss', () => {
    expect(describeCall(call())).toEqual({ label: 'Missed voice call', missed: true });
    expect(describeCall(call({ direction: 'outbound' }))).toEqual({
      label: 'Outgoing voice call · no answer',
      missed: false,
    });
    expect(describeCall(call({ outcome: 'declined', video: true })).label).toBe('Declined video call');
    expect(describeCall(call({ outcome: 'unknown' })).label).toBe('Incoming voice call · outcome unknown');
    expect(describeCall(call({ outcome: 'answered', direction: 'outbound', durationSecs: 2267 })).label).toBe(
      'Outgoing voice call · 37m 47s'
    );
  });

  it('names the caller of a group call', () => {
    expect(describeCall(call({ group: true })).label).toBe('Missed group voice call from Ada Lovelace');
    expect(describeCall(call({ group: true, outcome: 'unknown' })).label).toBe('Group voice call from Ada Lovelace');
  });
});

describe('formatCallDuration', () => {
  it('reads like a call log', () => {
    expect([45, 60, 125, 3600, 3725].map(formatCallDuration)).toEqual(['45s', '1m', '2m 5s', '1h', '1h 2m']);
  });
});
