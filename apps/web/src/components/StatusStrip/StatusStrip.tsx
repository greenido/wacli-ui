import React, { useState, useMemo } from 'react';
import { Activity, Bookmark, Clock, Hourglass, LifeBuoy, Moon, Settings } from 'lucide-react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useHealth } from '../../hooks/useHealth.ts';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import { useScheduledQueue } from '../../hooks/useScheduledQueue.ts';
import { useSleepMode } from '../../hooks/useSleepMode.ts';
import { POLL_ACTIVITY_MS, POLL_WAITING_MS, wacliReadQueryOptions } from '../../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../../lib/wacliReady.ts';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll.ts';
import { useAppStore } from '../../store/appStore.ts';
import { ResendConfirmModal } from './ResendConfirmModal.tsx';
import { HealthPanel } from './HealthPanel.tsx';
import { ActivityTab } from './ActivityTab.tsx';
import { ScheduledTab } from './ScheduledTab.tsx';
import { SavedTab } from './SavedTab.tsx';
import { WaitingTab } from './WaitingTab.tsx';
import { useOpenMessage } from './useOpenMessage.ts';
import { useScheduledActions } from './useScheduledActions.ts';
import type { SendLogEntry } from '../../types.ts';

interface StatusStripProps {
  wsConnected: boolean;
  width?: number;
}

type Tab = 'activity' | 'scheduled' | 'saved' | 'waiting';

/**
 * The right-hand pane: system health on top, and below it four lists: what
 * the console has done or will do, what the operator saved, and who has yet to
 * answer them. The lists' data lives here rather than in each tab, because the
 * tab bar shows every count at once.
 */
