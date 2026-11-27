import React, { useCallback, useState } from 'react';
import { Reply, Smile, Check, CheckCheck, Clock, Copy, Star, Bookmark, Forward, Pencil, Trash2 } from 'lucide-react';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { fullTimestamp } from '../../lib/messageDates.ts';
import { MediaViewer } from './MediaViewer.tsx';
import { EmojiReactionDrawer } from './EmojiReactionDrawer.tsx';
import { ReactionSummary } from './ReactionSummary.tsx';
import { QuoteChip } from './QuoteChip.tsx';
import { LinkifiedText } from './LinkifiedText.tsx';
import { deliveryTitle } from '../../lib/deliveryStatus.ts';
import { canDeleteForMe, canEdit, canForward, type MessageActionKind } from '../../lib/messageActions.ts';
import type { UnifiedMessage } from '../../types.ts';
import type { ThreadReaction } from '../../lib/reactionFold.ts';

export type { ThreadReaction };

interface MessageRowProps {
  msg: UnifiedMessage;
  /** Folded reactions to this message; the same array while nothing changes. */
  reactions: ThreadReaction[];
  /** The message this one quotes, when the thread has it loaded. */
  quoted: UnifiedMessage | null;
  isGroup: boolean;
  /** The chat to fetch this message's media from. */
  mediaChatJid: string;
  isFocused: boolean;
  isCopied: boolean;
  isReactionDrawerOpen: boolean;
  onReply: (msg: UnifiedMessage) => void;
  onCopy: (msg: UnifiedMessage) => void;
  onToggleBookmark: (msg: UnifiedMessage) => void;
  onToggleReactionDrawer: (msgId: string) => void;
  onCloseReactionDrawer: () => void;
  onReact: (msg: UnifiedMessage, emoji: string) => void;
  onJumpToMessage: (msgId: string, at: string) => void;
  /** Opens the edit, delete or forward dialog for this message. */
  onMessageAction: (msg: UnifiedMessage, kind: MessageActionKind) => void;
}

/**
 * One message in the thread.
 *
 * Memoised, with props that stay the same while the message does, so a thread
 * of hundreds of bubbles is not redrawn whole for something that concerns none
 * of them: a health poll, a typing indicator, a fetch starting or ending.
 */
