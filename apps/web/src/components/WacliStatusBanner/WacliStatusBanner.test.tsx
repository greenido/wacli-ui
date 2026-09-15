import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WacliStatusBanner } from './WacliStatusBanner.tsx';
import type { SleepState } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getSleep = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getHealth, getSleep },
}));

/** A health reading that raises the banner whenever the app is awake. */
const failingHealth = {
  wacliInstalled: true,
  wacliWorking: false,
  statusSummary: 'daemon_error',
  statusMessage: 'Sync daemon is in failed state.',
};

/**
 * Seeds both answers, so the first render already has them: an assertion that
 * the banner is absent then means something, rather than racing the fetches.
 */
function renderBanner(sleep: SleepState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['health'], failingHealth);
  client.setQueryData(['sleep'], sleep);
  return render(
    <QueryClientProvider client={client}>
      <WacliStatusBanner />
    </QueryClientProvider>
  );
}

describe('WacliStatusBanner', () => {
  beforeEach(() => {
    getHealth.mockReset();
    getSleep.mockReset();
    getHealth.mockResolvedValue(failingHealth);
  });

  it('raises a diagnostic warning while awake', () => {
    renderBanner({ sleeping: false, since: null });

    expect(screen.getByLabelText('System diagnostic warning')).toBeInTheDocument();
  });

  it('stays quiet while asleep, when the daemon is down on purpose', () => {
    renderBanner({ sleeping: true, since: '2026-09-15T22:14:00.000Z' });

    expect(screen.queryByLabelText('System diagnostic warning')).not.toBeInTheDocument();
  });
});
