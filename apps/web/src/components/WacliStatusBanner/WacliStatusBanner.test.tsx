import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

/** A health reading from a machine that has never had wacli on its PATH. */
const notInstalledHealth = {
  wacliInstalled: false,
  wacliWorking: false,
  statusSummary: 'not_installed',
  statusMessage: 'The wacli command-line tool was not found in your system PATH.',
};

/**
 * Seeds both answers, so the first render already has them: an assertion that
 * the banner is absent then means something, rather than racing the fetches.
 */
function renderBanner(sleep: SleepState, health: typeof failingHealth = failingHealth) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['health'], health);
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

  it('says nothing before the first reading, while health waits on the sleep answer', async () => {
    // Health is not fetched until the app is known to be awake. Waiting is not
    // loading, so a banner that only held back while loading would build a
    // warning out of no data at all.
    getSleep.mockReturnValue(new Promise(() => {}));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={client}>
        <WacliStatusBanner />
      </QueryClientProvider>
    );

    await waitFor(() => expect(getSleep).toHaveBeenCalled());
    expect(getHealth).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('System diagnostic warning')).not.toBeInTheDocument();
  });

  it('points a missing install at the openclaw tap, not some other wacli', async () => {
    // The tap name is the whole value of this guide: an operator who copies a
    // command for a different project's wacli installs a CLI this app cannot
    // drive, and the banner they are trying to clear stays up.
    getHealth.mockResolvedValue(notInstalledHealth);
    renderBanner({ sleeping: false, since: null }, notInstalledHealth);

    await userEvent.click(screen.getByTitle('Toggle setup instructions'));

    expect(screen.getByText('brew install openclaw/tap/wacli')).toBeInTheDocument();
    expect(screen.getByText(/github\.com\/openclaw\/wacli\/cmd\/wacli@latest/)).toBeInTheDocument();
    expect(screen.queryByText(/stevemcquaid/)).not.toBeInTheDocument();
  });

  it('copies the same brew command it displays', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    getHealth.mockResolvedValue(notInstalledHealth);
    renderBanner({ sleeping: false, since: null }, notInstalledHealth);

    await userEvent.click(screen.getByTitle('Toggle setup instructions'));
    const brewCard = screen.getByText('brew install openclaw/tap/wacli').closest('div');
    await userEvent.click(within(brewCard as HTMLElement).getByText('Copy'));

    expect(writeText).toHaveBeenCalledWith('brew install openclaw/tap/wacli');
  });
});
