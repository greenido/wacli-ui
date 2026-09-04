import React, { useState, useCallback } from 'react';
import { ReadOnlyBanner } from './components/ReadOnlyBanner/ReadOnlyBanner.tsx';
import { WacliStatusBanner } from './components/WacliStatusBanner/WacliStatusBanner.tsx';
import { ChatList } from './components/ChatList/ChatList.tsx';
import { ThreadView } from './components/ThreadView/ThreadView.tsx';
import { Composer } from './components/Composer/Composer.tsx';
import { StatusStrip } from './components/StatusStrip/StatusStrip.tsx';
import { SendConfirmModal } from './components/SendConfirmModal/SendConfirmModal.tsx';
import { SettingsModal } from './components/SettingsModal/SettingsModal.tsx';
import { NewChatModal } from './components/NewChatModal/NewChatModal.tsx';
import { ChatInfoModal } from './components/ChatInfoModal/ChatInfoModal.tsx';
import { HelpModal } from './components/HelpModal/HelpModal.tsx';
import { ModeConfirmModal } from './components/ModeConfirmModal/ModeConfirmModal.tsx';
import { SearchBar } from './components/SearchBar/SearchBar.tsx';
import { ResizeHandle } from './components/ResizeHandle/ResizeHandle.tsx';
import { useUnreadTitle } from './hooks/useUnreadBadge.ts';
import { useWebSocket } from './hooks/useWebSocket.ts';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts.ts';

const DEFAULT_CHAT_LIST_WIDTH = 320;
const DEFAULT_STATUS_STRIP_WIDTH = 256;

export const App: React.FC = () => {
  const { isConnected } = useWebSocket();
  // Puts the waiting count in the tab title, so a backgrounded console still
  // says whether anything needs the operator.
  useUnreadTitle();
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Resizable pane widths with localStorage persistence
  const [chatListWidth, setChatListWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('wacli_chat_list_width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 180 && parsed <= 650) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_CHAT_LIST_WIDTH;
  });

  const [statusStripWidth, setStatusStripWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('wacli_status_strip_width');
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= 160 && parsed <= 500) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return DEFAULT_STATUS_STRIP_WIDTH;
  });

  const handleChatListResize = (newWidth: number) => {
    setChatListWidth(newWidth);
    try {
      localStorage.setItem('wacli_chat_list_width', String(newWidth));
    } catch {
      // ignore
    }
  };

  const handleStatusStripResize = (newWidth: number) => {
    setStatusStripWidth(newWidth);
    try {
      localStorage.setItem('wacli_status_strip_width', String(newWidth));
    } catch {
      // ignore
    }
  };

  const handleResetChatListWidth = () => {
    handleChatListResize(DEFAULT_CHAT_LIST_WIDTH);
  };

  const handleResetStatusStripWidth = () => {
    handleStatusStripResize(DEFAULT_STATUS_STRIP_WIDTH);
  };

  const toggleSearch = useCallback(() => setIsSearchOpen((prev) => !prev), []);

  // The console's whole keyboard layer, catalogued in lib/shortcuts.ts and
  // documented by the same list the help modal renders.
  useKeyboardShortcuts({ isSearchOpen, onToggleSearch: toggleSearch });

  return (
    <div className="flex flex-col h-screen w-screen bg-mc-bg text-mc-text font-sans overflow-hidden select-none">
      {/* Safe Mode / Read-Only Top Banner */}
      <ReadOnlyBanner />

      {/* System Warning / First-Load wacli Diagnostic Banner */}
      <WacliStatusBanner />

      {/* Main 3-Pane Console */}
      <div className="flex-1 flex min-h-0">
        {/* Left Rail: Chat List */}
        <ChatList width={chatListWidth} />

        {/* Left Splitter */}
        <ResizeHandle
          side="left"
          currentWidth={chatListWidth}
          minWidth={200}
          maxWidth={600}
          onResize={handleChatListResize}
          onReset={handleResetChatListWidth}
        />

        {/* Dominant Center: Thread View + Fixed Composer */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 relative z-10 overflow-hidden">
          <ThreadView />
          <Composer />
        </div>

        {/* Right Splitter */}
        <ResizeHandle
          side="right"
          currentWidth={statusStripWidth}
          minWidth={180}
          maxWidth={500}
          onResize={handleStatusStripResize}
          onReset={handleResetStatusStripWidth}
        />

        {/* Right Rail: System Status Strip & Send Audit */}
        <StatusStrip wsConnected={isConnected} width={statusStripWidth} />
      </div>

      {/* Modals */}
      <SendConfirmModal />
      <SettingsModal />
      <NewChatModal />
      <ChatInfoModal />
      <ModeConfirmModal />
      <HelpModal />
      {isSearchOpen && <SearchBar onClose={() => setIsSearchOpen(false)} />}
    </div>
  );
};
