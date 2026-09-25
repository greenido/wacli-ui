import React from 'react';
import { Reply, Smile, Check, CheckCheck, Copy, Star, Bookmark } from 'lucide-react';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { MediaViewer } from './MediaViewer.tsx';
import { EmojiReactionDrawer } from './EmojiReactionDrawer.tsx';
import type { UnifiedMessage } from '../../types.ts';

export interface ThreadReaction {
  emoji: string;
  fromMe: boolean;
  sender: string;
}

interface MessageRowProps {
  msg: UnifiedMessage;
  /** Folded reactions to this message; the same array while nothing changes. */
  reactions: ThreadReaction[];
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
}) {
  const isMe = msg.fromMe;

  return (
    <div
      className={`group flex flex-col ${isMe ? 'items-end' : 'items-start'} ${
        isReactionDrawerOpen ? 'relative z-40' : 'relative z-0'
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
          isReactionDrawerOpen ? 'z-40' : 'z-0'
        } ${
          isFocused
            ? 'ring-2 ring-mc-live ring-offset-2 ring-offset-mc-bg shadow-[0_0_20px_rgba(37,211,102,0.7)] bg-[#1e3d2f] border-mc-live animate-pulse'
            : isMe
            ? 'bg-[#1B2823] border border-mc-live/30 text-mc-text'
            : 'bg-mc-surface border border-mc-border text-mc-text'
        }`}
      >
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
              msg.displayText || msg.text
            )}
          </div>
        )}

        {/* Message Footer: Timestamp, Edited, Star Badge, Status */}
        <div className="flex items-center justify-end gap-1.5 mt-1 text-[10px] font-mono text-mc-textMuted">
          {msg.starred && (
            <span title="Starred in WhatsApp">
              <Star size={11} className="fill-[#F5A623] text-[#F5A623]" />
            </span>
          )}
          {msg.bookmarked && (
            <span title="Bookmarked in Mission Control (this machine only)">
              <Bookmark size={11} className="fill-mc-live text-mc-live" />
            </span>
          )}
          {msg.edited && <span className="italic">edited</span>}
          <span>
            {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {isMe && (
            <span title={msg.deliveryStatus ?? 'sent'}>
              {msg.deliveryStatus === 'read' || msg.deliveryStatus === 'played' ? (
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
          <div className="absolute -bottom-2 right-2 flex gap-0.5 bg-mc-surface border border-mc-border rounded-full px-1.5 py-0.2 text-[11px] shadow-sm">
            {reactions.map((rx, i) => (
              <span key={i} title={rx.sender}>
                {rx.emoji}
              </span>
            ))}
          </div>
        )}

        {/* Hover Quick Actions Menu (FR-SR-7) */}
        <div className="absolute -top-3.5 right-2 hidden group-hover:flex items-center gap-0.5 bg-mc-surface/95 backdrop-blur-sm border border-mc-border rounded px-1 py-0.5 shadow-md z-20">
          {/* Reply */}
          <button
            onClick={() => onReply(msg)}
            className="p-1 hover:text-mc-live text-mc-textMuted hover:bg-mc-surfaceHover rounded transition-colors"
            title="Reply"
          >
            <Reply size={12} />
          </button>

          {/* Copy Text to Clipboard */}
          <button
            onClick={() => onCopy(msg)}
            className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
              isCopied ? 'text-mc-live' : 'text-mc-textMuted hover:text-mc-text'
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
              msg.bookmarked ? 'text-mc-live' : 'text-mc-textMuted hover:text-mc-live'
            }`}
            title={
              msg.bookmarked
                ? 'Remove local bookmark'
                : 'Bookmark locally (not synced to WhatsApp)'
            }
          >
            <Bookmark size={12} className={msg.bookmarked ? 'fill-mc-live' : ''} />
          </button>

          {/* Expanded Emoji Reaction Drawer */}
          <button
            onClick={() => onToggleReactionDrawer(msg.msgId)}
            className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
              isReactionDrawerOpen
                ? 'text-mc-live'
                : 'text-mc-textMuted hover:text-mc-live'
            }`}
            title="React with emoji"
          >
            <Smile size={12} />
          </button>
        </div>

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