export const MessageRow = React.memo<MessageRowProps>(function MessageRow({
  msg,
  reactions,
  quoted,
  isGroup,
  mediaChatJid,
  isFocused,
  isCopied,
  isReactionDrawerOpen,
  onReply,
  onCopy,
  onToggleBookmark,
  onToggleReactionDrawer,
  onCloseReactionDrawer,
  onReact,
  onJumpToMessage,
  onMessageAction,
}) {
  const isMe = msg.fromMe;
  // Still on its way out, under a local id WhatsApp has never seen: a reply,
  // reaction or bookmark aimed at it would point at nothing.
  const isPending = msg.deliveryStatus === 'pending';

  // Who reacted: only this row cares, so the state lives here.
  const [whoReactedOpen, setWhoReactedOpen] = useState(false);
  const toggleWhoReacted = useCallback(() => setWhoReactedOpen((open) => !open), []);
  const closeWhoReacted = useCallback(() => setWhoReactedOpen(false), []);
  // Either popover has to clear the bubbles below it.
  const raised = isReactionDrawerOpen || whoReactedOpen;

  return (
    <div
      className={`group flex flex-col ${isMe ? 'items-end' : 'items-start'} ${
        raised ? 'relative z-40' : 'relative z-0'
      }`}
    >
      {/* Sender Name in group */}
      {!isMe && msg.senderName && isGroup && (
        <span className="text-[11px] text-mc-textMuted font-mono px-1 mb-0.5">
          {msg.senderName}
        </span>
      )}

      {/* Bubble */}
      <div
        id={`msg-${msg.msgId}`}
        className={`relative max-w-[80%] rounded-mc p-2.5 text-xs shadow-sm transition-all duration-300 ${
          raised ? 'z-40' : 'z-0'
        } ${
          isFocused
            ? 'ring-2 ring-mc-accent ring-offset-2 ring-offset-mc-bg shadow-[0_0_20px_rgb(var(--mc-accent)/0.7)] bg-mc-accent/20 border-mc-accent animate-pulse'
            : isMe
            ? 'bg-mc-accent/10 border border-mc-accent/30 text-mc-text'
            : 'bg-mc-surface border border-mc-border text-mc-text'
        }`}
      >
        {/* What this replies to. A deleted reply keeps no context worth showing. */}
        {msg.quotedMsgId && !msg.revoked && (
          <QuoteChip
            quotedMsgId={msg.quotedMsgId}
            quoted={quoted}
            quotedText={msg.quotedText ?? null}
            chatJid={mediaChatJid}
            onJump={onJumpToMessage}
          />
        )}

        {/* Media Content (Image/Audio/Video/Document) */}
        {msg.mediaType && (
          // The message's own chat, not the selected one. While a
          // chat switch is in flight `keepPreviousData` keeps the
          // previous thread on screen, and pairing those messages
          // with the newly selected JID asked wacli to download
          // media for a chat the message is not in — a guaranteed
          // 404, and a doomed subprocess for every attachment.
          <MediaViewer msg={msg} chatJid={mediaChatJid} />
        )}

        {/* Body Text — selectable so operators can copy codes, addresses, numbers.
            `dir` is per message, not per chat: a thread mixes Hebrew and
            English freely, and it is the body that decides which edge it
            hangs from and where its punctuation lands. A revoked message
            shows our own English notice, so it stays left-to-right. */}
        {(msg.displayText || msg.text) && (
          <div
            dir={msg.revoked ? 'ltr' : detectTextDirection(msg.displayText || msg.text)}
            className="whitespace-pre-wrap break-words leading-relaxed select-text cursor-text text-start"
          >
            {msg.revoked ? (
              <span className="italic text-mc-textMuted">This message was deleted.</span>
            ) : (
              <LinkifiedText text={msg.displayText || msg.text} />
            )}
          </div>
        )}

        {/* Message Footer: Timestamp, Edited, Star Badge, Status */}
        <div className="flex items-center justify-end gap-1.5 mt-1 text-[10px] font-mono text-mc-textMuted">
          {msg.starred && (
            <span title="Starred in WhatsApp">
              <Star size={11} className="fill-mc-star text-mc-star" />
            </span>
          )}
          {msg.bookmarked && (
            <span title="Bookmarked in Mission Control (this machine only)">
              <Bookmark size={11} className="fill-mc-accent text-mc-accent" />
            </span>
          )}
          {msg.edited && <span className="italic">edited</span>}
          {/* The time alone, with the date a hover away: the day dividers say
              which day a run of bubbles belongs to. */}
          <time dateTime={msg.ts} title={fullTimestamp(msg.ts)}>
            {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time>
          {isMe && (
            <span title={deliveryTitle(msg, isGroup)}>
              {isPending ? (
                <Clock size={12} className="text-mc-textMuted" />
              ) : msg.deliveryStatus === 'read' || msg.deliveryStatus === 'played' ? (
                <CheckCheck size={12} className="text-mc-live" />
              ) : msg.deliveryStatus === 'delivered' ? (
                <CheckCheck size={12} className="text-mc-textMuted" />
              ) : (
                <Check size={12} className="text-mc-textMuted" />
              )}
            </span>
          )}
        </div>

        {/* Reactions Badge */}
        {reactions.length > 0 && (
          <ReactionSummary
            reactions={reactions}
            open={whoReactedOpen}
            onToggle={toggleWhoReacted}
            onClose={closeWhoReacted}
            align={isMe ? 'right' : 'left'}
          />
        )}

        {/* Hover Quick Actions Menu (FR-SR-7) */}
        {!isPending && (
          <div className="absolute -top-3.5 right-2 hidden group-hover:flex items-center gap-0.5 bg-mc-surface/95 backdrop-blur-sm border border-mc-border rounded px-1 py-0.5 shadow-md z-20">
            {/* Reply */}
            <button
              onClick={() => onReply(msg)}
              className="p-1 hover:text-mc-accent text-mc-textMuted hover:bg-mc-surfaceHover rounded transition-colors"
              title="Reply"
            >
              <Reply size={12} />
            </button>

            {/* Copy Text to Clipboard */}
            <button
              onClick={() => onCopy(msg)}
              className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                isCopied ? 'text-mc-accent' : 'text-mc-textMuted hover:text-mc-text'
              }`}
              title={isCopied ? 'Copied to clipboard!' : 'Copy message text'}
            >
              {isCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>

            {/* Local bookmark. Named for what it is: wacli cannot write
                WhatsApp's star, so this never leaves this machine. */}
            <button
              onClick={() => onToggleBookmark(msg)}
              className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                msg.bookmarked ? 'text-mc-accent' : 'text-mc-textMuted hover:text-mc-accent'
              }`}
              title={
                msg.bookmarked
                  ? 'Remove local bookmark'
                  : 'Bookmark locally (not synced to WhatsApp)'
              }
            >
              <Bookmark size={12} className={msg.bookmarked ? 'fill-mc-accent' : ''} />
            </button>

            {/* Expanded Emoji Reaction Drawer */}
            <button
              onClick={() => onToggleReactionDrawer(msg.msgId)}
              className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                isReactionDrawerOpen
                  ? 'text-mc-accent'
                  : 'text-mc-textMuted hover:text-mc-accent'
              }`}
              title="React with emoji"
            >
              <Smile size={12} />
            </button>

            {/* Changes that reach other phones. Offered only where WhatsApp
                would take them; the dialog is the read-back step. */}
            {canForward(msg) && (
              <button
                onClick={() => onMessageAction(msg, 'forward')}
                className="p-1 text-mc-textMuted hover:text-mc-accent hover:bg-mc-surfaceHover rounded transition-colors"
                title="Forward"
              >
                <Forward size={12} />
              </button>
            )}
            {canEdit(msg) && (
              <button
                onClick={() => onMessageAction(msg, 'edit')}
                className="p-1 text-mc-textMuted hover:text-mc-accent hover:bg-mc-surfaceHover rounded transition-colors"
                title="Edit (within 20 minutes of sending)"
              >
                <Pencil size={12} />
              </button>
            )}
            {canDeleteForMe(msg) && (
              <button
                onClick={() => onMessageAction(msg, 'delete')}
                className="p-1 text-mc-textMuted hover:text-mc-danger hover:bg-mc-surfaceHover rounded transition-colors"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}

        {/* Expanded Emoji Drawer Popover */}
        {isReactionDrawerOpen && (
          <EmojiReactionDrawer
            align={isMe ? 'right' : 'left'}
            onSelectEmoji={(emoji) => onReact(msg, emoji)}
            onClose={onCloseReactionDrawer}
          />
        )}
      </div>
    </div>
  );
});
