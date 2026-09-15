import { useEffect } from 'react';
import { focusManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';

export const SLEEP_QUERY_KEY = ['sleep'] as const;

export interface SleepMode {
  /** The server has answered. Until it has, nothing is known, awake included. */
  known: boolean;
  sleeping: boolean;
  /**
   * Known to be awake. Anything that would reach wacli waits on this rather
   * than on `!sleeping`, so a console that has not heard yet cannot race a
   * server that is asleep.
   */
  awake: boolean;
  /** When sleep began, ISO 8601, or null while awake. */
  since: string | null;
  /**
   * Asks the server to switch. The answer lands in the cache and a refusal in
   * `sleepError`, so a button can fire it and forget it without leaving an
   * unhandled rejection behind.
   */
  setSleeping: (sleeping: boolean, reason?: string) => void;
  isSettingSleep: boolean;
  /** Why the last switch from this caller failed, for the control that started it. */
  sleepError: Error | null;
}

/**
 * The console's reading of sleep mode.
 *
 * Pushed rather than polled: the server announces every change as
 * `sleep.changed`, and the socket re-reads it on reconnect in case one was
 * missed. So the query never goes stale on its own — and one that polled would
 * defeat the point of sleeping.
 */
export function useSleepMode(): SleepMode {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: SLEEP_QUERY_KEY,
    queryFn: () => api.getSleep(),
    staleTime: Infinity,
  });

  const mutation = useMutation({
    mutationFn: ({ sleeping, reason }: { sleeping: boolean; reason?: string }) =>
      api.setSleep(sleeping, reason),
    onSuccess: (state) => {
      queryClient.setQueryData(SLEEP_QUERY_KEY, state);
    },
  });

  return {
    known: data !== undefined,
    sleeping: data?.sleeping ?? false,
    awake: data !== undefined && !data.sleeping,
    since: data?.since ?? null,
    setSleeping: (sleeping, reason) => mutation.mutate({ sleeping, reason }),
    isSettingSleep: mutation.isPending,
    sleepError: mutation.error,
  };
}

/**
 * What sleep does to the whole tab. Mounted once, in App.
 *
 * Every poll in the console, the app's own lists included, ticks only while
 * the window counts as focused, and a refocus refetches whatever has gone
 * stale. Asleep, the window never counts as focused, so nothing polls and
 * nothing refetches on focus, while pushes still land. Waking hands focus
 * back to the browser, which refetches what went stale in the meantime.
 */
export function useSleepEffects(): void {
  const { sleeping } = useSleepMode();

  useEffect(() => {
    if (!sleeping) return;
    focusManager.setFocused(false);
    return () => focusManager.setFocused(undefined);
  }, [sleeping]);
}
