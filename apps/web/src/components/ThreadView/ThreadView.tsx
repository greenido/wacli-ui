import React, { useMemo, useRef, useEffect, useState } from 'react';
import {
  Reply,
  Smile,
  Check,
  CheckCheck,
  Copy,
  Star,
  Bookmark,
  ChevronUp,
  Clock,
  CloudDownload,
  Info,
  Loader2,
  Trash2,
  AlertOctagon,
  AlertTriangle,
  Terminal,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { POLL_MESSAGES_MS, POLL_SCHEDULED_MS, wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { useUiCommand } from '../../hooks/useUiCommand.ts';
import { useAppStore } from '../../store/appStore.ts';
import { resolveJumpTarget } from '../../lib/messageJump.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { MediaViewer } from './MediaViewer.tsx';
import { EmojiReactionDrawer } from './EmojiReactionDrawer.tsx';
import { ExportMenu } from './ExportMenu.tsx';
import type { ChatCoverage, UnifiedMessage } from '../../types.ts';

interface MessagePage {
  messages: UnifiedMessage[];
  hasMore: boolean;
}

interface ThreadReaction {
  emoji: string;
  fromMe: boolean;
  sender: string;
}

/**
 * WhatsApp allows one reaction per person per message. Our own reactions fold
 * under a fixed key because an outbound row carries no sender JID.
 */
const MY_REACTION_KEY = '@me';

/** A reaction sent from here that the local archive has not caught up with. */
interface PendingReaction {
  /** What we sent. */
  emoji: string;
  /**
   * What the archive said our reaction to that message was at the moment we
   * clicked. The stand-in stops applying as soon as the archive says something
   * else — which is how it retires itself, with no timer and no bookkeeping.
   */
  was: string;
}

/** Stable empty map, so switching chats does not churn the fold's dependencies. */
const NO_PENDING_REACTIONS: Record<string, PendingReaction> = {};

/** How many messages the thread opens with, and each "load older" step adds. */
const MESSAGE_WINDOW_STEP = 200;

const HIGHLIGHT_TTL_MS = 5000;

/** Longer, because a missed target comes with a notice worth reading. */
const HIGHLIGHT_MISS_TTL_MS = 12000;

/**
 * Coverage changes only when sync or a backfill moves the archive boundary, so
 * it is fetched on chat open and left alone — not polled.
 */
const COVERAGE_STALE_MS = 5 * 60_000;

/** How many older messages one "ask the phone" request tries to pull back. */
const BACKFILL_BATCH = 200;

function archiveDate(ts: string | null): string | null {
  if (!ts) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

export const ThreadView: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const presenceMap = useAppStore((s) => s.presenceMap);
  const highlightedMessageId = useAppStore((s) => s.highlightedMessageId);
  const highlightedMessageHint = useAppStore((s) => s.highlightedMessageHint);
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const triggerFocusComposer = useAppStore((s) => s.triggerFocusComposer);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeReactionMsgId, setActiveReactionMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  // Reactions sent from here, held on screen until the archive catches up, and
  // keyed by the message reacted to — all one reaction of ours can be. Sending
  // one costs a wacli spawn, the store lock, the send itself and a post-send
  // wait, and the row only reaches the thread on the poll after that, which is
  // why a click used to sit there doing nothing for most of a minute.
  //
  // Which chat it was decided for is part of the state, the same way the
  // history window is: reading it back through the current selection is what
  // scopes it to one conversation without an effect to keep the two in step.
  const [reactionState, setReactionState] = useState<{
    jid: string | null;
    pending: Record<string, PendingReaction>;
    error: string | null;
  }>({ jid: null, pending: NO_PENDING_REACTIONS, error: null });

  const reactionsAreForThisChat = reactionState.jid === (selectedChat?.jid ?? null);
  const pendingReactions = reactionsAreForThisChat ? reactionState.pending : NO_PENDING_REACTIONS;
  const reactionError = reactionsAreForThisChat ? reactionState.error : null;

  const dismissReactionError = () =>
    setReactionState((prev) => (prev.error ? { ...prev, error: null } : prev));

  // A jump we actually performed. Clearing the highlight afterwards must not
  // fall through to the scroll-to-newest branch: that yanked the operator away
  // from the message they had just been sent to, seconds after arriving.
  const jumpedToRef = useRef<string | null>(null);

  // How much history is loaded, and which chat that was decided for. Deriving
  // the size from the pair means moving to another conversation starts from the
  // newest page again, with no effect to keep the two in sync.
  const [messageWindow, setMessageWindow] = useState<{ jid: string | null; size: number }>({
    jid: null,
    size: MESSAGE_WINDOW_STEP,
  });
  const windowSize =
    messageWindow.jid === (selectedChat?.jid ?? null) ? messageWindow.size : MESSAGE_WINDOW_STEP;

  const loadOlderMessages = () => {
    setMessageWindow({ jid: selectedChat?.jid ?? null, size: windowSize + MESSAGE_WINDOW_STEP });
  };

  const queryClient = useQueryClient();

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  const readsReady = isWacliReadyForReads(health);
  const readQueryOpts = wacliReadQueryOptions<MessagePage>(
    readsReady && Boolean(selectedChat?.jid)
  );

  // The window is part of the query key, so widening it is an ordinary fetch
  // rather than a cache mutation. Everything that writes into a thread does so
  // with a prefix match, and therefore keeps working across window sizes.
  const {
    data: messagesData,
    isLoading,
    isFetching,
    isPlaceholderData,
  } = useQuery({
    queryKey: ['messages', selectedChat?.jid, windowSize],
    queryFn: () =>
      selectedChat
        ? api.getMessages({ chat: selectedChat.jid, limit: windowSize })
        : Promise.resolve({ messages: [], hasMore: false }),
    refetchInterval: POLL_MESSAGES_MS,
    // Keep the narrower window on screen while the wider one loads, so
    // "load older" extends the thread instead of blanking it.
    placeholderData: keepPreviousData,
    ...readQueryOpts,
  });

  const canLoadOlder = Boolean(messagesData?.hasMore);

  // How far back the local archive reaches. Paging the thread stops at whatever
  // sync happened to pull; this is what tells the operator whether the wall they
  // hit is the end of the conversation or just the end of what was synced.
  const { data: coverageRows } = useQuery({
    queryKey: ['coverage', selectedChat?.jid],
    queryFn: () =>
      selectedChat ? api.getHistoryCoverage({ chat: selectedChat.jid }) : Promise.resolve([]),
    staleTime: COVERAGE_STALE_MS,
    ...wacliReadQueryOptions<ChatCoverage[]>(readsReady && Boolean(selectedChat?.jid)),
  });

  const coverage = coverageRows?.[0] ?? null;
  const archiveStart = archiveDate(coverage?.oldestTs ?? null);

  const backfillMutation = useMutation({
    mutationFn: (chatJid: string) => api.backfillHistory({ chat: chatJid, count: BACKFILL_BATCH }),
    onSuccess: (_result, chatJid) => {
      queryClient.invalidateQueries({ queryKey: ['messages', chatJid] });
      queryClient.invalidateQueries({ queryKey: ['coverage', chatJid] });
    },
  });

  // Scheduled messages for current chat
  const { data: scheduledList = [] } = useQuery({
    queryKey: ['scheduled', selectedChat?.jid],
    queryFn: () => (selectedChat ? api.getScheduled({ chat: selectedChat.jid }) : []),
    enabled: Boolean(selectedChat?.jid),
    refetchInterval: POLL_SCHEDULED_MS,
  });

  const pendingScheduled = scheduledList.filter((s) => s.status === 'pending');

  const cancelScheduledMutation = useMutation({
    mutationFn: (id: string) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  // Local bookmark toggle. This is Mission Control's own flag, not WhatsApp's
  // star: wacli can read a synced star but has no command to set one, so a
  // "star" button here could never reach the phone.
  const bookmarkMutation = useMutation({
    mutationFn: (params: { chat: string; id: string; bookmarked: boolean }) =>
      api.bookmarkMessage(params),
    onMutate: async ({ chat, id, bookmarked }) => {
      await queryClient.cancelQueries({ queryKey: ['messages', chat] });
      queryClient.setQueriesData<MessagePage>({ queryKey: ['messages', chat] }, (old) =>
        old
          ? {
              ...old,
              messages: old.messages.map((m) => (m.msgId === id ? { ...m, bookmarked } : m)),
            }
          : old
      );
    },
    onError: (_err, { chat }) => {
      void queryClient.invalidateQueries({ queryKey: ['messages', chat] });
    },
  });

  // Reaction folding: map reactions onto target messages. Folding by reactor
  // rather than appending is what lets an optimistic reaction sit in the same
  // slot the archive's own row will occupy, instead of doubling the emoji up
  // the moment the real one arrives.
  const { messages, reactionsMap, myArchivedReactions } = useMemo(() => {
    const rawMessages = messagesData?.messages ?? [];
    const byTarget = new Map<string, Map<string, ThreadReaction & { at: number }>>();
    const visibleMsgs: UnifiedMessage[] = [];

    for (const msg of rawMessages) {
      if (msg.reactionToId) {
        const reactor = msg.fromMe ? MY_REACTION_KEY : msg.senderJid || msg.senderName || msg.msgId;
        const parsed = new Date(msg.ts).getTime();
        const at = Number.isNaN(parsed) ? 0 : parsed;
        const perTarget = byTarget.get(msg.reactionToId) ?? new Map();
        const seen = perTarget.get(reactor);
        // An empty emoji is a reaction being taken back, so it has to be able
        // to win too — it is only dropped once the newest one per reactor is known.
        if (!seen || at >= seen.at) {
          perTarget.set(reactor, {
            emoji: msg.reactionEmoji ?? '',
            fromMe: msg.fromMe,
            sender: msg.senderName || msg.senderJid,
            at,
          });
        }
        byTarget.set(msg.reactionToId, perTarget);
      } else {
        visibleMsgs.push(msg);
      }
    }

    // What the archive currently believes we reacted with, before our own
    // unconfirmed clicks are laid over it. That is the comparison that retires
    // a pending reaction.
    const mine = new Map<string, string>();
    for (const [target, perTarget] of byTarget) {
      mine.set(target, perTarget.get(MY_REACTION_KEY)?.emoji ?? '');
    }

    for (const [target, pending] of Object.entries(pendingReactions)) {
      // The archive has moved on: it has either caught up with this reaction or
      // learned of a newer one from another device. Either way it is now the
      // better answer, and the stand-in steps aside.
      if ((mine.get(target) ?? '') !== pending.was) continue;
      const perTarget = byTarget.get(target) ?? new Map();
      perTarget.set(MY_REACTION_KEY, {
        emoji: pending.emoji,
        fromMe: true,
        sender: 'Me',
        at: Number.MAX_SAFE_INTEGER,
      });
      byTarget.set(target, perTarget);
    }

    const rxMap = new Map<string, ThreadReaction[]>();
    for (const [target, perTarget] of byTarget) {
      const folded = [...perTarget.values()]
        .filter((rx) => rx.emoji)
        .map(({ emoji, fromMe, sender }) => ({ emoji, fromMe, sender }));
      if (folded.length > 0) {
        rxMap.set(target, folded);
      }
    }

    // Sort chronologically ascending for display
    visibleMsgs.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return { messages: visibleMsgs, reactionsMap: rxMap, myArchivedReactions: mine };
  }, [messagesData?.messages, pendingReactions]);

  // A jump target that is not in the loaded window — an old search hit, or a
  // send-log entry whose optimistic id has since been replaced by a real one.
  // Which message the jump actually lands on. An id is honoured when the thread
  // holds it; otherwise the hint recognises the message from what was sent.
  // Resolved here rather than written back to the store, so the thread stays a
  // pure reading of what is loaded.
  const jumpRequested = Boolean(highlightedMessageId || highlightedMessageHint);
  const focusedMessageId = useMemo(
    () => resolveJumpTarget(messages, highlightedMessageId, highlightedMessageHint),
    [messages, highlightedMessageId, highlightedMessageHint]
  );

  // `isPlaceholderData` carries as much weight as `isFetching`: while a chat
  // switch is in flight the thread on screen is still the previous
  // conversation's, and measuring the target against it accused the archive of
  // losing a message it had never been asked to hold.
  const highlightMissed =
    jumpRequested &&
    !isFetching &&
    !isPlaceholderData &&
    messages.length > 0 &&
    !focusedMessageId;

  // Auto-scroll to the newest message, unless we are navigating to a specific one.
  useEffect(() => {
    if (!jumpRequested) {
      // The highlight we just honoured has expired. Scrolling to the newest
      // message here is what made a jump look like it never worked: the
      // operator landed on the message, then five seconds later the thread
      // threw them back to the bottom.
      if (jumpedToRef.current) {
        jumpedToRef.current = null;
        return;
      }
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      return;
    }

    const el = focusedMessageId ? document.getElementById(`msg-${focusedMessageId}`) : null;
    if (el) {
      jumpedToRef.current = focusedMessageId;
      const raf = requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      const timer = setTimeout(() => setHighlightedMessageId(null), HIGHLIGHT_TTL_MS);
      return () => {
        cancelAnimationFrame(raf);
        clearTimeout(timer);
      };
    }

    // Put the notice and the "load older" control in view; leaving them above
    // the fold would look like the jump silently did nothing.
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }

    // Give up eventually, but always clear the id. Leaving it set used to
    // disable the auto-scroll branch above for the rest of the session, because
    // only the found path ever reset it.
    const timer = setTimeout(() => setHighlightedMessageId(null), HIGHLIGHT_MISS_TTL_MS);
    return () => clearTimeout(timer);
  }, [selectedChat?.jid, messages, jumpRequested, focusedMessageId, setHighlightedMessageId]);

  const reactMutation = useMutation({
    mutationFn: ({ msg, emoji }: { msg: UnifiedMessage; emoji: string }) =>
      api.sendReact({
        to: selectedChat!.jid,
        id: msg.msgId,
        reaction: emoji,
        sender: msg.senderJid || undefined,
        confirm: true,
      }),
    onError: (err, { msg }) => {
      // Showing the emoji before the send lands is only honest if a refusal
      // takes it away again and says why.
      setReactionState((prev) => {
        const { [msg.msgId]: _rolledBack, ...rest } = prev.pending;
        return {
          ...prev,
          pending: rest,
          error: err instanceof Error ? err.message : 'The reaction did not go out.',
        };
      });
    },
    onSuccess: (_data, { msg }) => {
      // Ask for the archive's own row now rather than waiting out the poll, so
      // the optimistic emoji is a stand-in for a second or two, not half a minute.
      void queryClient.invalidateQueries({
        queryKey: ['messages', msg.chatJid || selectedChat?.jid],
      });
    },
  });

  const handleReact = (msg: UnifiedMessage, emoji: string) => {
    if (!selectedChat) return;
    setActiveReactionMsgId(null);
    setReactionState({
      jid: selectedChat.jid,
      // What the archive says right now is the mark this stand-in watches for.
      pending: {
        ...pendingReactions,
        [msg.msgId]: { emoji, was: myArchivedReactions.get(msg.msgId) ?? '' },
      },
      error: null,
    });
    reactMutation.mutate({ msg, emoji });
  };

  const handleCopyText = async (msg: UnifiedMessage) => {
    const content = msg.displayText || msg.text || msg.mediaCaption || '';
    if (!content) return;

    try {
      await navigator.clipboard.writeText(content);
      setCopiedMsgId(msg.msgId);
      setTimeout(() => setCopiedMsgId((prev) => (prev === msg.msgId ? null : prev)), 2000);
    } catch {
      // fallback
    }
  };

  const handleToggleBookmark = (msg: UnifiedMessage) => {
    if (!selectedChat) return;
    bookmarkMutation.mutate({
      chat: selectedChat.jid,
      id: msg.msgId,
      bookmarked: !msg.bookmarked,
    });
  };

  // Shortcuts that need the loaded thread. The key handler at the app root
  // publishes a command; the pane holding the messages is what acts on it.
  useUiCommand('thread:reply-latest', () => {
    if (!selectedChat || messages.length === 0) return;
    // The newest message from someone else: quoting your own last line back
    // into the thread is almost never what "reply" is reaching for.
    const target =
      [...messages].reverse().find((m) => !m.fromMe) ?? messages[messages.length - 1];
    setReplyingTo(selectedChat.jid, target);
    triggerFocusComposer();
  });

  useUiCommand('thread:load-older', () => {
    if (!canLoadOlder || isFetching) return;
    loadOlderMessages();
  });

  useUiCommand('thread:jump-newest', () => {
    setHighlightedMessageId(null);
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  });

  if (!selectedChat) {
    if (health?.wacliInstalled === false) {
      return (
        <section
          aria-label="Conversation Thread"
          className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-text select-none p-6"
        >
          <div className="text-center space-y-4 max-w-md">
            <div className="w-12 h-12 rounded-full bg-mc-danger/10 border border-mc-danger/40 text-mc-danger flex items-center justify-center mx-auto">
              <AlertOctagon size={24} />
            </div>
            <div className="space-y-1">
              <div className="font-mono text-xs tracking-widest uppercase text-mc-danger font-bold">
                wacli CLI Not Installed
              </div>
              <div className="text-sm font-semibold text-mc-text">
                Command-line tool required
              </div>
              <p className="text-xs text-mc-textMuted font-sans">
                Mission Control connects to WhatsApp through the <code className="text-mc-danger font-mono font-semibold">wacli</code> CLI. Please install it on your system to view and manage messages.
              </p>
            </div>
            <div className="bg-mc-surface border border-mc-border rounded p-3 text-left space-y-1.5 font-mono text-xs">
              <div className="text-[11px] text-mc-textMuted flex items-center gap-1">
                <Terminal size={12} /> Install command:
              </div>
              <code className="text-mc-live text-xs block select-all">
                brew install stevemcquaid/wacli/wacli
              </code>
            </div>
          </div>
        </section>
      );
    }

    if (health?.statusSummary === 'not_authenticated' || (health?.doctor && !health.doctor.authenticated)) {
      return (
        <section
          aria-label="Conversation Thread"
          className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-text select-none p-6"
        >
          <div className="text-center space-y-4 max-w-md">
            <div className="w-12 h-12 rounded-full bg-mc-safe/10 border border-mc-safe/40 text-mc-safe flex items-center justify-center mx-auto">
              <AlertTriangle size={24} />
            </div>
            <div className="space-y-1">
              <div className="font-mono text-xs tracking-widest uppercase text-mc-safe font-bold">
                WhatsApp Account Not Paired
              </div>
              <div className="text-sm font-semibold text-mc-text">
                Pair your device to get started
              </div>
              <p className="text-xs text-mc-textMuted font-sans">
                Run the authentication command in your terminal and scan the QR code with WhatsApp on your phone:
              </p>
            </div>
            <div className="bg-mc-surface border border-mc-border rounded p-3 text-left space-y-1.5 font-mono text-xs">
              <div className="text-[11px] text-mc-textMuted flex items-center gap-1">
                <Terminal size={12} /> Terminal command:
              </div>
              <code className="text-mc-live text-xs block select-all">
                wacli auth
              </code>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section
        aria-label="Conversation Thread"
        className="flex-1 flex flex-col items-center justify-center bg-mc-bg text-mc-textMuted select-none"
      >
        <div className="text-center space-y-2">
          <div className="font-mono text-xs tracking-widest uppercase">wacli Mission Control</div>
          <div className="text-sm">Select a chat from the rail to view messages.</div>
        </div>
      </section>
    );
  }

  const presence = presenceMap[selectedChat.jid];
  const isTyping = presence && presence.state === 'composing';

  return (
    <section aria-label="Conversation Thread" className="flex-1 flex flex-col bg-mc-bg min-h-0 min-w-0 relative overflow-hidden">
      {/* Header */}
      <div className="h-14 border-b border-mc-border bg-mc-surface/80 backdrop-blur px-4 flex items-center justify-between shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold text-sm text-mc-text truncate">{selectedChat.name}</h2>
            <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded bg-mc-border/50 text-mc-textMuted">
              {selectedChat.kind}
            </span>
          </div>
          <div className="text-xs font-mono text-mc-textMuted truncate flex items-center gap-2">
            <span>{selectedChat.jid}</span>
            {isTyping && <span className="text-mc-live animate-pulse">● typing...</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {coverage && coverage.messageCount > 0 && (
            <span
              className="hidden sm:block text-[10px] font-mono text-mc-textMuted"
              title="How far back this machine's local archive reaches for this chat"
            >
              ARCHIVE {archiveStart ?? '?'} · {coverage.messageCount.toLocaleString()} MSG
            </span>
          )}
          <ExportMenu chatJid={selectedChat.jid} chatName={selectedChat.name} />
          <button
            onClick={() => setActiveModal('chat-info')}
            title="Contact details, local alias, and tags"
            aria-label="Chat info"
            className="flex items-center gap-1.5 text-[11px] font-mono px-2 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 hover:bg-mc-surfaceHover transition-colors"
          >
            <Info size={12} />
            <span>INFO</span>
          </button>
        </div>
      </div>

      {/* Scheduled Messages Banner for this chat (Send Later FR) */}
      {pendingScheduled.length > 0 && (
        <div className="bg-mc-surface border-b border-mc-border/80 px-3 py-2 flex items-center justify-between text-xs font-mono text-mc-text">
          <div className="flex items-center gap-2 truncate">
            <Clock size={14} className="text-mc-live shrink-0 animate-pulse" />
            <span className="text-mc-live font-semibold">SCHEDULED ({pendingScheduled.length}):</span>
            <span className="truncate text-mc-textMuted text-[11px]">
              {pendingScheduled[0].message || pendingScheduled[0].fileName} (due{' '}
              {new Date(pendingScheduled[0].scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})
            </span>
          </div>
          <button
            onClick={() => cancelScheduledMutation.mutate(pendingScheduled[0].id)}
            className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors shrink-0 ml-2"
            title="Cancel scheduled message"
          >
            <Trash2 size={11} />
            <span>CANCEL</span>
          </button>
        </div>
      )}

      {/* Message List */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {/* Older history. wacli keeps the full archive locally; the thread just
            has to ask for more of it. */}
        {reactionError && (
          <div
            role="alert"
            className="mb-1 p-2 rounded bg-mc-surface border border-mc-danger/40 text-[11px] font-mono text-mc-danger flex items-center gap-2"
          >
            <AlertTriangle size={13} className="shrink-0" />
            <span className="flex-1 break-words">Reaction not sent: {reactionError}</span>
            <button
              onClick={dismissReactionError}
              className="shrink-0 px-1.5 py-0.5 rounded border border-mc-danger/40 hover:bg-mc-surfaceHover transition-colors"
            >
              DISMISS
            </button>
          </div>
        )}

        {highlightMissed && (
          <div className="mb-1 p-2 rounded bg-mc-surface border border-mc-safe/40 text-[11px] font-mono text-mc-safe flex items-center gap-2">
            <AlertTriangle size={13} className="shrink-0" />
            <span>
              {canLoadOlder
                ? 'That message is older than the history loaded here — load older messages to reach it.'
                : 'That message is not in the local archive for this chat.'}
            </span>
          </div>
        )}

        {/* The local archive has run out. wacli can ask the primary device for
            more, which is the only way past this wall. */}
        {!canLoadOlder && messages.length > 0 && (
          <div className="flex flex-col items-center gap-1.5 pb-2">
            <span className="text-[10px] font-mono text-mc-textMuted text-center">
              {archiveStart
                ? `Local archive for this chat starts ${archiveStart}.`
                : 'Start of the local archive for this chat.'}
            </span>
            <button
              onClick={() => backfillMutation.mutate(selectedChat.jid)}
              disabled={backfillMutation.isPending || Boolean(health?.readOnly)}
              className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                health?.readOnly
                  ? 'Safe read-only mode is active: a backfill writes the local store, so it is disabled.'
                  : 'Ask your phone for older messages in this chat and add them to the local archive'
              }
            >
              {backfillMutation.isPending ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  <span>ASKING YOUR PHONE...</span>
                </>
              ) : (
                <>
                  <CloudDownload size={12} />
                  <span>REQUEST OLDER FROM PHONE</span>
                </>
              )}
            </button>
            {backfillMutation.isError && (
              <span className="text-[10px] font-mono text-mc-danger text-center max-w-sm">
                {(backfillMutation.error as Error).message}
              </span>
            )}
            {backfillMutation.isSuccess && !backfillMutation.isPending && (
              <span className="text-[10px] font-mono text-mc-textMuted text-center max-w-sm">
                Request sent. Your phone answers on its own schedule — anything it returns appears here.
              </span>
            )}
          </div>
        )}

        {canLoadOlder && messages.length > 0 && (
          <div className="flex justify-center pb-1">
            <button
              onClick={loadOlderMessages}
              disabled={isFetching}
              className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-live hover:border-mc-live/50 hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-wait"
              title="Load the previous 200 messages from the local archive"
            >
              {isFetching ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  <span>LOADING...</span>
                </>
              ) : (
                <>
                  <ChevronUp size={12} />
                  <span>LOAD OLDER MESSAGES</span>
                </>
              )}
            </button>
          </div>
        )}

        {isLoading ? (
          <div className="text-center py-12 text-xs font-mono text-mc-textMuted">
            Loading message history...
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <div className="w-10 h-10 rounded-full bg-mc-surface flex items-center justify-center text-mc-live border border-mc-border">
              <Reply size={18} />
            </div>
            <div className="space-y-1">
              <div className="text-mc-text font-semibold text-xs">No message history yet</div>
              <div className="text-mc-textMuted text-[11px] max-w-xs">
                Start a conversation with <span className="text-mc-text font-mono font-semibold">{selectedChat.name}</span> by typing your message in the composer below.
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => {
            const reactions = reactionsMap.get(msg.msgId) || [];
            const isMe = msg.fromMe;
            const isCopied = copiedMsgId === msg.msgId;

            return (
              <div
                key={msg.msgId}
                className={`group flex flex-col ${isMe ? 'items-end' : 'items-start'} ${
                  activeReactionMsgId === msg.msgId ? 'relative z-40' : 'relative z-0'
                }`}
              >
                {/* Sender Name in group */}
                {!isMe && msg.senderName && selectedChat.kind === 'group' && (
                  <span className="text-[11px] text-mc-textMuted font-mono px-1 mb-0.5">
                    {msg.senderName}
                  </span>
                )}

                {/* Bubble */}
                <div
                  id={`msg-${msg.msgId}`}
                  className={`relative max-w-[80%] rounded-mc p-2.5 text-xs shadow-sm transition-all duration-300 ${
                    activeReactionMsgId === msg.msgId ? 'z-40' : 'z-0'
                  } ${
                    focusedMessageId === msg.msgId
                      ? 'ring-2 ring-mc-live ring-offset-2 ring-offset-mc-bg shadow-[0_0_20px_rgba(37,211,102,0.7)] bg-[#1e3d2f] border-mc-live animate-pulse'
                      : isMe
                      ? 'bg-[#1B2823] border border-mc-live/30 text-mc-text'
                      : 'bg-mc-surface border border-mc-border text-mc-text'
                  }`}
                >
                  {/* Media Content (Image/Audio/Video/Document) */}
                  {msg.mediaType && (
                    // The message's own chat, not the selected one. While a
                    // chat switch is in flight `keepPreviousData` keeps the
                    // previous thread on screen, and pairing those messages
                    // with the newly selected JID asked wacli to download
                    // media for a chat the message is not in — a guaranteed
                    // 404, and a doomed subprocess for every attachment.
                    <MediaViewer msg={msg} chatJid={msg.chatJid || selectedChat.jid} />
                  )}

                  {/* Body Text — selectable so operators can copy codes, addresses, numbers.
                      `dir` is per message, not per chat: a thread mixes Hebrew and
                      English freely, and it is the body that decides which edge it
                      hangs from and where its punctuation lands. A revoked message
                      shows our own English notice, so it stays left-to-right. */}
                  {(msg.displayText || msg.text) && (
                    <div
                      dir={msg.revoked ? 'ltr' : detectTextDirection(msg.displayText || msg.text)}
                      className="whitespace-pre-wrap break-words leading-relaxed select-text cursor-text text-start"
                    >
                      {msg.revoked ? (
                        <span className="italic text-mc-textMuted">This message was deleted.</span>
                      ) : (
                        msg.displayText || msg.text
                      )}
                    </div>
                  )}

                  {/* Message Footer: Timestamp, Edited, Star Badge, Status */}
                  <div className="flex items-center justify-end gap-1.5 mt-1 text-[10px] font-mono text-mc-textMuted">
                    {msg.starred && (
                      <span title="Starred in WhatsApp">
                        <Star size={11} className="fill-[#F5A623] text-[#F5A623]" />
                      </span>
                    )}
                    {msg.bookmarked && (
                      <span title="Bookmarked in Mission Control (this machine only)">
                        <Bookmark size={11} className="fill-mc-live text-mc-live" />
                      </span>
                    )}
                    {msg.edited && <span className="italic">edited</span>}
                    <span>
                      {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {isMe && (
                      <span title={msg.deliveryStatus ?? 'sent'}>
                        {msg.deliveryStatus === 'read' || msg.deliveryStatus === 'played' ? (
                          <CheckCheck size={12} className="text-mc-live" />
                        ) : msg.deliveryStatus === 'delivered' ? (
                          <CheckCheck size={12} className="text-mc-textMuted" />
                        ) : (
                          <Check size={12} className="text-mc-textMuted" />
                        )}
                      </span>
                    )}
                  </div>

                  {/* Reactions Badge */}
                  {reactions.length > 0 && (
                    <div className="absolute -bottom-2 right-2 flex gap-0.5 bg-mc-surface border border-mc-border rounded-full px-1.5 py-0.2 text-[11px] shadow-sm">
                      {reactions.map((rx, i) => (
                        <span key={i} title={rx.sender}>
                          {rx.emoji}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Hover Quick Actions Menu (FR-SR-7) */}
                  <div className="absolute -top-3.5 right-2 hidden group-hover:flex items-center gap-0.5 bg-mc-surface/95 backdrop-blur-sm border border-mc-border rounded px-1 py-0.5 shadow-md z-20">
                    {/* Reply */}
                    <button
                      onClick={() => setReplyingTo(selectedChat.jid, msg)}
                      className="p-1 hover:text-mc-live text-mc-textMuted hover:bg-mc-surfaceHover rounded transition-colors"
                      title="Reply"
                    >
                      <Reply size={12} />
                    </button>

                    {/* Copy Text to Clipboard */}
                    <button
                      onClick={() => handleCopyText(msg)}
                      className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                        isCopied ? 'text-mc-live' : 'text-mc-textMuted hover:text-mc-text'
                      }`}
                      title={isCopied ? 'Copied to clipboard!' : 'Copy message text'}
                    >
                      {isCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>

                    {/* Local bookmark. Named for what it is: wacli cannot write
                        WhatsApp's star, so this never leaves this machine. */}
                    <button
                      onClick={() => handleToggleBookmark(msg)}
                      className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                        msg.bookmarked ? 'text-mc-live' : 'text-mc-textMuted hover:text-mc-live'
                      }`}
                      title={
                        msg.bookmarked
                          ? 'Remove local bookmark'
                          : 'Bookmark locally (not synced to WhatsApp)'
                      }
                    >
                      <Bookmark size={12} className={msg.bookmarked ? 'fill-mc-live' : ''} />
                    </button>

                    {/* Expanded Emoji Reaction Drawer */}
                    <button
                      onClick={() =>
                        setActiveReactionMsgId(
                          activeReactionMsgId === msg.msgId ? null : msg.msgId
                        )
                      }
                      className={`p-1 hover:bg-mc-surfaceHover rounded transition-colors ${
                        activeReactionMsgId === msg.msgId
                          ? 'text-mc-live'
                          : 'text-mc-textMuted hover:text-mc-live'
                      }`}
                      title="React with emoji"
                    >
                      <Smile size={12} />
                    </button>
                  </div>

                  {/* Expanded Emoji Drawer Popover */}
                  {activeReactionMsgId === msg.msgId && (
                    <EmojiReactionDrawer
                      align={isMe ? 'right' : 'left'}
                      onSelectEmoji={(emoji) => handleReact(msg, emoji)}
                      onClose={() => setActiveReactionMsgId(null)}
                    />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
};
