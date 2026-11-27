import React, { useCallback, useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import {
  Reply,
  ChevronUp,
  ChevronDown,
  ArrowDownToLine,
  History,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { useHealth } from '../../hooks/useHealth.ts';
import { ensureAwake, useSleepMode } from '../../hooks/useSleepMode.ts';
import { useUiCommand } from '../../hooks/useUiCommand.ts';
import { useAppStore } from '../../store/appStore.ts';
import { resolveJumpTarget } from '../../lib/messageJump.ts';
import { distanceFromBottom, shouldFollowNewest } from '../../lib/threadScroll.ts';
import { dayStartKeys, mergeTimeline } from '../../lib/callTimeline.ts';
import { flattenMessagePages, patchMessages, type MessagePages } from '../../lib/messagePages.ts';
import { CallRow } from './CallRow.tsx';
import { DayDivider } from './DayDivider.tsx';
import { MessageRow, type ThreadReaction } from './MessageRow.tsx';
import { ThreadEmptyState } from './ThreadEmptyState.tsx';
import { ThreadHeader } from './ThreadHeader.tsx';
import { ScheduledBanner } from './ScheduledBanner.tsx';
import { ArchiveBoundary } from './ArchiveBoundary.tsx';
import { useThreadPages } from './useThreadPages.ts';
import { useThreadReactions } from './useThreadReactions.ts';
import { useThreadCalls } from './useThreadCalls.ts';
import type { UnifiedMessage } from '../../types.ts';
import type { MessageActionKind } from '../../lib/messageActions.ts';

/** Shared by every row without reactions, so none of them looks changed. */
const NO_REACTIONS: ThreadReaction[] = [];

const HIGHLIGHT_TTL_MS = 5000;

/** Longer, because a missed target comes with a notice worth reading. */
const HIGHLIGHT_MISS_TTL_MS = 12000;

/**
 * Coverage changes only when sync or a backfill moves the archive boundary, so
 * it is fetched on chat open and left alone — not polled.
 */
const COVERAGE_STALE_MS = 5 * 60_000;

function archiveDate(ts: string | null): string | null {
  if (!ts) return null;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * One conversation: its messages, and the reading position within them.
 *
 * Which pages are loaded is `useThreadPages`, and the reactions folded onto
 * them are `useThreadReactions`. What stays here is scrolling: following the
 * newest message, holding the reading position while older history lands, and
 * landing a jump on its target. Those share refs too closely to split.
 */
export const ThreadView: React.FC = () => {
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setReplyingTo = useAppStore((s) => s.setReplyingTo);
  const openMessageAction = useAppStore((s) => s.openMessageAction);
  const highlightedMessageId = useAppStore((s) => s.highlightedMessageId);
  const highlightedMessageHint = useAppStore((s) => s.highlightedMessageHint);
  const highlightedMessageAt = useAppStore((s) => s.highlightedMessageAt);
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId);
  const triggerFocusComposer = useAppStore((s) => s.triggerFocusComposer);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeReactionMsgId, setActiveReactionMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  // A jump we actually performed. Clearing the highlight afterwards must not
  // fall through to the scroll-to-newest branch: that yanked the operator away
  // from the message they had just been sent to, seconds after arriving.
  const jumpedToRef = useRef<string | null>(null);

  const queryClient = useQueryClient();

  const { data: health } = useHealth();

  // Asleep, nothing reaches wacli: what is on screen stays as it was.
  const { awake } = useSleepMode();
  const readsReady = awake && isWacliReadyForReads(health);

  const { active, windowThread, windowAt, closeWindow } = useThreadPages({
    chatJid: selectedChat?.jid ?? null,
    readsReady,
    jumpTargetId: highlightedMessageId,
    jumpTargetAt: highlightedMessageAt,
  });

  // Whichever the thread is showing. Everything below reads this one.
  const {
    data: messagePages,
    isLoading,
    isFetching,
    isPlaceholderData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = active;

  const canLoadOlder = Boolean(hasNextPage);

  /**
   * How far the reading position sat from the bottom when a "load older" began,
   * or null when no such fetch is outstanding.
   *
   * Prepending history grows the scrollable area upwards. Measuring from the
   * bottom rather than the top is what survives that growth: re-applying it
   * afterwards leaves the line the operator was reading exactly where it was,
   * instead of dropping them back at the newest message.
   */
  const olderAnchorRef = useRef<number | null>(null);

  /** Set for the one commit that restores an anchor, so auto-scroll stands down. */
  const restoredOlderRef = useRef(false);

  /**
   * How far the reading position sat above the bottom when the operator last
   * moved it. Recorded on scroll rather than measured in the effect, because by
   * then the new message is already laid out and the distance it would report
   * is one the operator never chose.
   */
  const distanceFromBottomRef = useRef(0);

  /** Which conversation that distance belongs to, so opening another resets it. */
  const followedChatRef = useRef<string | null>(null);

  const handleThreadScroll = () => {
    if (scrollRef.current) {
      distanceFromBottomRef.current = distanceFromBottom(scrollRef.current);
    }
  };

  const loadOlderMessages = () => {
    if (!hasNextPage || isFetchingNextPage) return;
    const el = scrollRef.current;
    olderAnchorRef.current = el ? el.scrollHeight - el.scrollTop : null;
    // Paging bypasses `enabled`, so it wakes a sleeping app itself rather than
    // asking a server that would refuse it.
    void ensureAwake(queryClient, 'load older').then(() => fetchNextPage());
  };

  // Forward from a window, at the bottom of the thread. Nothing to hold in
  // place: what lands goes below the reading position, not above it.
  const loadNewerMessages = () => {
    if (!windowThread.hasPreviousPage || windowThread.isFetchingPreviousPage) return;
    void ensureAwake(queryClient, 'load newer').then(() => windowThread.fetchPreviousPage());
  };

  /** Leaves any history window for the live thread, at its newest message. */
  const backToLatest = () => {
    closeWindow();
    // Still set, the jump would open the window straight back up.
    setHighlightedMessageId(null);
    // An ask to go to the newest message is also an ask to follow it again,
    // not to stay where the jump put us.
    jumpedToRef.current = null;
    distanceFromBottomRef.current = 0;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    if (anchor === null) return;
    olderAnchorRef.current = null;
    restoredOlderRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchor;
  }, [messagePages]);

  // How far back the local archive reaches. Paging the thread stops at whatever
  // sync happened to pull; this is what tells the operator whether the wall they
  // hit is the end of the conversation or just the end of what was synced.
  const { data: coverageRows } = useQuery({
    queryKey: ['coverage', selectedChat?.jid],
    queryFn: () =>
      selectedChat ? api.getHistoryCoverage({ chat: selectedChat.jid }) : Promise.resolve([]),
    staleTime: COVERAGE_STALE_MS,
    ...wacliReadQueryOptions(readsReady && Boolean(selectedChat?.jid)),
  });

  const coverage = coverageRows?.[0] ?? null;
  const archiveStart = archiveDate(coverage?.oldestTs ?? null);

  // Local bookmark toggle. This is Mission Control's own flag, not WhatsApp's
  // star: wacli can read a synced star but has no command to set one, so a
  // "star" button here could never reach the phone.
  const bookmarkMutation = useMutation({
    mutationFn: (params: {
      chat: string;
      id: string;
      bookmarked: boolean;
      chatName?: string;
      senderName?: string;
      text?: string;
      ts?: string;
    }) => api.bookmarkMessage(params),
    onMutate: async ({ chat, id, bookmarked }) => {
      await queryClient.cancelQueries({ queryKey: ['messages', chat] });
      queryClient.setQueriesData<MessagePages>({ queryKey: ['messages', chat] }, (old) =>
        patchMessages(
          old,
          (m) => m.msgId === id,
          (m) => ({ ...m, bookmarked })
        )
      );
    },
    onError: (_err, { chat }) => {
      void queryClient.invalidateQueries({ queryKey: ['messages', chat] });
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });

  const loadedMessages = useMemo(() => flattenMessagePages(messagePages), [messagePages]);

  const { messages, reactionsMap, reactionError, dismissReactionError, onReact: react } =
    useThreadReactions(selectedChat?.jid ?? null, loadedMessages);

  // What a reply quotes, when it is loaded. Each entry is the same object as
  // the message itself, so a row's `quoted` prop only changes with the quote.
  const messagesById = useMemo(
    () => new Map(messages.map((msg) => [msg.msgId, msg])),
    [messages]
  );

  // Calls sit between the messages they came between.
  const calls = useThreadCalls({
    chatJid: selectedChat?.jid ?? null,
    readsReady,
    messages,
    canLoadOlder,
    canLoadNewer: Boolean(windowAt && windowThread.hasPreviousPage),
  });
  const timeline = useMemo(() => mergeTimeline(messages, calls), [messages, calls]);

  // The first line of each local day, which is where a divider goes.
  const dayStarts = useMemo(() => dayStartKeys(timeline), [timeline]);

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
    // Older history just landed and the layout pass has already put the reading
    // position back. Scrolling to the newest message now is exactly what "load
    // older" is asking not to happen.
    if (restoredOlderRef.current) {
      restoredOlderRef.current = false;
      return;
    }

    if (!jumpRequested) {
      // The highlight we just honoured has expired. Scrolling to the newest
      // message here is what made a jump look like it never worked: the
      // operator landed on the message, then five seconds later the thread
      // threw them back to the bottom.
      if (jumpedToRef.current) {
        jumpedToRef.current = null;
        return;
      }

      // A conversation just opened always shows its newest message.
      const openedAnotherChat = followedChatRef.current !== (selectedChat?.jid ?? null);
      followedChatRef.current = selectedChat?.jid ?? null;
      if (openedAnotherChat) {
        distanceFromBottomRef.current = 0;
      }

      // A window onto older history is read at the operator's own pace, not
      // followed: loading newer messages into it must not throw them to its end.
      if (windowAt) {
        return;
      }

      // Following the live edge, or reading back through history? Judged on
      // where the operator was before this message was laid out — see
      // lib/threadScroll.
      if (!shouldFollowNewest(distanceFromBottomRef.current)) {
        return;
      }

      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        distanceFromBottomRef.current = 0;
      }
      return;
    }

    const el = focusedMessageId ? document.getElementById(`msg-${focusedMessageId}`) : null;
    if (el) {
      jumpedToRef.current = focusedMessageId;
      const raf = requestAnimationFrame(() => {
        // Straight there in a window. It replaced the thread outright, so
        // there is no reading position to glide from, and gliding across
        // thousands of pixels spent the highlight before it arrived.
        el.scrollIntoView({ behavior: windowAt ? 'auto' : 'smooth', block: 'center' });
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
  }, [selectedChat?.jid, messages, jumpRequested, focusedMessageId, setHighlightedMessageId, windowAt]);

  // `react` is the same function for the life of the thread, so this is too.
  const onReact = useCallback(
    (msg: UnifiedMessage, emoji: string) => {
      setActiveReactionMsgId(null);
      react(msg, emoji);
    },
    [react]
  );

  const selectedJid = selectedChat?.jid;

  const onReply = useCallback(
    (msg: UnifiedMessage) => {
      if (selectedJid) setReplyingTo(selectedJid, msg);
    },
    [selectedJid, setReplyingTo]
  );

  // A quoted message is jumped to the way a search hit is: by id, with its time
  // to open a window around it when the live pages do not reach back that far.
  const onJumpToMessage = useCallback(
    (msgId: string, at: string) => setHighlightedMessageId(msgId, null, at),
    [setHighlightedMessageId]
  );

  const handleCopyText = useCallback(async (msg: UnifiedMessage) => {
    const content = msg.displayText || msg.text || msg.mediaCaption || '';
    if (!content) return;

    try {
      await navigator.clipboard.writeText(content);
      setCopiedMsgId(msg.msgId);
      setTimeout(() => setCopiedMsgId((prev) => (prev === msg.msgId ? null : prev)), 2000);
    } catch {
      // fallback
    }
  }, []);

  const { mutate: bookmark } = bookmarkMutation;
  const selectedChatName = selectedChat?.name;

  const onMessageAction = useCallback(
    (msg: UnifiedMessage, kind: MessageActionKind) => {
      if (!selectedJid) return;
      openMessageAction({ kind, msg, chatJid: msg.chatJid || selectedJid, chatName: selectedChatName ?? selectedJid });
    },
    [selectedJid, selectedChatName, openMessageAction]
  );

  const handleToggleBookmark = useCallback(
    (msg: UnifiedMessage) => {
      if (!selectedJid) return;
      const snippet = msg.displayText || msg.text || msg.mediaCaption || msg.filename || undefined;
      bookmark({
        chat: selectedJid,
        id: msg.msgId,
        bookmarked: !msg.bookmarked,
        chatName: selectedChatName || msg.chatName || undefined,
        senderName: msg.fromMe ? 'Me' : msg.senderName || msg.senderJid || undefined,
        text: snippet,
        ts: msg.ts || undefined,
      });
    },
    [selectedJid, selectedChatName, bookmark]
  );

  const toggleReactionDrawer = useCallback(
    (msgId: string) => setActiveReactionMsgId((current) => (current === msgId ? null : msgId)),
    []
  );
  const closeReactionDrawer = useCallback(() => setActiveReactionMsgId(null), []);

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
    if (!canLoadOlder || isFetchingNextPage) return;
    loadOlderMessages();
  });

  useUiCommand('thread:jump-newest', () => backToLatest());

  if (!selectedChat) {
    return <ThreadEmptyState health={health} />;
  }

  return (
    <section aria-label="Conversation Thread" className="flex-1 flex flex-col bg-mc-bg min-h-0 min-w-0 relative overflow-hidden">
      <ThreadHeader chat={selectedChat} coverage={coverage} archiveStart={archiveStart} />

      {/* Scheduled Messages Banner for this chat (Send Later FR) */}
      <ScheduledBanner chatJid={selectedChat.jid} />

      {/* Outside the list, so it stays in view however far the window is
          scrolled: the thread below is not the live one. */}
      {windowAt && (
        <div className="px-4 py-1.5 border-b border-mc-border bg-mc-surface flex items-center justify-between gap-3 text-[11px] font-mono text-mc-textMuted shrink-0">
          <span className="flex items-center gap-1.5 min-w-0">
            <History size={12} className="shrink-0 text-mc-accent" />
            <span className="truncate">Reading history from {archiveDate(windowAt) ?? 'an earlier date'}</span>
          </span>
          <button
            onClick={backToLatest}
            className="shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded border border-mc-border hover:text-mc-accent hover:border-mc-accent/50 hover:bg-mc-surfaceHover transition-colors"
            title="Back to the newest messages in this chat"
          >
            <ArrowDownToLine size={12} />
            <span>BACK TO LATEST</span>
          </button>
        </div>
      )}

      {/* Message List */}
      <div
        ref={scrollRef}
        onScroll={handleThreadScroll}
        className="flex-1 overflow-y-auto p-4 space-y-3"
      >
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
          <ArchiveBoundary
            chatJid={selectedChat.jid}
            archiveStart={archiveStart}
            readOnly={Boolean(health?.readOnly)}
          />
        )}

        {canLoadOlder && messages.length > 0 && (
          <div className="flex justify-center pb-1">
            <button
              onClick={loadOlderMessages}
              disabled={isFetchingNextPage}
              className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-accent hover:border-mc-accent/50 hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-wait"
              title="Load the previous 200 messages from the local archive"
            >
              {isFetchingNextPage ? (
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
        ) : timeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center space-y-3">
            <div className="w-10 h-10 rounded-full bg-mc-surface flex items-center justify-center text-mc-accent border border-mc-border">
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
          timeline.map((item) => {
            // The divider's slot is there, empty, for every line, so a row
            // keeps its place (and its memoised render) when older history
            // lands and the day's first line changes.
            const divider = dayStarts.has(item.key) && <DayDivider ts={item.ts} />;
            if (item.kind === 'call') {
              return (
                <React.Fragment key={item.key}>
                  {divider}
                  <CallRow call={item.call} />
                </React.Fragment>
              );
            }
            const msg = item.msg;
            return (
              <React.Fragment key={item.key}>
                {divider}
                <MessageRow
                  msg={msg}
                  reactions={reactionsMap.get(msg.msgId) ?? NO_REACTIONS}
                  quoted={(msg.quotedMsgId && messagesById.get(msg.quotedMsgId)) || null}
                  isGroup={selectedChat.kind === 'group'}
                  mediaChatJid={msg.chatJid || selectedChat.jid}
                  isFocused={focusedMessageId === msg.msgId}
                  isCopied={copiedMsgId === msg.msgId}
                  isReactionDrawerOpen={activeReactionMsgId === msg.msgId}
                  onReply={onReply}
                  onCopy={handleCopyText}
                  onToggleBookmark={handleToggleBookmark}
                  onToggleReactionDrawer={toggleReactionDrawer}
                  onCloseReactionDrawer={closeReactionDrawer}
                  onReact={onReact}
                  onJumpToMessage={onJumpToMessage}
                  onMessageAction={onMessageAction}
                />
              </React.Fragment>
            );
          })
        )}

        {/* A window's own end: more of it, or, once it reaches the newest
            message, the live thread. */}
        {windowAt && messages.length > 0 && (
          <div className="flex justify-center pt-1">
            {windowThread.hasPreviousPage ? (
              <button
                onClick={loadNewerMessages}
                disabled={windowThread.isFetchingPreviousPage}
                className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-accent hover:border-mc-accent/50 hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-wait"
                title="Load the next 200 messages from the local archive"
              >
                {windowThread.isFetchingPreviousPage ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    <span>LOADING...</span>
                  </>
                ) : (
                  <>
                    <ChevronDown size={12} />
                    <span>LOAD NEWER MESSAGES</span>
                  </>
                )}
              </button>
            ) : (
              <button
                onClick={backToLatest}
                className="flex items-center gap-1.5 text-[11px] font-mono px-2.5 py-1 rounded border border-mc-border text-mc-textMuted hover:text-mc-accent hover:border-mc-accent/50 hover:bg-mc-surfaceHover transition-colors"
                title="Back to the live thread"
              >
                <ArrowDownToLine size={12} />
                <span>BACK TO LATEST</span>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
