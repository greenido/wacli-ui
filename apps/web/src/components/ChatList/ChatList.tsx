import React, { useMemo } from 'react';
import { MessageSquare, Search, Pin, VolumeX, Archive, Plus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

export const ChatList: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const chatFilter = useAppStore((s) => s.chatFilter);
  const setChatFilter = useAppStore((s) => s.setChatFilter);
  const presenceMap = useAppStore((s) => s.presenceMap);
  const setActiveModal = useAppStore((s) => s.setActiveModal);

  const { data: chats = [], isLoading } = useQuery({
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
    <aside aria-label="Chats sidebar" className="w-80 bg-mc-surface border-r border-mc-border flex flex-col h-full select-none">
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
        {isLoading ? (
          <div className="p-6 text-center text-xs font-mono text-mc-textMuted">
            Loading chats...
          </div>
        ) : filteredChats.length === 0 ? (
          <div className="p-6 text-center text-xs text-mc-textMuted">
            No chats found.
          </div>
        ) : (
          filteredChats.map((chat: UnifiedChat) => {
            const isSelected = selectedChat?.jid === chat.jid;
            const presence = presenceMap[chat.jid];
            const isTyping = presence && presence.state === 'composing';

            return (
              <button
                key={chat.jid}
                onClick={() => setSelectedChat(chat)}
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
