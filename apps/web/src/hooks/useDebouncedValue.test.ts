import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedValue } from './useDebouncedValue.ts';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately, so the first render is not blank', () => {
    const { result } = renderHook(() => useDebouncedValue('alice', 250));
    expect(result.current).toBe('alice');
  });

  it('holds a change back until the delay has elapsed', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'ab' });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(249);
    });
    expect(result.current).toBe('a');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('ab');
  });

  it('emits once for a burst of keystrokes rather than once per keystroke', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: '' },
    });

    for (const v of ['m', 'mo', 'mom']) {
      rerender({ v });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      // Still on the initial value: no intermediate key ever escaped.
      expect(result.current).toBe('');
    }

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe('mom');
  });

  it('settles back without emitting when the value returns to what it already was', () => {
    const { result, rerender } = renderHook(({ v }) => useDebouncedValue(v, 250), {
      initialProps: { v: 'a' },
    });

    rerender({ v: 'ab' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender({ v: 'a' });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe('a');
  });
});
