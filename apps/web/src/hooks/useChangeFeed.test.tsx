import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useChangeFeed } from './useChangeFeed.ts';
import { POLL_CHANGES_MS } from '../lib/queryOptions.ts';
import { useAppStore } from '../store/appStore.ts';
import type { ChangesAnswer, SleepState } from '../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getSleep = vi.hoisted(() => vi.fn());
const getChanges = vi.hoisted(() => vi.fn());

vi.mock('../api/client.ts', () => ({
  api: { getHealth, getSleep, getChanges },
  ApiClientError: class extends Error {},
}));

const AWAKE: SleepState = { sleeping: false, since: null };
const ASLEEP: SleepState = { sleeping: true, since: '2026-11-23T22:14:00.000Z' };
const ADA = '15550100001@s.whatsapp.net';

const answer = (overrides: Partial<ChangesAnswer> = {}): ChangesAnswer => ({
  supported: true,
  checkpoint: 'CKPT1',
  chats: [],
  reset: false,
  ...overrides,
});

let client: QueryClient;
let invalidated: unknown[][];

function mount() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useChangeFeed(), { wrapper });
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('useChangeFeed', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    invalidated = [];
    vi.spyOn(client, 'invalidateQueries').mockImplementation(async (filters) => {
      invalidated.push((filters?.queryKey as unknown[]) ?? []);
    });
    getHealth.mockReset().mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    getSleep.mockReset().mockResolvedValue(AWAKE);
    getChanges.mockReset();
    useAppStore.setState({ changeFeedLive: false });
  });

  afterEach(() => {
    client.clear();
    vi.useRealTimers();
    useAppStore.setState({ changeFeedLive: false });
  });

  it('starts from a checkpoint without refetching what was just loaded', async () => {
    getChanges.mockResolvedValue(answer({ reset: true, checkpoint: 'CKPT0' }));

    mount();

    await waitFor(() => expect(useAppStore.getState().changeFeedLive).toBe(true));
    expect(getChanges).toHaveBeenCalledWith(undefined);
    expect(invalidated).toEqual([]);
  });

  it('refetches exactly the chats that changed, and asks from the new checkpoint', async () => {
    getChanges
      .mockResolvedValueOnce(answer({ reset: true, checkpoint: 'CKPT0' }))
      .mockResolvedValueOnce(answer({ checkpoint: 'CKPT1', chats: [ADA] }))
      .mockResolvedValue(answer({ checkpoint: 'CKPT1' }));

    mount();
    await waitFor(() => expect(getChanges).toHaveBeenCalledTimes(1));
    await advance(POLL_CHANGES_MS);

    expect(getChanges).toHaveBeenLastCalledWith('CKPT0');
    expect(invalidated).toEqual([['messages', ADA], ['chats'], ['waiting']]);

    // Nothing changed: nothing is refetched.
    invalidated = [];
    await advance(POLL_CHANGES_MS);
    expect(getChanges).toHaveBeenLastCalledWith('CKPT1');
    expect(invalidated).toEqual([]);
  });

  it('refetches everything once when the feed has to start over', async () => {
    getChanges
      .mockResolvedValueOnce(answer({ reset: true, checkpoint: 'CKPT0' }))
      .mockResolvedValueOnce(answer({ reset: true, checkpoint: 'FRESH' }));

    mount();
    await waitFor(() => expect(getChanges).toHaveBeenCalledTimes(1));
    await advance(POLL_CHANGES_MS);

    expect(invalidated).toEqual([['messages'], ['chats'], ['waiting']]);
  });

  it('hands back to the timers on a wacli without the feed, and asks again much later', async () => {
    getChanges.mockResolvedValue(answer({ supported: false, checkpoint: null }));

    mount();
    await waitFor(() => expect(getChanges).toHaveBeenCalledTimes(1));
    await advance(POLL_CHANGES_MS * 3);

    expect(useAppStore.getState().changeFeedLive).toBe(false);
    expect(getChanges).toHaveBeenCalledTimes(1);
  });

  it('falls back on a failure, and resumes from the same checkpoint', async () => {
    getChanges
      .mockResolvedValueOnce(answer({ reset: true, checkpoint: 'CKPT0' }))
      .mockRejectedValueOnce(new Error('database is locked'))
      .mockResolvedValue(answer({ checkpoint: 'CKPT1' }));

    mount();
    await waitFor(() => expect(useAppStore.getState().changeFeedLive).toBe(true));
    await advance(POLL_CHANGES_MS);
    expect(useAppStore.getState().changeFeedLive).toBe(false);

    await advance(POLL_CHANGES_MS);
    // What happened during the failure is still covered.
    expect(getChanges).toHaveBeenLastCalledWith('CKPT0');
    expect(useAppStore.getState().changeFeedLive).toBe(true);
  });

  it('asks nothing while asleep', async () => {
    getSleep.mockResolvedValue(ASLEEP);

    mount();
    await advance(POLL_CHANGES_MS * 2);

    expect(getChanges).not.toHaveBeenCalled();
    expect(useAppStore.getState().changeFeedLive).toBe(false);
  });
});
