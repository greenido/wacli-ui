import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { useHealth } from './useHealth.ts';
import { POLL_HEALTH_MS } from '../lib/queryOptions.ts';
import type { SleepState } from '../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getSleep = vi.hoisted(() => vi.fn());

vi.mock('../api/client.ts', () => ({
  api: { getHealth, getSleep },
}));

const AWAKE: SleepState = { sleeping: false, since: null };
const ASLEEP: SleepState = { sleeping: true, since: '2026-09-15T22:14:00.000Z' };

let client: QueryClient;

function mount() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useHealth(), { wrapper });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getHealth.mockReset();
    getHealth.mockResolvedValue({ processState: 'running' });
    getSleep.mockReset();
  });

  afterEach(() => {
    client.clear();
    // The focus manager is a module-level singleton; leave it as found.
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it('polls on the health interval while awake', async () => {
    getSleep.mockResolvedValue(AWAKE);

    const { result } = mount();
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(getHealth).toHaveBeenCalledTimes(1);

    await advance(POLL_HEALTH_MS);
    expect(getHealth).toHaveBeenCalledTimes(2);
  });

  it('waits for the sleep answer before its first fetch', async () => {
    let answer: (state: SleepState) => void = () => {};
    getSleep.mockReturnValue(
      new Promise<SleepState>((resolve) => {
        answer = resolve;
      })
    );

    mount();
    await advance(POLL_HEALTH_MS * 2);
    expect(getHealth).not.toHaveBeenCalled();

    act(() => answer(AWAKE));
    await waitFor(() => expect(getHealth).toHaveBeenCalledTimes(1));
  });

  it('fetches nothing while asleep, whatever asks for it', async () => {
    getSleep.mockResolvedValue(ASLEEP);

    mount();
    await waitFor(() => expect(client.getQueryData(['sleep'])).toEqual(ASLEEP));

    // The interval, an invalidation, a refocus, and another component mounting.
    await advance(10 * 60_000);
    await act(() => client.invalidateQueries({ queryKey: ['health'] }));
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    mount();
    await advance(POLL_HEALTH_MS);

    expect(getHealth).not.toHaveBeenCalled();
  });

  it('keeps the last reading while asleep, and reads again on wake', async () => {
    getSleep.mockResolvedValue(AWAKE);

    const { result } = mount();
    await waitFor(() => expect(result.current.data).toEqual({ processState: 'running' }));

    act(() => client.setQueryData(['sleep'], ASLEEP));
    getHealth.mockResolvedValue({ processState: 'starting' });
    await advance(10 * 60_000);

    expect(getHealth).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ processState: 'running' });

    act(() => client.setQueryData(['sleep'], AWAKE));
    await waitFor(() => expect(result.current.data).toEqual({ processState: 'starting' }));
    expect(getHealth).toHaveBeenCalledTimes(2);
  });
});
