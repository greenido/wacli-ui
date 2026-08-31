import React, { useState, useEffect } from 'react';
import { ReadOnlyBanner } from './components/ReadOnlyBanner/ReadOnlyBanner.tsx';
import { ChatList } from './components/ChatList/ChatList.tsx';
import { ThreadView } from './components/ThreadView/ThreadView.tsx';
import { Composer } from './components/Composer/Composer.tsx';
import { StatusStrip } from './components/StatusStrip/StatusStrip.tsx';
import { SendConfirmModal } from './components/SendConfirmModal/SendConfirmModal.tsx';
import { SettingsModal } from './components/SettingsModal/SettingsModal.tsx';
import { NewChatModal } from './components/NewChatModal/NewChatModal.tsx';
import { SearchBar } from './components/SearchBar/SearchBar.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';

export const App: React.FC = () => {
  const { isConnected } = useWebSocket();
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Global shortcut Cmd+K or Ctrl+K to open search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-mc-bg text-mc-text font-sans overflow-hidden select-none">
      {/* Safe Mode / Read-Only Top Banner */}
      <ReadOnlyBanner />

      {/* Main 3-Pane Console */}
      <div className="flex-1 flex min-h-0">
        {/* Left Rail: Chat List */}
        <ChatList />

        {/* Dominant Center: Thread View + Fixed Composer */}
        <div className="flex-1 flex flex-col min-w-0 h-full border-r border-mc-border relative z-10">
          <ThreadView />
          <Composer />
        </div>

        {/* Right Rail: System Status Strip & Send Audit */}
        <StatusStrip wsConnected={isConnected} />
      </div>

      {/* Modals */}
      <SendConfirmModal />
      <SettingsModal />
      <NewChatModal />
      {isSearchOpen && <SearchBar onClose={() => setIsSearchOpen(false)} />}
    </div>
  );
};
