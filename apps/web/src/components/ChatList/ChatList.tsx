import React, { useMemo, useEffect, useCallback } from 'react';
import { MessageSquare, Search, Pin, VolumeX, Archive, Plus, AlertOctagon, AlertTriangle } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '../../api/client.ts';
import { chatWithUnreadCleared, markChatAsRead } from '../../lib/chatRead.ts';
import { wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

interface ChatListProps {
  width?: number;
}

export const ChatList: React.FC<ChatListProps> = ({ width = 320 }) => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const chatFilter = useAppStore((s) => s.chatFilter);
  const setChatFilter = useAppStore((s) => s.setChatFilter);
  const presenceMap = useAppStore((s) => s.presenceMap);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  const readsReady = isWacliReadyForReads(health);
  const readQueryOpts = wacliReadQueryOptions<UnifiedChat[]>(readsReady);

  const { data: chats = [], isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['chats', searchQuery, chatFilter],
    queryFn: () =>
      api.getChats({
        query: searchQuery || undefined,
        limit: 100,
        unread: chatFilter === 'unread' ? true : undefined,
        pinned: chatFilter === 'pinned' ? true : undefined,
        archived: chatFilter === 'archived' ? true : chatFilter === 'all' ? false : undefined,
        muted: chatFilter === 'muted' ? true : undefined,
      }),
    refetchInterval: 10000,
    ...readQueryOpts,
  });

  const filteredChats = useMemo(() => {
    return chats.filter((c) => {
      if (chatFilter === 'all') return !c.archived;
      if (chatFilter === 'unread') return c.unread || c.unreadCount > 0;
      if (chatFilter === 'pinned') return c.pinned;
      if (chatFilter === 'archived') return c.archived;
      if (chatFilter === 'muted') return c.mutedUntil > 0;
      return true;
    });
  }, [chats, chatFilter]);

  const handleSelectChat = useCallback((chat: UnifiedChat) => {
    const chatToSelect = chatWithUnreadCleared(chat);
    setSelectedChat(chatToSelect);
    if (chat.unread || chat.unreadCount > 0) {
      void markChatAsRead(queryClient, chat.jid);
    }
    try {
      localStorage.setItem('wacli_selected_chat', chat.jid);
    } catch {
      // ignore
    }
  }, [queryClient, setSelectedChat]);

  // Auto-select chat when opening the app if none selected
  useEffect(() => {
    if (!selectedChat && filteredChats.length > 0) {
      const savedJid = localStorage.getItem('wacli_selected_chat');
      const found = filteredChats.find((c) => c.jid === savedJid) || filteredChats[0];
      handleSelectChat(found);
    }
  }, [filteredChats, selectedChat, handleSelectChat]);

  const formatTimestamp = (ts: string | null) => {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <aside
      aria-label="Chats sidebar"
      style={{ width }}
      className="shrink-0 bg-mc-surface flex flex-col h-full select-none"
    >
      {/* Header & Search */}
      <div className="p-3 border-b border-mc-border space-y-2.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessageSquare size={16} className="text-mc-live" />
            <h1 className="font-semibold text-mc-text tracking-wide text-sm">CHATS</h1>
          </div>
          <button
            onClick={() => setActiveModal('new-chat')}
            className="flex items-center gap-1 text-xs font-mono text-mc-live hover:bg-mc-surfaceHover px-2 py-1 rounded border border-mc-border hover:border-mc-live/50 transition-all"
            title="Start new message"
          >
            <Plus size={13} />
            <span>NEW</span>
          </button>
        </div>

        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-2.5 text-mc-textMuted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats or contacts..."
            className="w-full bg-mc-bg border border-mc-border rounded pl-8 pr-3 py-1.5 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live font-sans"
          />
        </div>

        {/* Filters */}
        <div className="flex gap-1 overflow-x-auto text-[11px] font-mono no-scrollbar">
          {(['all', 'unread', 'pinned', 'muted', 'archived'] as const).map((filter) => (
            <button
              key={filter}
              onClick={() => setChatFilter(filter)}
              className={`px-2 py-0.5 rounded capitalize transition-colors ${
                chatFilter === filter
                  ? 'bg-mc-live/15 text-mc-live border border-mc-live/40 font-semibold'
                  : 'text-mc-textMuted hover:text-mc-text border border-transparent hover:bg-mc-surfaceHover'
              }`}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto divide-y divide-mc-border/40">
        {isLoading || (isFetching && chats.length === 0 && !readsReady) ? (
          <div className="p-6 text-center text-xs font-mono text-mc-textMuted">
            {readsReady ? 'Loading chats...' : 'Waiting for sync daemon...'}
          </div>
        ) : health?.wacliInstalled === false ? (
          <div className="p-6 text-center space-y-3 font-mono">
            <div className="w-9 h-9 rounded-full bg-mc-danger/10 border border-mc-danger/30 text-mc-danger flex items-center justify-center mx-auto">
              <AlertOctagon size={18} />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-mc-danger">wacli Not Installed</div>
              <div className="text-[11px] text-mc-textMuted font-sans">
                Install the wacli CLI to sync and view your WhatsApp chats.
              </div>
            </div>
          </div>
        ) : health?.statusSummary === 'not_authenticated' || (health?.doctor && !health.doctor.authenticated) ? (
          <div className="p-6 text-center space-y-3 font-mono">
            <div className="w-9 h-9 rounded-full bg-mc-safe/10 border border-mc-safe/30 text-mc-safe flex items-center justify-center mx-auto">
              <AlertTriangle size={18} />
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-mc-safe">Pairing Required</div>
              <div className="text-[11px] text-mc-textMuted font-sans">
                Run <code className="text-mc-live font-mono font-semibold">wacli auth</code> in your terminal to pair your WhatsApp account.
              </div>
            </div>
          </div>
        ) : filteredChats.length === 0 ? (
          <div className="p-6 text-center text-xs text-mc-textMuted font-sans">
            {isError
              ? error instanceof ApiClientError && error.code === 'STORE_LOCKED'
                ? 'Store is temporarily locked. Retrying...'
                : 'Unable to load chats. Check CLI connection.'
              : 'No chats found.'}
          </div>
        ) : (
          filteredChats.map((chat: UnifiedChat) => {
            const isSelected = selectedChat?.jid === chat.jid;
            const presence = presenceMap[chat.jid];
            const isTyping = presence && presence.state === 'composing';

            return (
              <button
                key={chat.jid}
                onClick={() => handleSelectChat(chat)}
                className={`w-full text-left p-3 flex items-start justify-between gap-2 transition-colors ${
                  isSelected
                    ? 'bg-mc-surfaceHover border-l-2 border-mc-live'
                    : 'hover:bg-mc-surfaceHover/60'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {chat.pinned && <Pin size={11} className="text-mc-safe shrink-0" />}
                    {chat.mutedUntil > 0 && <VolumeX size={11} className="text-mc-textMuted shrink-0" />}
                    {chat.archived && <Archive size={11} className="text-mc-textMuted shrink-0" />}
                    <span className="font-medium text-xs text-mc-text truncate">
                      {chat.name}
                    </span>
                  </div>

                  <div className="text-[11px] truncate">
                    {isTyping ? (
                      <span className="text-mc-live font-mono animate-pulse">typing...</span>
                    ) : (
                      <span className="text-mc-textMuted font-mono">{chat.jid.split('@')[0]}</span>
                    )}
                  </div>
                </div>

                <div className="flex flex-col items-end gap-1 shrink-0 font-mono text-[10px]">
                  <span className="text-mc-textMuted">
                    {formatTimestamp(chat.lastMessageTs)}
                  </span>
                  {chat.unreadCount > 0 && (
                    <span className="bg-mc-live text-[#12151B] font-bold px-1.5 py-0.2 rounded-full text-[10px] min-w-4 text-center">
                      {chat.unreadCount}
                    </span>
                  )}
                </div>
              </button>
            );
          })
        )}
      </div>
    </aside>
  );
};
