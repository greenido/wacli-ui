import { describe, it, expect } from 'vitest';
import { ApiClientError } from '../api/client.ts';
import { wacliReadQueryOptions } from './queryOptions.ts';

describe('wacliReadQueryOptions retry', () => {
  const { retry } = wacliReadQueryOptions(true);

  it('keeps trying through a held store lock, up to a point', () => {
    const locked = new ApiClientError('store is locked', 409, 'STORE_LOCKED');

    expect(retry(0, locked)).toBe(true);
    expect(retry(3, locked)).toBe(true);
    expect(retry(4, locked)).toBe(false);
  });

  it('never retries a server that is asleep: asking again cannot wake it', () => {
    expect(retry(0, new ApiClientError('asleep', 409, 'ASLEEP'))).toBe(false);
  });

  it('retries anything else once', () => {
    const failed = new ApiClientError('boom', 500);

    expect(retry(0, failed)).toBe(true);
    expect(retry(1, failed)).toBe(false);
  });
});
