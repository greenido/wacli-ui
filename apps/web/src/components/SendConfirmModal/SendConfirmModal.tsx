import React, { useState } from 'react';
import { Send, X, AlertCircle, FileText, CheckCircle2, ShieldAlert, Clock, Calendar } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import type { UnifiedMessage, UnifiedChat } from '../../types.ts';

// Preset time helper
const getPresetTime = (minutesOffset: number) => {
  const d = new Date(Date.now() + minutesOffset * 60 * 1000);
  // Format for datetime-local input YYYY-MM-DDTHH:mm
  const pad = (n: number) => (n < 10 ? `0${n}` : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const getTomorrowMorning = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => (n < 10 ? `0${n}` : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
};

export const SendConfirmModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const sendConfirmData = useAppStore((s) => s.sendConfirmData);
  const setSendConfirmData = useAppStore((s) => s.setSendConfirmData);
  const clearComposer = useAppStore((s) => s.clearComposer);
  const addSendLog = useAppStore((s) => s.addSendLog);
  const updateSendLog = useAppStore((s) => s.updateSendLog);
  const queryClient = useQueryClient();

  const [isCommitted, setIsCommitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isOpen = activeModal === 'send-confirm' && Boolean(sendConfirmData);
  const dialogRef = useModalDialog<HTMLDivElement>(isOpen, () => setActiveModal(null));

  const [isScheduled, setIsScheduled] = useState(() => Boolean(sendConfirmData?.scheduleMode));
  const [scheduleTime, setScheduleTime] = useState(() => getPresetTime(30));

  const { data: modeData } = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.getMode(),
  });

  const isReadOnly = modeData?.readOnly ?? false;

  const sendTextMutation = useMutation({
    mutationFn: (data: { to: string; message: string; replyTo?: string }) =>
      api.sendText({ ...data, confirm: true }),
  });

  const sendFileMutation = useMutation({
    mutationFn: (formData: FormData) => api.sendFile(formData),
  });

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

  if (activeModal !== 'send-confirm' || !sendConfirmData) return null;

  const handleConfirmSend = async () => {
    setErrorMessage(null);
    setIsCommitted(true);

    const isScheduling = isScheduled && scheduleTime;
    const isoScheduledAt = isScheduling ? new Date(scheduleTime).toISOString() : undefined;

    const logId = addSendLog({
      to: sendConfirmData.toJid,
      chatName: sendConfirmData.recipientName,
      message: `${isScheduling ? '[Scheduled] ' : ''}${sendConfirmData.messageText || sendConfirmData.fileAttachment?.name || 'File Attachment'}`,
      status: 'pending',
    });

    try {
      if (isScheduling && isoScheduledAt) {
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

        updateSendLog(logId, { status: 'success' });
        queryClient.invalidateQueries({ queryKey: ['scheduled'] });
      } else {
        // Immediate Send flow
        if (isReadOnly) {
          localStorage.setItem('wacli_safe_mode', 'false');
          await api.setMode(false);
          queryClient.invalidateQueries({ queryKey: ['mode'] });
          queryClient.invalidateQueries({ queryKey: ['health'] });
        }

        let sentResult: { sent: boolean; messageId?: string } | undefined;

        if (sendConfirmData.fileAttachment) {
          const fd = new FormData();
          fd.append('file', sendConfirmData.fileAttachment);
          fd.append('to', sendConfirmData.toJid);
          if (sendConfirmData.messageText) {
            fd.append('caption', sendConfirmData.messageText);
          }
          if (sendConfirmData.replyToId) {
            fd.append('replyTo', sendConfirmData.replyToId);
          }
          fd.append('confirm', 'true');

          sentResult = await sendFileMutation.mutateAsync(fd);
        } else {
          sentResult = await sendTextMutation.mutateAsync({
            to: sendConfirmData.toJid,
            message: sendConfirmData.messageText,
            replyTo: sendConfirmData.replyToId,
          });
        }

        updateSendLog(logId, { status: 'success' });

        // Optimistic message append in active thread
        const optimisticMsg: UnifiedMessage = {
          chatJid: sendConfirmData.toJid,
          chatName: sendConfirmData.recipientName,
          msgId: sentResult?.messageId || `out-${Date.now()}`,
          senderJid: '',
          senderName: 'Me',
          ts: new Date().toISOString(),
          fromMe: true,
          text: sendConfirmData.messageText,
          displayText: sendConfirmData.messageText,
          isForwarded: false,
          reactionToId: null,
          reactionEmoji: null,
          mediaType: sendConfirmData.fileAttachment ? 'document' : null,
          mediaCaption: sendConfirmData.messageText || null,
          filename: sendConfirmData.fileAttachment?.name || null,
          mimeType: sendConfirmData.fileAttachment?.type || null,
          localPath: null,
          starred: false,
          edited: false,
          revoked: false,
          deliveryStatus: 'sent',
        };

        queryClient.setQueryData<{ messages: UnifiedMessage[]; hasMore: boolean }>(
          ['messages', sendConfirmData.toJid],
          (old) => {
            if (!old) return { messages: [optimisticMsg], hasMore: false };
            return {
              ...old,
              messages: [...old.messages, optimisticMsg],
            };
          }
        );

        queryClient.setQueryData<UnifiedChat[]>(['chats'], (old) => {
          const chats = old ? [...old] : [];
          const existingIdx = chats.findIndex((c) => c.jid === sendConfirmData.toJid);
          const updatedChat: UnifiedChat = existingIdx >= 0
            ? {
                ...chats[existingIdx],
                lastMessageTs: new Date().toISOString(),
              }
            : {
                jid: sendConfirmData.toJid,
                name: sendConfirmData.recipientName,
                kind: sendConfirmData.toJid.endsWith('@g.us') ? 'group' : 'dm',
                lastMessageTs: new Date().toISOString(),
                archived: false,
                pinned: false,
                mutedUntil: 0,
                unread: false,
                unreadCount: 0,
              };

          const filtered = chats.filter((c) => c.jid !== sendConfirmData.toJid);
          return [updatedChat, ...filtered];
        });

        queryClient.invalidateQueries({ queryKey: ['messages', sendConfirmData.toJid] });
        queryClient.invalidateQueries({ queryKey: ['chats'] });
      }

      clearComposer();

      setTimeout(() => {
        setIsCommitted(false);
        setSendConfirmData(null);
        setActiveModal(null);
      }, 400);
    } catch (err: unknown) {
      setIsCommitted(false);
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      updateSendLog(logId, { status: 'error', error: msg });
    }
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
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
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

          {/* Quoted Message */}
          {sendConfirmData.replyToId && (
            <div className="text-[11px] text-mc-textMuted">
              <span className="font-semibold text-mc-live">In Reply To Msg ID:</span> {sendConfirmData.replyToId}
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
              <div className="p-3 bg-mc-bg rounded border border-mc-border text-xs text-mc-text font-sans whitespace-pre-wrap max-h-40 overflow-y-auto leading-relaxed">
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
        <div className="p-4 border-t border-mc-border bg-mc-bg/40 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setActiveModal(null)}
            className="px-3 py-1.5 rounded border border-mc-border text-mc-textMuted hover:text-mc-text hover:bg-mc-surface"
          >
            CANCEL
          </button>
          <button
            type="button"
            onClick={handleConfirmSend}
            disabled={isCommitted || (isScheduled && !scheduleTime)}
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
  );
};
