import { describe, it, expect } from 'vitest';
import { formatWhen } from './scheduleTime.ts';

describe('formatWhen', () => {
  const now = new Date(2026, 8, 15, 22, 14);

  it('gives only the clock for a moment today', () => {
    const later = new Date(2026, 8, 15, 23, 5);

    expect(formatWhen(later.toISOString(), now)).toBe(
      later.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    );
  });

  it('adds the date for any other day, so tomorrow morning is not read as this one', () => {
    const tomorrow = new Date(2026, 8, 16, 6, 30);
    const formatted = formatWhen(tomorrow.toISOString(), now);

    expect(formatted).toContain(tomorrow.toLocaleDateString([], { month: 'short', day: 'numeric' }));
    expect(formatted).toContain(tomorrow.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });
});
