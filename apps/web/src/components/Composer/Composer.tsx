import React, { useRef, useEffect, useLayoutEffect, useState, useId } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, Paperclip, X, Unlock, ShieldAlert, Clock, MessageSquareText } from 'lucide-react';
import { api } from '../../api/client.ts';
import {
  insertTemplate,
  matchTemplates,
  templateOptionId,
  templateQuery,
} from '../../lib/templatePicker.ts';
import { TemplatePicker } from './TemplatePicker.tsx';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { useUiCommand } from '../../hooks/useUiCommand.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { QuickReplyTemplate, UnifiedMessage } from '../../types.ts';

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
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const { isReadOnly, setSafeMode, isSettingMode } = useSafeMode();

  // Quick replies. Each of these names the chat it applies to, so switching
  // chats closes the picker without an effect to reset it.
  const queryClient = useQueryClient();
  const pickerId = useId();
  const [hasFocus, setHasFocus] = useState(false);
  /** The chat whose picker the button opened, with no `/` typed. */
  const [pickerForcedFor, setPickerForcedFor] = useState<string | null>(null);
  /** The chat whose `/` search was closed with Esc, until the slash goes. */
  const [pickerDismissedFor, setPickerDismissedFor] = useState<string | null>(null);
  const [pickerIndex, setPickerIndex] = useState(0);
  /** Where the caret goes once an inserted template has rendered. */
  const pendingCaret = useRef<number | null>(null);

  const templatesQuery = useQuery({
    queryKey: ['templates'],
    queryFn: () => api.getTemplates(),
    enabled: Boolean(selectedChat) && !isReadOnly,
    staleTime: 60_000,
  });
  const templates = templatesQuery.data ?? [];

  const slashQuery = templateQuery(composerDraft);
  const pickerOpen =
    hasFocus &&
    !isReadOnly &&
    (pickerForcedFor === chatJid || (slashQuery !== null && pickerDismissedFor !== chatJid));
  const pickerMatches = pickerOpen ? matchTemplates(templates, slashQuery ?? '') : [];
  const activeIndex = Math.min(pickerIndex, Math.max(0, pickerMatches.length - 1));

  const closePicker = () => {
    setPickerForcedFor(null);
    if (slashQuery !== null) setPickerDismissedFor(chatJid);
  };

  const pickTemplate = (template: QuickReplyTemplate) => {
    const caret = textareaRef.current?.selectionStart ?? composerDraft.length;
    const next = insertTemplate(composerDraft, template.body, caret, slashQuery !== null);
    setComposerDraft(chatJid, next.draft);
    setPickerForcedFor(null);
    // A template that itself begins with a slash is text, not another search.
    setPickerDismissedFor(templateQuery(next.draft) !== null ? chatJid : null);
    setPickerIndex(0);
    pendingCaret.current = next.caret;
    // Only reorders the picker; a failure here costs nothing worth showing.
    api
      .markTemplateUsed(template.id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['templates'] }))
      .catch(() => {});
  };

  // The box grows with the draft, up to its max-h-32, and scrolls from there.
  // Held at one row, a multi-line draft sat in a one-line box that showed a
  // single line of it at a time.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Not laid out (hidden, or a test's DOM): leave it to its one row.
    if (!el.scrollHeight) {
      el.style.height = '';
      return;
    }
    // scrollHeight leaves out the border, which the box's height includes.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [composerDraft, chatJid, isReadOnly]);

  // After a template goes in, the caret sits at its end rather than wherever
  // the browser leaves it when the value is replaced.
  useLayoutEffect(() => {
    const caret = pendingCaret.current;
    if (caret === null) return;
    pendingCaret.current = null;
    textareaRef.current?.setSelectionRange(caret, caret);
  }, [composerDraft]);

  // Whether the textarea has focus, for showing the picker only while typing.
  // Native listeners, not onFocus/onBlur: a dialog closing hands focus back
  // from its layout-effect cleanup, which React runs mid-commit with its own
  // event system switched off, so onFocus never heard the composer get focus
  // back and the picker stayed hidden. Declared ahead of the effects below
  // that focus the textarea, so the listeners are there to see it.
  const hasTextarea = Boolean(selectedChat) && !isReadOnly;
  useEffect(() => {
    const el = textareaRef.current;
    if (!hasTextarea || !el) return;
    const onFocus = () => setHasFocus(true);
    const onBlur = () => {
      setHasFocus(false);
      setPickerForcedFor(null);
    };
    el.addEventListener('focus', onFocus);
    el.addEventListener('blur', onBlur);
    if (document.activeElement === el) onFocus();
    return () => {
      el.removeEventListener('focus', onFocus);
      el.removeEventListener('blur', onBlur);
    };
  }, [hasTextarea]);

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
      <div className="border-t border-mc-safe/30 bg-mc-safe/5 p-3 shrink-0">
        <div className="flex items-center justify-between gap-3 text-xs font-mono">
          <div className="flex items-center gap-2 min-w-0 text-mc-safe">
            <ShieldAlert size={14} className="shrink-0" />
            <span className="truncate">
              Safe read-only mode — unlock live sends to compose messages.
            </span>
          </div>
          <button
            type="button"
            onClick={() => void setSafeMode(false)}
            disabled={isSettingMode}
            className="shrink-0 flex items-center gap-1.5 bg-mc-safe/20 hover:bg-mc-safe/30 text-mc-safe border border-mc-safe/50 hover:border-mc-safe px-2.5 py-1.5 rounded text-[11px] font-semibold transition-all"
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
    // The picker has the keys while it is open. With nothing to pick, Enter
    // falls through to an ordinary send of what was typed.
    if (pickerOpen) {
      const count = pickerMatches.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count > 0) {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : -1;
        setPickerIndex((activeIndex + step + count) % count);
        return;
      }
      const plainEnter = e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey;
      if ((plainEnter || e.key === 'Tab') && count > 0) {
        e.preventDefault();
        pickTemplate(pickerMatches[activeIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closePicker();
        return;
      }
    }

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

  /** One attachment per message, as the paperclip has it: a new one replaces it. */
  const attach = (file: File | undefined) => {
    if (!file) return;
    setComposerFile(chatJid, file);
    textareaRef.current?.focus();
  };

  // A screenshot on the clipboard, or a file from the desktop: the same
  // attachment the paperclip makes, without the file picker.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const file = e.clipboardData.files[0];
    // Text wins when there is any. Cells copied from a spreadsheet come with a
    // picture of themselves, and attaching that is not what the paste meant.
    if (!file || e.clipboardData.getData('text/plain')) return;
    e.preventDefault();
    attach(file);
  };

  /** Files being dragged in, as opposed to text being dragged about the page. */
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleDragOver = (e: React.DragEvent<HTMLElement>) => {
    if (!carriesFiles(e)) return;
    // Without this the browser refuses the drop, or opens the file itself.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDraggingFile(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLElement>) => {
    // Crossing into one of the composer's own children is not leaving it.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDraggingFile(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    setIsDraggingFile(false);
    attach(e.dataTransfer.files[0]);
  };

  return (
    <section
      aria-label="Message composer"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative border-t border-mc-border bg-mc-surface p-3 shrink-0 ${
        isDraggingFile ? 'ring-2 ring-inset ring-mc-accent' : ''
      }`}
    >
      {isDraggingFile && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-mc-surface/90 text-xs font-mono font-bold text-mc-accent pointer-events-none">
          DROP TO ATTACH
        </div>
      )}
      {/* Reply-to Bar */}
      {replyingTo && (
        <div className="mb-2 p-2 rounded bg-mc-bg border-l-2 border-mc-accent flex items-center justify-between text-xs font-mono">
          <div className="min-w-0 truncate">
            <span className="text-mc-accent font-semibold">Replying to {replyingTo.senderName || replyingTo.senderJid}:</span>{' '}
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

        {/* Kept from taking focus, so a template lands at the caret the
            operator left in the draft rather than at its start. */}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setPickerForcedFor(pickerOpen ? null : chatJid);
            setPickerIndex(0);
            textareaRef.current?.focus();
          }}
          aria-expanded={pickerOpen}
          className={`p-2 rounded hover:bg-mc-surfaceHover transition-colors ${
            pickerOpen ? 'text-mc-accent' : 'text-mc-textMuted hover:text-mc-text'
          }`}
          title="Quick replies (or type / to start a message)"
        >
          <MessageSquareText size={16} />
        </button>

        <div className="flex-1 min-h-[38px] relative">
          {pickerOpen && (
            <TemplatePicker
              id={pickerId}
              matches={pickerMatches}
              activeIndex={activeIndex}
              query={slashQuery ?? ''}
              hasTemplates={templates.length > 0}
              isLoading={templatesQuery.isLoading}
              isError={templatesQuery.isError}
              onPick={pickTemplate}
              onHover={setPickerIndex}
              onManage={() => {
                setPickerForcedFor(null);
                setActiveModal('templates');
              }}
            />
          )}
          {/* The draft flips as it is typed, so composing in Hebrew looks the
              way it will read once sent — and the caret sits at the right edge
              instead of the left. The placeholder is English either way, so it
              only flips once there is a draft to flip for. */}
          <textarea
            ref={textareaRef}
            value={composerDraft}
            onChange={(e) => {
              setComposerDraft(chatJid, e.target.value);
              setPickerIndex(0);
              setPickerForcedFor(null);
              // Esc closed this search; deleting the slash is what ends it.
              if (templateQuery(e.target.value) === null) setPickerDismissedFor(null);
            }}
            aria-autocomplete="list"
            aria-controls={pickerOpen && pickerMatches.length > 0 ? pickerId : undefined}
            aria-activedescendant={
              pickerOpen && pickerMatches.length > 0 ? templateOptionId(pickerId, activeIndex) : undefined
            }
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            dir={detectTextDirection(composerDraft)}
            placeholder={`Message ${selectedChat.name}... (Press Enter to send)`}
            className="w-full bg-mc-bg border border-mc-border rounded p-2 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-accent resize-none font-sans max-h-32 text-start"
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
              : 'text-mc-textMuted hover:text-mc-accent hover:bg-mc-surfaceHover border border-mc-border'
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
              : 'bg-mc-live text-mc-onLive font-bold hover:bg-mc-live/90 shadow-sm'
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
    </section>
  );
};
