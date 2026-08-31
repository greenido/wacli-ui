import React, { useState } from 'react';
import { Activity, Settings, ShieldCheck, ShieldAlert, AlertTriangle, Clock, Trash2 } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useAppStore } from '../../store/appStore.ts';

interface StatusStripProps {
  wsConnected: boolean;
}

export const StatusStrip: React.FC<StatusStripProps> = ({ wsConnected }) => {
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const sendLogs = useAppStore((s) => s.sendLogs);
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<'activity' | 'scheduled'>('activity');

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

  const cancelMutation = useMutation({
    mutationFn: (id: string) => api.cancelScheduled(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] });
    },
  });

  const pendingScheduled = scheduledItems.filter((i) => i.status === 'pending');

  const isReadOnly = health?.readOnly ?? true;
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
    <aside aria-label="System status strip" className="w-64 bg-mc-surface border-l border-mc-border flex flex-col h-full select-none text-xs font-mono">
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

        {/* Sync Daemon Connection */}
        <div className="bg-mc-bg p-2.5 rounded border border-mc-border space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-mc-textMuted">DAEMON</span>
            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${getStatusColor().split(' ')[0]} ${processState === 'running' ? 'animate-pulse' : ''}`} />
              <span className={`font-semibold uppercase ${getStatusColor().split(' ')[1]}`}>
                {processState}
              </span>
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
              sendLogs.map((log) => (
                <div
                  key={log.id}
                  className="p-2 rounded bg-mc-bg border border-mc-border/70 space-y-1 text-[11px]"
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
                  <div className="text-mc-text truncate font-semibold">
                    {log.chatName || log.to}
                  </div>
                  <div className="text-mc-textMuted truncate">
                    {log.message}
                  </div>
                  {log.error && (
                    <div className="text-[10px] text-mc-danger truncate">{log.error}</div>
                  )}
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
            {scheduledItems.length === 0 ? (
              <div className="text-center py-6 text-mc-textMuted/60 text-[11px]">
                No scheduled messages queued.
              </div>
            ) : (
              scheduledItems.map((item) => (
                <div
                  key={item.id}
                  className="p-2 rounded bg-mc-bg border border-mc-border/70 space-y-1 text-[11px]"
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
                  <div className="text-mc-text truncate font-semibold">
                    {item.recipientName || item.to}
                  </div>
                  <div className="text-mc-textMuted truncate">
                    {item.fileName ? `[File: ${item.fileName}] ` : ''}
                    {item.message}
                  </div>
                  {item.status === 'pending' && (
                    <div className="pt-1 flex justify-end">
                      <button
                        onClick={() => cancelMutation.mutate(item.id)}
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
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
