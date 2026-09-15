import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSleepMode } from './useSleepMode.ts';
import type { SleepState } from '../types.ts';

const getSleep = vi.hoisted(() => vi.fn());
const setSleep = vi.hoisted(() => vi.fn());

vi.mock('../api/client.ts', () => ({
  api: { getSleep, setSleep },
}));

const SINCE = '2026-09-15T22:14:00.000Z';

let client: QueryClient;

function mount() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSleepMode(), { wrapper });
}

describe('useSleepMode', () => {
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getSleep.mockReset();
    setSleep.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('knows nothing, awake included, until the server answers', async () => {
    let answer: (state: SleepState) => void = () => {};
    getSleep.mockReturnValue(
      new Promise<SleepState>((resolve) => {
        answer = resolve;
      })
    );

    const { result } = mount();

    // Reads that reach wacli wait on `awake`, so a console that does not know
    // yet must not claim it: that would race a server that is asleep.
    expect(result.current.known).toBe(false);
    expect(result.current.awake).toBe(false);
    expect(result.current.sleeping).toBe(false);

    act(() => answer({ sleeping: false, since: null }));
    await waitFor(() => expect(result.current.awake).toBe(true));
  });

  it('reports sleep and when it began', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: SINCE });

    const { result } = mount();

    await waitFor(() => expect(result.current.known).toBe(true));
    expect(result.current).toMatchObject({ sleeping: true, awake: false, since: SINCE });
  });

  it("takes the server's answer to a switch as the new state, without a refetch", async () => {
    getSleep.mockResolvedValue({ sleeping: false, since: null });
    setSleep.mockResolvedValue({ sleeping: true, since: SINCE });

    const { result } = mount();
    await waitFor(() => expect(result.current.awake).toBe(true));
    act(() => result.current.setSleeping(true, 'sleep button'));

    await waitFor(() => expect(result.current.sleeping).toBe(true));
    expect(setSleep).toHaveBeenCalledWith(true, 'sleep button');
    expect(result.current.since).toBe(SINCE);
    expect(getSleep).toHaveBeenCalledTimes(1);
  });

  it('keeps a refused switch for the control to show, and the state as it was', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: SINCE });
    setSleep.mockRejectedValue(new Error('API unreachable'));

    const { result } = mount();
    await waitFor(() => expect(result.current.sleeping).toBe(true));
    act(() => result.current.setSleeping(false, 'wake button'));

    await waitFor(() => expect(result.current.sleepError?.message).toBe('API unreachable'));
    expect(result.current).toMatchObject({ sleeping: true, since: SINCE });
  });

  it('never polls: the WebSocket keeps it current', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getSleep.mockResolvedValue({ sleeping: false, since: null });

    const { result } = mount();
    await waitFor(() => expect(result.current.known).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });

    expect(getSleep).toHaveBeenCalledTimes(1);
  });
});
