import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { POLL_HEALTH_MS } from '../lib/queryOptions.ts';
import { useSleepMode } from './useSleepMode.ts';

/**
 * The console's one declaration of `/api/health`, which costs the server a
 * `wacli doctor`.
 *
 * It is off while the app is asleep. The last reading stays on screen, and
 * nothing reaches the server for a new one until the app wakes: not the
 * interval, an invalidation, a refocus, or another component mounting. Eight
 * components declared this query inline, and every one of them would have
 * had to be gated to get that; now it is one line.
 */
export function useHealth() {
  const { awake } = useSleepMode();

  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.getHealth(),
    refetchInterval: POLL_HEALTH_MS,
    enabled: awake,
  });
}
