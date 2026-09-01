import type { UseQueryOptions } from '@tanstack/react-query';
import { ApiClientError } from '../api/client.ts';

export function wacliReadQueryOptions<T>(
  enabled: boolean
): Pick<UseQueryOptions<T, ApiClientError>, 'enabled' | 'retry' | 'retryDelay'> {
  return {
    enabled,
    retry: (failureCount, error) => {
      if (error instanceof ApiClientError && error.code === 'STORE_LOCKED' && failureCount < 4) {
        return true;
      }
      return failureCount < 1;
    },
    retryDelay: (attempt) => Math.min(400 * attempt, 2000),
  };
}
