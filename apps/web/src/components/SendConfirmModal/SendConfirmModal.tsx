import React, { useState } from 'react';
import { Send, X, AlertCircle, FileText, CheckCircle2, ShieldAlert } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedMessage, UnifiedChat } from '../../types.ts';

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

  if (activeModal !== 'send-confirm' || !sendConfirmData) return null;

  const handleConfirmSend = async () => {
    setErrorMessage(null);
    setIsCommitted(true);

    const logId = addSendLog({
      to: sendConfirmData.toJid,
      chatName: sendConfirmData.recipientName,
      message: sendConfirmData.messageText || sendConfirmData.fileAttachment?.name || 'File Attachment',
      status: 'pending',
    });

    try {
      // If currently in safe read-only mode, unlock live sends first
      if (isReadOnly) {
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

      // Update chats list query cache so new/updated chat appears at top
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

      // Clear composer draft
      clearComposer();

      // Clean up & close modal
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
        className={`bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-lg flex flex-col font-mono text-xs transition-all duration-300 ${
          isCommitted ? 'scale-[0.98] border-mc-live' : 'scale-100'
        }`}
      >
        {/* Modal Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-mc-live font-semibold">
            <Send size={15} />
            <span>CONFIRM OUTBOUND DISPATCH</span>
          </div>
          <button
            onClick={() => setActiveModal(null)}
            className="p-1 text-mc-textMuted hover:text-mc-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 space-y-4">
          {/* Safe Mode notice if active */}
          {isReadOnly && (
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
            disabled={isCommitted}
            className={`px-4 py-1.5 rounded font-bold flex items-center gap-1.5 transition-all ${
              isCommitted
                ? 'bg-mc-live text-[#12151B]'
                : 'bg-mc-live hover:bg-mc-live/90 text-[#12151B]'
            }`}
          >
            {isCommitted ? (
              <>
                <CheckCircle2 size={14} className="animate-spin" />
                <span>DISPATCHING...</span>
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
