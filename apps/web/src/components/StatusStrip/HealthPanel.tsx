import React from 'react';
import { RotateCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { isHeartbeatStale } from '../../lib/heartbeat.ts';
import { CopyableError } from '../CopyableError/CopyableError.tsx';
import { statusColor } from '../../lib/statusColor.ts';
import type { MissionControlStatus } from '../../types.ts';

interface HealthPanelProps {
  health: MissionControlStatus | undefined;
  wsConnected: boolean;
  isReadOnly: boolean;
  sleeping: boolean;
  sleepError: Error | null;
}

/** The state blocks at the top of the strip: mode, wacli, the daemon, the linked account. */
export const HealthPanel: React.FC<HealthPanelProps> = ({
  health,
  wsConnected,
  isReadOnly,
  sleeping,
  sleepError,
}) => {
  const queryClient = useQueryClient();
  const restartDaemonMutation = useMutation({
    mutationFn: () => api.restartDaemon(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] });
    },
  });

  const processState = health?.processState ?? 'stopped';
  const offByChoice = processState === 'stopped' && Boolean(health?.syncDisabled);
  const doctor = health?.doctor;
  const heartbeatAge = health?.heartbeatAgeSeconds;

  const getStatusColor = () => statusColor(processState, wsConnected);

  return (
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
          {/* Asleep, the daemon is down on purpose: `stopped` in red would
              read as a fault, and a restart would undo the sleep. */}
          {sleeping ? (
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-mc-textMuted" />
              <span className="font-semibold uppercase text-mc-textMuted">sleeping</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${
                  offByChoice ? 'bg-mc-textMuted' : getStatusColor().split(' ')[0]
                } ${processState === 'running' ? 'animate-pulse' : ''}`}
              />
              {/* Off on purpose (`--no-sync`) is not a fault either: reads
                  still work, and only live updates wait for a daemon. */}
              {offByChoice ? (
                <span
                  className="font-semibold uppercase text-mc-textMuted"
                  title="Started with --no-sync. Chats and messages still load; nothing new arrives live until the daemon runs."
                >
                  off (--no-sync)
                </span>
              ) : (
                <span className={`font-semibold uppercase ${getStatusColor().split(' ')[1]}`}>
                  {processState}
                </span>
              )}
              <button
                onClick={() => restartDaemonMutation.mutate()}
                disabled={restartDaemonMutation.isPending}
                className="ml-1 p-0.5 rounded hover:bg-mc-surfaceHover text-mc-textMuted hover:text-mc-text transition-colors"
                title={offByChoice ? 'Start the daemon' : 'Restart Daemon'}
              >
                <RotateCw size={11} className={restartDaemonMutation.isPending ? 'animate-spin' : ''} />
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between text-[11px] text-mc-textMuted pt-1 border-t border-mc-border/50">
          <span>WS RELAY</span>
          <span className={wsConnected ? 'text-mc-live' : 'text-mc-danger'}>
            {wsConnected ? 'ONLINE' : 'DISCONNECTED'}
          </span>
        </div>

        {!sleeping && heartbeatAge !== null && heartbeatAge !== undefined && (
          <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
            <span>HEARTBEAT</span>
            <span className={isHeartbeatStale(heartbeatAge) ? 'text-mc-safe' : 'text-mc-text'}>
              {heartbeatAge}s ago
            </span>
          </div>
        )}

        {!sleeping && typeof health?.processPid === 'number' && (
          <div className="flex items-center justify-between text-[11px] text-mc-textMuted">
            <span>PID</span>
            <span className="text-mc-text font-mono">{health.processPid}</span>
          </div>
        )}

        {!sleeping && health?.storeLockHeld && (
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

        {sleepError && (
          <div className="text-[11px] text-mc-danger break-all">
            Sleep switch failed: {sleepError.message}
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

      {health?.lastError && <CopyableError message={health.lastError} />}
    </div>
  );
};
