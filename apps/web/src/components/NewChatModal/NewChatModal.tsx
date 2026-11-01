import React, { useRef, useState } from 'react';
import { X, UserPlus, Search, ArrowRight, Phone } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { chatWithUnreadCleared, markChatAsRead } from '../../lib/chatRead.ts';
import { wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { chatDisplayName } from '../../lib/chatDisplayName.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useHealth } from '../../hooks/useHealth.ts';
import { useSleepMode } from '../../hooks/useSleepMode.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';
import type { UnifiedChat } from '../../types.ts';

export const NewChatModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const triggerFocusComposer = useAppStore((s) => s.triggerFocusComposer);
  const queryClient = useQueryClient();

  const [inputQuery, setInputQuery] = useState('');
  // Tied to the query it was made for, so typing falls back to the default.
  const [selection, setSelection] = useState<{ query: string; index: number } | null>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  const clearQuery = () => {
    setInputQuery('');
    setSelection(null);
  };

  const dialogRef = useModalDialog<HTMLDivElement>(activeModal === 'new-chat', () => {
    setActiveModal(null);
    clearQuery();
  });

  const { data: health } = useHealth();

  // Asleep, nothing reaches wacli: what is on screen stays as it was.
  const { awake } = useSleepMode();
  const readsReady = awake && isWacliReadyForReads(health);
  const readQueryOpts = wacliReadQueryOptions(
    activeModal === 'new-chat' && readsReady
  );

  // Fetch either matching chats or recent chats if no search query
  const { data: searchResults = [], isLoading } = useQuery({
    queryKey: ['newChatList', inputQuery.trim()],
    queryFn: () =>
      api.getChats({
        query: inputQuery.trim() || undefined,
        limit: inputQuery.trim() ? 25 : 50,
      }),
    ...readQueryOpts,
  });

  if (activeModal !== 'new-chat') return null;

  const handleSelectChat = (chat: UnifiedChat) => {
    setSelectedChat(chatWithUnreadCleared(chat));
    if (chat.unread || chat.unreadCount > 0) {
      void markChatAsRead(queryClient, chat.jid);
    }
    setActiveModal(null);
    clearQuery();
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
    const displayName = isJid ? chatDisplayName(jid) : (cleanDigits ? `+${cleanDigits}` : raw);

    const customChat: UnifiedChat = {
      jid,
      name: displayName,
      kind: jid.endsWith('@g.us') ? 'group' : 'dm',
      lastMessageTs: new Date().toISOString(),
      lastMessage: null,
      lastMessageFromMe: false,
      archived: false,
      pinned: false,
      mutedUntil: 0,
      unread: false,
      unreadCount: 0,
    };

    setSelectedChat(customChat);
    setActiveModal(null);
    clearQuery();
    setTimeout(() => {
      triggerFocusComposer();
    }, 50);
  };

  const hasDigits = inputQuery.replace(/[^0-9]/g, '').length >= 3;
  const showDirect = hasDigits || inputQuery.includes('@');
  // Option 0 is the direct row when it is shown; the results follow it.
  const firstResult = showDirect ? 1 : 0;
  const optionCount = firstResult + searchResults.length;
  // "Room 101" offers the direct row, but it reads as a name, so the match wins.
  const looksDirect =
    inputQuery.includes('@') || (hasDigits && /^\+?[\d\s\-().]+$/.test(inputQuery.trim()));
  const defaultIndex =
    showDirect && (looksDirect || searchResults.length === 0)
      ? 0
      : searchResults.length > 0
        ? firstResult
        : -1;
  const selectedIndex =
    selection?.query === inputQuery && selection.index < optionCount
      ? selection.index
      : defaultIndex;

  const selectOption = (index: number) => setSelection({ query: inputQuery, index });

  const moveSelection = (delta: number) => {
    if (optionCount === 0) return;
    const next =
      selectedIndex < 0
        ? delta > 0
          ? 0
          : optionCount - 1
        : (selectedIndex + delta + optionCount) % optionCount;
    selectOption(next);
    optionsRef.current
      ?.querySelector<HTMLElement>(`[data-option-index="${next}"]`)
      // Optional call: jsdom has no scrollIntoView.
      ?.scrollIntoView?.({ block: 'nearest' });
  };

  const openOption = (index: number) => {
    if (index < 0) return;
    if (index < firstResult) handleStartCustomNumber();
    else handleSelectChat(searchResults[index - firstResult]);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setActiveModal(null);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openOption(selectedIndex);
    }
  };

  const enterHint = (
    <span className="text-[10px] bg-mc-live text-[#12151B] px-1.5 py-0.5 rounded font-bold flex items-center gap-1 ml-2 shrink-0">
      ENTER <ArrowRight size={10} />
    </span>
  );

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-chat-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-lg flex flex-col max-h-[80vh] font-mono text-xs"
      >
        {/* Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2 id="new-chat-title" className="flex items-center gap-2 text-mc-live font-semibold">
            <UserPlus size={15} />
            <span>START NEW CONVERSATION</span>
          </h2>
          <button
            onClick={() => {
              setActiveModal(null);
              clearQuery();
            }}
            aria-label="Close new conversation dialog"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded"
          >
            <X size={16} />
          </button>
        </div>

        {/* Input */}
        <div ref={optionsRef} className="p-4 space-y-3">
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
          {showDirect && (
            <button
              data-option-index={0}
              aria-current={selectedIndex === 0 ? 'true' : undefined}
              onClick={handleStartCustomNumber}
              onMouseEnter={() => selectOption(0)}
              className={`w-full text-left p-2.5 rounded bg-mc-live/15 hover:bg-mc-live/25 border text-mc-live flex items-center justify-between font-semibold transition-colors ${
                selectedIndex === 0 ? 'border-mc-live ring-1 ring-mc-live/50' : 'border-mc-live/50'
              }`}
            >
              <div className="flex items-center gap-2">
                <Phone size={13} />
                <span>Message &ldquo;{inputQuery.trim()}&rdquo; directly</span>
              </div>
              {selectedIndex === 0 && enterHint}
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
              searchResults.map((c, i) => {
                const index = firstResult + i;
                const isSelected = index === selectedIndex;
                return (
                  <button
                    key={c.jid}
                    data-option-index={index}
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => handleSelectChat(c)}
                    onMouseEnter={() => selectOption(index)}
                    className={`w-full text-left p-2.5 rounded border flex items-center justify-between transition-colors ${
                      isSelected
                        ? 'bg-mc-surfaceHover border-transparent ring-1 ring-mc-live/50'
                        : 'border-transparent hover:bg-mc-surfaceHover hover:border-mc-border'
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-mc-text font-semibold truncate">{c.name}</div>
                      <div className="text-mc-textMuted text-[10px] font-mono truncate">{c.jid}</div>
                    </div>
                    <span className="text-mc-live text-[10px] uppercase ml-2 shrink-0">{c.kind}</span>
                    {isSelected && enterHint}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
