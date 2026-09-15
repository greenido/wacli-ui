import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store/appStore.ts';
import { ensureAwake, useSleepMode } from './useSleepMode.ts';

type AppState = ReturnType<typeof useAppStore.getState>;

/**
 * Why a change in the store means the operator wants fresh data from wacli,
 * or null when it doesn't. The reason is what the API log records.
 *
 * Opening the chat that is already open is not a trigger: a LATER or ACTIVITY
 * row for it only moves the highlight within what is loaded. Nor is closing a
 * chat, a tag filter, or any other modal, none of which reads from wacli.
 *
 * The rail also opens a chat by itself when none is open. Today that happens
 * only as a page loads, which wakes the app anyway; anything that can leave
 * the console with no chat open would make it a wake of its own.
 */
export function wakeReason(state: AppState, prev: AppState): string | null {
  if (state.selectedChat && state.selectedChat.jid !== prev.selectedChat?.jid) return 'open chat';
  if (state.chatFilter !== prev.chatFilter) return 'rail filter';
  if (state.searchQuery !== prev.searchQuery) return 'rail search';
  if (state.activeModal !== prev.activeModal) {
    if (state.activeModal === 'new-chat') return 'new chat';
    if (state.activeModal === 'chat-info') return 'chat info';
  }
  return null;
}

/**
 * Every place the console wakes itself, so they can be audited in one file.
 * Mounted once, in App.
 *
 * Wakes are explicit and never inferred from a fetch: a background refetch
 * that slipped through would otherwise end sleep, which nothing automatic may
 * do. The other two ways out are the Wake button and the server, which wakes
 * for any wacli write. Load older and Export, the two fetches that bypass
 * `enabled`, call `ensureAwake` themselves.
 */
export function useWakeOnIntent({ searchOpen }: { searchOpen: boolean }): void {
  const queryClient = useQueryClient();
  const { known, sleeping } = useSleepMode();

  // A page loading is someone at the machine. Only the first answer counts: a
  // reconnect reads the state again, and that is not a page load.
  const firstAnswer = useRef<boolean | null>(null);
  useEffect(() => {
    if (!known || firstAnswer.current !== null) return;
    firstAnswer.current = sleeping;
    if (sleeping) void ensureAwake(queryClient, 'page load');
  }, [known, sleeping, queryClient]);

  useEffect(
    () =>
      useAppStore.subscribe((state, prev) => {
        const reason = wakeReason(state, prev);
        if (reason) void ensureAwake(queryClient, reason);
      }),
    [queryClient]
  );

  useEffect(() => {
    if (searchOpen) void ensureAwake(queryClient, 'search');
  }, [searchOpen, queryClient]);
}
