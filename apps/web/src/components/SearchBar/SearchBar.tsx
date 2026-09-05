import React, { useState, useRef } from 'react';
import { Search, X, MessageSquare } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { chatFromMessage } from '../../lib/chatFromMessage.ts';
import { chatWithUnreadCleared, markChatAsRead } from '../../lib/chatRead.ts';
import { wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useDebouncedValue } from '../../hooks/useDebouncedValue.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import type { UnifiedMessage } from '../../types.ts';

interface SearchBarProps {
  onClose: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;

export const SearchBar: React.FC<SearchBarProps> = ({ onClose }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // SearchBar is only mounted while open, so it is always open here.
  const dialogRef = useModalDialog<HTMLDivElement>(true, onClose);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId);
  const queryClient = useQueryClient();
  const resultsContainerRef = useRef<HTMLDivElement>(null);

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  // Every distinct query key spawns a `wacli messages search` subprocess, so the
  // key follows the typing rather than leading it.
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const settledQuery = debouncedQuery.trim();
  const isTypingAhead = query.trim() !== settledQuery;

  const readsReady = isWacliReadyForReads(health);
  const readQueryOpts = wacliReadQueryOptions<{ query: string; fts: boolean; results: UnifiedMessage[] } | null>(
    readsReady && Boolean(settledQuery)
  );

  const { data: searchResults, isFetching } = useQuery({
    queryKey: ['search', settledQuery],
    queryFn: () => (settledQuery ? api.searchMessages({ q: settledQuery, limit: 50 }) : null),
    ...readQueryOpts,
  });

  const results = searchResults?.results ?? [];
  const isSearching = isFetching || isTypingAhead;

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setSelectedIndex(0);
  };

  const handleSelectResult = (msg: UnifiedMessage) => {
    const chat = chatWithUnreadCleared(chatFromMessage(msg));
    setSelectedChat(chat);
    void markChatAsRead(queryClient, msg.chatJid);
    setHighlightedMessageId(msg.msgId);
    try {
      localStorage.setItem('wacli_selected_chat', msg.chatJid);
    } catch {
      // ignore
    }
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev + 1) % results.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (results.length > 0 ? (prev - 1 + results.length) % results.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results.length > 0 && results[selectedIndex]) {
        handleSelectResult(results[selectedIndex]);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-20 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search all messages"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-2xl flex flex-col max-h-[70vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Input Bar */}
        <div className="p-3 border-b border-mc-border flex items-center gap-2">
          <Search size={16} className="text-mc-live shrink-0" />
          <input
            type="text"
            autoFocus
            data-autofocus
            aria-label="Search query"
            value={query}
            onChange={handleQueryChange}
            placeholder="Full-text search across all messages (FTS5)..."
            className="flex-1 bg-transparent text-sm text-mc-text placeholder-mc-textMuted/60 focus:outline-none font-sans"
          />
          {isSearching && <span className="text-xs font-mono text-mc-live animate-pulse">searching...</span>}
          <button
            onClick={onClose}
            className="p-1 text-mc-textMuted hover:text-mc-text"
          >
            <X size={16} />
          </button>
        </div>

        {/* Results List */}
        <div ref={resultsContainerRef} className="flex-1 overflow-y-auto p-2 divide-y divide-mc-border/40">
          {!query.trim() ? (
            <div className="p-8 text-center text-xs font-mono text-mc-textMuted">
              Type a word, phrase, or keyword to search the local FTS5 SQLite index.
            </div>
          ) : results.length === 0 && !isSearching ? (
            <div className="p-8 text-center text-xs font-mono text-mc-textMuted">
              No matching messages found for "{settledQuery}".
            </div>
          ) : (
            results.map((msg, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <button
                  key={msg.msgId}
                  onClick={() => handleSelectResult(msg)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={`w-full text-left p-3 rounded transition-colors flex flex-col gap-1 ${
                    isSelected
                      ? 'bg-mc-surfaceHover ring-1 ring-mc-live/50'
                      : 'hover:bg-mc-surfaceHover'
                  }`}
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
                  {/* `text-start` because the result button sets `text-left`. */}
                  <div
                    dir={detectTextDirection(msg.snippet || msg.displayText || msg.text)}
                    className="text-xs text-mc-text line-clamp-2 text-start"
                  >
                    {msg.snippet || msg.displayText || msg.text}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
