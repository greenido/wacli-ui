import { describe, it, expect } from 'vitest';
import { dayLabel, fullTimestamp, localDayKey } from './messageDates.ts';

/** A moment in local time, the way the thread reads timestamps. */
const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe('localDayKey', () => {
  it('puts two moments of the same local day together, however far apart', () => {
    expect(localDayKey(at(2026, 9, 1, 0, 1))).toBe(localDayKey(at(2026, 9, 1, 23, 59)));
  });

  it('splits at local midnight', () => {
    expect(localDayKey(at(2026, 9, 1, 23, 59))).not.toBe(localDayKey(at(2026, 9, 2, 0, 1)));
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 8, 3, 9, 30);

  it('says Today and Yesterday by local calendar day, not by 24-hour spans', () => {
    expect(dayLabel(at(2026, 9, 3, 0, 5), now)).toBe('Today');
    // Late last night is under 24 hours ago, and still yesterday.
    expect(dayLabel(at(2026, 9, 2, 23, 50), now)).toBe('Yesterday');
    expect(dayLabel(at(2026, 9, 2, 0, 5), now)).toBe('Yesterday');
  });

  it('dates anything older, with the year only when it is not this one', () => {
    const earlier = dayLabel(at(2026, 9, 1), now);
    expect(earlier).not.toMatch(/Today|Yesterday/);
    expect(earlier).not.toContain('2026');

    expect(dayLabel(at(2025, 12, 31), now)).toContain('2025');
  });

  it('counts days across a clock change', () => {
    // In a zone that changes its clocks on these dates, the days around the
    // change are 23 or 25 hours long, and the count still has to come out whole.
    const monday = new Date(2026, 2, 30, 12);
    expect(dayLabel(at(2026, 3, 29), monday)).toBe('Yesterday');
    expect(dayLabel(at(2026, 10, 25), new Date(2026, 9, 26, 12))).toBe('Yesterday');
  });

  it('gives nothing for a time it cannot read', () => {
    expect(dayLabel('not a time', now)).toBe('');
  });
});

describe('fullTimestamp', () => {
  it('carries the year and the time', () => {
    const text = fullTimestamp(at(2026, 7, 30, 12, 43));
    expect(text).toContain('2026');
    expect(text).toMatch(/12:43|0?12\.43/);
  });

  it('gives nothing for a time it cannot read', () => {
    expect(fullTimestamp('')).toBe('');
  });
});
