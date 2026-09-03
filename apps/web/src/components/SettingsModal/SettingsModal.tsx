import React, { useState } from 'react';
import { X, ShieldCheck, ShieldAlert, Database, FileText, CheckCircle2, Activity, RotateCw, AlertTriangle, Bell, BellOff } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import {
  notificationPermission,
  notificationsEnabled,
  notificationsSupported,
  requestNotificationPermission,
  setNotificationsEnabled,
} from '../../lib/notifications.ts';
import { useAppStore } from '../../store/appStore.ts';
import { useModalDialog } from '../../hooks/useModalDialog.ts';

/**
 * Desktop notifications are opt-in twice over: the operator has to switch them
 * on here, and the browser has to grant permission. This shows which of the two
 * is missing rather than leaving a silent console unexplained.
 */
const NotificationToggle: React.FC = () => {
  const supported = notificationsSupported();
  const [enabled, setEnabled] = useState(() => notificationsEnabled());
  const [permission, setPermission] = useState<NotificationPermission>(() => notificationPermission());
  const [isRequesting, setIsRequesting] = useState(false);

  const isOn = enabled && permission === 'granted';
  const isBlocked = supported && permission === 'denied';

  const handleToggle = async () => {
    if (isOn) {
      setNotificationsEnabled(false);
      setEnabled(false);
      return;
    }

    setIsRequesting(true);
    try {
      const granted = await requestNotificationPermission();
      setPermission(granted);
      if (granted === 'granted') {
        setNotificationsEnabled(true);
        setEnabled(true);
      }
    } finally {
      setIsRequesting(false);
    }
  };

  return (
    <div className="p-3 bg-mc-bg rounded border border-mc-border space-y-2">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-mc-text flex items-center gap-2">
          {isOn ? <Bell size={16} className="text-mc-live" /> : <BellOff size={16} className="text-mc-textMuted" />}
          DESKTOP NOTIFICATIONS
        </span>
        <button
          onClick={() => void handleToggle()}
          disabled={!supported || isBlocked || isRequesting}
          aria-pressed={isOn}
          className={`px-3 py-1 rounded text-xs font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
            isOn
              ? 'bg-mc-live/20 text-mc-live border border-mc-live/60 hover:bg-mc-live/30'
              : 'bg-mc-surfaceHover text-mc-text border border-mc-border hover:bg-mc-border/50'
          }`}
        >
          {isRequesting ? 'ASKING...' : isOn ? 'ON' : 'OFF'}
        </button>
      </div>
      <p className="text-[11px] text-mc-textMuted font-sans">
        {!supported
          ? 'This browser cannot show desktop notifications.'
          : isBlocked
          ? 'Blocked in your browser settings. Allow notifications for this site, then re-open Settings.'
          : isOn
          ? 'Incoming messages raise a desktop notification. Your own messages, reactions, muted chats, and the conversation you are already watching stay silent.'
          : 'Off. Turning this on asks the browser for permission; nothing is sent anywhere — the notification is raised locally from the WebSocket bridge.'}
      </p>
    </div>
  );
};

