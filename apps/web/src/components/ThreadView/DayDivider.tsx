import React from 'react';
import { dayLabel, fullTimestamp } from '../../lib/messageDates.ts';

/**
 * Marks where a new day starts in the thread. Bubbles show only their time, so
 * without these a thread read back across days gave no hint which day it was.
 */
export const DayDivider: React.FC<{ ts: string }> = ({ ts }) => {
  const label = dayLabel(ts);
  if (!label) return null;

  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 py-1 select-none">
      <div className="flex-1 border-t border-mc-border/60" />
      <time
        dateTime={ts}
        title={fullTimestamp(ts)}
        className="text-[10px] font-mono uppercase tracking-wider text-mc-textMuted"
      >
        {label}
      </time>
      <div className="flex-1 border-t border-mc-border/60" />
    </div>
  );
};
