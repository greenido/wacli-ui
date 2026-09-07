import React, { useState, useMemo } from 'react';
import {
  Activity,
  Settings,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Clock,
  Trash2,
  RotateCw,
  ChevronDown,
  ChevronRight,
  Loader2, LifeBuoy, X } from 'lucide-react';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import { POLL_ACTIVITY_MS, POLL_HEALTH_MS, POLL_SCHEDULED_MS } from '../../lib/queryOptions.ts';
import { useInfiniteScroll } from '../../hooks/useInfiniteScroll.ts';
import { useAppStore } from '../../store/appStore.ts';
import { usableMessageId } from '../../lib/messageJump.ts';
import { detectTextDirection } from '../../lib/textDirection.ts';
import { isHeartbeatStale } from '../../lib/heartbeat.ts';
import type { MessageJumpHint } from '../../store/appStore.ts';
import { ResendConfirmModal } from './ResendConfirmModal.tsx';
import type { ScheduledMessage, SendLogEntry, UnifiedChat } from '../../types.ts';

interface StatusStripProps {
  wsConnected: boolean;
  width?: number;
}

export const StatusStrip: React.FC<StatusStripProps> = ({ wsConnected, width = 256 }) => {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const sendLogs = useAppStore((s) => s.sendLogs);
  const selectedChat = useAppStore((s) => s.selectedChat);
  const setSelectedChat = useAppStore((s) => s.setSelectedChat);
  const setHighlightedMessageId = useAppStore((s) => s.setHighlightedMessageId);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const chatFilter = useAppStore((s) => s.chatFilter);
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'activity' | 'scheduled'>('activity');
  // A failed message has nothing to show in the thread, so its detail has to
  // open here instead of sending the operator to a conversation that is missing
  // the very message they clicked.
  const [expandedScheduledId, setExpandedScheduledId] = useState<string | null>(null);
  const [resendTarget, setResendTarget] = useState<ScheduledMessage | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  /**
   * Why a cancel or discard did not happen. These are refusals about state the
   * operator cannot see — the message went out a second ago, another pane got
   * there first — so they belong on screen rather than in a console log.
   */
  const [scheduledActionError, setScheduledActionError] = useState<string | null>(null);

  const sortedSendLogs = useMemo(
    () =>
      [...sendLogs].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    [sendLogs]
  );

  const handleSelectMessageChat = (
    toJid: string,
    name?: string,
    msgId?: string,
    hint?: MessageJumpHint
  ) => {
    if (!toJid) return;
    const cachedChats =
      queryClient.getQueryData<UnifiedChat[]>(['chats', searchQuery, chatFilter]) ||
      queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all']) ||
      [];
    const existing = cachedChats.find((c) => c.jid === toJid);

    const targetChat: UnifiedChat = existing || {
      jid: toJid,
      name: name || toJid.split('@')[0],
      kind: toJid.endsWith('@g.us') ? 'group' : 'dm',
      lastMessageTs: null,
      lastMessage: null,
      lastMessageFromMe: false,
      archived: false,
      pinned: false,
      mutedUntil: 0,
      unread: false,
      unreadCount: 0,
    };

    setSelectedChat(targetChat);
    try {
      localStorage.setItem('wacli_selected_chat', targetChat.jid);
    } catch {
      // ignore
    }

    // Always assign, never only on a hit. Leaving the previous target set sent
    // the newly opened thread hunting for a message from the chat before it,
    // which it then reported as missing from the local archive.
    //
    // The hint goes along with the id because most rows have no usable id at
    // all: everything sent before wacli's id was recorded, which is every
    // scheduled message already on disk.
    setHighlightedMessageId(usableMessageId(msgId), hint ?? null);
  };

  const openSendLog = (log: SendLogEntry) => {
    handleSelectMessageChat(log.to, log.chatName, log.messageId, {
      text: log.message,
      sentAfter: log.timestamp,
    });
  };

  /**
   * A message that never went out has nothing to focus, and a queued one has
   * not been sent yet — only a delivered message can be pointed at.
   */
  const scheduledJumpHint = (item: ScheduledMessage): MessageJumpHint | undefined =>
    item.status === 'sent'
      ? { text: item.message || item.fileName || '', sentAfter: item.scheduledAt }
      : undefined;

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: POLL_HEALTH_MS,
  });

  /**
   * The queue: every pending message on the first page, history a page at a
   * time. Only page one is polled — the pages behind it are settled history and
   * refetching them on a timer would fight the operator's own scrolling.
   */
  const scheduledQuery = useInfiniteQuery({
    queryKey: ['scheduled'],
    queryFn: ({ pageParam }) => api.getScheduled({ before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_SCHEDULED_MS,
  });

  const activityQuery = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => api.getActivity({ before: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: POLL_ACTIVITY_MS,
  });

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

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
    onError: (err: unknown) => {
      // The server refuses a cancel it cannot honour — the message already went
      // out, or was cancelled a moment ago in another pane. It used to answer
      // those as successes, so the row simply stopped responding; now the
      // reason is on screen, next to the same list the resend refusals use.
      setScheduledActionError(err instanceof Error ? err.message : String(err));
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  const resendMutation = useMutation({
    mutationFn: ({ id, scheduledAt }: { id: string; scheduledAt?: string }) =>
      api.resendScheduled(id, scheduledAt ? { scheduledAt } : {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
      setResendTarget(null);
      setResendError(null);
    },
    onError: (err: unknown) => {
      // Includes the server's own refusals (already sent, already in flight,
      // safe mode), which the operator needs to read rather than have swallowed.
      setResendError(err instanceof Error ? err.message : String(err));
    },
  });

  const discardMutation = useMutation({
    mutationFn: (id: string) => api.discardScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
    onError: (err: unknown) => {
      setScheduledActionError(err instanceof Error ? err.message : String(err));
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  const restartDaemonMutation = useMutation({
    mutationFn: () => api.restartDaemon(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const { isReadOnly } = useSafeMode();
  const processState = health?.processState ?? 'stopped';
  const doctor = health?.doctor;
  const heartbeatAge = health?.heartbeatAgeSeconds;

  const getStatusColor = () => {
    if (!wsConnected || processState === 'failed' || processState === 'logged_out') {
      return 'bg-mc-danger text-mc-danger';
    }
    if (processState === 'restarting' || processState === 'paused' || processState === 'starting') {
      return 'bg-mc-safe text-mc-safe';
    }
    return 'bg-mc-live text-mc-live';
  };

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

      {/* State Blocks */}
      <div className="p-3 space-y-3 border-b border-mc-border">
        {/* Mode Indicator */}
        <div className="bg-mc-bg p-2.5 rounded border border-mc-border flex items-center justify-between">
          <span className="text-mc-textMuted">MODE</span>
          <div className="flex items-center gap-1.5">
            {isReadOnly ? (
              <>
                <ShieldCheck size={13} className="text-mc-safe" />
                <span className="text-mc-safe font-semibold">SAFE (R/O)</span>
              </>
            ) : (
              <>
                <ShieldAlert size={13} className="text-mc-live" />
                <span className="text-mc-live font-semibold">LIVE WRITE</span>
              </>
            )}
          </div>
        </div>

        {/* CLI Binary Status */}
        <div className="bg-mc-bg p-2.5 rounded border border-mc-border space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-mc-textMuted">WACLI CLI</span>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  health?.wacliInstalled === false
                    ? 'bg-mc-danger'
                    : health?.wacliWorking
                    ? 'bg-mc-live'
                    : 'bg-mc-safe'
                }`}
              />
              <span
                className={`font-semibold uppercase text-[11px] ${
                  health?.wacliInstalled === false
                    ? 'text-mc-danger'
                    : health?.wacliWorking
                    ? 'text-mc-live'
                    : 'text-mc-safe'
                }`}
              >
                {health?.wacliInstalled === false
                  ? 'NOT FOUND'
                  : health?.wacliWorking
                  ? 'READY'
                  : 'NEEDS AUTH'}
              </span>
            </div>
          </div>
          {health?.wacliVersion && (
            <div className="flex items-center justify-between text-[11px] text-mc-textMuted pt-1 border-t border-mc-border/50">
              <span>VERSION</span>
              <span className="text-mc-text truncate font-mono text-[10px]">
                {health.wacliVersion}
              </span>
            </div>
          )}
        </div>

        {/* Sync Daemon Connection */}
        <div className="bg-mc-bg p-2.5 rounded border border-mc-border space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-mc-textMuted">DAEMON</span>
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${getStatusColor().split(' ')[0]} ${processState === 'running' ? 'animate-pulse' : ''}`} />
              <span className={`font-semibold uppercase ${getStatusColor().split(' ')[1]}`}>
                {processState}
              </span>
              <button
                onClick={() => restartDaemonMutation.mutate()}
                disabled={restartDaemonMutation.isPending}
                className="ml-1 p-0.5 rounded hover:bg-mc-surfaceHover text-mc-textMuted hover:text-mc-text transition-colors"
                title="Restart Daemon"
              >
                <RotateCw size={11} className={restartDaemonMutation.isPending ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          <div className="flex items-center justify-between text-[11px] text-mc-textMuted pt-1 border-t border-mc-border/50">
            <span>WS RELAY</span>
            <span className={wsConnected ? 'text-mc-live' : 'text-mc-danger'}>
              {wsConnected ? 'ONLINE' : 'DISCONNECTED'}
            </span>
          </div>

          {heartbeatAge !== null && heartbeatAge !== undefined && (
            <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
              <span>HEARTBEAT</span>
              <span className={isHeartbeatStale(heartbeatAge) ? 'text-mc-safe' : 'text-mc-text'}>
                {heartbeatAge}s ago
              </span>
            </div>
          )}

          {typeof health?.processPid === 'number' && (
            <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
              <span>PID</span>
              <span className="text-mc-text font-mono">{health.processPid}</span>
            </div>
          )}

          {health?.storeLockHeld && (
            <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
              <span>STORE LOCK</span>
              {/* Whether the holder is ours is the API's call: comparing the two
                  PIDs here read the lock as the daemon's own whenever we did not
                  know our PID, which is exactly the restarting state an external
                  holder puts us in — the strip then contradicted the banner. */}
              <span
                className={
                  health.statusSummary === 'store_locked_external'
                    ? 'text-mc-danger font-semibold'
                    : 'text-mc-live font-semibold'
                }
              >
                {health.statusSummary === 'store_locked_external'
                  ? health.storeLockHolderPid
                    ? `EXTERNAL (pid ${health.storeLockHolderPid})`
                    : 'EXTERNAL'
                  : 'HELD BY DAEMON'}
              </span>
            </div>
          )}
        </div>

        {/* Linked Identity */}
        {doctor && (
          <div className="bg-mc-bg p-2.5 rounded border border-mc-border space-y-1">
            <div className="text-[11px] text-mc-textMuted">LINKED IDENTITY</div>
            <div className="text-mc-text truncate font-mono text-[11px]" title={doctor.linkedJid ?? 'Unpaired'}>
              {doctor.linkedJid ?? 'None'}
            </div>
            <div className="text-[10px] text-mc-textMuted flex justify-between pt-1">
              <span>{doctor.store.messages.toLocaleString()} msgs</span>
              <span>{doctor.store.chats.toLocaleString()} chats</span>
            </div>
          </div>
        )}

        {health?.lastError && (
          <div className="bg-mc-danger/10 border border-mc-danger/30 p-2 rounded text-[11px] text-mc-danger flex items-start gap-1.5">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span className="break-all">{health.lastError}</span>
          </div>
        )}
      </div>

      {/* Bottom Half: Send Activity Log & Scheduled Queue */}
      <div className="flex-1 flex flex-col min-h-0">
        <div className="px-2 py-1.5 border-b border-mc-border flex items-center justify-between text-mc-textMuted bg-mc-bg/30">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('activity')}
              className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                activeTab === 'activity'
                  ? 'bg-mc-surfaceHover text-mc-text font-bold'
                  : 'text-mc-textMuted hover:text-mc-text'
              }`}
            >
              ACTIVITY ({activityTotal})
            </button>
            <button
              onClick={() => setActiveTab('scheduled')}
              className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors flex items-center gap-1 ${
                activeTab === 'scheduled'
                  ? 'bg-mc-surfaceHover text-mc-live font-bold'
                  : 'text-mc-textMuted hover:text-mc-text'
              }`}
            >
              <Clock size={11} />
              <span>LATER ({scheduledCount})</span>
            </button>
          </div>
        </div>

        {activeTab === 'activity' ? (
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {activityRows.length === 0 ? (
              <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
                {activityQuery.isPending ? 'Loading activity…' : 'No outbound sends on record.'}
              </div>
            ) : (
              <>
              {activityRows.map((log) => {
                const isSelected = selectedChat?.jid === log.to;
                return (
                  <div
                    key={log.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openSendLog(log)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openSendLog(log);
                      }
                    }}
                    className={`p-2 rounded bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                      isSelected
                        ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                        : 'border-mc-border/70'
                    }`}
                    title="Click to open the conversation and focus this message"
                  >
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="text-mc-textMuted">
                        {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                      <span
                        className={`font-semibold uppercase ${
                          log.status === 'success'
                            ? 'text-mc-live'
                            : log.status === 'pending'
                            ? 'text-mc-safe'
                            : 'text-mc-danger'
                        }`}
                      >
                        {log.status}
                      </span>
                    </div>
                    <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                      <span className="truncate">{log.chatName || log.to}</span>
                      <span className="text-[9px] text-mc-live font-mono opacity-80 shrink-0">
                        OPEN →
                      </span>
                    </div>
                    <div
                      dir={detectTextDirection(log.message)}
                      className="text-mc-textMuted truncate text-start"
                    >
                      {log.message}
                    </div>
                    {log.error && (
                      <div className="text-[10px] text-mc-danger truncate">{log.error}</div>
                    )}
                  </div>
                );
              })}
              {activityQuery.hasNextPage && (
                // The sentinel is the paging control: scrolling to it asks for
                // the next page. It stays visible while that page loads so the
                // list does not jump as rows arrive underneath the scroll.
                <div
                  ref={activitySentinelRef}
                  className="py-2 text-center text-[10px] font-mono text-mc-textMuted/70"
                >
                  {activityQuery.isFetchingNextPage ? 'loading more…' : 'scroll for more'}
                </div>
              )}
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {scheduledActionError && (
              <div
                role="alert"
                className="flex items-start justify-between gap-2 rounded border border-mc-danger/50 bg-mc-danger/10 px-2 py-1.5 text-[11px] text-mc-danger"
              >
                <span className="min-w-0 break-words">{scheduledActionError}</span>
                <button
                  type="button"
                  onClick={() => setScheduledActionError(null)}
                  aria-label="Dismiss"
                  className="shrink-0 text-mc-danger/70 hover:text-mc-danger"
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {scheduledRows.length === 0 ? (
              <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
                {scheduledQuery.isPending ? 'Loading queue…' : 'No scheduled messages queued.'}
              </div>
            ) : (
              <>
              {scheduledRows.map((item) => {
                const isSelected = selectedChat?.jid === item.to;
                const isFailed = item.status === 'failed';
                const isExpanded = isFailed && expandedScheduledId === item.id;
                // A failed message was never delivered, so there is nothing in
                // the thread to jump to. Opening the row in place is the only
                // click that can actually tell the operator anything.
                const handleActivate = () => {
                  if (isFailed) {
                    setExpandedScheduledId(isExpanded ? null : item.id);
                  }
                  handleSelectMessageChat(
                    item.to,
                    item.recipientName,
                    item.sentMessageId,
                    scheduledJumpHint(item)
                  );
                };

                return (
                  <div key={item.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={isFailed ? isExpanded : undefined}
                      onClick={handleActivate}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleActivate();
                        }
                      }}
                      className={`p-2 bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                        isExpanded ? 'rounded-t' : 'rounded'
                      } ${
                        isFailed
                          ? 'border-mc-danger/50'
                          : isSelected
                          ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                          : 'border-mc-border/70'
                      }`}
                      title={
                        isFailed
                          ? 'Not delivered. Click for the failure detail and resend options.'
                          : 'Click to view conversation in main chat area'
                      }
                    >
                      <div className="flex items-center justify-between text-[10px]">
                        <span className="text-mc-live font-semibold flex items-center gap-1">
                          <Clock size={10} />
                          {new Date(item.scheduledAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}{' '}
                          {new Date(item.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span
                          className={`font-semibold uppercase ${
                            item.status === 'sent'
                              ? 'text-mc-live'
                              : item.status === 'pending'
                              ? 'text-mc-safe'
                              : isFailed
                              ? 'text-mc-danger'
                              : 'text-mc-textMuted'
                          }`}
                        >
                          {item.status}
                        </span>
                      </div>
                      <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                        <span className="truncate">{item.recipientName || item.to}</span>
                        {isFailed ? (
                          <span className="text-[9px] text-mc-danger font-mono opacity-90 shrink-0 flex items-center gap-0.5">
                            {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            <span>DETAILS</span>
                          </span>
                        ) : (
                          <span className="text-[9px] text-mc-live font-mono opacity-80 shrink-0">
                            OPEN →
                          </span>
                        )}
                      </div>
                      <div
                        dir={detectTextDirection(item.message)}
                        className="text-mc-textMuted truncate text-start"
                      >
                        {item.fileName ? `[File: ${item.fileName}] ` : ''}
                        {item.message}
                      </div>
                      {item.status === 'pending' && (
                        <div className="pt-1 flex justify-end">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              cancelMutation.mutate(item.id);
                            }}
                            disabled={cancelMutation.isPending}
                            className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors"
                            title="Cancel scheduled dispatch"
                          >
                            <Trash2 size={10} />
                            <span>CANCEL</span>
                          </button>
                        </div>
                      )}
                      {item.error && !isExpanded && (
                        <div className="text-[10px] text-mc-danger leading-snug break-words pt-0.5 line-clamp-2">
                          {item.error}
                        </div>
                      )}
                    </div>

                    {/* Failure detail. Rendered as a sibling of the clickable
                        summary rather than inside it, so these controls are not
                        buttons nested in a role="button". */}
                    {isExpanded && (
                      <div className="border border-t-0 border-mc-danger/50 rounded-b bg-mc-bg/60 p-2 space-y-2 text-[10px]">
                        <div className="text-mc-danger leading-snug break-words">
                          <span className="font-bold uppercase">Not delivered: </span>
                          {item.error || 'No reason recorded.'}
                        </div>

                        <div className="text-mc-textMuted leading-snug">
                          <span className="uppercase">Message: </span>
                          <span
                            dir={detectTextDirection(item.message)}
                            className="text-mc-text break-words whitespace-pre-wrap"
                          >
                            {item.message || '(no text)'}
                          </span>
                        </div>

                        {item.fileName && (
                          <div
                            className={`leading-snug break-words ${
                              item.attachmentMissing ? 'text-mc-danger' : 'text-mc-textMuted'
                            }`}
                          >
                            <span className="uppercase">Attachment: </span>
                            {item.fileName}
                            {item.attachmentMissing && ' — no longer on disk'}
                          </div>
                        )}

                        {typeof item.resendCount === 'number' && item.resendCount > 0 && (
                          <div className="text-mc-safe">
                            Resent {item.resendCount} {item.resendCount === 1 ? 'time' : 'times'}
                            {item.lastAttemptAt
                              ? `, last at ${new Date(item.lastAttemptAt).toLocaleTimeString([], {
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}`
                              : ''}
                          </div>
                        )}

                        <div className="flex items-center gap-1.5 pt-0.5">
                          <button
                            onClick={() => {
                              setResendError(null);
                              setResendTarget(item);
                            }}
                            disabled={resendMutation.isPending || discardMutation.isPending}
                            className="flex items-center gap-1 text-[10px] text-mc-live hover:text-mc-text border border-mc-live/40 hover:border-mc-live px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Send this message again, now or at a new time"
                          >
                            {resendMutation.isPending && resendTarget?.id === item.id ? (
                              <Loader2 size={10} className="animate-spin" />
                            ) : (
                              <RotateCw size={10} />
                            )}
                            <span>RESEND</span>
                          </button>
                          <button
                            onClick={() => {
                              setExpandedScheduledId(null);
                              discardMutation.mutate(item.id);
                            }}
                            disabled={resendMutation.isPending || discardMutation.isPending}
                            className="flex items-center gap-1 text-[10px] text-mc-danger hover:text-mc-danger/80 border border-mc-danger/40 hover:border-mc-danger px-1.5 py-0.5 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Remove this failed message from the queue"
                          >
                            <Trash2 size={10} />
                            <span>DISCARD</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {scheduledQuery.hasNextPage && (
                <div
                  ref={scheduledSentinelRef}
                  className="py-2 text-center text-[10px] font-mono text-mc-textMuted/70"
                >
                  {scheduledQuery.isFetchingNextPage ? 'loading more…' : 'scroll for more'}
                </div>
              )}
              </>
            )}
          </div>
        )}
      </div>

      {resendTarget && (
        <ResendConfirmModal
          item={resendTarget}
          isReadOnly={isReadOnly}
          isPending={resendMutation.isPending}
          errorMessage={resendError}
          onClose={() => {
            setResendTarget(null);
            setResendError(null);
          }}
          onConfirm={(scheduledAt) => resendMutation.mutate({ id: resendTarget.id, scheduledAt })}
        />
      )}
    </aside>
  );
};
