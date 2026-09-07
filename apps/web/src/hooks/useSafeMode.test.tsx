import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSafeMode, readCachedSafeMode } from './useSafeMode.ts';

const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());

vi.mock('../api/client.ts', () => ({ api: { getMode, setMode } }));

const STORAGE_KEY = 'wacli_safe_mode';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const renderSafeMode = () => renderHook(() => useSafeMode(), { wrapper });

describe('readCachedSafeMode', () => {
  beforeEach(() => localStorage.clear());

  /**
   * Safe read-only mode is the one guardrail between a keystroke and a message
   * leaving this machine. Five components each defaulted it to *unlocked* while
   * the answer was still unknown, which is the opposite of the server's own
   * first-run default.
   */
  it('is locked when nothing has been remembered', () => {
    expect(readCachedSafeMode()).toBe(true);
  });

  it('is locked when the remembered value is not a confirmed "live"', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    expect(readCachedSafeMode()).toBe(true);

    localStorage.setItem(STORAGE_KEY, 'whatever an older build wrote');
    expect(readCachedSafeMode()).toBe(true);

    localStorage.setItem(STORAGE_KEY, '');
    expect(readCachedSafeMode()).toBe(true);
  });

  it('is live only for a remembered, confirmed "false"', () => {
    localStorage.setItem(STORAGE_KEY, 'false');
    expect(readCachedSafeMode()).toBe(false);
  });

  it('is locked when storage cannot be read at all', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('storage disabled');
      });

    expect(readCachedSafeMode()).toBe(true);
    getItem.mockRestore();
  });
});

describe('useSafeMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getMode.mockResolvedValue({ readOnly: true });
    setMode.mockResolvedValue({ readOnly: false });
  });

  it('starts locked, before the server has said anything', () => {
    const { result } = renderSafeMode();
    expect(result.current.isReadOnly).toBe(true);
  });

  it('stays locked while the server is unreachable', async () => {
    getMode.mockRejectedValue(new Error('connection refused'));

    const { result } = renderSafeMode();
    await waitFor(() => expect(getMode).toHaveBeenCalled());

    expect(result.current.isReadOnly).toBe(true);
  });

  it('takes the server’s answer once it arrives', async () => {
    getMode.mockResolvedValue({ readOnly: false });

    const { result } = renderSafeMode();

    await waitFor(() => expect(result.current.isReadOnly).toBe(false));
  });

  it('opens unlocked for an operator who already unlocked before', async () => {
    // A cached, server-confirmed "live" is the one thing that skips the wait,
    // so a reload does not flash the safe-mode banner at a live console.
    localStorage.setItem(STORAGE_KEY, 'false');
    getMode.mockReturnValue(new Promise(() => {}));

    const { result } = renderSafeMode();

    expect(result.current.isReadOnly).toBe(false);
  });

  it('remembers a mode the server reported', async () => {
    getMode.mockResolvedValue({ readOnly: false });

    renderSafeMode();

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('false'));
  });

  /**
   * The regression this hook exists for: every call site wrote localStorage
   * inside its own `mutationFn`, before the request. A refused unlock left the
   * console claiming live sends while the server was still refusing them.
   */
  it('does not remember an unlock the server refused', async () => {
    getMode.mockResolvedValue({ readOnly: true });
    setMode.mockRejectedValue(new Error('Safe read-only mode is active.'));

    const { result } = renderSafeMode();
    await waitFor(() => expect(result.current.isReadOnly).toBe(true));

    await act(async () => {
      await expect(result.current.setSafeMode(false)).rejects.toThrow();
    });

    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');
    expect(result.current.isReadOnly).toBe(true);
  });

  it('remembers an unlock the server confirmed', async () => {
    const { result } = renderSafeMode();
    await waitFor(() => expect(result.current.isReadOnly).toBe(true));

    getMode.mockResolvedValue({ readOnly: false });
    await act(async () => {
      await result.current.setSafeMode(false);
    });

    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe('false'));
    await waitFor(() => expect(result.current.isReadOnly).toBe(false));
  });

  it('reports why a flip failed', async () => {
    setMode.mockRejectedValue(new Error('Safe read-only mode is active.'));

    const { result } = renderSafeMode();

    await act(async () => {
      await result.current.setSafeMode(false).catch(() => {});
    });

    await waitFor(() =>
      expect(result.current.setModeError?.message).toBe('Safe read-only mode is active.')
    );
  });
});
