import React, { useMemo, useRef, useEffect, useState } from 'react';
import {
  Reply,
  Smile,
  Check,
  CheckCheck,
  Copy,
  Star,
  Clock,
  Trash2,
  AlertOctagon,
  AlertTriangle,
  Terminal,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import { MediaViewer } from './MediaViewer.tsx';
import { EmojiReactionDrawer } from './EmojiReactionDrawer.tsx';
import type { UnifiedMessage } from '../../types.ts';

export const ThreadView: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const presenceMap = useAppStore((s) => s.presenceMap);
  const highlightedMessageId = useAppStore((s) => s.highlightedMessageId);
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeReactionMsgId, setActiveReactionMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  const {
    data: messagesData,
    isLoading,
  } = useQuery({
    queryKey: ['messages', selectedChat?.jid],
    queryFn: () =>
      selectedChat
        ? api.getMessages({ chat: selectedChat.jid, limit: 200 })
        : Promise.resolve({ messages: [], hasMore: false }),
    enabled: Boolean(selectedChat?.jid),
    refetchInterval: 5000,
  });

  // Scheduled messages for current chat
  const { data: scheduledList = [] } = useQuery({
    queryKey: ['scheduled', selectedChat?.jid],
    queryFn: () => (selectedChat ? api.getScheduled({ chat: selectedChat.jid }) : []),
    enabled: Boolean(selectedChat?.jid),
    refetchInterval: 5000,
  });

  const pendingScheduled = scheduledList.filter((s) => s.status === 'pending');

  const cancelScheduledMutation = useMutation({
    mutationFn: (id: string) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  // Star / Unstar mutation
  const starMutation = useMutation({
    mutationFn: (params: { chat: string; id: string; starred: boolean }) =>
      api.starMessage(params),
    onMutate: async ({ chat, id, starred }) => {
      await queryClient.cancelQueries({ queryKey: ['messages', chat] });
      const prev = queryClient.getQueryData<{ messages: UnifiedMessage[]; hasMore: boolean }>([
        'messages',
        chat,
      ]);
      if (prev) {
        queryClient.setQueryData<{ messages: UnifiedMessage[]; hasMore: boolean }>(
          ['messages', chat],
          {
            ...prev,
            messages: prev.messages.map((m) => (m.msgId === id ? { ...m, starred } : m)),
          }
        );
      }
      return { prev };
    },
    onError: (_err, { chat }, context) => {
      if (context?.prev) {
        queryClient.setQueryData(['messages', chat], context.prev);
      }
    },
  });

  // Reaction folding: map reactions onto target messages
  const { messages, reactionsMap } = useMemo(() => {
    const rawMessages = messagesData?.messages ?? [];
    const rxMap = new Map<string, Array<{ emoji: string; fromMe: boolean; sender: string }>>();
    const visibleMsgs: UnifiedMessage[] = [];

    for (const msg of rawMessages) {
      if (msg.reactionToId) {
        if (msg.reactionEmoji) {
          const existing = rxMap.get(msg.reactionToId) || [];
          existing.push({
            emoji: msg.reactionEmoji,
            fromMe: msg.fromMe,
            sender: msg.senderName || msg.senderJid,
          });
          rxMap.set(msg.reactionToId, existing);
        }
      } else {
        visibleMsgs.push(msg);
      }
    }

    // Sort chronologically ascending for display
    visibleMsgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return { messages: visibleMsgs, reactionsMap: rxMap };
  }, [messagesData?.messages]);

  // Auto-scroll to bottom on message load or new incoming (unless navigating to a specific highlighted msg)
  useEffect(() => {
    if (highlightedMessageId) {
      const el = document.getElementById(`msg-${highlightedMessageId}`);
      if (el) {
        const raf = requestAnimationFrame(() => {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
        const timer = setTimeout(() => {
          setHighlightedMessageId(null);
        }, 5000);
        return () => {
          cancelAnimationFrame(raf);
          clearTimeout(timer);
        };
      }
    } else if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [selectedChat?.jid, messages, highlightedMessageId, setHighlightedMessageId]);

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

  const handleCopyText = async (msg: UnifiedMessage) => {
    const content = msg.displayText || msg.text || msg.mediaCaption || '';
    if (!content) return;

    try {
      await navigator.clipboard.writeText(content);
      setCopiedMsgId(msg.msgId);
      setTimeout(() => setCopiedMsgId((prev) => (prev === msg.msgId ? null : prev)), 2000);
    } catch {
      // fallback
    }
  };

  const handleToggleStar = (msg: UnifiedMessage) => {
    if (!selectedChat) return;
    starMutation.mutate({
      chat: selectedChat.jid,
      id: msg.msgId,
      starred: !msg.starred,
    });
  };

  if (!selectedChat) {
    if (health?.wacliInstalled === false) {
      return (
        <section
          aria-label="Conversation Thread"
          className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-text select-none p-6"
        >
          <div className="text-center space-y-4 max-w-md">
            <div className="w-12 h-12 rounded-full bg-mc-danger/10 border border-mc-danger/40 text-mc-danger flex items-center justify-center mx-auto">
              <AlertOctagon size={24} />
            </div>
            <div className="space-y-1">
              <div className="font-mono text-xs tracking-widest uppercase text-mc-danger font-bold">
                wacli CLI Not Installed
              </div>
              <div className="text-sm font-semibold text-mc-text">
                Command-line tool required
              </div>
              <p className="text-xs text-mc-textMuted font-sans">
                Mission Control connects to WhatsApp through the <code className="text-mc-danger font-mono font-semibold">wacli</code> CLI. Please install it on your system to view and manage messages.
              </p>
            </div>
            <div className="bg-mc-surface border border-mc-border rounded p-3 text-left space-y-1.5 font-mono text-xs">
              <div className="text-[11px] text-mc-textMuted flex items-center gap-1">
                <Terminal size={12} /> Install command:
              </div>
              <code className="text-mc-live text-xs block select-all">
                brew install stevemcquaid/wacli/wacli
              </code>
            </div>
          </div>
        </section>
      );
    }

    if (health?.statusSummary === 'not_authenticated' || (health?.doctor && !health.doctor.authenticated)) {
      return (
        <section
          aria-label="Conversation Thread"
          className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-text select-none p-6"
        >
          <div className="text-center space-y-4 max-w-md">
            <div className="w-12 h-12 rounded-full bg-mc-safe/10 border border-mc-safe/40 text-mc-safe flex items-center justify-center mx-auto">
              <AlertTriangle size={24} />
            </div>
            <div className="space-y-1">
              <div className="font-mono text-xs tracking-widest uppercase text-mc-safe font-bold">
                WhatsApp Account Not Paired
              </div>
              <div className="text-sm font-semibold text-mc-text">
                Pair your device to get started
              </div>
              <p className="text-xs text-mc-textMuted font-sans">
                Run the authentication command in your terminal and scan the QR code with WhatsApp on your phone:
              </p>
            </div>
            <div className="bg-mc-surface border border-mc-border rounded p-3 text-left space-y-1.5 font-mono text-xs">
              <div className="text-[11px] text-mc-textMuted flex items-center gap-1">
                <Terminal size={12} /> Terminal command:
              </div>
              <code className="text-mc-live text-xs block select-all">
                wacli auth
              </code>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section
        aria-label="Conversation Thread"
        className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-textMuted select-none"
      >
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
    <section aria-label="Conversation Thread" className="flex-1 flex flex-col bg-mc-bg min-h-0 min-w-0 relative overflow-hidden">
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

      {/* Scheduled Messages Banner for this chat (Send Later FR) */}
      {pendingScheduled.length > 0 && (
        <div className="bg-mc-surface border-b border-mc-border/80 px-3 py-2 flex items-center justify-between text-xs font-mono text-mc-text">
          <div className="flex items-center gap-2 truncate">
            <Clock size={14} className="text-mc-live shrink-0 animate-pulse" />
            <span className="text-mc-live font-semibold">SCHEDULED ({pendingScheduled.length}):</span>
            <span className="truncate text-mc-textMuted text-[11px]">
              {pendingScheduled[0].message || pendingScheduled[0].fileName} (due{' '}
              {new Date(pendingScheduled[0].scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
            </span>
          </div>
          <button
            onClick={() => cancelScheduledMutation.mutate(pendingScheduled[0].id)}
            className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors shrink-0 ml-2"
            title="Cancel scheduled message"
          >
            <Trash2 size={11} />
            <span>CANCEL</span>
          </button>
        </div>
      )}

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
            const isCopied = copiedMsgId === msg.msgId;

            return (
              <div
                key={msg.msgId}
                className={`group flex flex-col ${isMe ? 'items-end' : 'items-start'} ${
                  activeReactionMsgId === msg.msgId ? 'relative z-40' : 'relative z-0'
                }`}
              >
                {/* Sender Name in group */}
                {!isMe && msg.senderName && selectedChat.kind === 'group' && (
                  <span className="text-[11px] text-mc-textMuted font-mono px-1 mb-0.5">
                    {msg.senderName}
                  </span>
                )}

                {/* Bubble */}
                <div
                  id={`msg-${msg.msgId}`}
                  className={`relative max-w-[80%] rounded-mc p-2.5 text-xs shadow-sm transition-all duration-300 ${
                    activeReactionMsgId === msg.msgId ? 'z-40' : 'z-0'
                  } ${
                    highlightedMessageId === msg.msgId
                      ? 'ring-2 ring-mc-live ring-offset-2 ring-offset-mc-bg shadow-[0_0_20px_rgba(37,211,102,0.7)] bg-[#1e3d2f] border-mc-live animate-pulse'
                      : isMe
                      ? 'bg-[#1B2823] border border-mc-live/30 text-mc-text'
                      : 'bg-mc-surface border border-mc-border text-mc-text'
                  }`}
                >
                  {/* Media Content (Image/Audio/Video/Document) */}
                  {msg.mediaType && (
                    <MediaViewer msg={msg} chatJid={selectedChat.jid} />
                  )}

                  {/* Body Text */}
                  {(msg.displayText || msg.text) && (
                    <div className="whitespace-pre-wrap break-words leading-relaxed">
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
                      <span title="Starred message">
                        <Star size={11} className="fill-[#F5A623] text-[#F5A623]" />
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
                      onClick={() => setReplyingTo(msg)}
                      className="p-1 hover:text-mc-live text-mc-textMuted hover:bg-mc-surfaceHover rounded transition-colors"
                      title="Reply"
                    >
                      <Reply size={12} />
                    </button>

                    {/* Copy Text to Clipboard */}
                    <button
                      onClick={() => handleCopyText(msg)}
                      className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                        isCopied ? 'text-mc-live' : 'text-mc-textMuted hover:text-mc-text'
                      }`}
                      title={isCopied ? 'Copied to clipboard!' : 'Copy message text'}
                    >
                      {isCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>

                    {/* Star / Unstar Message */}
                    <button
                      onClick={() => handleToggleStar(msg)}
                      className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                        msg.starred ? 'text-[#F5A623]' : 'text-mc-textMuted hover:text-[#F5A623]'
                      }`}
                      title={msg.starred ? 'Unstar message' : 'Star message'}
                    >
                      <Star size={12} className={msg.starred ? 'fill-[#F5A623]' : ''} />
                    </button>

                    {/* Expanded Emoji Reaction Drawer */}
                    <button
                      onClick={() =>
                        setActiveReactionMsgId(
                          activeReactionMsgId === msg.msgId ? null : msg.msgId
                        )
                      }
                      className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                        activeReactionMsgId === msg.msgId
                          ? 'text-mc-live'
                          : 'text-mc-textMuted hover:text-mc-live'
                      }`}
                      title="React with emoji"
                    >
                      <Smile size={12} />
                    </button>
                  </div>

                  {/* Expanded Emoji Drawer Popover */}
                  {activeReactionMsgId === msg.msgId && (
                    <EmojiReactionDrawer
                      align={isMe ? 'right' : 'left'}
                      onSelectEmoji={(emoji) => handleReact(msg, emoji)}
                      onClose={() => setActiveReactionMsgId(null)}
                    />
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
