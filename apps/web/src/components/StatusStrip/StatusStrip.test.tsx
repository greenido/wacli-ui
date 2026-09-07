import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusStrip } from './StatusStrip.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { ScheduledMessage } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getScheduled = vi.hoisted(() => vi.fn());
const getActivity = vi.hoisted(() => vi.fn());
const cancelScheduled = vi.hoisted(() => vi.fn());
const resendScheduled = vi.hoisted(() => vi.fn());
const discardScheduled = vi.hoisted(() => vi.fn());
const restartDaemon = vi.hoisted(() => vi.fn());
// StatusStrip reads safe mode through useSafeMode, which asks /api/mode rather
// than reading it off the health payload.
const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: {
    getHealth,
    getScheduled,
    getActivity,
    cancelScheduled,
    resendScheduled,
    discardScheduled,
    restartDaemon,
    getMode,
    setMode,
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

/**
 * The queue answers with pending and history separated, so a test that thinks
 * in one flat list says so here rather than at every call site.
 */
function mockScheduled(items: ScheduledMessage[]) {
  const pending = items.filter((i) => i.status === 'pending');
  const history = items.filter((i) => i.status !== 'pending');
  getScheduled.mockResolvedValue({
    pending,
    history,
    nextCursor: null,
    totalPending: pending.length,
    totalHistory: history.length,
  });
}

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
    getActivity.mockReset();
    getActivity.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    resendScheduled.mockReset();
    discardScheduled.mockReset();
    getHealth.mockResolvedValue({ readOnly: false, processState: 'running' });
    getMode.mockResolvedValue({ readOnly: false });
    mockScheduled([failedItem]);
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
    getMode.mockResolvedValue({ readOnly: true });
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
    mockScheduled([
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

  /**
   * The server used to answer a cancel or discard it could not honour with
   * `success: true` and the reason tucked into `error`, which the client reads
   * as success — so a row the operator could no longer act on simply stopped
   * responding, with nothing said about why.
   */
  it('says why a discard was refused', async () => {
    discardScheduled.mockRejectedValue(
      new Error('Scheduled message not found, or not in a failed state.')
    );
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /DISCARD/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not in a failed state/i);
  });

  it('says why a cancel was refused', async () => {
    mockScheduled([
      { ...failedItem, status: 'pending', error: undefined },
    ]);
    cancelScheduled.mockRejectedValue(
      new Error('Scheduled message not found, or no longer pending.')
    );
    const user = userEvent.setup();
    renderStrip();
    await user.click(await screen.findByRole('button', { name: /LATER/i }));

    // By title, because the row itself is a button whose name also matches.
    await user.click(await screen.findByTitle(/Cancel scheduled dispatch/i));

    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer pending/i);
  });

  it('clears the refusal when the operator dismisses it', async () => {
    discardScheduled.mockRejectedValue(new Error('Scheduled message not found.'));
    const user = userEvent.setup();
    renderStrip();
    await openFailedDetail(user);

    await user.click(screen.getByRole('button', { name: /DISCARD/i }));
    const alert = await screen.findByRole('alert');

    await user.click(within(alert).getByRole('button', { name: /dismiss/i }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('leaves a sent message alone: no detail panel, no resend', async () => {
    mockScheduled([
      { ...failedItem, status: 'sent', error: undefined, sentMessageId: 'wamid.OK' },
    ]);
    const user = userEvent.setup();
    renderStrip();
    await user.click(await screen.findByRole('button', { name: /LATER/i }));

    await user.click(await screen.findByTitle(/Click to view conversation/i));

    expect(screen.queryByRole('button', { name: /RESEND/i })).not.toBeInTheDocument();
  });
});

describe('StatusStrip jumps to the message a row stands for', () => {
  const sentItem: ScheduledMessage = {
    ...failedItem,
    id: 'sched-2',
    status: 'sent',
    error: undefined,
    sentMessageId: 'wamid.SENT',
  };

  beforeEach(() => {
    getHealth.mockReset();
    getScheduled.mockReset();
    getActivity.mockReset();
    getActivity.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    getHealth.mockResolvedValue({ readOnly: false, processState: 'running' });
    getMode.mockResolvedValue({ readOnly: false });
    mockScheduled([]);
    useAppStore.setState({ selectedChat: null, sendLogs: [], highlightedMessageId: null });
  });

  it('focuses the message an ACTIVITY row logged, not just its conversation', async () => {
    useAppStore.setState({
      sendLogs: [
        {
          id: 'send-1',
          timestamp: new Date('2026-09-04T10:00:00Z').toISOString(),
          to: failedItem.to,
          chatName: 'Alice',
          message: 'the wire went out',
          status: 'success',
          // The id the send returned. Until it was carried here the row could
          // only reopen the chat, which read as the click having done nothing.
          messageId: 'wamid.LOGGED',
        },
      ],
    });
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByTitle(/focus this message/i));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(failedItem.to);
    expect(state.highlightedMessageId).toBe('wamid.LOGGED');
  });

  it('focuses the message a sent LATER row produced', async () => {
    mockScheduled([sentItem]);
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: /LATER/i }));
    await user.click(await screen.findByTitle(/Click to view conversation/i));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(sentItem.to);
    expect(state.highlightedMessageId).toBe('wamid.SENT');
  });

  it('clears a stale highlight when the row it opens has no message of its own', async () => {
    // A pending item was never delivered, so there is nothing to focus. Leaving
    // the previous target set sent the newly opened thread looking for another
    // chat's message, and it answered that the archive did not have it.
    mockScheduled([
      { ...failedItem, id: 'sched-3', status: 'pending', error: undefined },
    ]);
    useAppStore.setState({ highlightedMessageId: 'wamid.FROM-ANOTHER-CHAT' });
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: /LATER/i }));
    await user.click(await screen.findByTitle(/Click to view conversation/i));

    expect(useAppStore.getState().highlightedMessageId).toBeNull();
  });
});

