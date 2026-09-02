import { create } from 'zustand';
import { TYPING_TTL_MS } from '../lib/presence.ts';
import type { UnifiedChat, UnifiedMessage, SendLogEntry } from '../types.ts';

const presenceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearPresenceTimer(chatJid: string) {
  const timer = presenceTimers.get(chatJid);
  if (timer) {
    clearTimeout(timer);
    presenceTimers.delete(chatJid);
  }
}

function schedulePresenceExpiry(chatJid: string, clear: () => void) {
  clearPresenceTimer(chatJid);
  presenceTimers.set(
    chatJid,
    setTimeout(() => {
      presenceTimers.delete(chatJid);
      clear();
    }, TYPING_TTL_MS)
  );
}

interface AppState {
  selectedChat: UnifiedChat | null;
  searchQuery: string;
  chatFilter: 'all' | 'unread' | 'pinned' | 'archived' | 'muted';
  /**
   * Composer state is keyed by chat JID. A single shared draft followed the
   * operator into whichever chat they switched to, so a reply aimed at one
   * conversation could be dispatched into another.
   */
  replyingToByChat: Record<string, UnifiedMessage>;
  presenceMap: Record<string, { state: 'composing' | 'paused'; sender: string }>;
  sendLogs: SendLogEntry[];
  highlightedMessageId: string | null;
  activeModal: 'send-confirm' | 'settings' | 'new-chat' | null;
  composerDrafts: Record<string, string>;
  composerFiles: Record<string, File>;
  focusComposerTrigger: number;
  sendConfirmData: {
    toJid: string;
    recipientName: string;
    messageText: string;
    replyToId?: string;
    /** Quoted message shown in the confirm dialog, so the target is verifiable. */
    replyToPreview?: { sender: string; text: string };
    fileAttachment?: File;
    scheduleMode?: boolean;
    scheduledAt?: string;
  } | null;

  setSelectedChat: (chat: UnifiedChat | null) => void;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: 'all' | 'unread' | 'pinned' | 'archived' | 'muted') => void;
  setReplyingTo: (chatJid: string, msg: UnifiedMessage | null) => void;
  setPresence: (chatJid: string, state: 'composing' | 'paused', sender: string) => void;
  clearPresence: (chatJid: string) => void;
  addSendLog: (entry: Omit<SendLogEntry, 'id' | 'timestamp'>) => string;
  updateSendLog: (id: string, update: Partial<SendLogEntry>) => void;
  setHighlightedMessageId: (id: string | null) => void;
  setActiveModal: (modal: 'send-confirm' | 'settings' | 'new-chat' | null) => void;
  setSendConfirmData: (data: AppState['sendConfirmData']) => void;
  setComposerDraft: (chatJid: string, draft: string) => void;
  setComposerFile: (chatJid: string, file: File | null) => void;
  clearComposer: (chatJid: string) => void;
  triggerFocusComposer: () => void;
}

/** Drops a key without leaving an `undefined` hole behind. */
function omitKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const { [key]: _removed, ...rest } = map;
  return rest;
}

export const useAppStore = create<AppState>((set) => ({
  selectedChat: null,
  searchQuery: '',
  chatFilter: 'all',
  replyingToByChat: {},
  presenceMap: {},
  sendLogs: [],
  highlightedMessageId: null,
  activeModal: null,
  composerDrafts: {},
  composerFiles: {},
  focusComposerTrigger: 0,
  sendConfirmData: null,

  setSelectedChat: (chat) => set({ selectedChat: chat }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setChatFilter: (filter) => set({ chatFilter: filter }),
  setReplyingTo: (chatJid, msg) =>
    set((s) => ({
      replyingToByChat: msg
        ? { ...s.replyingToByChat, [chatJid]: msg }
        : omitKey(s.replyingToByChat, chatJid),
    })),
  setPresence: (chatJid, state, sender) => {
    if (state === 'paused') {
      clearPresenceTimer(chatJid);
      set((s) => {
        const { [chatJid]: _, ...rest } = s.presenceMap;
        return { presenceMap: rest };
      });
      return;
    }

    set((s) => ({
      presenceMap: {
        ...s.presenceMap,
        [chatJid]: { state: 'composing', sender },
      },
    }));
    schedulePresenceExpiry(chatJid, () => {
      set((s) => {
        if (s.presenceMap[chatJid]?.state !== 'composing') {
          return s;
        }
        const { [chatJid]: _, ...rest } = s.presenceMap;
        return { presenceMap: rest };
      });
    });
  },
  clearPresence: (chatJid) => {
    clearPresenceTimer(chatJid);
    set((s) => {
      if (!s.presenceMap[chatJid]) {
        return s;
      }
      const { [chatJid]: _, ...rest } = s.presenceMap;
      return { presenceMap: rest };
    });
  },
  addSendLog: (entry) => {
    const id = `send-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const newEntry: SendLogEntry = {
      id,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    set((s) => ({ sendLogs: [newEntry, ...s.sendLogs].slice(0, 500) }));
    return id;
  },
  updateSendLog: (id, update) =>
    set((s) => ({
      sendLogs: s.sendLogs.map((item) => (item.id === id ? { ...item, ...update } : item)),
    })),
  setHighlightedMessageId: (id) => set({ highlightedMessageId: id }),
  setActiveModal: (modal) => set({ activeModal: modal }),
  setSendConfirmData: (data) => set({ sendConfirmData: data }),
  setComposerDraft: (chatJid, draft) =>
    set((s) => ({
      composerDrafts: draft
        ? { ...s.composerDrafts, [chatJid]: draft }
        : omitKey(s.composerDrafts, chatJid),
    })),
  setComposerFile: (chatJid, file) =>
    set((s) => ({
      composerFiles: file
        ? { ...s.composerFiles, [chatJid]: file }
        : omitKey(s.composerFiles, chatJid),
    })),
  clearComposer: (chatJid) =>
    set((s) => ({
      composerDrafts: omitKey(s.composerDrafts, chatJid),
      composerFiles: omitKey(s.composerFiles, chatJid),
      replyingToByChat: omitKey(s.replyingToByChat, chatJid),
    })),
  triggerFocusComposer: () => set((s) => ({ focusComposerTrigger: s.focusComposerTrigger + 1 })),
}));
