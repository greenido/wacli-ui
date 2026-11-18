import React from 'react';
import { ChevronDown, ChevronRight, Clock, Loader2, RotateCw, Trash2, X } from 'lucide-react';
import { detectTextDirection } from '../../lib/textDirection.ts';
import type { MessageJumpHint } from '../../store/appStore.ts';
import type { ScheduledMessage } from '../../types.ts';
import type { OpenMessage } from './useOpenMessage.ts';
import type { ScheduledActions } from './useScheduledActions.ts';

interface ScheduledTabProps {
  rows: ScheduledMessage[];
  isPending: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  sentinelRef: React.Ref<HTMLDivElement>;
  selectedJid: string | undefined;
  openMessage: OpenMessage;
  actions: ScheduledActions;
}

/**
 * A message that never went out has nothing to focus, and a queued one has
 * not been sent yet — only a delivered message can be pointed at.
 */
const scheduledJumpHint = (item: ScheduledMessage): MessageJumpHint | undefined =>
  item.status === 'sent'
    ? { text: item.message || item.fileName || '', sentAfter: item.scheduledAt }
    : undefined;

/** LATER: the queue, pending first, then what already went out or failed. */
export const ScheduledTab: React.FC<ScheduledTabProps> = ({
  rows,
  isPending,
  hasNextPage,
  isFetchingNextPage,
  sentinelRef,
  selectedJid,
  openMessage,
  actions,
}) => {
  const { cancel, discard, resend, resendTarget, expandedId, setExpandedId } = actions;

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
      {actions.actionError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 rounded border border-mc-danger/50 bg-mc-danger/10 px-2 py-1.5 text-[11px] text-mc-danger"
        >
          <span className="min-w-0 break-words">{actions.actionError}</span>
          <button
            type="button"
            onClick={actions.clearActionError}
            aria-label="Dismiss"
            className="shrink-0 text-mc-danger/70 hover:text-mc-danger"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
          {isPending ? 'Loading queue…' : 'No scheduled messages queued.'}
        </div>
      ) : (
        <>
          {rows.map((item) => {
            const isSelected = selectedJid === item.to;
            const isFailed = item.status === 'failed';
            const isExpanded = isFailed && expandedId === item.id;
            // A failed message was never delivered, so there is nothing in
            // the thread to jump to. Opening the row in place is the only
            // click that can actually tell the operator anything.
            const handleActivate = () => {
              if (isFailed) {
                setExpandedId(isExpanded ? null : item.id);
              }
              openMessage(item.to, item.recipientName, item.sentMessageId, scheduledJumpHint(item));
            };

            return (
              <div key={item.id}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={isFailed ? isExpanded : undefined}
                  onClick={handleActivate}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleActivate();
                    }
                  }}
                  className={`p-2 bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                    isExpanded ? 'rounded-t' : 'rounded'
                  } ${
                    isFailed
                      ? 'border-mc-danger/50'
                      : isSelected
                      ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                      : 'border-mc-border/70'
                  }`}
                  title={
                    isFailed
                      ? 'Not delivered. Click for the failure detail and resend options.'
                      : 'Click to view conversation in main chat area'
                  }
                >
                  <div className="flex items-center justify-between text-[10px]">
                    <span className="text-mc-live font-semibold flex items-center gap-1">
                      <Clock size={10} />
                      {new Date(item.scheduledAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
                      {new Date(item.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span
                      className={`font-semibold uppercase ${
                        item.status === 'sent'
                          ? 'text-mc-live'
                          : item.status === 'pending' || item.status === 'sending'
                          ? 'text-mc-safe'
                          : isFailed
                          ? 'text-mc-danger'
                          : 'text-mc-textMuted'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>
                  <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                    <span className="truncate">{item.recipientName || item.to}</span>
                    {isFailed ? (
                      <span className="text-[9px] text-mc-danger font-mono opacity-90 shrink-0 flex items-center gap-0.5">
                        {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span>DETAILS</span>
                      </span>
                    ) : (
                      <span className="text-[9px] text-mc-live font-mono opacity-80 shrink-0">
                        OPEN →
                      </span>
                    )}
                  </div>
                  <div
                    dir={detectTextDirection(item.message)}
                    className="text-mc-textMuted truncate text-start"
                  >
                    {item.fileName ? `[File: ${item.fileName}] ` : ''}
                    {item.message}
                  </div>
                  {item.status === 'pending' && (
                    <div className="pt-1 flex justify-end">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          cancel.mutate(item.id);
                        }}
                        disabled={cancel.isPending}
                        className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors"
                        title="Cancel scheduled dispatch"
                      >
                        <Trash2 size={10} />
                        <span>CANCEL</span>
                      </button>
                    </div>
                  )}
                  {item.error && !isExpanded && (
                    <div className="text-[10px] text-mc-danger leading-snug break-words pt-0.5 line-clamp-2">
                      {item.error}
                    </div>
                  )}
                </div>

                {/* Failure detail. Rendered as a sibling of the clickable
                    summary rather than inside it, so these controls are not
                    buttons nested in a role="button". */}
                {isExpanded && (
                  <div className="border border-t-0 border-mc-danger/50 rounded-b bg-mc-bg/60 p-2 space-y-2 text-[10px]">
                    <div className="text-mc-danger leading-snug break-words">
                      <span className="font-bold uppercase">Not delivered: </span>
                      {item.error || 'No reason recorded.'}
                    </div>

                    <div className="text-mc-textMuted leading-snug">
                      <span className="uppercase">Message: </span>
                      <span
                        dir={detectTextDirection(item.message)}
                        className="text-mc-text break-words whitespace-pre-wrap"
                      >
                        {item.message || '(no text)'}
                      </span>
                    </div>

                    {item.fileName && (
                      <div
                        className={`leading-snug break-words ${
                          item.attachmentMissing ? 'text-mc-danger' : 'text-mc-textMuted'
                        }`}
                      >
                        <span className="uppercase">Attachment: </span>
                        {item.fileName}
                        {item.attachmentMissing && ' — no longer on disk'}
                      </div>
                    )}

                    {typeof item.resendCount === 'number' && item.resendCount > 0 && (
                      <div className="text-mc-safe">
                        Resent {item.resendCount} {item.resendCount === 1 ? 'time' : 'times'}
                        {item.lastAttemptAt
                          ? `, last at ${new Date(item.lastAttemptAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}`
                          : ''}
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 pt-0.5">
                      <button
                        onClick={() => actions.openResend(item)}
                        disabled={resend.isPending || discard.isPending}
                        className="flex items-center gap-1 text-[10px] text-mc-live hover:text-mc-text border border-mc-live/40 hover:border-mc-live px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Send this message again, now or at a new time"
                      >
                        {resend.isPending && resendTarget?.id === item.id ? (
                          <Loader2 size={10} className="animate-spin" />
                        ) : (
                          <RotateCw size={10} />
                        )}
                        <span>RESEND</span>
                      </button>
                      <button
                        onClick={() => {
                          setExpandedId(null);
                          discard.mutate(item.id);
                        }}
                        disabled={resend.isPending || discard.isPending}
                        className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        title="Remove this failed message from the queue"
                      >
                        <Trash2 size={10} />
                        <span>DISCARD</span>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {hasNextPage && (
            <div
              ref={sentinelRef}
              className="py-2 text-center text-[10px] font-mono text-mc-textMuted/70"
            >
              {isFetchingNextPage ? 'loading more…' : 'scroll for more'}
            </div>
          )}
        </>
      )}
    </div>
  );
};
