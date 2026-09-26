import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WacliUpdateNotice } from './WacliUpdateNotice.tsx';
import type { MissionControlStatus } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getSleep = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({ api: { getHealth, getSleep } }));

function health(wacliUpdate: MissionControlStatus['wacliUpdate']): MissionControlStatus {
  return {
    readOnly: false,
    processState: 'running',
    processPid: 4242,
    heartbeatAgeSeconds: 1,
    lastError: null,
    reconnectAttempts: 0,
    doctor: null,
    wacliInstalled: true,
    wacliWorking: true,
    wacliVersion: 'wacli 0.19.0',
    wacliBinaryPath: 'wacli',
    statusSummary: 'ok',
    statusMessage: null,
    storeLockHeld: false,
    storeLockHolderPid: null,
    wacliUpdate,
  };
}

const update = (latestVersion: string, upgradeCommand: string | null = 'brew upgrade wacli') => ({
  latestVersion,
  releaseUrl: `https://github.com/openclaw/wacli/releases/tag/v${latestVersion}`,
  upgradeCommand,
});

function renderNotice() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WacliUpdateNotice />
    </QueryClientProvider>
  );
}

describe('WacliUpdateNotice', () => {
  beforeEach(() => {
    getHealth.mockReset();
    getSleep.mockReset();
    getSleep.mockResolvedValue({ sleeping: false, since: null });
    localStorage.clear();
  });

  it('names the release, the installed version, and the command that upgrades it', async () => {
    getHealth.mockResolvedValue(health(update('0.19.1')));
    renderNotice();

    const notice = await screen.findByRole('status', { name: 'wacli update available' });
    expect(notice).toHaveTextContent('wacli 0.19.1 is available (you have 0.19.0)');
    expect(notice).toHaveTextContent('brew upgrade wacli');
    expect(screen.getByRole('link', { name: /release notes/i })).toHaveAttribute(
      'href',
      'https://github.com/openclaw/wacli/releases/tag/v0.19.1'
    );
  });

  it('offers no command for an install brew does not own', async () => {
    getHealth.mockResolvedValue(health(update('0.19.1', null)));
    renderNotice();

    const notice = await screen.findByRole('status', { name: 'wacli update available' });
    expect(notice).toHaveTextContent('Install it, then restart Mission Control.');
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull();
  });

  it('says nothing when wacli is current', async () => {
    getHealth.mockResolvedValue(health(null));
    renderNotice();

    await vi.waitFor(() => expect(getHealth).toHaveBeenCalled());
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays dismissed for that release, and comes back for the next one', async () => {
    getHealth.mockResolvedValue(health(update('0.19.1')));
    const first = renderNotice();
    await screen.findByRole('status', { name: 'wacli update available' });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss wacli update notice' }));
    expect(screen.queryByRole('status')).toBeNull();
    first.unmount();

    // Reloaded on the same release: still dismissed once the health reading lands.
    const second = renderNotice();
    await vi.waitFor(() => expect(getHealth).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('status')).toBeNull();
    second.unmount();

    getHealth.mockResolvedValue(health(update('0.20.0')));
    renderNotice();
    expect(await screen.findByRole('status', { name: 'wacli update available' })).toHaveTextContent(
      'wacli 0.20.0 is available'
    );
  });
});
