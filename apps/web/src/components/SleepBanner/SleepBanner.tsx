import React from 'react';
import { AlertTriangle, Moon, Sun } from 'lucide-react';
import { useSleepMode } from '../../hooks/useSleepMode.ts';
import { useSafeMode } from '../../hooks/useSafeMode.ts';
import { useScheduledQueue } from '../../hooks/useScheduledQueue.ts';
import { formatWhen } from '../../lib/scheduleTime.ts';

/**
 * Says the app is asleep, and what it is still doing about it.
 *
 * The scheduled queue is the one thing sleep keeps, so the banner carries its
 * count and the next send time; everything else on screen is as it was when
 * sleep began. Safe mode gets a warning here because it is the one setting that
 * quietly turns the whole queue into failures, and the operator is about to
 * walk away from it.
 */
export const SleepBanner: React.FC = () => {
  const { sleeping, since, setSleeping, isSettingSleep, sleepError } = useSleepMode();
  const { isReadOnly } = useSafeMode();
  const { data: queue } = useScheduledQueue();

  if (!sleeping) return null;

  const firstPage = queue?.pages[0];
  // Pending is complete and soonest first, so its head is the next send.
  const next = firstPage?.pending[0];

  return (
    <div
      role="status"
      aria-label="Sleep mode"
      className="min-h-8 bg-mc-surface border-b border-mc-border flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-1 text-xs font-mono select-none"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
        <Moon size={14} className="text-mc-textMuted shrink-0" />
        <span className="font-semibold text-mc-text">
          SLEEPING{since ? ` SINCE ${formatWhen(since)}` : ''}
        </span>
        {firstPage && (
          <span className="text-mc-textMuted">
            {'· '}
            {next
              ? `${firstPage.totalPending} scheduled, next ${formatWhen(next.scheduledAt)}`
              : 'nothing scheduled'}
          </span>
        )}
        {isReadOnly && next && (
          <span className="flex items-center gap-1 text-mc-danger font-semibold">
            <AlertTriangle size={12} className="shrink-0" />
            Safe mode is on — these will fail when due.
          </span>
        )}
        {sleepError && (
          <span className="text-mc-danger">Could not wake: {sleepError.message}</span>
        )}
      </div>
      <button
        onClick={() => setSleeping(false, 'wake button')}
        disabled={isSettingSleep}
        className="flex items-center gap-1.5 bg-mc-surfaceHover hover:bg-mc-border text-mc-text border border-mc-border px-2 py-0.5 rounded text-[11px] font-semibold transition-colors disabled:opacity-50"
        title="Wake: resume syncing and refreshing"
      >
        <Sun size={12} />
        <span>WAKE</span>
      </button>
    </div>
  );
};
