/**
 * Shared by every dialog that picks a dispatch time. `datetime-local` inputs
 * speak local wall-clock strings with no zone, so these deliberately format
 * from the local getters rather than toISOString(), which would shift the
 * value by the operator's UTC offset.
 */

const pad = (n: number) => (n < 10 ? `0${n}` : String(n));

/** Formats a Date for a `datetime-local` input: YYYY-MM-DDTHH:mm. */
export const toLocalInputValue = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A `datetime-local` value this many minutes from now. */
export const getPresetTime = (minutesOffset: number): string =>
  toLocalInputValue(new Date(Date.now() + minutesOffset * 60 * 1000));

/** A `datetime-local` value for 09:00 tomorrow. */
export const getTomorrowMorning = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return toLocalInputValue(d);
};
