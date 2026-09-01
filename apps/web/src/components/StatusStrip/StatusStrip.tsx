import React, { useState, useMemo } from 'react';
import { Activity, Settings, ShieldCheck, ShieldAlert, AlertTriangle, Clock, Trash2, RotateCw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

const LIST_PAGE_SIZE = 100;

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
  const [activityVisibleCount, setActivityVisibleCount] = useState(LIST_PAGE_SIZE);
  const [scheduledVisibleCount, setScheduledVisibleCount] = useState(LIST_PAGE_SIZE);

  const sortedSendLogs = useMemo(
    () =>
      [...sendLogs].sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      ),
    [sendLogs]
  );

  const handleSelectMessageChat = (toJid: string, name?: string, msgId?: string) => {
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

    if (msgId) {
      setHighlightedMessageId(msgId);
    }
  };

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: 5000,
  });

  const { data: scheduledItems = [] } = useQuery({
    queryKey: ['scheduled'],
    queryFn: () => api.getScheduled(),
    refetchInterval: 5000,
  });

  const sortedScheduledItems = useMemo(
    () =>
      [...scheduledItems].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      ),
    [scheduledItems]
  );

  const visibleSendLogs = sortedSendLogs.slice(0, activityVisibleCount);
  const visibleScheduledItems = sortedScheduledItems.slice(0, scheduledVisibleCount);
  const hasMoreActivity = sortedSendLogs.length > activityVisibleCount;
  const hasMoreScheduled = sortedScheduledItems.length > scheduledVisibleCount;

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  const restartDaemonMutation = useMutation({
    mutationFn: () => api.restartDaemon(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const pendingScheduled = scheduledItems.filter((i) => i.status === 'pending');

  const isReadOnly = health?.readOnly ?? (localStorage.getItem('wacli_safe_mode') !== null ? localStorage.getItem('wacli_safe_mode') === 'true' : false);
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
        <button
          onClick={() => setActiveModal('settings')}
          className="p-1 rounded hover:bg-mc-surfaceHover text-mc-textMuted hover:text-mc-text transition-colors"
          title="Open Settings & Diagnostics"
        >
          <Settings size={15} />
        </button>
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
              <span className={heartbeatAge < 120 ? 'text-mc-text' : 'text-mc-safe'}>
                {heartbeatAge}s ago
              </span>
            </div>
          )}

          {health?.processPid != null && (
            <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
              <span>PID</span>
              <span className="text-mc-text font-mono">{health.processPid}</span>
            </div>
          )}

          {health?.storeLockHeld && (
            <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
              <span>STORE LOCK</span>
              <span
                className={
                  health.storeLockHolderPid &&
                  health.processPid &&
                  health.storeLockHolderPid !== health.processPid
                    ? 'text-mc-danger font-semibold'
                    : 'text-mc-live font-semibold'
                }
              >
                {health.storeLockHolderPid &&
                health.processPid &&
                health.storeLockHolderPid !== health.processPid
                  ? `EXTERNAL (pid ${health.storeLockHolderPid})`
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
              ACTIVITY ({sendLogs.length})
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
              <span>LATER ({pendingScheduled.length})</span>
            </button>
          </div>
        </div>

        {activeTab === 'activity' ? (
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {sendLogs.length === 0 ? (
              <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
                No outbound sends in this session.
              </div>
            ) : (
              <>
              {visibleSendLogs.map((log) => {
                const isSelected = selectedChat?.jid === log.to;
                return (
                  <div
                    key={log.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectMessageChat(log.to, log.chatName)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectMessageChat(log.to, log.chatName);
                      }
                    }}
                    className={`p-2 rounded bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                      isSelected
                        ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                        : 'border-mc-border/70'
                    }`}
                    title="Click to view conversation in main chat area"
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
                    <div className="text-mc-textMuted truncate">
                      {log.message}
                    </div>
                    {log.error && (
                      <div className="text-[10px] text-mc-danger truncate">{log.error}</div>
                    )}
                  </div>
                );
              })}
              {hasMoreActivity && (
                <button
                  onClick={() => setActivityVisibleCount((count) => count + LIST_PAGE_SIZE)}
                  className="w-full py-2 text-[11px] font-mono text-mc-live hover:text-mc-text border border-mc-border hover:border-mc-live/50 rounded bg-mc-bg hover:bg-mc-surfaceHover transition-colors"
                >
                  fetch more
                </button>
              )}
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {scheduledItems.length === 0 ? (
              <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
                No scheduled messages queued.
              </div>
            ) : (
              <>
              {visibleScheduledItems.map((item) => {
                const isSelected = selectedChat?.jid === item.to;
                return (
                  <div
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectMessageChat(item.to, item.recipientName, item.sentMessageId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleSelectMessageChat(item.to, item.recipientName, item.sentMessageId);
                      }
                    }}
                    className={`p-2 rounded bg-mc-bg border transition-all cursor-pointer space-y-1 text-[11px] hover:border-mc-live/60 hover:bg-mc-surfaceHover/80 ${
                      isSelected
                        ? 'border-mc-live/60 bg-mc-surfaceHover/50 ring-1 ring-mc-live/30'
                        : 'border-mc-border/70'
                    }`}
                    title="Click to view conversation in main chat area"
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
                            : 'text-mc-textMuted'
                        }`}
                      >
                        {item.status}
                      </span>
                    </div>
                    <div className="text-mc-text truncate font-semibold flex items-center justify-between gap-1">
                      <span className="truncate">{item.recipientName || item.to}</span>
                      <span className="text-[9px] text-mc-live font-mono opacity-80 shrink-0">
                        OPEN →
                      </span>
                    </div>
                    <div className="text-mc-textMuted truncate">
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
                    {item.error && (
                      <div className="text-[10px] text-mc-danger truncate">{item.error}</div>
                    )}
                  </div>
                );
              })}
              {hasMoreScheduled && (
                <button
                  onClick={() => setScheduledVisibleCount((count) => count + LIST_PAGE_SIZE)}
                  className="w-full py-2 text-[11px] font-mono text-mc-live hover:text-mc-text border border-mc-border hover:border-mc-live/50 rounded bg-mc-bg hover:bg-mc-surfaceHover transition-colors"
                >
                  fetch more
                </button>
              )}
              </>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
