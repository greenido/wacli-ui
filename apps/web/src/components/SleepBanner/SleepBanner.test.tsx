import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SleepBanner } from './SleepBanner.tsx';
import { formatWhen } from '../../lib/scheduleTime.ts';
import type { ScheduledMessage } from '../../types.ts';

const getSleep = vi.hoisted(() => vi.fn());
const setSleep = vi.hoisted(() => vi.fn());
const getScheduled = vi.hoisted(() => vi.fn());
const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getSleep, setSleep, getScheduled, getMode, setMode },
}));

function pending(scheduledAt: string): ScheduledMessage {
  return {
    id: `sched-${scheduledAt}`,
    to: '15550100001@s.whatsapp.net',
    recipientName: 'Ada Lovelace',
    message: 'Good morning',
    scheduledAt,
    createdAt: '2026-09-15T20:00:00.000Z',
    status: 'pending',
  };
}

/** The server sorts pending soonest first; so does this. */
function mockQueue(items: ScheduledMessage[]) {
  getScheduled.mockResolvedValue({
    pending: items,
    history: [],
    nextCursor: null,
    totalPending: items.length,
    totalHistory: 0,
  });
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SleepBanner />
    </QueryClientProvider>
  );
}

const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe('SleepBanner', () => {
  beforeEach(() => {
    for (const mock of [getSleep, setSleep, getScheduled, getMode, setMode]) mock.mockReset();
    getMode.mockResolvedValue({ readOnly: false });
    mockQueue([]);
  });

  it('stays out of the way while awake', async () => {
    getSleep.mockResolvedValue({ sleeping: false, since: null });

    renderBanner();

    await waitFor(() => expect(getSleep).toHaveBeenCalled());
    expect(screen.queryByRole('status', { name: /sleep mode/i })).not.toBeInTheDocument();
  });

  it('says since when, how many are queued, and when the next goes out', async () => {
    const since = inMinutes(-30);
    const next = inMinutes(20);
    getSleep.mockResolvedValue({ sleeping: true, since });
    mockQueue([pending(next), pending(inMinutes(90))]);

    renderBanner();

    const banner = await screen.findByRole('status', { name: /sleep mode/i });
    expect(banner).toHaveTextContent(`SLEEPING SINCE ${formatWhen(since)}`);
    await waitFor(() => expect(banner).toHaveTextContent(`2 scheduled, next ${formatWhen(next)}`));
  });

  it('says so when nothing is queued', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: inMinutes(-5) });

    renderBanner();

    expect(await screen.findByText(/nothing scheduled/i)).toBeInTheDocument();
  });

  it('warns when safe mode will make the queued messages fail', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: inMinutes(-5) });
    getMode.mockResolvedValue({ readOnly: true });
    mockQueue([pending(inMinutes(20))]);

    renderBanner();

    expect(await screen.findByText(/safe mode is on/i)).toBeInTheDocument();
  });

  it('does not warn while sends are live', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: inMinutes(-5) });
    mockQueue([pending(inMinutes(20))]);

    renderBanner();

    // Safe mode reads as on until the server says otherwise, so the warning may
    // flash first; what matters is that the server's answer takes it away.
    await screen.findByText(/1 scheduled/i);
    await waitFor(() => expect(screen.queryByText(/safe mode is on/i)).not.toBeInTheDocument());
  });

  it('does not warn about safe mode when nothing is queued', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: inMinutes(-5) });
    getMode.mockResolvedValue({ readOnly: true });

    renderBanner();

    await screen.findByText(/nothing scheduled/i);
    expect(screen.queryByText(/safe mode is on/i)).not.toBeInTheDocument();
  });

  it('wakes the app from its button', async () => {
    const user = userEvent.setup();
    getSleep.mockResolvedValue({ sleeping: true, since: inMinutes(-5) });
    setSleep.mockResolvedValue({ sleeping: false, since: null });

    renderBanner();
    await user.click(await screen.findByRole('button', { name: /wake/i }));

    await waitFor(() =>
      expect(screen.queryByRole('status', { name: /sleep mode/i })).not.toBeInTheDocument()
    );
    expect(setSleep).toHaveBeenCalledWith(false, 'wake button');
  });

  it('says why when waking fails, and stays up', async () => {
    const user = userEvent.setup();
    getSleep.mockResolvedValue({ sleeping: true, since: inMinutes(-5) });
    setSleep.mockRejectedValue(new Error('API unreachable'));

    renderBanner();
    await user.click(await screen.findByRole('button', { name: /wake/i }));

    expect(await screen.findByText(/could not wake: api unreachable/i)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: /sleep mode/i })).toBeInTheDocument();
  });
});
