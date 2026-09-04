import React, { useState } from 'react';
import { RotateCw, X, AlertTriangle, ShieldAlert, Clock, Calendar, FileText, Loader2 } from 'lucide-react';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { getPresetTime, getTomorrowMorning } from '../../lib/scheduleTime.ts';
import type { ScheduledMessage } from '../../types.ts';

interface ResendConfirmModalProps {
  item: ScheduledMessage;
  isReadOnly: boolean;
  isPending: boolean;
  errorMessage: string | null;
  onClose: () => void;
  /** Omit scheduledAt to dispatch now; pass an ISO string to requeue it. */
  onConfirm: (scheduledAt?: string) => void;
}

/**
 * The deliberate pause between clicking RESEND and a message actually going
 * out. It exists because "failed" is not proof of non-delivery: a send that
 * timed out may already have reached the recipient's phone, and this is the
 * only place the operator is told that before the duplicate exists.
 */
export const ResendConfirmModal: React.FC<ResendConfirmModalProps> = ({
  item,
  isReadOnly,
  isPending,
  errorMessage,
  onClose,
  onConfirm,
}) => {
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose);
  const [isScheduled, setIsScheduled] = useState(false);
  const [scheduleTime, setScheduleTime] = useState(() => getPresetTime(30));

  // Safe mode blocks the live send but not the queueing of one for later, which
  // is exactly the escape hatch for a message that failed *because* of safe mode.
  const blocked = isReadOnly && !isScheduled;
  const canSubmit = !isPending && !blocked && (!isScheduled || Boolean(scheduleTime));

  const handleConfirm = () => {
    if (!canSubmit) return;
    onConfirm(isScheduled ? new Date(scheduleTime).toISOString() : undefined);
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="resend-confirm-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-lg flex flex-col font-mono text-xs"
      >
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2 id="resend-confirm-title" className="flex items-center gap-2 text-mc-live font-semibold">
            <RotateCw size={15} />
            <span>{isScheduled ? 'REQUEUE FAILED DISPATCH' : 'RESEND FAILED DISPATCH'}</span>
          </h2>
          <button
            onClick={onClose}
            aria-label="Close resend confirmation"
            className="p-1 text-mc-textMuted hover:text-mc-text"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* The whole reason this dialog exists. Shown for a requeue too:
              scheduling the retry for later defers the duplicate, it does not
              avoid one. */}
          <div className="p-3 bg-[#E8B96A]/10 border border-[#E8B96A]/40 rounded text-mc-safe flex items-start gap-2.5">
            <AlertTriangle size={16} className="shrink-0 mt-0.5" />
            <div>
              <span className="font-bold">This may deliver the message twice.</span>
              <p className="text-[11px] text-mc-text mt-0.5">
                A dispatch that timed out can still have reached WhatsApp. Check the conversation
                before {isScheduled ? 'requeueing' : 'resending'} if you are not sure it is missing.
              </p>
            </div>
          </div>

          {blocked && (
            <div className="p-3 bg-mc-danger/10 border border-mc-danger/40 rounded text-mc-danger flex items-start gap-2.5">
              <ShieldAlert size={16} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Safe read-only mode is active.</span>
                <p className="text-[11px] text-mc-text mt-0.5">
                  Live sends are disabled. Unlock live mode in settings to resend now, or requeue
                  this message for a later time.
                </p>
              </div>
            </div>
          )}

          {/* dispatch() falls back to a plain text send when the attachment has
              gone, so the dialog must not promise a file it will not send. */}
          {item.attachmentMissing && (
            <div className="p-3 bg-mc-danger/10 border border-mc-danger/40 rounded text-mc-danger flex items-start gap-2.5">
              <FileText size={16} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">The attachment is no longer on disk.</span>
                <p className="text-[11px] text-mc-text mt-0.5">
                  {item.fileName ? `"${item.fileName}" ` : 'The file '}
                  cannot be resent.{' '}
                  {item.message
                    ? 'Only the caption below will go out, as a plain text message.'
                    : 'There is nothing left to send — discard this instead and send the file again from the composer.'}
                </p>
              </div>
            </div>
          )}

          <div className="p-3 bg-mc-bg rounded border border-mc-border space-y-2">
            <div className="flex justify-between gap-2">
              <span className="text-mc-textMuted">TO</span>
              <span className="text-mc-text font-semibold truncate">
                {item.recipientName || item.to}
              </span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-mc-textMuted">ORIGINALLY DUE</span>
              <span className="text-mc-text">{new Date(item.scheduledAt).toLocaleString()}</span>
            </div>
            {typeof item.resendCount === 'number' && item.resendCount > 0 && (
              <div className="flex justify-between gap-2">
                <span className="text-mc-textMuted">PREVIOUS RESENDS</span>
                <span className="text-mc-safe">{item.resendCount}</span>
              </div>
            )}
            <div className="pt-1 border-t border-mc-border/60">
              <div className="text-mc-textMuted mb-1">MESSAGE</div>
              <div className="text-mc-text whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                {item.fileName && !item.attachmentMissing && (
                  <span className="text-mc-live">[File: {item.fileName}] </span>
                )}
                {item.message || <span className="text-mc-textMuted italic">(no text)</span>}
              </div>
            </div>
          </div>

          {item.error && (
            <div className="p-2.5 bg-mc-danger/5 border border-mc-danger/30 rounded text-[11px] text-mc-danger break-words">
              <span className="font-bold uppercase">Previous failure: </span>
              {item.error}
            </div>
          )}

          <div className="flex items-center justify-between p-2.5 bg-mc-bg rounded border border-mc-border">
            <span className="text-mc-text font-semibold flex items-center gap-1.5">
              <Clock size={14} className={isScheduled ? 'text-mc-live' : 'text-mc-textMuted'} />
              <span>RETRY TIMING:</span>
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setIsScheduled(false)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                  !isScheduled
                    ? 'bg-mc-live text-[#12151B] font-bold'
                    : 'text-mc-textMuted hover:text-mc-text bg-mc-surface border border-mc-border'
                }`}
              >
                SEND NOW
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsScheduled(true);
                  if (!scheduleTime) setScheduleTime(getPresetTime(30));
                }}
                className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors ${
                  isScheduled
                    ? 'bg-mc-live text-[#12151B] font-bold'
                    : 'text-mc-textMuted hover:text-mc-text bg-mc-surface border border-mc-border'
                }`}
              >
                PICK A TIME
              </button>
            </div>
          </div>

          {isScheduled && (
            <div className="p-3 bg-mc-bg rounded border border-mc-border/80 space-y-2.5">
              <div className="text-[10px] text-mc-textMuted uppercase tracking-wider flex items-center gap-1">
                <Calendar size={12} />
                <span>SELECT DISPATCH TIME (LOCAL)</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                {[
                  { label: '+15 MIN', value: () => getPresetTime(15) },
                  { label: '+1 HR', value: () => getPresetTime(60) },
                  { label: '+4 HRS', value: () => getPresetTime(240) },
                  { label: 'TOMORROW', value: getTomorrowMorning },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => setScheduleTime(preset.value())}
                    className="p-1.5 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-text"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <input
                type="datetime-local"
                aria-label="Dispatch time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                className="w-full bg-mc-surface border border-mc-border rounded px-2 py-1.5 text-mc-text font-mono text-[11px] focus:outline-none focus:border-mc-live"
              />
            </div>
          )}

          {errorMessage && (
            <div
              role="alert"
              className="p-2.5 bg-mc-danger/10 border border-mc-danger/40 rounded text-[11px] text-mc-danger break-words"
            >
              {errorMessage}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-mc-border flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-mc-border text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceHover transition-colors"
          >
            CANCEL
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canSubmit}
            data-autofocus
            className="px-3 py-1.5 rounded bg-mc-live text-[#12151B] font-bold flex items-center gap-1.5 hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPending ? (
              <>
                <Loader2 size={13} className="animate-spin" />
                <span>SENDING...</span>
              </>
            ) : (
              <>
                <RotateCw size={13} />
                <span>{isScheduled ? 'REQUEUE' : 'RESEND NOW'}</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
