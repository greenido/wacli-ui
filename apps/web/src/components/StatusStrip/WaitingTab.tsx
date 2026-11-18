import React, { useState } from 'react';
import { AlarmClock, Check, Send } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { messagePreviewText } from '../../lib/messagePreview.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { formatWhen } from '../../lib/scheduleTime.ts';
import { describeWaiting, nudgeText, remindPresets, sentAgo } from '../../lib/waiting.ts';
import type { WaitingItem } from '../../types.ts';
import type { OpenMessage } from './useOpenMessage.ts';

interface WaitingTabProps {
  items: WaitingItem[];
  snoozed: number;
  isPending: boolean;
  isError: boolean;
  selectedJid: string | undefined;
  openMessage: OpenMessage;
}

const actionClass =
  'flex items-center gap-1 px-1.5 py-0.5 rounded border border-mc-border/70 text-[10px] text-mc-textMuted hover:text-mc-text hover:border-mc-live/60 transition-colors disabled:opacity-50';

/**
 * WAITING: messages the operator sent that the other side has and has not
 * answered, longest wait first. Every action here is local. Nudge only fills
 * the composer, and what goes out after that passes the same confirmation and
 * safe-mode guard as any other send.
 */
export const WaitingTab: React.FC<WaitingTabProps> = ({
  items,
  snoozed,
  isPending,
  isError,
  selectedJid,
  openMessage,
}) => {
  const queryClient = useQueryClient();
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const triggerFocusComposer = useAppStore((s) => s.triggerFocusComposer);
  const [remindOpenFor, setRemindOpenFor] = useState<string | null>(null);

  const settle = () => void queryClient.invalidateQueries({ queryKey: ['waiting'] });

  const dismiss = useMutation({
    mutationFn: (item: WaitingItem) => api.dismissWaiting({ chat: item.chatJid, id: item.message.msgId }),
    onSuccess: settle,
  });

  const snooze = useMutation({
    mutationFn: ({ item, until }: { item: WaitingItem; until: string }) =>
      api.snoozeWaiting({ chat: item.chatJid, id: item.message.msgId, until }),
    onSuccess: () => {
      setRemindOpenFor(null);
      settle();
    },
  });

  const open = (item: WaitingItem) =>
    openMessage(item.chatJid, item.chatName, item.message.msgId, undefined, item.message.ts);

  const nudge = async (item: WaitingItem) => {
    open(item);
    // The follow-up quotes the message it chases, so the other side sees
    // what it is about without scrolling.
    setReplyingTo(item.chatJid, item.message);
    // Text the operator already started in that chat is worth more than a
    // canned line, so it is only filled into an empty composer.
    if (!useAppStore.getState().composerDrafts[item.chatJid]?.trim()) {
      const templates = await queryClient
        .fetchQuery({ queryKey: ['templates'], queryFn: () => api.getTemplates() })
        .catch(() => undefined);
      if (!useAppStore.getState().composerDrafts[item.chatJid]?.trim()) {
        setComposerDraft(item.chatJid, nudgeText(templates));
      }
    }
    triggerFocusComposer();
  };

  const busy = dismiss.isPending || snooze.isPending;

  return (
    <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
      {items.length === 0 ? (
        <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
          {isPending
            ? 'Checking for unanswered messages…'
            : isError
            ? 'Could not check for unanswered messages.'
            : 'Nobody owes you a reply.'}
        </div>
      ) : (
        items.map((item) => {
          const { message } = item;
          const isSelected = selectedJid === item.chatJid;
          const preview = messagePreviewText(message) || message.msgId;
          return (
            <div
              key={message.msgId}
              role="button"
              tabIndex={0}
              onClick={() => open(item)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  open(item);
                }
              }}
              className={`p-2 rounded bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                isSelected
                  ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                  : 'border-mc-border/70'
              }`}
              title="Open the conversation at this message"
            >
              <div className="flex items-center justify-between gap-1 text-[10px]">
                <span className="text-mc-textMuted">sent {sentAgo(message.ts)}</span>
                {item.snoozedUntil && (
                  <span className="flex items-center gap-0.5 text-mc-safe" title="Back from a reminder">
                    <AlarmClock size={10} /> REMINDER
                  </span>
                )}
              </div>
              <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                <span className="truncate">{item.chatName}</span>
                <span className="text-[9px] text-mc-live font-mono opacity-80 shrink-0">OPEN →</span>
              </div>
              <div dir={detectTextDirection(preview)} className="text-mc-textMuted truncate text-start">
                {preview}
              </div>
              <div className="text-[10px] text-mc-textMuted/80">{describeWaiting(item)}</div>

              <div className="flex flex-wrap gap-1 pt-0.5">
                <button
                  type="button"
                  className={actionClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    void nudge(item);
                  }}
                  title="Open the chat with a follow-up ready in the composer. Nothing is sent until you confirm."
                >
                  <Send size={10} /> Nudge
                </button>
                <button
                  type="button"
                  className={actionClass}
                  aria-expanded={remindOpenFor === message.msgId}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRemindOpenFor((cur) => (cur === message.msgId ? null : message.msgId));
                  }}
                  title="Hide this until later, then bring it back here"
                >
                  <AlarmClock size={10} /> Remind me
                </button>
                <button
                  type="button"
                  className={actionClass}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    dismiss.mutate(item);
                  }}
                  title="Stop waiting on this one"
                >
                  <Check size={10} /> Done
                </button>
              </div>

              {remindOpenFor === message.msgId && (
                <div className="flex flex-wrap gap-1" role="group" aria-label="Remind me">
                  {remindPresets().map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={actionClass}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        snooze.mutate({ item, until: preset.until });
                      }}
                      title={formatWhen(preset.until)}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })
      )}

      {(dismiss.isError || snooze.isError) && (
        <div className="rounded border border-mc-danger/50 bg-mc-danger/10 px-2 py-1.5 text-[11px] text-mc-danger">
          {(dismiss.error ?? snooze.error)?.message ?? 'That did not save.'}
        </div>
      )}

      {snoozed > 0 && (
        <div className="text-center py-1 text-[10px] text-mc-textMuted/70">
          {snoozed} hidden until a reminder
        </div>
      )}
    </div>
  );
};
