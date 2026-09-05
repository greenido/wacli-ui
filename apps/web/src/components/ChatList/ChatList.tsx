import React, { useMemo, useEffect, useCallback, useRef } from 'react';
import { MessageSquare, Search, Pin, VolumeX, Archive, Plus, AlertOctagon, AlertTriangle, Tag, SlidersHorizontal } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiClientError } from '../../api/client.ts';
import { chatWithUnreadCleared, markChatAsRead } from '../../lib/chatRead.ts';
import { POLL_CHATS_MS, wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.ts';
import { useUiCommand } from '../../hooks/useUiCommand.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { ChatFocusIntent } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

interface ChatListProps {
  width?: number;
}

const SEARCH_DEBOUNCE_MS = 250;

export const ChatList: React.FC<ChatListProps> = ({ width = 320 }) => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const chatFilter = useAppStore((s) => s.chatFilter);
  const setChatFilter = useAppStore((s) => s.setChatFilter);
  const tagFilter = useAppStore((s) => s.tagFilter);
  const setTagFilter = useAppStore((s) => s.setTagFilter);
  const presenceMap = useAppStore((s) => s.presenceMap);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const queryClient = useQueryClient();
  const filterInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  // `GET /api/chats` is the app's most expensive read — a `chats list` plus the
  // 400-message preview scan — so the query key follows the typing rather than
  // leading it. The input itself stays instant; only the fetch waits.
  const debouncedSearchQuery = useDebouncedValue(searchQuery, SEARCH_DEBOUNCE_MS);

  const readsReady = isWacliReadyForReads(health);
  const readQueryOpts = wacliReadQueryOptions<UnifiedChat[]>(readsReady);

  const { data: chats = [], isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['chats', debouncedSearchQuery, chatFilter],
    queryFn: () =>
      api.getChats({
        query: debouncedSearchQuery || undefined,
        limit: 100,
        unread: chatFilter === 'unread' ? true : undefined,
        pinned: chatFilter === 'pinned' ? true : undefined,
        archived: chatFilter === 'archived' ? true : chatFilter === 'all' ? false : undefined,
        muted: chatFilter === 'muted' ? true : undefined,
      }),
    refetchInterval: POLL_CHATS_MS,
    ...readQueryOpts,
  });

  // Tags are Mission Control's own, so the rail filters on them here rather
  // than asking wacli for a list it has no way to produce.
  const { data: tagData } = useQuery({
    queryKey: ['tags'],
    queryFn: () => api.getTags(),
  });

  const availableTags = tagData?.tags ?? [];

  const filteredChats = useMemo(() => {
    // Read the map inside the callback: `?? {}` outside would mint a new object
    // every render and defeat the memo.
    const tagsByJid = tagData?.byJid ?? {};

    return chats.filter((c) => {
      if (tagFilter && !(tagsByJid[c.jid] ?? []).includes(tagFilter)) return false;
      if (chatFilter === 'all') return !c.archived;
      if (chatFilter === 'unread') return c.unread || c.unreadCount > 0;
      if (chatFilter === 'pinned') return c.pinned;
      if (chatFilter === 'archived') return c.archived;
      if (chatFilter === 'muted') return c.mutedUntil > 0;
      return true;
    });
  }, [chats, chatFilter, tagFilter, tagData]);

  const handleSelectChat = useCallback((chat: UnifiedChat, focusIntent: ChatFocusIntent = 'composer') => {
    const chatToSelect = chatWithUnreadCleared(chat);
    setSelectedChat(chatToSelect, focusIntent);
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

  // Keyboard stepping through the rail. The list order lives here, so this is
  // where the shortcut lands; `rail` keeps focus out of the composer, which
  // would otherwise swallow the next navigation key.
  const stepChat = useCallback(
    (delta: number) => {
      if (filteredChats.length === 0) return;
      const current = filteredChats.findIndex((c) => c.jid === selectedChat?.jid);
      const next =
        current === -1
          ? delta > 0
            ? 0
            : filteredChats.length - 1
          : (current + delta + filteredChats.length) % filteredChats.length;
      handleSelectChat(filteredChats[next], 'rail');
    },
    [filteredChats, selectedChat?.jid, handleSelectChat]
  );

  useUiCommand('chat:next', () => stepChat(1));
  useUiCommand('chat:prev', () => stepChat(-1));
  useUiCommand('chatlist:focus-filter', () => {
    // Focus explicitly: select() alone moves the caret in a browser but not the
    // focus ring, and does neither under jsdom.
    filterInputRef.current?.focus();
    filterInputRef.current?.select();
  });

  // A selection reached by keyboard can easily be off-screen in a long rail.
  useEffect(() => {
    if (!selectedChat) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-chat-jid="${selectedChat.jid}"]`
    );
    // Optional call: jsdom has no scrollIntoView, and neither do very old
    // browsers. Failing to scroll is not worth throwing over.
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedChat]);

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
            ref={filterInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search chats or contacts...  ( / )"
            aria-label="Filter chats by name or JID"
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

        {availableTags.length > 0 && (
          <div className="flex gap-1 items-center text-[11px] font-mono">
            <Tag size={11} className="text-mc-textMuted shrink-0" />
            {/*
              Only the chips scroll. The manage button sits outside that box, so
              a long vocabulary cannot push the way to edit it off the rail.
            */}
            <div className="flex gap-1 items-center flex-1 min-w-0 overflow-x-auto no-scrollbar">
              {availableTags.map((tag) => {
                const isActive = tagFilter === tag;
                return (
                  <button
                    key={tag}
                    onClick={() => setTagFilter(isActive ? null : tag)}
                    aria-pressed={isActive}
                    title={`Show only chats tagged "${tag}"`}
                    className={`px-2 py-0.5 rounded shrink-0 transition-colors ${
                      isActive
                        ? 'bg-mc-live/15 text-mc-live border border-mc-live/40 font-semibold'
                        : 'text-mc-textMuted hover:text-mc-text border border-transparent hover:bg-mc-surfaceHover'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
            {/*
              Rendered only alongside the chips: with no tags there is nothing
              to manage, and this whole row is absent anyway.
            */}
            <button
              onClick={() => setActiveModal('tag-manager')}
              aria-label="Manage tags"
              title="Rename or delete tags"
              className="p-1 rounded shrink-0 text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceHover transition-colors"
            >
              <SlidersHorizontal size={11} />
            </button>
          </div>
        )}
      </div>

      {/* Chat List */}
      <div ref={listRef} className="flex-1 overflow-y-auto divide-y divide-mc-border/40">
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
                data-chat-jid={chat.jid}
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

                  {/* What the conversation is about. When there is no preview
                      to show, say that: the JID that used to sit here repeated
                      the row above for unknown contacts and told the operator
                      nothing for everyone else.

                      The preview follows its own message's direction, so a
                      Hebrew rail reads from the right edge. `text-start` is
                      needed because the row button sets `text-left`, which
                      would otherwise pin the line to the left regardless of
                      `dir`. Only the preview flips — the name above it is a
                      contact label, and the row's own chrome stays put. */}
                  <div
                    dir={isTyping ? 'ltr' : detectTextDirection(chat.lastMessage)}
                    className="text-[11px] truncate text-start"
                  >
                    {isTyping ? (
                      <span className="text-mc-live font-mono animate-pulse">typing...</span>
                    ) : chat.lastMessage ? (
                      <span className="text-mc-textMuted">
                        {chat.lastMessageFromMe && <span className="text-mc-textMuted/70">You: </span>}
                        {chat.lastMessage}
                      </span>
                    ) : (
                      <span className="text-mc-textMuted/60 italic">No preview available</span>
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
