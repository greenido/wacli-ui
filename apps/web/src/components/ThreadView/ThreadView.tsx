import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Reply, Smile, Check, CheckCheck, FileText, Music, Image as ImageIcon, Video } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedMessage } from '../../types.ts';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export const ThreadView: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const presenceMap = useAppStore((s) => s.presenceMap);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeReactionMsgId, setActiveReactionMsgId] = useState<string | null>(null);

  const {
    data: messagesData,
    isLoading,
  } = useQuery({
    queryKey: ['messages', selectedChat?.jid],
    queryFn: () =>
      selectedChat
        ? api.getMessages({ chat: selectedChat.jid, limit: 100 })
        : Promise.resolve({ messages: [], hasMore: false }),
    enabled: Boolean(selectedChat?.jid),
    refetchInterval: 5000,
  });

  // Reaction folding: map reactions onto target messages
  const { messages, reactionsMap } = useMemo(() => {
    const rawMessages = messagesData?.messages ?? [];
    const rxMap = new Map<string, Array<{ emoji: string; fromMe: boolean; sender: string }>>();
    const visibleMsgs: UnifiedMessage[] = [];

    for (const msg of rawMessages) {
      if (msg.reactionToId && msg.reactionEmoji) {
        const existing = rxMap.get(msg.reactionToId) || [];
        existing.push({
          emoji: msg.reactionEmoji,
          fromMe: msg.fromMe,
          sender: msg.senderName || msg.senderJid,
        });
        rxMap.set(msg.reactionToId, existing);
      } else {
        visibleMsgs.push(msg);
      }
    }

    // Sort chronologically ascending for display
    visibleMsgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return { messages: visibleMsgs, reactionsMap: rxMap };
  }, [messagesData?.messages]);

  // Auto-scroll to bottom on message load or new incoming
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [selectedChat?.jid, messages.length]);

  const handleReact = async (msg: UnifiedMessage, emoji: string) => {
    setActiveReactionMsgId(null);
    try {
      await api.sendReact({
        to: selectedChat!.jid,
        id: msg.msgId,
        reaction: emoji,
        sender: msg.senderJid || undefined,
        confirm: true,
      });
    } catch {
      // ignore
    }
  };

  if (!selectedChat) {
    return (
      <section aria-label="Conversation Thread" className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-textMuted select-none">
        <div className="text-center space-y-2">
          <div className="font-mono text-xs tracking-widest uppercase">wacli Mission Control</div>
          <div className="text-sm">Select a chat from the rail to view messages.</div>
        </div>
      </section>
    );
  }

  const presence = presenceMap[selectedChat.jid];
  const isTyping = presence && presence.state === 'composing';

  return (
    <section aria-label="Conversation Thread" className="flex-1 flex flex-col bg-mc-bg h-full min-w-0">
      {/* Header */}
      <div className="h-14 border-b border-mc-border bg-mc-surface/80 backdrop-blur px-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm text-mc-text truncate">{selectedChat.name}</h2>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-mc-border/50 text-mc-textMuted">
              {selectedChat.kind}
            </span>
          </div>
          <div className="text-xs font-mono text-mc-textMuted truncate flex items-center gap-2">
            <span>{selectedChat.jid}</span>
            {isTyping && <span className="text-mc-live animate-pulse">● typing...</span>}
          </div>
        </div>
      </div>

      {/* Message List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="text-center py-12 text-xs font-mono text-mc-textMuted">
            Loading message history...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <div className="w-10 h-10 rounded-full bg-mc-surface flex items-center justify-center text-mc-live border border-mc-border">
              <Reply size={18} />
            </div>
            <div className="space-y-1">
              <div className="text-mc-text font-semibold text-xs">No message history yet</div>
              <div className="text-mc-textMuted text-[11px] max-w-xs">
                Start a conversation with <span className="text-mc-text font-mono font-semibold">{selectedChat.name}</span> by typing your message in the composer below.
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const reactions = reactionsMap.get(msg.msgId) || [];
            const isMe = msg.fromMe;

            return (
              <div
                key={msg.msgId}
                className={`group flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
              >
                {/* Sender Name in group */}
                {!isMe && msg.senderName && selectedChat.kind === 'group' && (
                  <span className="text-[11px] text-mc-textMuted font-mono px-1 mb-0.5">
                    {msg.senderName}
                  </span>
                )}

                {/* Bubble */}
                <div
                  className={`relative max-w-[80%] rounded-mc p-2.5 text-xs shadow-sm ${
                    isMe
                      ? 'bg-[#1B2823] border border-mc-live/30 text-mc-text'
                      : 'bg-mc-surface border border-mc-border text-mc-text'
                  }`}
                >
                  {/* Media Content */}
                  {msg.mediaType && (
                    <div className="mb-2 p-2 rounded bg-mc-bg/50 border border-mc-border/50 flex items-center gap-2 text-[11px] font-mono">
                      {msg.mediaType === 'image' && <ImageIcon size={15} className="text-mc-live" />}
                      {msg.mediaType === 'audio' && <Music size={15} className="text-mc-live" />}
                      {msg.mediaType === 'video' && <Video size={15} className="text-mc-live" />}
                      {msg.mediaType === 'document' && <FileText size={15} className="text-mc-live" />}
                      <span className="truncate">{msg.filename || `${msg.mediaType} attachment`}</span>
                    </div>
                  )}

                  {/* Body Text */}
                  <div className="whitespace-pre-wrap break-words leading-relaxed">
                    {msg.revoked ? (
                      <span className="italic text-mc-textMuted">This message was deleted.</span>
                    ) : (
                      msg.displayText || msg.text
                    )}
                  </div>

                  {/* Message Footer: Timestamp, Edited, Status */}
                  <div className="flex items-center justify-end gap-1 mt-1 text-[10px] font-mono text-mc-textMuted">
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

                  {/* Hover Actions Menu */}
                  <div className="absolute -top-3 right-2 hidden group-hover:flex items-center gap-1 bg-mc-surface border border-mc-border rounded px-1 py-0.5 shadow-md">
                    <button
                      onClick={() => setReplyingTo(msg)}
                      className="p-1 hover:text-mc-live text-mc-textMuted transition-colors"
                      title="Reply"
                    >
                      <Reply size={12} />
                    </button>
                    <button
                      onClick={() =>
                        setActiveReactionMsgId(
                          activeReactionMsgId === msg.msgId ? null : msg.msgId
                        )
                      }
                      className="p-1 hover:text-mc-live text-mc-textMuted transition-colors"
                      title="React"
                    >
                      <Smile size={12} />
                    </button>
                  </div>

                  {/* Quick Reaction Popup */}
                  {activeReactionMsgId === msg.msgId && (
                    <div className="absolute -top-9 right-2 flex gap-1 bg-mc-surface border border-mc-border rounded-full p-1 shadow-lg z-10">
                      {QUICK_EMOJIS.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => handleReact(msg, emoji)}
                          className="hover:scale-125 transition-transform px-1"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
