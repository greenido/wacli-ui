import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { POLL_CHANGES_MS } from '../lib/queryOptions.ts';
import { isWacliReadyForReads } from '../lib/wacliReady.ts';
import { useAppStore } from '../store/appStore.ts';
import { useHealth } from './useHealth.ts';
import { useSleepMode } from './useSleepMode.ts';

/**
 * How long to wait before asking a wacli without the feed again. It does not
 * grow one by being asked, but an upgrade (and a restart of the console)
 * should not have to wait for a page reload to be noticed.
 */
const UNSUPPORTED_RETRY_MS = 5 * 60_000;

/** Refetches what a change in `chats` makes stale: each thread, every page of it, and the lists. */
export function refreshChangedChats(queryClient: QueryClient, chats: string[] | 'all'): void {
  if (chats === 'all') {
    void queryClient.invalidateQueries({ queryKey: ['messages'] });
  } else {
    // A prefix: the live thread and any history window open on it. Every
    // loaded page refetches, which is what keeps a thread read far back from
    // going stale, and it is paid only by a chat that actually changed.
    for (const jid of chats) void queryClient.invalidateQueries({ queryKey: ['messages', jid] });
    if (chats.length === 0) return;
  }
  void queryClient.invalidateQueries({ queryKey: ['chats'] });
  void queryClient.invalidateQueries({ queryKey: ['waiting'] });
}

/**
 * Follows wacli's change feed and refreshes exactly the chats it names.
 * Mounted once, in App.
 *
 * The checkpoint lives here for the life of the page. The first answer only
 * sets it, since everything on screen was fetched just now. A reset after
 * that (an expired checkpoint, or more changes than one answer lists) means
 * something was missed, so everything is refetched once.
 *
 * Paused while the tab is hidden, as React Query's own polls are, and asked
 * again the moment it is shown. Asleep, or before wacli is ready, it does not
 * ask at all.
 */
export function useChangeFeed(): void {
  const queryClient = useQueryClient();
  const { awake } = useSleepMode();
  const { data: health } = useHealth();
  const readsReady = awake && isWacliReadyForReads(health);
  const checkpoint = useRef<string | null>(null);

  useEffect(() => {
    const { setChangeFeedLive } = useAppStore.getState();
    if (!readsReady) {
      setChangeFeedLive(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!cancelled) timer = setTimeout(tick, ms);
    };

    async function tick() {
      if (cancelled || inFlight) return;
      if (document.visibilityState === 'hidden') return; // resumed by onVisible
      inFlight = true;
      let next = POLL_CHANGES_MS;
      try {
        const answer = await api.getChanges(checkpoint.current ?? undefined);
        if (cancelled) return;
        if (!answer.supported) {
          checkpoint.current = null;
          setChangeFeedLive(false);
          next = UNSUPPORTED_RETRY_MS;
        } else {
          const first = checkpoint.current === null;
          checkpoint.current = answer.checkpoint;
          setChangeFeedLive(true);
          if (answer.reset) {
            if (!first) refreshChangedChats(queryClient, 'all');
          } else {
            refreshChangedChats(queryClient, answer.chats);
          }
        }
      } catch {
        // The blind polls take over until the feed answers again. The
        // checkpoint is kept: a later answer from it still covers the gap.
        setChangeFeedLive(false);
      } finally {
        inFlight = false;
      }
      schedule(next);
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule(0);
    };

    document.addEventListener('visibilitychange', onVisible);
    void tick();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [readsReady, queryClient]);
}
