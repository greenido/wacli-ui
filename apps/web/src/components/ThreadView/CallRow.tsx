import React from 'react';
import { PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing, Video } from 'lucide-react';
import { describeCall } from '../../lib/callTimeline.ts';
import { fullTimestamp } from '../../lib/messageDates.ts';
import type { CallRecord } from '../../types.ts';

/** Why an `unknown` call says so, on hover. */
const UNKNOWN_HINT =
  'wacli saw this call ring but not how it went: it was still ringing, it ended while sync was not running, or it was a group call, which the phone joins without telling linked devices.';

/**
 * A call, in the thread between the messages around it. Centred like a day
 * divider rather than drawn as a bubble: nobody said it.
 */
export const CallRow = React.memo<{ call: CallRecord }>(function CallRow({ call }) {
  const { label, missed } = describeCall(call);
  const Icon = call.video
    ? Video
    : missed
      ? PhoneMissed
      : call.outcome === 'declined'
        ? PhoneOff
        : call.direction === 'outbound'
          ? PhoneOutgoing
          : PhoneIncoming;

  return (
    <div className="flex justify-center py-0.5" data-call-id={call.callId}>
      <div
        className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-mono ${
          missed
            ? 'border-mc-danger/50 bg-mc-danger/10 text-mc-danger'
            : 'border-mc-border bg-mc-surface text-mc-textMuted'
        }`}
        title={call.outcome === 'unknown' ? UNKNOWN_HINT : undefined}
      >
        <Icon size={12} aria-hidden="true" />
        <span>{label}</span>
        <time dateTime={call.ts} title={fullTimestamp(call.ts)} className="opacity-70">
          {new Date(call.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
      </div>
    </div>
  );
});
