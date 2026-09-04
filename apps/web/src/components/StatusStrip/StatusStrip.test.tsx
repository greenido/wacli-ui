import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusStrip } from './StatusStrip.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { ScheduledMessage } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getScheduled = vi.hoisted(() => vi.fn());
const cancelScheduled = vi.hoisted(() => vi.fn());
const resendScheduled = vi.hoisted(() => vi.fn());
const discardScheduled = vi.hoisted(() => vi.fn());
const restartDaemon = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: {
    getHealth,
    getScheduled,
    cancelScheduled,
    resendScheduled,
    discardScheduled,
    restartDaemon,
  },
}));

const failedItem: ScheduledMessage = {
  id: 'sched-1',
  to: '15551234567@s.whatsapp.net',
  recipientName: 'Alice',
  message: 'The thing we discussed',
  scheduledAt: new Date('2026-09-04T10:00:00Z').toISOString(),
  createdAt: new Date('2026-09-04T09:00:00Z').toISOString(),
  status: 'failed',
  error: 'wacli daemon was not running',
};

function renderStrip() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StatusStrip wsConnected />
    </QueryClientProvider>
  );
}

/** Opens the LATER tab and expands the failed row's detail panel. */
async function openFailedDetail(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /LATER/i }));
  await user.click(await screen.findByTitle(/Click for the failure detail/i));
}

describe('StatusStrip scheduled failures', () => {
  beforeEach(() => {
    getHealth.mockReset();
    getScheduled.mockReset();
    resendScheduled.mockReset();
    discardScheduled.mockReset();
    getHealth.mockResolvedValue({ readOnly: false, processState: 'running' });
    getScheduled.mockResolvedValue([failedItem]);
    resendScheduled.mockResolvedValue({ resent: true, item: { ...failedItem, status: 'sent' } });
    discardScheduled.mockResolvedValue({ discarded: true });
    useAppStore.setState({ selectedChat: null, sendLogs: [] });
  });

  it('opens the failure detail in place, since the message is not in the thread', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    // The reason and the full body, neither of which the thread can show.
    expect(await screen.findByText(/wacli daemon was not running/i)).toBeInTheDocument();
    // Twice over: the truncated row preview, and the untruncated detail body.
    expect(screen.getAllByText(/The thing we discussed/)).toHaveLength(2);
    expect(screen.getByRole('button', { name: /RESEND/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /DISCARD/i })).toBeInTheDocument();
  });

  it('does not resend until the operator confirms', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /RESEND/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/may deliver the message twice/i)).toBeInTheDocument();
    expect(resendScheduled).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: /RESEND NOW/i }));

    await waitFor(() => expect(resendScheduled).toHaveBeenCalledWith('sched-1', {}));
  });

  it('backs out of the confirmation without sending anything', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /RESEND/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^CANCEL$/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(resendScheduled).not.toHaveBeenCalled();
  });

  it('requeues for a chosen time instead of sending now', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /RESEND/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /PICK A TIME/i }));

    // Deferring the retry does not remove the duplicate risk, so the warning stays.
    expect(within(dialog).getByText(/may deliver the message twice/i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /\+1 HR/i }));
    await user.click(within(dialog).getByRole('button', { name: /REQUEUE/i }));

    await waitFor(() => expect(resendScheduled).toHaveBeenCalledTimes(1));
    const [id, opts] = resendScheduled.mock.calls[0] as [string, { scheduledAt?: string }];
    expect(id).toBe('sched-1');
    expect(opts.scheduledAt).toBeDefined();
    expect(new Date(opts.scheduledAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('blocks an immediate resend in safe read-only mode but still allows requeueing', async () => {
    getHealth.mockResolvedValue({ readOnly: true, processState: 'running' });
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /RESEND/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByText(/Safe read-only mode is active/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /RESEND NOW/i })).toBeDisabled();

    await user.click(within(dialog).getByRole('button', { name: /PICK A TIME/i }));
    expect(within(dialog).getByRole('button', { name: /REQUEUE/i })).toBeEnabled();
  });

  it('surfaces the server refusal instead of pretending the resend worked', async () => {
    resendScheduled.mockRejectedValue(new Error('Only a failed message can be resent'));
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /RESEND/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /RESEND NOW/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Only a failed message can be resent/i);
  });

  it('warns that a vanished attachment will go out as text only', async () => {
    getScheduled.mockResolvedValue([
      { ...failedItem, fileName: 'report.pdf', filePath: '/tmp/gone.pdf', attachmentMissing: true },
    ]);
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    expect(screen.getByText(/no longer on disk/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /RESEND/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/attachment is no longer on disk/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/as a plain text message/i)).toBeInTheDocument();
  });

  it('discards a failed message the operator has given up on', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /DISCARD/i }));

    await waitFor(() => expect(discardScheduled).toHaveBeenCalledWith('sched-1'));
  });

  it('leaves a sent message alone: no detail panel, no resend', async () => {
    getScheduled.mockResolvedValue([
      { ...failedItem, status: 'sent', error: undefined, sentMessageId: 'wamid.OK' },
    ]);
    const user = userEvent.setup();
    renderStrip();
    await user.click(await screen.findByRole('button', { name: /LATER/i }));

    await user.click(await screen.findByTitle(/Click to view conversation/i));

    expect(screen.queryByRole('button', { name: /RESEND/i })).not.toBeInTheDocument();
  });
});