export const StatusStrip: React.FC<StatusStripProps> = ({ wsConnected, width = 256 }) => {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const sendLogs = useAppStore((s) => s.sendLogs);
  const selectedJid = useAppStore((s) => s.selectedChat?.jid);
  const setComposerDraft = useAppStore((s) => s.setComposerDraft);
  const triggerFocusComposer = useAppStore((s) => s.triggerFocusComposer);
  const [activeTab, setActiveTab] = useState<Tab>('activity');

  const openMessage = useOpenMessage();
  const scheduledActions = useScheduledActions();

  const { data: health } = useHealth();
  const { isReadOnly } = useSafeMode();
  const { known: sleepKnown, sleeping, awake, setSleeping, isSettingSleep, sleepError } = useSleepMode();

  const sortedSendLogs = useMemo(
    () =>
      [...sendLogs].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    [sendLogs]
  );

  const openSendLog = (log: SendLogEntry) => {
    // An error row never produced a WhatsApp message. Jumping into the thread
    // can only report it missing ("older than the history loaded here"), so
    // reopen the text in the composer instead — replace any draft already
    // there, because the click is an explicit retry of this failed send.
    if (log.status === 'error') {
      openMessage(log.to, log.chatName);
      setComposerDraft(log.to, log.message);
      triggerFocusComposer();
      return;
    }

    openMessage(log.to, log.chatName, log.messageId, {
      text: log.message,
      sentAfter: log.timestamp,
    });
  };

  const scheduledQuery = useScheduledQueue();

  const activityQuery = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => api.getActivity({ before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_ACTIVITY_MS,
  });

  const bookmarksQuery = useQuery({
    queryKey: ['bookmarks'],
    queryFn: () => api.getBookmarks(),
  });

  const bookmarks = bookmarksQuery.data ?? [];

  // Reaches wacli (the server's scan of recent messages), so it waits for the
  // same readiness the chat rail does, and asleep it keeps what it last had.
  const waitingQuery = useQuery({
    queryKey: ['waiting'],
    queryFn: () => api.getWaiting(),
    refetchInterval: POLL_WAITING_MS,
    ...wacliReadQueryOptions(awake && isWacliReadyForReads(health)),
  });
  const waitingItems = useMemo(() => waitingQuery.data?.items ?? [], [waitingQuery.data]);

  // The `?? []` fallback allocates a fresh array each render, so it lives
  // inside the memo rather than feeding one from outside.
  const pendingScheduled = useMemo(
    () => scheduledQuery.data?.pages[0]?.pending ?? [],
    [scheduledQuery.data]
  );

  /**
   * In-flight sends first, then the server's record.
   *
   * The local rows exist only between clicking send and the server answering,
   * and are dropped the moment its row lands — so this concatenation cannot
   * show the same send twice.
   */
  const activityRows = useMemo(
    () => [...sortedSendLogs, ...(activityQuery.data?.pages.flatMap((p) => p.items) ?? [])],
    [sortedSendLogs, activityQuery.data]
  );

  // Pending first, then resolved history: what is about to happen reads above
  // what already did, and pending is never paged away.
  const scheduledRows = useMemo(
    () => [
      ...pendingScheduled,
      ...(scheduledQuery.data?.pages.flatMap((p) => p.history) ?? []),
    ],
    [pendingScheduled, scheduledQuery.data]
  );

  const activityTotal = (activityQuery.data?.pages[0]?.total ?? 0) + sortedSendLogs.length;
  const scheduledCount = scheduledQuery.data?.pages[0]?.totalPending ?? 0;

  const activitySentinelRef = useInfiniteScroll({
    hasMore: activityQuery.hasNextPage,
    isLoading: activityQuery.isFetchingNextPage,
    onLoadMore: () => void activityQuery.fetchNextPage(),
  });

  const scheduledSentinelRef = useInfiniteScroll({
    hasMore: scheduledQuery.hasNextPage,
    isLoading: scheduledQuery.isFetchingNextPage,
    onLoadMore: () => void scheduledQuery.fetchNextPage(),
  });

  const tabClass = (tab: Tab, activeColor: string) =>
    `px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
      activeTab === tab
        ? `bg-mc-surfaceHover ${activeColor} font-bold`
        : 'text-mc-textMuted hover:text-mc-text'
    }`;

  const { resendTarget } = scheduledActions;

  return (
    <aside
      aria-label="System status strip"
      style={{ width }}
      className="shrink-0 bg-mc-surface flex flex-col h-full select-none text-xs font-mono"
    >
      {/* Header */}
      <div className="h-12 border-b border-mc-border flex items-center justify-between px-3">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-mc-live" />
          <span className="font-semibold text-mc-text tracking-wider">SYSTEM STATUS</span>
        </div>
        <div className="flex items-center gap-0.5">
          {/* No confirmation: sleep takes nothing away that waking does not
              give back, and the scheduled queue keeps sending either way. */}
          <button
            onClick={() => setSleeping(!sleeping, 'moon button')}
            disabled={!sleepKnown || isSettingSleep}
            aria-label="Sleep mode"
            aria-pressed={sleeping}
            className={`p-1 rounded hover:bg-mc-surfaceHover transition-colors disabled:opacity-50 ${
              sleeping ? 'bg-mc-surfaceHover text-mc-text' : 'text-mc-textMuted hover:text-mc-text'
            }`}
            title={
              sleeping
                ? 'Asleep: only scheduled messages go out. Click to wake.'
                : 'Sleep: stop syncing and refreshing; scheduled messages still go out'
            }
          >
            <Moon size={15} />
          </button>
          <button
            onClick={() => setActiveModal('help')}
            aria-label="Help and keyboard shortcuts"
            className="p-1 rounded hover:bg-mc-surfaceHover text-mc-textMuted hover:text-mc-text transition-colors"
            title="Help & keyboard shortcuts  ( ? )"
          >
            <LifeBuoy size={15} />
          </button>
          <button
            onClick={() => setActiveModal('settings')}
            aria-label="Settings and diagnostics"
            className="p-1 rounded hover:bg-mc-surfaceHover text-mc-textMuted hover:text-mc-text transition-colors"
            title="Open Settings & Diagnostics"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>

      <HealthPanel
        health={health}
        wsConnected={wsConnected}
        isReadOnly={isReadOnly}
        sleeping={sleeping}
        sleepError={sleepError}
      />

      {/* Bottom Half: Send Activity Log & Scheduled Queue */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-2 py-1.5 border-b border-mc-border flex items-center justify-between text-mc-textMuted bg-mc-bg/30">
          <div className="flex flex-wrap gap-1">
            <button onClick={() => setActiveTab('activity')} className={tabClass('activity', 'text-mc-text')}>
              ACTIVITY ({activityTotal})
            </button>
            <button
              onClick={() => setActiveTab('scheduled')}
              className={`${tabClass('scheduled', 'text-mc-live')} flex items-center gap-1`}
            >
              <Clock size={11} />
              <span>LATER ({scheduledCount})</span>
            </button>
            <button
              onClick={() => setActiveTab('saved')}
              className={`${tabClass('saved', 'text-mc-live')} flex items-center gap-1`}
            >
              <Bookmark size={11} />
              <span>SAVED ({bookmarks.length})</span>
            </button>
            <button
              onClick={() => setActiveTab('waiting')}
              className={`${tabClass('waiting', 'text-mc-live')} flex items-center gap-1`}
              title="Messages you sent that have had no reply"
            >
              <Hourglass size={11} />
              <span>WAITING ({waitingQuery.data?.total ?? 0})</span>
            </button>
          </div>
        </div>

        {activeTab === 'waiting' ? (
          <WaitingTab
            items={waitingItems}
            snoozed={waitingQuery.data?.snoozed ?? 0}
            isPending={waitingQuery.isPending}
            isError={waitingQuery.isError}
            selectedJid={selectedJid}
            openMessage={openMessage}
          />
        ) : activeTab === 'saved' ? (
          <SavedTab
            bookmarks={bookmarks}
            isPending={bookmarksQuery.isPending}
            selectedJid={selectedJid}
            openMessage={openMessage}
          />
        ) : activeTab === 'activity' ? (
          <ActivityTab
            rows={activityRows}
            isPending={activityQuery.isPending}
            hasNextPage={activityQuery.hasNextPage}
            isFetchingNextPage={activityQuery.isFetchingNextPage}
            sentinelRef={activitySentinelRef}
            selectedJid={selectedJid}
            onOpen={openSendLog}
          />
        ) : (
          <ScheduledTab
            rows={scheduledRows}
            isPending={scheduledQuery.isPending}
            hasNextPage={scheduledQuery.hasNextPage}
            isFetchingNextPage={scheduledQuery.isFetchingNextPage}
            sentinelRef={scheduledSentinelRef}
            selectedJid={selectedJid}
            openMessage={openMessage}
            actions={scheduledActions}
          />
        )}
      </div>

      {resendTarget && (
        <ResendConfirmModal
          item={resendTarget}
          isReadOnly={isReadOnly}
          isPending={scheduledActions.resend.isPending}
          errorMessage={scheduledActions.resendError}
          onClose={scheduledActions.closeResend}
          onConfirm={(scheduledAt) =>
            scheduledActions.resend.mutate({ id: resendTarget.id, scheduledAt })
          }
        />
      )}
    </aside>
  );
};