describe('StatusStrip rows recorded before message ids were kept', () => {
  beforeEach(() => {
    getHealth.mockReset();
    getScheduled.mockReset();
    getActivity.mockReset();
    getActivity.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    getHealth.mockResolvedValue({ readOnly: false, processState: 'running' });
    getMode.mockResolvedValue({ readOnly: false });
    mockScheduled([]);
    useAppStore.setState({
      selectedChat: null,
      sendLogs: [],
      highlightedMessageId: null,
      highlightedMessageHint: null,
    });
  });

  it('describes the message when a LATER row only has a placeholder id', async () => {
    // This is what every scheduled send already on disk looks like: `out-<ms>`,
    // a value wacli never produced and no archive can match.
    mockScheduled([
      {
        ...failedItem,
        id: 'sched-legacy',
        status: 'sent',
        error: undefined,
        message: 'Ma kore gever?',
        scheduledAt: new Date('2026-09-04T10:00:00Z').toISOString(),
        sentMessageId: 'out-1788203211119',
      },
    ]);
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: /LATER/i }));
    await user.click(await screen.findByTitle(/Click to view conversation/i));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(failedItem.to);
    // The placeholder is discarded rather than handed to the thread, which used
    // to answer it with "that message is not in the local archive".
    expect(state.highlightedMessageId).toBeNull();
    expect(state.highlightedMessageHint).toEqual({
      text: 'Ma kore gever?',
      sentAfter: new Date('2026-09-04T10:00:00Z').toISOString(),
    });
  });

  it('describes the message an ACTIVITY row logged, id or no id', async () => {
    useAppStore.setState({
      sendLogs: [
        {
          id: 'send-1',
          timestamp: new Date('2026-09-04T10:00:00Z').toISOString(),
          to: failedItem.to,
          chatName: 'Alice',
          message: 'the wire went out',
          status: 'success',
        },
      ],
    });
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByTitle(/focus this message/i));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(failedItem.to);
    expect(state.highlightedMessageHint).toEqual({
      text: 'the wire went out',
      sentAfter: new Date('2026-09-04T10:00:00Z').toISOString(),
    });
  });

  it('offers nothing to focus for a message that never went out', async () => {
    mockScheduled([
      { ...failedItem, id: 'sched-pending', status: 'pending', error: undefined },
    ]);
    useAppStore.setState({ highlightedMessageId: 'wamid.FROM-ANOTHER-CHAT' });
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: /LATER/i }));
    await user.click(await screen.findByTitle(/Click to view conversation/i));

    const state = useAppStore.getState();
    expect(state.highlightedMessageId).toBeNull();
    expect(state.highlightedMessageHint).toBeNull();
  });
});
