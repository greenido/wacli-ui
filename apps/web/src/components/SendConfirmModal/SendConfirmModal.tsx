import React, { useEffect, useRef, useState } from 'react';
import { Send, X, AlertCircle, FileText, CheckCircle2, ShieldAlert, Clock, Calendar } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import { getPresetTime, getTomorrowMorning } from '../../lib/scheduleTime.ts';
import { dropPendingSend, paintPendingSend, settlePendingSend } from '../../lib/pendingSend.ts';

type SendConfirmRequest = NonNullable<ReturnType<typeof useAppStore.getState>['sendConfirmData']>;

/**
 * Mounts the dialog only while a dispatch is actually pending confirmation.
 * The dialog below keeps state the caller decides - scheduling above all - and
 * a component that is mounted for the life of the app carries that state from
 * one opening to the next: this is what makes each opening a fresh one.
 */
export const SendConfirmModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const sendConfirmData = useAppStore((s) => s.sendConfirmData);

  if (activeModal !== 'send-confirm' || !sendConfirmData) return null;
  return <SendConfirmDialog sendConfirmData={sendConfirmData} />;
};

const SendConfirmDialog: React.FC<{ sendConfirmData: SendConfirmRequest }> = ({
  sendConfirmData,
}) => {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setSendConfirmData = useAppStore((s) => s.setSendConfirmData);
  const clearComposer = useAppStore((s) => s.clearComposer);
  const addSendLog = useAppStore((s) => s.addSendLog);
  const clearSendLog = useAppStore((s) => s.clearSendLog);
  const queryClient = useQueryClient();

  const [isCommitted, setIsCommitted] = useState(false);
  // Opened again by a send that failed after the dialog closed: say why.
  const [errorMessage, setErrorMessage] = useState<string | null>(sendConfirmData.error ?? null);

  const dialogRef = useModalDialog<HTMLDivElement>(true, () => setActiveModal(null));

  // The "scheduled" tick is held on screen for a moment before the dialog closes
  // itself. That timer writes shared app state, so it has to die with the
  // dialog that armed it: an uncancelled one fires into whatever is on screen
  // 400ms later and closes a confirmation this send knows nothing about.
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    },
    []
  );

  // Only ever read at mount, which is the opening this dialog is for.
  const [isScheduled, setIsScheduled] = useState(sendConfirmData.scheduleMode ?? false);
  const [scheduleTime, setScheduleTime] = useState(() => getPresetTime(30));

  const { isReadOnly, setSafeMode } = useSafeMode();

  const scheduleTextMutation = useMutation({
    mutationFn: (data: {
      to: string;
      recipientName?: string;
      message: string;
      replyTo?: string;
      scheduledAt: string;
      confirm: boolean;
    }) => api.scheduleText(data),
  });

  const scheduleFileMutation = useMutation({
    mutationFn: (formData: FormData) => api.scheduleFile(formData),
  });

  /**
   * Sends now, and gets out of the way while it does.
   *
   * The dialog closes as soon as the send is under way and the message shows
   * in its thread as pending, because the answer can take seconds: the daemon
   * carries out one command at a time, and a send can queue behind a read
   * receipt. If it fails, the draft goes back in the composer and the dialog
   * comes back with the reason, unless something else is on screen by then;
   * the server's ACTIVITY row records it either way.
   *
   * Everything after the dialog closes runs with the dialog unmounted, so it
   * works through the store and the query client, never through this
   * component's state.
   */
  const dispatchNow = async () => {
    const data = sendConfirmData;
    const jid = data.toJid;

    // Confirming an immediate send is taken as the decision to go live, so the
    // lock comes off here. Routed through the shared hook so the mode is only
    // recorded once the server has agreed to it — and so a refusal throws
    // before anything is dispatched, rather than leaving the console claiming
    // live sends while the server still refuses them.
    if (isReadOnly) {
      try {
        await setSafeMode(false);
      } catch (err: unknown) {
        setIsCommitted(false);
        setErrorMessage(err instanceof Error ? err.message : String(err));
        return;
      }
    }

    const logId = addSendLog({
      to: jid,
      chatName: data.recipientName,
      message: data.messageText || data.fileAttachment?.name || 'File Attachment',
      status: 'pending',
    });
    const pendingId = `pending-${logId}`;
    const replyingTo = useAppStore.getState().replyingToByChat[jid] ?? null;

    // Painting is a nicety on top of the send. A throw in here must not stop
    // the message going out.
    try {
      paintPendingSend(queryClient, pendingId, {
        chatJid: jid,
        chatName: data.recipientName,
        text: data.messageText,
        file: data.fileAttachment,
      });
    } catch (err: unknown) {
      console.error('wacli-ui: could not paint a pending send into the caches', err);
    }
    clearComposer(jid);
    setSendConfirmData(null);
    setActiveModal(null);

    let sentResult: { sent: boolean; messageId?: string };
    try {
      // The server writes the ACTIVITY row, and names it from `chatName`.
      // Without it, every send made from here was listed under its JID.
      if (data.fileAttachment) {
        const fd = new FormData();
        fd.append('file', data.fileAttachment);
        fd.append('to', jid);
        fd.append('chatName', data.recipientName);
        if (data.messageText) {
          fd.append('caption', data.messageText);
        }
        if (data.replyToId) {
          fd.append('replyTo', data.replyToId);
        }
        fd.append('confirm', 'true');

        sentResult = await api.sendFile(fd);
      } else {
        sentResult = await api.sendText({
          to: jid,
          chatName: data.recipientName,
          message: data.messageText,
          replyTo: data.replyToId,
          confirm: true,
        });
      }
    } catch (err: unknown) {
      try {
        dropPendingSend(queryClient, jid, pendingId);
      } catch (paintErr: unknown) {
        console.error('wacli-ui: could not take a failed send out of the caches', paintErr);
      }
      // A send that reached the server is already logged there as failed.
      clearSendLog(logId);
      queryClient.invalidateQueries({ queryKey: ['activity'] });
      queryClient.invalidateQueries({ queryKey: ['chats'] });

      // Back where it was typed, unless something new has been typed there since.
      const store = useAppStore.getState();
      if (!store.composerDrafts[jid] && !store.composerFiles[jid]) {
        if (data.messageText) store.setComposerDraft(jid, data.messageText);
        if (data.fileAttachment) store.setComposerFile(jid, data.fileAttachment);
        if (replyingTo) store.setReplyingTo(jid, replyingTo);
      }
      if (store.activeModal === null) {
        store.setSendConfirmData({
          ...data,
          error: err instanceof Error ? err.message : String(err),
        });
        store.setActiveModal('send-confirm');
      }
      return;
    }

    // The server recorded this send itself; its row is the record now.
    clearSendLog(logId);
    queryClient.invalidateQueries({ queryKey: ['activity'] });
    try {
      settlePendingSend(queryClient, jid, pendingId, sentResult?.messageId);
    } catch (err: unknown) {
      console.error('wacli-ui: could not settle a sent message in the caches', err);
    }
    queryClient.invalidateQueries({ queryKey: ['messages', jid] });
    queryClient.invalidateQueries({ queryKey: ['chats'] });
  };

  const handleConfirmSend = async () => {
    setErrorMessage(null);
    setIsCommitted(true);

    const isoScheduledAt =
      isScheduled && scheduleTime ? new Date(scheduleTime).toISOString() : undefined;
    if (!isoScheduledAt) {
      await dispatchNow();
      return;
    }

    const logId = addSendLog({
      to: sendConfirmData.toJid,
      chatName: sendConfirmData.recipientName,
      message: `[Scheduled] ${sendConfirmData.messageText || sendConfirmData.fileAttachment?.name || 'File Attachment'}`,
      status: 'pending',
    });

    try {
      // Send Later flow
      if (sendConfirmData.fileAttachment) {
        const fd = new FormData();
        fd.append('file', sendConfirmData.fileAttachment);
        fd.append('to', sendConfirmData.toJid);
        fd.append('recipientName', sendConfirmData.recipientName);
        if (sendConfirmData.messageText) {
          fd.append('caption', sendConfirmData.messageText);
        }
        if (sendConfirmData.replyToId) {
          fd.append('replyTo', sendConfirmData.replyToId);
        }
        fd.append('scheduledAt', isoScheduledAt);
        fd.append('confirm', 'true');

        await scheduleFileMutation.mutateAsync(fd);
      } else {
        await scheduleTextMutation.mutateAsync({
          to: sendConfirmData.toJid,
          recipientName: sendConfirmData.recipientName,
          message: sendConfirmData.messageText,
          replyTo: sendConfirmData.replyToId,
          scheduledAt: isoScheduledAt,
          confirm: true,
        });
      }

      // Queuing is not sending. The row belongs in LATER, and the activity
      // log gets its entry when the message actually goes out — which is
      // also the only way a dispatch fired with no console open is recorded.
      clearSendLog(logId);
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });

      clearComposer(sendConfirmData.toJid);

      closeTimerRef.current = setTimeout(() => {
        closeTimerRef.current = null;
        setIsCommitted(false);
        setSendConfirmData(null);
        setActiveModal(null);
      }, 400);
    } catch (err: unknown) {
      setIsCommitted(false);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      // Nothing was queued, so the dialog stays open showing the error rather
      // than closing over a silent failure.
      clearSendLog(logId);
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    }
  };

  const canSubmit = !isCommitted && !(isScheduled && !scheduleTime);

  /**
   * Enter confirms from the time field too, which is where a keyboard user ends
   * up after picking a schedule - there is no form around this dialog, so the
   * key would otherwise do nothing there.
   */
  const handleTimeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.repeat) return;
    e.preventDefault();
    if (canSubmit) void handleConfirmSend();
  };

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-confirm-title"
        className={`bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-lg flex flex-col font-mono text-xs transition-all duration-300 ${
          isCommitted ? 'scale-[0.98] border-mc-live' : 'scale-100'
        }`}
      >
        {/* Modal Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2 id="send-confirm-title" className="flex items-center gap-2 text-mc-live font-semibold">
            {isScheduled ? <Clock size={15} /> : <Send size={15} />}
            <span>{isScheduled ? 'SCHEDULE OUTBOUND DISPATCH' : 'CONFIRM OUTBOUND DISPATCH'}</span>
          </h2>
          <button
            onClick={() => setActiveModal(null)}
            aria-label="Close dispatch confirmation"
            className="p-1 text-mc-textMuted hover:text-mc-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* Safe Mode notice if active and immediate send */}
          {isReadOnly && !isScheduled && (
            <div className="p-3 bg-[#E8B96A]/10 border border-[#E8B96A]/40 rounded text-mc-safe flex items-start gap-2.5 text-xs">
              <ShieldAlert size={16} className="shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">Safe Read-Only Mode is active.</span>
                <p className="text-[11px] text-mc-text mt-0.5">
                  Confirming dispatch will automatically switch to Live Mode and transmit this message.
                </p>
              </div>
            </div>
          )}

          {/* Send Mode Toggle: Now vs Later */}
          <div className="flex items-center justify-between p-2.5 bg-mc-bg rounded border border-mc-border">
            <span className="text-mc-text font-semibold flex items-center gap-1.5">
              <Clock size={14} className={isScheduled ? 'text-mc-live' : 'text-mc-textMuted'} />
              <span>DISPATCH TIMING:</span>
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
                SEND LATER
              </button>
            </div>
          </div>

          {/* Schedule Time Selector */}
          {isScheduled && (
            <div className="p-3 bg-mc-bg rounded border border-mc-border/80 space-y-2.5">
              <div className="text-[10px] text-mc-textMuted uppercase tracking-wider flex items-center gap-1">
                <Calendar size={12} />
                <span>SELECT DISPATCH TIME (LOCAL)</span>
              </div>

              {/* Quick Presets */}
              <div className="grid grid-cols-4 gap-1.5 text-[10px]">
                <button
                  type="button"
                  onClick={() => setScheduleTime(getPresetTime(15))}
                  className="p-1.5 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-text"
                >
                  +15 MIN
                </button>
                <button
                  type="button"
                  onClick={() => setScheduleTime(getPresetTime(60))}
                  className="p-1.5 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-text"
                >
                  +1 HOUR
                </button>
                <button
                  type="button"
                  onClick={() => setScheduleTime(getPresetTime(180))}
                  className="p-1.5 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-text"
                >
                  +3 HOURS
                </button>
                <button
                  type="button"
                  onClick={() => setScheduleTime(getTomorrowMorning())}
                  className="p-1.5 rounded bg-mc-surface hover:bg-mc-surfaceHover border border-mc-border text-mc-text truncate"
                >
                  TOMORROW 9AM
                </button>
              </div>

              <input
                type="datetime-local"
                aria-label="Dispatch time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                onKeyDown={handleTimeKeyDown}
                min={getPresetTime(1)}
                className="w-full bg-mc-surface border border-mc-border rounded p-2 text-xs text-mc-text focus:outline-none focus:border-mc-live font-mono"
              />
            </div>
          )}

          {/* Target details */}
          <div className="p-3 bg-mc-bg rounded border border-mc-border space-y-1.5">
            <div className="text-mc-textMuted text-[10px]">RECIPIENT (CANONICAL JID)</div>
            <div className="text-sm font-semibold text-mc-text">{sendConfirmData.recipientName}</div>
            <div className="text-xs text-mc-live">{sendConfirmData.toJid}</div>
          </div>

          {/* Quoted Message — shown in full, because a raw wamid is not something
              an operator can check the reply is aimed at the right message. */}
          {sendConfirmData.replyToId && (
            <div className="p-2.5 bg-mc-bg rounded border-l-2 border-mc-live space-y-1">
              <div className="text-mc-textMuted text-[10px]">QUOTING</div>
              {sendConfirmData.replyToPreview ? (
                <>
                  <div className="text-mc-live font-semibold text-[11px]">
                    {sendConfirmData.replyToPreview.sender}
                  </div>
                  <div
                    dir={detectTextDirection(sendConfirmData.replyToPreview.text)}
                    className="text-mc-text text-[11px] font-sans line-clamp-3 whitespace-pre-wrap text-start"
                  >
                    {sendConfirmData.replyToPreview.text}
                  </div>
                </>
              ) : (
                <div className="text-mc-text text-[11px]">{sendConfirmData.replyToId}</div>
              )}
            </div>
          )}

          {/* Attachment */}
          {sendConfirmData.fileAttachment && (
            <div className="p-2.5 bg-mc-bg rounded border border-mc-border flex items-center gap-2 text-xs">
              <FileText size={16} className="text-mc-live" />
              <div className="truncate flex-1">
                <div className="text-mc-text font-semibold truncate">{sendConfirmData.fileAttachment.name}</div>
                <div className="text-mc-textMuted text-[10px]">{(sendConfirmData.fileAttachment.size / 1024).toFixed(1)} KB</div>
              </div>
            </div>
          )}

          {/* Message Content */}
          {sendConfirmData.messageText && (
            <div className="space-y-1">
              <div className="text-mc-textMuted text-[10px]">MESSAGE BODY</div>
              {/* Read back what is about to go out the way the recipient will
                  see it — a Hebrew body confirmed in left-to-right layout is
                  not the message the operator is agreeing to send. */}
              <div
                dir={detectTextDirection(sendConfirmData.messageText)}
                className="p-3 bg-mc-bg rounded border border-mc-border text-xs text-mc-text font-sans whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed text-start"
              >
                {sendConfirmData.messageText}
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="p-2.5 bg-mc-danger/15 border border-mc-danger/40 rounded text-mc-danger flex items-start gap-2 text-[11px]">
              <AlertCircle size={15} className="shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-mc-border bg-mc-bg/40 flex items-center justify-between gap-3">
          <div className="text-[10px] text-mc-textMuted hidden sm:flex items-center gap-1.5">
            <kbd className="px-1.5 py-0.5 rounded border border-mc-border bg-mc-surface text-mc-text">
              ENTER
            </kbd>
            <span>confirm</span>
            <kbd className="px-1.5 py-0.5 rounded border border-mc-border bg-mc-surface text-mc-text">
              ESC
            </kbd>
            <span>cancel</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setActiveModal(null)}
              className="px-3 py-1.5 rounded border border-mc-border text-mc-textMuted hover:text-mc-text hover:bg-mc-surface"
            >
              CANCEL
            </button>
            {/* data-autofocus: this button takes focus on open, so the Enter that
                opened the dialog from the composer can be pressed once more to
                dispatch. Without it focus lands on the first control - the close
                button - and that same Enter discards the message instead. */}
            <button
              type="button"
              onClick={handleConfirmSend}
              disabled={!canSubmit}
              data-autofocus
              className={`px-4 py-1.5 rounded font-bold flex items-center gap-1.5 transition-all ${
                isCommitted
                  ? 'bg-mc-live text-[#12151B]'
                  : 'bg-mc-live hover:bg-mc-live/90 text-[#12151B]'
              }`}
            >
              {isCommitted ? (
                <>
                  <CheckCircle2 size={14} className="animate-spin" />
                  <span>{isScheduled ? 'SCHEDULING...' : 'DISPATCHING...'}</span>
                </>
              ) : isScheduled ? (
                <>
                  <Clock size={14} />
                  <span>SCHEDULE DISPATCH</span>
                </>
              ) : (
                <>
                  <Send size={14} />
                  <span>CONFIRM & SEND</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
