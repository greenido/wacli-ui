import { create } from 'zustand';
import type { UnifiedChat, UnifiedMessage, SendLogEntry } from '../types.ts';

interface AppState {
  selectedChat: UnifiedChat | null;
  searchQuery: string;
  chatFilter: 'all' | 'unread' | 'pinned' | 'archived' | 'muted';
  replyingTo: UnifiedMessage | null;
  presenceMap: Record<string, { state: 'composing' | 'paused'; sender: string }>;
  sendLogs: SendLogEntry[];
  activeModal: 'send-confirm' | 'settings' | 'new-chat' | null;
  composerDraft: string;
  composerFile: File | null;
  focusComposerTrigger: number;
  sendConfirmData: {
    toJid: string;
    recipientName: string;
    messageText: string;
    replyToId?: string;
    fileAttachment?: File;
  } | null;

  setSelectedChat: (chat: UnifiedChat | null) => void;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: 'all' | 'unread' | 'pinned' | 'archived' | 'muted') => void;
  setReplyingTo: (msg: UnifiedMessage | null) => void;
  setPresence: (chatJid: string, state: 'composing' | 'paused', sender: string) => void;
  addSendLog: (entry: Omit<SendLogEntry, 'id' | 'timestamp'>) => string;
  updateSendLog: (id: string, update: Partial<SendLogEntry>) => void;
  setActiveModal: (modal: 'send-confirm' | 'settings' | 'new-chat' | null) => void;
  setSendConfirmData: (data: AppState['sendConfirmData']) => void;
  setComposerDraft: (draft: string) => void;
  setComposerFile: (file: File | null) => void;
  clearComposer: () => void;
  triggerFocusComposer: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  selectedChat: null,
  searchQuery: '',
  chatFilter: 'all',
  replyingTo: null,
  presenceMap: {},
  sendLogs: [],
  activeModal: null,
  composerDraft: '',
  composerFile: null,
  focusComposerTrigger: 0,
  sendConfirmData: null,

  setSelectedChat: (chat) => set({ selectedChat: chat }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setChatFilter: (filter) => set({ chatFilter: filter }),
  setReplyingTo: (msg) => set({ replyingTo: msg }),
  setPresence: (chatJid, state, sender) =>
    set((s) => ({
      presenceMap: {
        ...s.presenceMap,
        [chatJid]: { state, sender },
      },
    })),
  addSendLog: (entry) => {
    const id = `send-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newEntry: SendLogEntry = {
      id,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    set((s) => ({ sendLogs: [newEntry, ...s.sendLogs].slice(0, 50) }));
    return id;
  },
  updateSendLog: (id, update) =>
    set((s) => ({
      sendLogs: s.sendLogs.map((item) => (item.id === id ? { ...item, ...update } : item)),
    })),
  setActiveModal: (modal) => set({ activeModal: modal }),
  setSendConfirmData: (data) => set({ sendConfirmData: data }),
  setComposerDraft: (draft) => set({ composerDraft: draft }),
  setComposerFile: (file) => set({ composerFile: file }),
  clearComposer: () => set({ composerDraft: '', composerFile: null, replyingTo: null }),
  triggerFocusComposer: () => set((s) => ({ focusComposerTrigger: s.focusComposerTrigger + 1 })),
}));
