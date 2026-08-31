import React, { useState } from 'react';
import { Search, X, MessageSquare } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedMessage } from '../../types.ts';

interface SearchBarProps {
  onClose: () => void;
}

export const SearchBar: React.FC<SearchBarProps> = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);

  const { data: searchResults, isFetching } = useQuery({
    queryKey: ['search', query],
    queryFn: () => (query.trim() ? api.searchMessages({ q: query.trim(), limit: 50 }) : null),
    enabled: Boolean(query.trim()),
  });

  const results = searchResults?.results ?? [];

  const handleSelectResult = (msg: UnifiedMessage) => {
    setSelectedChat({
      jid: msg.chatJid,
      name: msg.chatName || msg.chatJid.split('@')[0],
      kind: msg.chatJid.endsWith('@g.us') ? 'group' : 'dm',
      lastMessageTs: msg.ts,
      archived: false,
      pinned: false,
      mutedUntil: 0,
      unread: false,
      unreadCount: 0,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-20 p-4">
      <div className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-2xl flex flex-col max-h-[70vh]">
        {/* Input Bar */}
        <div className="p-3 border-b border-mc-border flex items-center gap-2">
          <Search size={16} className="text-mc-live shrink-0" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Full-text search across all messages (FTS5)..."
            className="flex-1 bg-transparent text-sm text-mc-text placeholder-mc-textMuted/60 focus:outline-none font-sans"
          />
          {isFetching && <span className="text-xs font-mono text-mc-live animate-pulse">searching...</span>}
          <button
            onClick={onClose}
            className="p-1 text-mc-textMuted hover:text-mc-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto p-2 divide-y divide-mc-border/40">
          {!query.trim() ? (
            <div className="p-8 text-center text-xs font-mono text-mc-textMuted">
              Type a word, phrase, or keyword to search the local FTS5 SQLite index.
            </div>
          ) : results.length === 0 && !isFetching ? (
            <div className="p-8 text-center text-xs font-mono text-mc-textMuted">
              No matching messages found for "{query}".
            </div>
          ) : (
            results.map((msg) => (
              <button
                key={msg.msgId}
                onClick={() => handleSelectResult(msg)}
                className="w-full text-left p-3 hover:bg-mc-surfaceHover rounded transition-colors flex flex-col gap-1"
              >
                <div className="flex items-center justify-between text-xs font-mono">
                  <span className="font-semibold text-mc-live flex items-center gap-1">
                    <MessageSquare size={12} />
                    {msg.chatName || msg.chatJid}
                  </span>
                  <span className="text-mc-textMuted text-[10px]">
                    {new Date(msg.ts).toLocaleDateString()} {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="text-xs text-mc-text line-clamp-2">
                  {msg.snippet || msg.displayText || msg.text}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
