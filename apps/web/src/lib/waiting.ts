import type { QuickReplyTemplate, WaitingItem } from '../types.ts';

/**
 * What a nudge says when the operator has no template for it. Short and
 * neutral, because it goes out under their name once they confirm it.
 */
export const DEFAULT_NUDGE_TEXT = 'Just following up on this. Any news?';

/** A template whose name says it is for this: "Follow-up", "nudge", and so on. */
const NUDGE_TEMPLATE_NAME = /follow|nudge/i;

/**
 * The text Nudge puts in the composer: the operator's own follow-up template
 * when they keep one, so the wording is theirs, and a plain default otherwise.
 * Templates arrive most recently used first, so that one wins a tie.
 */
export function nudgeText(templates: readonly QuickReplyTemplate[] | undefined): string {
  const own = templates?.find((t) => NUDGE_TEMPLATE_NAME.test(t.name) && t.body.trim());
  return own ? own.body : DEFAULT_NUDGE_TEXT;
}

/**
 * Who has it, in the words the row uses. wacli keeps receipt counts but not
 * receipt times, so this says what they did and not when they did it; the age
 * next to it is how long ago the message went out.
 */
export function describeWaiting(item: WaitingItem): string {
  const name = item.chatName || item.chatJid.split('@')[0];
  switch (item.message.deliveryStatus) {
    case 'read':
      return `${name} read this`;
    case 'played':
      return `${name} played this`;
    default:
      return `Delivered to ${name}`;
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "5 min ago", "3h ago", "2 days ago": coarse on purpose, it is a waiting time. */
export function sentAgo(ts: string, now: Date = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - new Date(ts).getTime());
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  const days = Math.floor(elapsed / DAY);
  if (days < 14) return days === 1 ? '1 day ago' : `${days} days ago`;
  return `${Math.floor(days / 7)} weeks ago`;
}

export interface RemindPreset {
  label: string;
  /** ISO 8601. */
  until: string;
}

/** That many days from now, at 09:00 local time. */
function morningIn(days: number, now: Date): string {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

/**
 * When "Remind me" can bring a row back. Mornings rather than "24 hours from
 * now", so a reminder set late in the evening does not land at the same late
 * hour.
 */
export function remindPresets(now: Date = new Date()): RemindPreset[] {
  return [
    { label: 'In 3 hours', until: new Date(now.getTime() + 3 * HOUR).toISOString() },
    { label: 'Tomorrow 9:00', until: morningIn(1, now) },
    { label: 'In 3 days', until: morningIn(3, now) },
    { label: 'Next week', until: morningIn(7, now) },
  ];
}
