import { create } from 'zustand';
import { TYPING_TTL_MS } from '../lib/presence.ts';
import type { UiCommand } from '../lib/shortcuts.ts';
import type { UnifiedChat, UnifiedMessage, SendLogEntry } from '../types.ts';

export type ActiveModal =
  | 'send-confirm'
  | 'settings'
  | 'new-chat'
  | 'chat-info'
  | 'tag-manager'
  | 'help'
  | 'mode-confirm';

/**
 * Where focus belongs once a chat opens. Clicking a conversation means you
 * intend to write, so the composer takes the caret; stepping through the rail
 * on the keyboard does not, and a composer that grabbed focus there would
 * swallow the very next navigation key.
 */
export type ChatFocusIntent = 'composer' | 'rail';

/**
 * How to recognise a message when no id was recorded for it.
 *
 * Sends made before Mission Control kept wacli's message id — which is every
 * one already on disk — have nothing to jump to. What they do have is the chat,
 * the body that went out and roughly when, and that is enough to pick the
 * message out of a thread the console has already loaded.
 */
export interface MessageJumpHint {
  /** The body that was sent. Compared against the message as it is displayed. */
  text: string;
  /** Not before this moment, so an identical older message is not mistaken for it. */
  sentAfter: string;
}

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
  /** Mission Control's own label filter, orthogonal to the chat filters above. */
  tagFilter: string | null;
  /**
   * Composer state is keyed by chat JID. A single shared draft followed the
   * operator into whichever chat they switched to, so a reply aimed at one
   * conversation could be dispatched into another.
   */
  replyingToByChat: Record<string, UnifiedMessage>;
  presenceMap: Record<string, { state: 'composing' | 'paused'; sender: string }>;
  sendLogs: SendLogEntry[];
  highlightedMessageId: string | null;
  /** Used only when the id is absent or turns out not to be in the thread. */
  highlightedMessageHint: MessageJumpHint | null;
  activeModal: ActiveModal | null;
  chatFocusIntent: ChatFocusIntent;
  /**
   * A one-shot signal to whichever pane owns a shortcut's behaviour: the rail
   * knows the filtered chat order, the thread knows its loaded messages, and
   * neither belongs in a key handler at the app root. The sequence number is
   * what makes it fire, so the same command twice running is still two events.
   */
  uiCommand: { name: UiCommand; seq: number } | null;
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

  setSelectedChat: (chat: UnifiedChat | null, focusIntent?: ChatFocusIntent) => void;
  setSearchQuery: (query: string) => void;
  setChatFilter: (filter: 'all' | 'unread' | 'pinned' | 'archived' | 'muted') => void;
  setTagFilter: (tag: string | null) => void;
  setReplyingTo: (chatJid: string, msg: UnifiedMessage | null) => void;
  setPresence: (chatJid: string, state: 'composing' | 'paused', sender: string) => void;
  clearPresence: (chatJid: string) => void;
  addSendLog: (entry: Omit<SendLogEntry, 'id' | 'timestamp'>) => string;
  updateSendLog: (id: string, update: Partial<SendLogEntry>) => void;
  setHighlightedMessageId: (id: string | null, hint?: MessageJumpHint | null) => void;
  setActiveModal: (modal: ActiveModal | null) => void;
  runCommand: (name: UiCommand) => void;
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
  tagFilter: null,
  replyingToByChat: {},
  presenceMap: {},
  sendLogs: [],
  highlightedMessageId: null,
  highlightedMessageHint: null,
  activeModal: null,
  chatFocusIntent: 'composer',
  uiCommand: null,
  composerDrafts: {},
  composerFiles: {},
  focusComposerTrigger: 0,
  sendConfirmData: null,

  // Moving to another conversation drops any pending jump target. A highlight
  // that outlived its chat made the new thread announce that the message was
  // "not in the local archive" — a message that was never in this chat to
  // begin with. Callers that jump to a message set the id after the chat.
  setSelectedChat: (chat, focusIntent = 'composer') =>
    set((s) =>
      s.selectedChat?.jid === chat?.jid
        ? { selectedChat: chat, chatFocusIntent: focusIntent }
        : {
            selectedChat: chat,
            chatFocusIntent: focusIntent,
            highlightedMessageId: null,
            highlightedMessageHint: null,
          }
    ),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setChatFilter: (filter) => set({ chatFilter: filter }),
  setTagFilter: (tag) => set({ tagFilter: tag }),
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
  // The hint travels with the id and is replaced with it, so a jump can never
  // be answered with the leftovers of the one before it.
  setHighlightedMessageId: (id, hint = null) =>
    set({ highlightedMessageId: id, highlightedMessageHint: hint }),
  setActiveModal: (modal) => set({ activeModal: modal }),
  runCommand: (name) =>
    set((s) => ({ uiCommand: { name, seq: (s.uiCommand?.seq ?? 0) + 1 } })),
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
