import React, { useState } from 'react';
import { X, UserPlus, Search, ArrowRight, Phone } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

export const NewChatModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const triggerFocusComposer = useAppStore((s) => s.triggerFocusComposer);

  const [inputQuery, setInputQuery] = useState('');

  // Fetch either matching chats or recent chats if no search query
  const { data: searchResults = [], isLoading } = useQuery({
    queryKey: ['newChatList', inputQuery.trim()],
    queryFn: () =>
      api.getChats({
        query: inputQuery.trim() || undefined,
        limit: inputQuery.trim() ? 25 : 50,
      }),
    enabled: activeModal === 'new-chat',
  });

  if (activeModal !== 'new-chat') return null;

  const handleSelectChat = (chat: UnifiedChat) => {
    setSelectedChat(chat);
    setActiveModal(null);
    setInputQuery('');
    setTimeout(() => {
      triggerFocusComposer();
    }, 50);
  };

  const handleStartCustomNumber = () => {
    const raw = inputQuery.trim();
    if (!raw) return;

    const cleanDigits = raw.replace(/[^0-9]/g, '');
    const isJid = raw.includes('@');
    const jid = isJid ? raw : `${cleanDigits}@s.whatsapp.net`;
    const displayName = isJid ? raw.split('@')[0] : (cleanDigits ? `+${cleanDigits}` : raw);

    const customChat: UnifiedChat = {
      jid,
      name: displayName,
      kind: jid.endsWith('@g.us') ? 'group' : 'dm',
      lastMessageTs: new Date().toISOString(),
      archived: false,
      pinned: false,
      mutedUntil: 0,
      unread: false,
      unreadCount: 0,
    };

    setSelectedChat(customChat);
    setActiveModal(null);
    setInputQuery('');
    setTimeout(() => {
      triggerFocusComposer();
    }, 50);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setActiveModal(null);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchResults.length > 0 && !inputQuery.replace(/[^0-9]/g, '')) {
        handleSelectChat(searchResults[0]);
      } else if (inputQuery.trim()) {
        handleStartCustomNumber();
      }
    }
  };

  const hasDigits = inputQuery.replace(/[^0-9]/g, '').length >= 3;

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh] font-mono text-xs">
        {/* Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <div className="flex items-center gap-2 text-mc-live font-semibold">
            <UserPlus size={15} />
            <span>START NEW CONVERSATION</span>
          </div>
          <button
            onClick={() => {
              setActiveModal(null);
              setInputQuery('');
            }}
            className="p-1 text-mc-textMuted hover:text-mc-text rounded"
          >
            <X size={16} />
          </button>
        </div>

        {/* Input */}
        <div className="p-4 space-y-3">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-2.5 text-mc-textMuted" />
            <input
              type="text"
              autoFocus
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search contact name, or type phone number (+1555...)..."
              className="w-full bg-mc-bg border border-mc-border rounded pl-8 pr-3 py-2 text-xs text-mc-text placeholder-mc-textMuted/60 focus:outline-none focus:border-mc-live font-sans"
            />
          </div>

          {/* Quick Direct Number Action */}
          {(hasDigits || inputQuery.includes('@')) && (
            <button
              onClick={handleStartCustomNumber}
              className="w-full text-left p-2.5 rounded bg-mc-live/15 hover:bg-mc-live/25 border border-mc-live/50 text-mc-live flex items-center justify-between font-semibold transition-colors"
            >
              <div className="flex items-center gap-2">
                <Phone size={13} />
                <span>Message &ldquo;{inputQuery.trim()}&rdquo; directly</span>
              </div>
              <span className="text-[10px] bg-mc-live text-[#12151B] px-1.5 py-0.5 rounded font-bold flex items-center gap-1">
                ENTER <ArrowRight size={10} />
              </span>
            </button>
          )}

          {/* Section Header */}
          <div className="text-[10px] text-mc-textMuted font-semibold uppercase tracking-wider pt-1">
            {inputQuery.trim() ? 'Search Results' : 'Recent Contacts & Chats'}
          </div>

          {/* Results / Options */}
          <div className="space-y-1 max-h-64 overflow-y-auto divide-y divide-mc-border/30">
            {isLoading ? (
              <div className="p-4 text-center text-mc-textMuted">Loading contacts...</div>
            ) : searchResults.length === 0 && !hasDigits ? (
              <div className="p-4 text-center text-mc-textMuted font-sans">
                No matching contacts found. Type a phone number to start a new chat.
              </div>
            ) : (
              searchResults.map((c) => (
                <button
                  key={c.jid}
                  onClick={() => handleSelectChat(c)}
                  className="w-full text-left p-2.5 rounded hover:bg-mc-surfaceHover border border-transparent hover:border-mc-border flex items-center justify-between transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-mc-text font-semibold truncate">{c.name}</div>
                    <div className="text-mc-textMuted text-[10px] font-mono truncate">{c.jid}</div>
                  </div>
                  <span className="text-mc-live text-[10px] uppercase ml-2 shrink-0">{c.kind}</span>
                </button>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
