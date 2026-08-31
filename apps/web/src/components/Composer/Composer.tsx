import React, { useRef, useEffect } from 'react';
import { Send, Paperclip, X, Lock, Unlock, ShieldAlert } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';

export const Composer: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const replyingTo = useAppStore((s) => s.replyingTo);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setSendConfirmData = useAppStore((s) => s.setSendConfirmData);
  const composerDraft = useAppStore((s) => s.composerDraft);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const composerFile = useAppStore((s) => s.composerFile);
  const setComposerFile = useAppStore((s) => s.setComposerFile);
  const focusComposerTrigger = useAppStore((s) => s.focusComposerTrigger);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: modeData } = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.getMode(),
  });

  const modeMutation = useMutation({
    mutationFn: (newReadOnly: boolean) => api.setMode(newReadOnly),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const isReadOnly = modeData?.readOnly ?? true;

  // Auto-focus composer when selected chat changes or when trigger is fired
  useEffect(() => {
    if (selectedChat && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [selectedChat?.jid, focusComposerTrigger]);

  if (!selectedChat) {
    return null;
  }

  const handleTriggerSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!composerDraft.trim() && !composerFile) {
      return;
    }

    setSendConfirmData({
      toJid: selectedChat.jid,
      recipientName: selectedChat.name,
      messageText: composerDraft.trim(),
      replyToId: replyingTo?.msgId,
      fileAttachment: composerFile ?? undefined,
    });
    setActiveModal('send-confirm');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTriggerSend(e);
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
            <span className="text-mc-textMuted truncate">{replyingTo.displayText || replyingTo.text}</span>
          </div>
          <button
            onClick={() => setReplyingTo(null)}
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
            onClick={() => setComposerFile(null)}
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
              setComposerFile(e.target.files[0]);
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
          <textarea
            ref={textareaRef}
            value={composerDraft}
            onChange={(e) => setComposerDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={`Message ${selectedChat.name}... (Press Enter to send)`}
            className="w-full bg-mc-bg border border-mc-border rounded p-2 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live resize-none font-sans max-h-32"
          />
        </div>

        {/* Quick Mode Unlock / Lock Indicator Button */}
        {isReadOnly ? (
          <button
            type="button"
            onClick={() => modeMutation.mutate(false)}
            className="p-2 rounded font-mono text-[11px] bg-[#E8B96A]/15 hover:bg-[#E8B96A]/25 text-mc-safe border border-mc-safe/40 flex items-center gap-1 transition-colors"
            title="Safe read-only mode is active. Click to unlock live sends."
          >
            <Unlock size={14} />
            <span className="hidden sm:inline font-semibold">SAFE</span>
          </button>
        ) : null}

        <button
          type="submit"
          disabled={!hasContent}
          className={`p-2 rounded font-mono text-xs flex items-center justify-center gap-1.5 transition-all ${
            !hasContent
              ? 'bg-mc-surfaceHover text-mc-textMuted/50 cursor-not-allowed'
              : isReadOnly
              ? 'bg-[#E8B96A] text-[#12151B] font-bold hover:bg-[#E8B96A]/90 shadow-sm'
              : 'bg-mc-live text-[#12151B] font-bold hover:bg-mc-live/90 shadow-sm'
          }`}
          title={
            !hasContent
              ? 'Type a message or select an attachment to send'
              : isReadOnly
              ? 'Send message (will prompt to confirm & unlock)'
              : 'Send message (opens confirmation)'
          }
        >
          {isReadOnly && hasContent ? <ShieldAlert size={14} /> : <Send size={14} />}
          <span className="font-bold hidden md:inline">SEND</span>
        </button>
      </form>
    </div>
  );
};
