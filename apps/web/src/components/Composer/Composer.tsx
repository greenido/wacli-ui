import React, { useRef, useEffect } from 'react';
import { Send, Paperclip, X, Unlock, ShieldAlert, Clock } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { POLL_MODE_MS } from '../../lib/queryOptions.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { useUiCommand } from '../../hooks/useUiCommand.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedMessage } from '../../types.ts';

/** What the confirm dialog shows instead of a bare wamid. */
function describeReplyTarget(msg: UnifiedMessage): { sender: string; text: string } {
  const text = msg.displayText || msg.text || msg.mediaCaption || '';
  return {
    sender: msg.senderName || msg.senderJid || 'Unknown sender',
    text: text || `[${msg.mediaType || 'no text'}]`,
  };
}

export const Composer: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  // Composer state belongs to a conversation, not to the app, so every read and
  // write below is scoped by JID. An empty key is only ever used while no chat
  // is selected, in which case the composer does not render.
  const chatJid = selectedChat?.jid ?? '';
  const replyingTo = useAppStore((s) => s.replyingToByChat[chatJid] ?? null);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setSendConfirmData = useAppStore((s) => s.setSendConfirmData);
  const composerDraft = useAppStore((s) => s.composerDrafts[chatJid] ?? '');
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const composerFile = useAppStore((s) => s.composerFiles[chatJid] ?? null);
  const setComposerFile = useAppStore((s) => s.setComposerFile);
  const focusComposerTrigger = useAppStore((s) => s.focusComposerTrigger);
  const chatFocusIntent = useAppStore((s) => s.chatFocusIntent);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: modeData } = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.getMode(),
    refetchInterval: POLL_MODE_MS,
  });

  const modeMutation = useMutation({
    mutationFn: (newReadOnly: boolean) => {
      localStorage.setItem('wacli_safe_mode', String(newReadOnly));
      return api.setMode(newReadOnly);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const isReadOnly = modeData?.readOnly ?? (localStorage.getItem('wacli_safe_mode') !== null ? localStorage.getItem('wacli_safe_mode') === 'true' : false);

  // Opening a chat by clicking it means you intend to write, so the caret
  // follows. Stepping through the rail on the keyboard does not: a composer
  // that grabbed focus there would swallow the next navigation key.
  useEffect(() => {
    if (selectedChat && chatFocusIntent === 'composer') {
      textareaRef.current?.focus();
    }
  }, [selectedChat, chatFocusIntent]);

  // An explicit ask — the `c` shortcut, or a chat just created from the modal.
  useEffect(() => {
    if (focusComposerTrigger > 0) {
      textareaRef.current?.focus();
    }
  }, [focusComposerTrigger]);

  /** Hands the draft to the confirmation step; nothing is sent from here. */
  const stageForConfirm = (scheduleMode: boolean) => {
    if (!selectedChat) return;
    if (!composerDraft.trim() && !composerFile) return;

    setSendConfirmData({
      toJid: selectedChat.jid,
      recipientName: selectedChat.name,
      messageText: composerDraft.trim(),
      replyToId: replyingTo?.msgId,
      replyToPreview: replyingTo ? describeReplyTarget(replyingTo) : undefined,
      fileAttachment: composerFile ?? undefined,
      scheduleMode,
    });
    setActiveModal('send-confirm');
  };

  useUiCommand('composer:attach', () => {
    if (!selectedChat || isReadOnly) return;
    fileInputRef.current?.click();
  });

  useUiCommand('composer:send-later', () => {
    if (isReadOnly) return;
    stageForConfirm(true);
  });

  if (!selectedChat) {
    return null;
  }

  if (isReadOnly) {
    return (
      <div className="border-t border-[#E8B96A]/30 bg-[#E8B96A]/5 p-3 shrink-0">
        <div className="flex items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-2 min-w-0 text-mc-safe">
            <ShieldAlert size={14} className="shrink-0" />
            <span className="truncate">
              Safe read-only mode — unlock live sends to compose messages.
            </span>
          </div>
          <button
            type="button"
            onClick={() => modeMutation.mutate(false)}
            disabled={modeMutation.isPending}
            className="shrink-0 flex items-center gap-1.5 bg-[#E8B96A]/20 hover:bg-[#E8B96A]/30 text-mc-safe border border-mc-safe/50 hover:border-mc-safe px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all"
            title="Switch to live write mode to send messages"
          >
            <Unlock size={12} />
            <span>UNLOCK LIVE SENDS</span>
          </button>
        </div>
      </div>
    );
  }

  const handleTriggerSend = (e: React.FormEvent) => {
    e.preventDefault();
    stageForConfirm(false);
  };

  const handleTriggerSendLater = (e: React.MouseEvent) => {
    e.preventDefault();
    stageForConfirm(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      stageForConfirm(false);
      return;
    }

    // Escape backs out one step at a time: drop the reply target first, and
    // only then leave the composer so the single-key shortcuts come alive.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (replyingTo) {
        setReplyingTo(chatJid, null);
        return;
      }
      textareaRef.current?.blur();
    }
  };

  const hasContent = Boolean(composerDraft.trim() || composerFile);

  return (
    <div className="border-t border-mc-border bg-mc-surface p-3 shrink-0">
      {/* Reply-to Bar */}
      {replyingTo && (
        <div className="mb-2 p-2 rounded bg-mc-bg border-l-2 border-mc-live flex items-center justify-between text-xs font-mono">
          <div className="min-w-0 truncate">
            <span className="text-mc-live font-semibold">Replying to {replyingTo.senderName || replyingTo.senderJid}:</span>{' '}
            <span
              dir={detectTextDirection(replyingTo.displayText || replyingTo.text)}
              className="text-mc-textMuted truncate"
            >
              {replyingTo.displayText || replyingTo.text}
            </span>
          </div>
          <button
            onClick={() => setReplyingTo(chatJid, null)}
            className="p-1 text-mc-textMuted hover:text-mc-text"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {/* Selected File Badge */}
      {composerFile && (
        <div className="mb-2 p-1.5 rounded bg-mc-bg border border-mc-border flex items-center justify-between text-xs font-mono">
          <span className="text-mc-text truncate">{composerFile.name} ({(composerFile.size / 1024).toFixed(1)} KB)</span>
          <button
            onClick={() => setComposerFile(chatJid, null)}
            className="p-1 text-mc-textMuted hover:text-mc-danger"
          >
            <X size={13} />
          </button>
        </div>
      )}

      <form onSubmit={handleTriggerSend} className="flex items-end gap-2">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.[0]) {
              setComposerFile(chatJid, e.target.files[0]);
            }
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="p-2 rounded text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceHover transition-colors"
          title="Attach file or media"
        >
          <Paperclip size={16} />
        </button>

        <div className="flex-1 min-h-[38px] relative">
          {/* The draft flips as it is typed, so composing in Hebrew looks the
              way it will read once sent — and the caret sits at the right edge
              instead of the left. The placeholder is English either way, so it
              only flips once there is a draft to flip for. */}
          <textarea
            ref={textareaRef}
            value={composerDraft}
            onChange={(e) => setComposerDraft(chatJid, e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            dir={detectTextDirection(composerDraft)}
            placeholder={`Message ${selectedChat.name}... (Press Enter to send)`}
            className="w-full bg-mc-bg border border-mc-border rounded p-2 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live resize-none font-sans max-h-32 text-start"
          />
        </div>

        {/* Send Later Button */}
        <button
          type="button"
          disabled={!hasContent}
          onClick={handleTriggerSendLater}
          className={`p-2 rounded font-mono text-xs flex items-center justify-center gap-1 transition-all ${
            !hasContent
              ? 'text-mc-textMuted/40 hover:text-mc-textMuted/40 cursor-not-allowed'
              : 'text-mc-textMuted hover:text-mc-live hover:bg-mc-surfaceHover border border-mc-border'
          }`}
          title="Schedule message for later dispatch"
        >
          <Clock size={15} />
          <span className="hidden lg:inline text-[11px]">LATER</span>
        </button>

        <button
          type="submit"
          disabled={!hasContent}
          className={`p-2 rounded font-mono text-xs flex items-center justify-center gap-1.5 transition-all ${
            !hasContent
              ? 'bg-mc-surfaceHover text-mc-textMuted/50 cursor-not-allowed'
              : 'bg-mc-live text-[#12151B] font-bold hover:bg-mc-live/90 shadow-sm'
          }`}
          title={
            !hasContent
              ? 'Type a message or select an attachment to send'
              : 'Send message (opens confirmation)'
          }
        >
          <Send size={14} />
          <span className="font-bold hidden md:inline">SEND</span>
        </button>
      </form>
    </div>
  );
};
