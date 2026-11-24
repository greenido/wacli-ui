import { useState } from 'react';
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { api, ApiClientError } from '../../api/client.ts';
import { POLL_MESSAGES_MS, pollBehindFeed, wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { useAppStore } from '../../store/appStore.ts';
import {
  hasMessage,
  newerCursor,
  newerPage,
  olderCursor,
  shouldPollThread,
  windowPage,
  type MessagePage,
  type MessagePages,
  type WindowPageParam,
} from '../../lib/messagePages.ts';

/** How many messages the thread opens with, and each "load older" step adds. */
export const MESSAGE_PAGE_SIZE = 200;

/** How many messages a history window opens with on either side of its moment. */
const WINDOW_SIDE = 100;

/** A second on. wacli's `--before` is strict and counts whole seconds. */
function secondAfter(ts: string): string {
  return new Date(new Date(ts).getTime() + 1000).toISOString();
}

/** One page of a history window: around its moment, or on back or forward. */
async function fetchWindowPage(chat: string, param: WindowPageParam): Promise<MessagePage> {
  if ('before' in param) {
    return api.getMessages({ chat, limit: MESSAGE_PAGE_SIZE, before: param.before });
  }
  if ('after' in param) {
    // Oldest first. Newest first, the page would be the newest messages in
    // the chat rather than the ones that follow the window.
    return newerPage(
      await api.getMessages({ chat, limit: MESSAGE_PAGE_SIZE, after: param.after, asc: true })
    );
  }
  const [older, newer] = await Promise.all([
    // Up to and including the moment itself.
    api.getMessages({ chat, limit: WINDOW_SIDE, before: secondAfter(param.around) }),
    api.getMessages({ chat, limit: WINDOW_SIDE, after: param.around, asc: true }),
  ]);
  return windowPage(older, newer);
}

interface ThreadPagesOptions {
  chatJid: string | null;
  /** Whether wacli may be asked anything right now (awake, and ready). */
  readsReady: boolean;
  /** The message a jump is heading for, and when it was sent. */
  jumpTargetId: string | null;
  jumpTargetAt: string | null;
}

/**
 * The pages of messages a thread shows: the live thread, newest first, or —
 * while a jump has sent it into older history — a window around one moment.
 */
export function useThreadPages({ chatJid, readsReady, jumpTargetId, jumpTargetAt }: ThreadPagesOptions) {
  /**
   * History around a message older than the live pages reach, opened for a
   * jump to it, in the chat it was opened for.
   */
  const [historyWindow, setHistoryWindow] = useState<{
    jid: string;
    msgId: string;
    at: string;
  } | null>(null);

  const changeFeedLive = useAppStore((s) => s.changeFeedLive);

  // One page per "load older", walked back with a `before` cursor, rather than
  // one ever-widening `limit`. Re-reading the whole thread to reach 200 more
  // messages is what made the sixth step cost a 1200-message subprocess — and
  // then cost it again on every poll.
  const liveThread = useInfiniteQuery<MessagePage, ApiClientError, MessagePages, unknown[], string | undefined>({
    queryKey: ['messages', chatJid ?? undefined],
    queryFn: ({ pageParam }) =>
      chatJid
        ? api.getMessages({
            chat: chatJid,
            limit: MESSAGE_PAGE_SIZE,
            before: pageParam,
          })
        : Promise.resolve({ messages: [], hasMore: false }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? olderCursor(lastPage) : undefined),
    // Behind the change feed this only has receipts left to catch, and the
    // feed refetches every page of a thread that changed, however deep.
    refetchInterval: (query) =>
      shouldPollThread(query.state.data?.pages.length ?? 1)
        ? pollBehindFeed(POLL_MESSAGES_MS, changeFeedLive)
        : false,
    // Keep the previous conversation on screen while the next one loads, so
    // switching chats does not blank the pane.
    placeholderData: keepPreviousData,
    ...wacliReadQueryOptions(readsReady && Boolean(chatJid)),
  });

  // The window this chat is reading, if any. One left open in another chat
  // is closed below, before anything reads it.
  const windowAt = historyWindow?.jid === chatJid ? (historyWindow?.at ?? null) : null;

  // History around one moment, and from there back or forward on demand. Not
  // polled: it is settled history, and the live thread goes on following the
  // newest message underneath it.
  const windowThread = useInfiniteQuery<MessagePage, ApiClientError, MessagePages, unknown[], WindowPageParam>({
    queryKey: ['messages', chatJid ?? undefined, 'around', windowAt],
    queryFn: ({ pageParam }) => fetchWindowPage(chatJid!, pageParam),
    initialPageParam: { around: windowAt ?? '' },
    getNextPageParam: (lastPage) => {
      const before = lastPage.hasMore ? olderCursor(lastPage) : undefined;
      return before ? { before } : undefined;
    },
    getPreviousPageParam: (firstPage) => {
      const after = firstPage.hasNewer ? newerCursor(firstPage) : undefined;
      return after ? { after } : undefined;
    },
    ...wacliReadQueryOptions(readsReady && Boolean(chatJid && windowAt)),
  });

  // Opened in one chat, a window has nothing to say about the next: a chat
  // always opens on its newest messages.
  if (historyWindow && historyWindow.jid !== chatJid) {
    setHistoryWindow(null);
  }

  // A jump to a message the live pages do not hold opens a window around it,
  // however far back it is: two reads of the archive, where paging back to it
  // could take dozens. Judged once the live pages have settled, so a switch to
  // the hit's chat is not measured against the previous chat's messages.
  const liveData = liveThread.data;
  if (
    chatJid &&
    jumpTargetId &&
    jumpTargetAt &&
    liveData &&
    !liveThread.isFetching &&
    !liveThread.isPlaceholderData
  ) {
    const inLive = hasMessage(liveData, jumpTargetId);
    const openFor = windowAt ? historyWindow?.msgId : null;
    if (!inLive && openFor !== jumpTargetId) {
      setHistoryWindow({ jid: chatJid, msgId: jumpTargetId, at: jumpTargetAt });
    } else if (inLive && windowAt) {
      setHistoryWindow(null);
    }
  }

  return {
    /** Whichever the thread is showing. */
    active: windowAt ? windowThread : liveThread,
    windowThread,
    /** The moment the open history window is around, or null on the live thread. */
    windowAt,
    closeWindow: () => setHistoryWindow(null),
  };
}
