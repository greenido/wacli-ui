/**
 * Dates for the thread. A bubble shows only its time, so a thread read back
 * across days needs the days marked, and each time needs its date to hand.
 */

const DAY_MS = 86_400_000;

/** The local calendar day a moment falls on, as a key two moments can share. */
export function localDayKey(ts: string): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** What a day divider says: Today, Yesterday, or the date itself. */
export function dayLabel(ts: string, now: Date = new Date()): string {
  const day = new Date(ts);
  if (Number.isNaN(day.getTime())) return '';

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const that = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  // Rounded, because the day a clock change falls on is 23 or 25 hours long.
  const daysAgo = Math.round((today.getTime() - that.getTime()) / DAY_MS);
  if (daysAgo === 0) return 'Today';
  if (daysAgo === 1) return 'Yesterday';

  return day.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    // This year's dates go without it, the way people write them.
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** The full date and time, for hovering over a bubble's time. */
export function fullTimestamp(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
}
