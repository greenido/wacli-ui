import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsModal } from './SettingsModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { SleepState } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getSettings = vi.hoisted(() => vi.fn());
const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());
const restartDaemon = vi.hoisted(() => vi.fn());
const getSleep = vi.hoisted(() => vi.fn());
const setSleep = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getHealth, getSettings, getMode, setMode, restartDaemon, getSleep, setSleep },
}));

const SINCE = '2026-09-15T22:14:00.000Z';

/** The daemon section, so assertions cannot match the rest of the dialog. */
function daemonSection() {
  return screen.getByText('Sync Daemon Control').closest('div.space-y-2') as HTMLElement;
}

/** Seeds the answers the first render needs, so absences are not races. */
function renderSettings(sleep: SleepState) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['health'], {
    processState: 'stopped',
    processPid: null,
    heartbeatAgeSeconds: null,
    lastError: null,
    wacliInstalled: true,
    wacliWorking: true,
    statusSummary: 'ok',
  });
  client.setQueryData(['sleep'], sleep);
  return render(
    <QueryClientProvider client={client}>
      <SettingsModal />
    </QueryClientProvider>
  );
}

describe('SettingsModal daemon control', () => {
  beforeEach(() => {
    for (const mock of [getHealth, getSettings, getMode, setMode, restartDaemon, getSleep, setSleep]) {
      mock.mockReset();
    }
    getHealth.mockResolvedValue({ processState: 'stopped', statusSummary: 'ok' });
    getSettings.mockResolvedValue({ currentLogFile: null });
    getMode.mockResolvedValue({ readOnly: false });
    useAppStore.setState({ activeModal: 'settings' });
  });

  it('offers a restart while awake', () => {
    getSleep.mockResolvedValue({ sleeping: false, since: null });
    renderSettings({ sleeping: false, since: null });

    const section = daemonSection();
    expect(within(section).getByRole('button', { name: /restart daemon/i })).toBeInTheDocument();
    expect(within(section).getByText('stopped')).toBeInTheDocument();
  });

  it('reads sleeping while asleep, and offers wake instead of a restart', async () => {
    const user = userEvent.setup();
    getSleep.mockResolvedValue({ sleeping: true, since: SINCE });
    setSleep.mockResolvedValue({ sleeping: false, since: null });
    renderSettings({ sleeping: true, since: SINCE });

    const section = daemonSection();
    expect(within(section).getByText('sleeping')).toBeInTheDocument();
    expect(within(section).queryByText('stopped')).not.toBeInTheDocument();
    expect(within(section).getByText(/only scheduled messages go out/i)).toBeInTheDocument();
    // A restart would bring the daemon back while the app still says asleep.
    expect(within(section).queryByRole('button', { name: /restart daemon/i })).not.toBeInTheDocument();

    await user.click(within(section).getByRole('button', { name: /wake/i }));

    await waitFor(() => expect(setSleep).toHaveBeenCalledWith(false, 'settings wake'));
    expect(restartDaemon).not.toHaveBeenCalled();
  });
});