export const SettingsModal: React.FC = () => {
  const activeModal = useAppStore((s) => s.activeModal);
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const queryClient = useQueryClient();

  const dialogRef = useModalDialog<HTMLDivElement>(activeModal === 'settings', () =>
    setActiveModal(null)
  );

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.getSettings(),
  });

  const modeMutation = useMutation({
    mutationFn: (newReadOnly: boolean) => {
      localStorage.setItem('wacli_safe_mode', String(newReadOnly));
      return api.setMode(newReadOnly);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const restartDaemonMutation = useMutation({
    mutationFn: () => api.restartDaemon(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  if (activeModal !== 'settings') return null;

  const isReadOnly = settings?.readOnly ?? (localStorage.getItem('wacli_safe_mode') !== null ? localStorage.getItem('wacli_safe_mode') === 'true' : false);
  const doctor = health?.doctor;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="bg-mc-surface border border-mc-border rounded shadow-2xl w-full max-w-xl flex flex-col max-h-[85vh] font-sans text-xs"
      >
        {/* Header */}
        <div className="p-4 border-b border-mc-border flex items-center justify-between">
          <h2
            id="settings-title"
            className="flex items-center gap-2 font-mono font-semibold text-sm text-mc-text"
          >
            <span>SETTINGS &amp; DIAGNOSTICS</span>
          </h2>
          <button
            onClick={() => setActiveModal(null)}
            aria-label="Close settings"
            className="p-1 text-mc-textMuted hover:text-mc-text rounded"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5 overflow-y-auto font-mono">
          {/* Read-Only Safety Toggle */}
          <div className="p-3 bg-mc-bg rounded border border-mc-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-mc-text flex items-center gap-2">
                {isReadOnly ? <ShieldCheck size={16} className="text-mc-safe" /> : <ShieldAlert size={16} className="text-mc-live" />}
                OPERATOR MODE
              </span>
              <button
                onClick={() => modeMutation.mutate(!isReadOnly)}
                disabled={modeMutation.isPending}
                className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                  isReadOnly
                    ? 'bg-mc-safe/20 text-mc-safe border border-mc-safe/60 hover:bg-mc-safe/30'
                    : 'bg-mc-live/20 text-mc-live border border-mc-live/60 hover:bg-mc-live/30'
                }`}
              >
                {isReadOnly ? 'UNLOCK WRITE (LIVE)' : 'LOCK (SAFE MODE)'}
              </button>
            </div>
            <p className="text-[11px] text-mc-textMuted font-sans">
              {isReadOnly
                ? 'Safe mode prevents all outgoing message sends, replies, and reactions.'
                : 'Live mode active: outbound commands are allowed with modal confirmation.'}
            </p>
          </div>

          <NotificationToggle />

          {/* wacli CLI Installation Status */}
          <div className="space-y-2">
            <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 size={12} className={health?.wacliInstalled ? 'text-mc-live' : 'text-mc-danger'} />
                wacli CLI Environment
              </span>
              <button
                onClick={() => {
                  queryClient.invalidateQueries({ queryKey: ['health'] });
                  queryClient.invalidateQueries({ queryKey: ['settings'] });
                }}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-mc-surfaceHover text-mc-text border border-mc-border hover:bg-mc-border/50 transition-colors"
                title="Refresh CLI health"
              >
                <RotateCw size={10} />
                <span>Re-check</span>
              </button>
            </div>
            <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-2 text-[11px]">
              <div className="flex justify-between">
                <span className="text-mc-textMuted">Binary Status:</span>
                <span className={`font-semibold uppercase ${health?.wacliInstalled ? 'text-mc-live' : 'text-mc-danger'}`}>
                  {health?.wacliInstalled ? 'Installed & Detected' : 'Not Found'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-mc-textMuted">CLI Version:</span>
                <span className="text-mc-text">{health?.wacliVersion ?? 'Unknown'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-mc-textMuted">Health Assessment:</span>
                <span className={`font-semibold uppercase ${
                  health?.wacliWorking
                    ? 'text-mc-live'
                    : health?.statusSummary === 'not_authenticated'
                    ? 'text-mc-safe'
                    : 'text-mc-danger'
                }`}>
                  {health?.statusSummary ?? 'Unknown'}
                </span>
              </div>
              {health?.statusMessage && (
                <div className="text-[10px] text-mc-textMuted pt-1 border-t border-mc-border/50">
                  {health.statusMessage}
                </div>
              )}
            </div>
          </div>

          {/* Sync Daemon Status & Control */}
          <div className="space-y-2">
            <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Activity size={12} className="text-mc-live" />
                Sync Daemon Control
              </span>
              <button
                onClick={() => restartDaemonMutation.mutate()}
                disabled={restartDaemonMutation.isPending}
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-mc-surfaceHover text-mc-text border border-mc-border hover:bg-mc-border/50 transition-colors"
                title="Restart wacli sync daemon"
              >
                <RotateCw size={10} className={restartDaemonMutation.isPending ? 'animate-spin' : ''} />
                <span>Restart Daemon</span>
              </button>
            </div>
            <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-2 text-[11px]">
              <div className="flex justify-between">
                <span className="text-mc-textMuted">Daemon State:</span>
                <span className={`font-semibold uppercase ${
                  health?.processState === 'running'
                    ? 'text-mc-live'
                    : health?.processState === 'restarting' || health?.processState === 'starting'
                    ? 'text-mc-safe'
                    : 'text-mc-danger'
                }`}>
                  {health?.processState ?? 'unknown'}
                </span>
              </div>
              {health?.processPid && (
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Process PID:</span>
                  <span className="text-mc-text">{health.processPid}</span>
                </div>
              )}
              {health?.heartbeatAgeSeconds !== null && health?.heartbeatAgeSeconds !== undefined && (
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Heartbeat:</span>
                  <span className={health.heartbeatAgeSeconds < 120 ? 'text-mc-text' : 'text-mc-safe'}>
                    {health.heartbeatAgeSeconds}s ago
                  </span>
                </div>
              )}
              {health?.lastError && (
                <div className="bg-mc-danger/10 border border-mc-danger/30 p-2 rounded text-[10px] text-mc-danger flex items-start gap-1.5 mt-1">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <span className="break-all">{health.lastError}</span>
                </div>
              )}
            </div>
          </div>

          {/* Doctor Status */}
          {doctor && (
            <div className="space-y-2">
              <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold">
                wacli doctor diagnostics
              </div>
              <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-2 text-[11px]">
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Session Pairing:</span>
                  <span className={doctor.authenticated ? 'text-mc-live flex items-center gap-1' : 'text-mc-danger'}>
                    {doctor.authenticated ? <CheckCircle2 size={12} /> : null}
                    {doctor.authenticated ? 'Authenticated' : 'Not Paired'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Linked JID:</span>
                  <span className="text-mc-text truncate max-w-[280px]">{doctor.linkedJid ?? 'None'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">FTS5 Search:</span>
                  <span className={doctor.ftsEnabled ? 'text-mc-live' : 'text-mc-danger'}>
                    {doctor.ftsEnabled ? 'Active (Ready)' : 'Disabled'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Store Messages:</span>
                  <span className="text-mc-text">{doctor.store.messages.toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-mc-textMuted">Store Chats:</span>
                  <span className="text-mc-text">{doctor.store.chats.toLocaleString()}</span>
                </div>
              </div>
            </div>
          )}

          {/* Paths & Logs */}
          <div className="space-y-2">
            <div className="text-[11px] text-mc-textMuted tracking-wider uppercase font-semibold">
              Storage & Logging
            </div>
            <div className="bg-mc-bg rounded border border-mc-border p-3 space-y-2 text-[11px]">
              <div className="flex items-start justify-between gap-2">
                <span className="text-mc-textMuted flex items-center gap-1 shrink-0">
                  <Database size={12} /> Store Path:
                </span>
                <span className="text-mc-text break-all text-right">{doctor?.storeDir || '~/.wacli'}</span>
              </div>
              <div className="flex items-start justify-between gap-2">
                <span className="text-mc-textMuted flex items-center gap-1 shrink-0">
                  <FileText size={12} /> Current Log:
                </span>
                <span className="text-mc-text break-all text-right">{settings?.currentLogFile || 'apps/api/logs/'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
