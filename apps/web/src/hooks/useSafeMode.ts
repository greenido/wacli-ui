import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { POLL_MODE_MS } from '../lib/queryOptions.ts';

const STORAGE_KEY = 'wacli_safe_mode';

/**
 * What the console believes about safe read-only mode before the server has
 * answered.
 *
 * Anything other than a remembered, server-confirmed "live" reads as locked:
 * no cache, an unreadable one, a value written by an older build. This is the
 * one guardrail between a keystroke and a message leaving the machine, and the
 * server's own first-run default is locked — so a console that does not yet
 * know must not render as though sends are armed. Five components each carried
 * their own copy of this expression and every one of them defaulted the other
 * way.
 */
export function readCachedSafeMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    // Private window, or storage disabled. Locked is the safe answer.
    return true;
  }
}

/** Remembers a mode the server has actually confirmed. Never a guess. */
function cacheSafeMode(readOnly: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(readOnly));
  } catch {
    // The mode still applies for this session; only the memory of it is lost.
    }
}

export interface SafeMode {
  /** Whether outgoing sends are currently locked. Locked until told otherwise. */
  isReadOnly: boolean;
  /**
   * Flips the mode, and only records it once the server has agreed. Rejects if
   * the server refuses, so a caller with something to do afterwards can wait on
   * it; callers with nothing to do can ignore it and read `setModeError`.
   */
  setSafeMode: (readOnly: boolean) => Promise<{ readOnly: boolean }>;
  /** A flip is in flight, for disabling the control that started it. */
  isSettingMode: boolean;
  /** Why the last flip failed, for a control that shows its own errors. */
  setModeError: Error | null;
}

/**
 * The console's single reading of safe read-only mode.
 *
 * The cache is written from the server's answer — on a poll, or when a flip
 * comes back — and never before. Writing it up front, which every call site
 * used to do inside its own `mutationFn`, meant a failed unlock left the UI
 * claiming live sends while the server was still refusing them.
 */
export function useSafeMode(): SafeMode {
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['mode'],
    queryFn: () => api.getMode(),
    refetchInterval: POLL_MODE_MS,
  });

  useEffect(() => {
    if (typeof data?.readOnly === 'boolean') {
      cacheSafeMode(data.readOnly);
    }
  }, [data?.readOnly]);

  const mutation = useMutation({
    mutationFn: (readOnly: boolean) => api.setMode(readOnly),
    onSuccess: (result) => {
      cacheSafeMode(result.readOnly);
      queryClient.invalidateQueries({ queryKey: ['mode'] });
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  return {
    isReadOnly: data?.readOnly ?? readCachedSafeMode(),
    setSafeMode: mutation.mutateAsync,
    isSettingMode: mutation.isPending,
    setModeError: mutation.error,
  };
}
