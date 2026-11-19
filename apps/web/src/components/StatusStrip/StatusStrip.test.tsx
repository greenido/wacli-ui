import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusStrip } from './StatusStrip.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { ScheduledMessage, UnifiedMessage, WaitingItem } from '../../types.ts';

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
const getSleep = vi.hoisted(() => vi.fn());
const setSleep = vi.hoisted(() => vi.fn());
const getBookmarks = vi.hoisted(() => vi.fn());
const bookmarkMessage = vi.hoisted(() => vi.fn());
const getWaiting = vi.hoisted(() => vi.fn());
const dismissWaiting = vi.hoisted(() => vi.fn());
const snoozeWaiting = vi.hoisted(() => vi.fn());
const getTemplates = vi.hoisted(() => vi.fn());

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
    getSleep,
    setSleep,
    getBookmarks,
    bookmarkMessage,
    getWaiting,
    dismissWaiting,
    snoozeWaiting,
    getTemplates,
  },
}));

// Every strip asks whether the app is asleep. Awake, unless a test says otherwise.
beforeEach(() => {
  getSleep.mockReset();
  getSleep.mockResolvedValue({ sleeping: false, since: null });
  setSleep.mockReset();
  getBookmarks.mockReset();
  getBookmarks.mockResolvedValue([]);
  bookmarkMessage.mockReset();
  bookmarkMessage.mockResolvedValue({ bookmarked: false });
  getWaiting.mockReset();
  getWaiting.mockResolvedValue({ items: [], total: 0, snoozed: 0 });
  dismissWaiting.mockReset();
  snoozeWaiting.mockReset();
  getTemplates.mockReset();
  getTemplates.mockResolvedValue([]);
});

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
  // As the server splits it: a message on its way out has not finished.
  const isOpen = (i: ScheduledMessage) => i.status === 'pending' || i.status === 'sending';
  const pending = items.filter(isOpen);
  const history = items.filter((i) => !isOpen(i));
  getScheduled.mockResolvedValue({
    pending,
    history,
    nextCursor: null,
    totalPending: pending.length,
    totalHistory: history.length,
  });
}

function renderStrip(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
) {
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

  it('will not resend a file message whose attachment has vanished', async () => {
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
    expect(within(dialog).getByText(/send the file again/i)).toBeInTheDocument();
    // Only the caption would go out, which is not the message that was scheduled.
    expect(within(dialog).getByRole('button', { name: /RESEND NOW/i })).toBeDisabled();
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

  it('loads a failed ACTIVITY row into the composer instead of hunting the thread', async () => {
    // An error row never produced a WhatsApp message, so jumping into the
    // thread can only ever report it missing. The useful click is to reopen
    // the draft so the operator can send or schedule it again.
    useAppStore.setState({
      sendLogs: [],
      composerDrafts: { [failedItem.to]: 'half-written something else' },
      highlightedMessageId: 'wamid.STALE',
      highlightedMessageHint: { text: 'stale', sentAfter: '2026-01-01T00:00:00Z' },
    });
    getActivity.mockResolvedValue({
      items: [
        {
          id: 'send-err-1',
          timestamp: new Date('2026-09-04T10:00:00Z').toISOString(),
          to: failedItem.to,
          chatName: 'Alice',
          message: 'never made it out',
          status: 'error',
          error: 'daemon was down',
        },
      ],
      nextCursor: null,
      total: 1,
    });
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByTitle(/retry in the composer/i));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(failedItem.to);
    expect(state.composerDrafts[failedItem.to]).toBe('never made it out');
    expect(state.highlightedMessageId).toBeNull();
    expect(state.highlightedMessageHint).toBeNull();
    expect(state.chatFocusIntent).toBe('composer');
    expect(state.focusComposerTrigger).toBeGreaterThan(0);
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

  it('shows a message on its way out as sending, with nothing to cancel', async () => {
    mockScheduled([{ ...failedItem, id: 'sched-sending', status: 'sending', error: undefined }]);
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: /LATER/i }));

    expect(await screen.findByText('sending')).toBeInTheDocument();
    expect(screen.queryByTitle('Cancel scheduled dispatch')).not.toBeInTheDocument();
  });
});

describe('StatusStrip sleep mode', () => {
  beforeEach(() => {
    getHealth.mockReset();
    getScheduled.mockReset();
    getActivity.mockReset();
    getActivity.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    getMode.mockResolvedValue({ readOnly: false });
    mockScheduled([]);
    // What a stopped daemon's health looks like, with the leftovers a stale
    // payload can carry: none of it is worth showing while asleep.
    getHealth.mockResolvedValue({
      readOnly: false,
      processState: 'stopped',
      processPid: null,
      heartbeatAgeSeconds: 42,
      storeLockHeld: true,
      statusSummary: 'ok',
    });
    useAppStore.setState({ selectedChat: null, sendLogs: [] });
  });

  it('puts the app to sleep from the moon, without asking first', async () => {
    const user = userEvent.setup();
    setSleep.mockResolvedValue({ sleeping: true, since: '2026-09-15T22:14:00.000Z' });
    renderStrip();

    const moon = await screen.findByRole('button', { name: /sleep mode/i });
    await waitFor(() => expect(moon).toBeEnabled());
    expect(moon).toHaveAttribute('aria-pressed', 'false');
    await user.click(moon);

    await waitFor(() => expect(moon).toHaveAttribute('aria-pressed', 'true'));
    expect(setSleep).toHaveBeenCalledWith(true, 'moon button');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('reads SLEEPING for the daemon, with no restart and none of its vitals', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: '2026-09-15T22:14:00.000Z' });
    // Asleep, health is not read again: what is cached is the last reading
    // from before sleep, of a daemon that was running then.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['health'], {
      readOnly: false,
      processState: 'running',
      processPid: 4242,
      heartbeatAgeSeconds: 3,
      storeLockHeld: true,
      statusSummary: 'ok',
    });
    renderStrip(client);

    expect(await screen.findByText(/^sleeping$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^running$/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle('Restart Daemon')).not.toBeInTheDocument();
    expect(screen.queryByText('PID')).not.toBeInTheDocument();
    expect(screen.queryByText('HEARTBEAT')).not.toBeInTheDocument();
    expect(screen.queryByText('STORE LOCK')).not.toBeInTheDocument();
    expect(getHealth).not.toHaveBeenCalled();
  });

  it('wakes the app from the same moon', async () => {
    const user = userEvent.setup();
    getSleep.mockResolvedValue({ sleeping: true, since: '2026-09-15T22:14:00.000Z' });
    setSleep.mockResolvedValue({ sleeping: false, since: null });
    renderStrip();

    const moon = await screen.findByRole('button', { name: /sleep mode/i });
    await waitFor(() => expect(moon).toHaveAttribute('aria-pressed', 'true'));
    await user.click(moon);

    await waitFor(() => expect(moon).toHaveAttribute('aria-pressed', 'false'));
    expect(setSleep).toHaveBeenCalledWith(false, 'moon button');
    expect(await screen.findByTitle('Restart Daemon')).toBeInTheDocument();
  });

  it('says why a switch failed instead of doing nothing', async () => {
    const user = userEvent.setup();
    setSleep.mockRejectedValue(new Error('API unreachable'));
    renderStrip();

    const moon = await screen.findByRole('button', { name: /sleep mode/i });
    await waitFor(() => expect(moon).toBeEnabled());
    await user.click(moon);

    expect(await screen.findByText(/sleep switch failed: api unreachable/i)).toBeInTheDocument();
    expect(moon).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('StatusStrip saved bookmarks', () => {
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
      highlightedMessageAt: null,
    });
  });

  it('lists saved bookmarks and jumps to the bookmarked message on click', async () => {
    getBookmarks.mockResolvedValue([
      {
        msgId: 'MSG-BM-1',
        chatJid: 'alice@s.whatsapp.net',
        createdAt: '2026-09-05T10:00:00Z',
        chatName: 'Alice',
        senderName: 'Alice',
        text: 'Gate code is 4821',
        ts: '2026-06-15T08:30:00Z',
      },
    ]);
    const user = userEvent.setup();
    renderStrip();

    const savedTab = await screen.findByRole('button', { name: /SAVED \(1\)/i });
    await user.click(savedTab);

    expect(await screen.findByText('Gate code is 4821')).toBeInTheDocument();
    await user.click(screen.getByTitle(/Open conversation and jump to this bookmarked message/i));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe('alice@s.whatsapp.net');
    expect(state.highlightedMessageId).toBe('MSG-BM-1');
    expect(state.highlightedMessageAt).toBe('2026-06-15T08:30:00Z');
  });

  it('removes a bookmark from the saved tab', async () => {
    getBookmarks.mockResolvedValue([
      {
        msgId: 'MSG-BM-2',
        chatJid: 'alice@s.whatsapp.net',
        createdAt: '2026-09-05T10:00:00Z',
        chatName: 'Alice',
        text: 'Temporary note',
      },
    ]);
    const user = userEvent.setup();
    renderStrip();

    await user.click(await screen.findByRole('button', { name: /SAVED \(1\)/i }));
    await user.click(await screen.findByTitle(/Remove bookmark/i));

    await waitFor(() =>
      expect(bookmarkMessage).toHaveBeenCalledWith({
        chat: 'alice@s.whatsapp.net',
        id: 'MSG-BM-2',
        bookmarked: false,
      })
    );
  });
});

describe('StatusStrip waiting on a reply', () => {
  const ADA = '15550100001@s.whatsapp.net';
  const GRACE = '15550100002@s.whatsapp.net';

  function waiting(chatJid: string, chatName: string, msgId: string, text: string, extra: Partial<UnifiedMessage> = {}): WaitingItem {
    return {
      chatJid,
      chatName,
      snoozedUntil: null,
      message: {
        chatJid,
        chatName,
        msgId,
        senderJid: '',
        senderName: '',
        ts: '2026-11-16T10:00:00Z',
        fromMe: true,
        text,
        displayText: text,
        isForwarded: false,
        reactionToId: null,
        reactionEmoji: null,
        mediaType: null,
        mediaCaption: null,
        filename: null,
        mimeType: null,
        localPath: null,
        starred: false,
        bookmarked: false,
        edited: false,
        revoked: false,
        deliveryStatus: 'read',
        ...extra,
      },
    };
  }

  const toGrace = waiting(GRACE, 'Grace Hopper', 'GRACE-1', 'Found the moth yet?', {
    ts: '2026-11-14T10:00:00Z',
    deliveryStatus: 'delivered',
  });
  const toAda = waiting(ADA, 'Ada Lovelace', 'ADA-1', 'Did the engine run?');

  beforeEach(() => {
    getHealth.mockReset();
    getScheduled.mockReset();
    getActivity.mockReset();
    getActivity.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    // Ready for reads: WAITING reaches wacli, so it waits for what the rail waits for.
    getHealth.mockResolvedValue({
      readOnly: false,
      processState: 'running',
      wacliInstalled: true,
      wacliWorking: true,
      statusSummary: 'ok',
    });
    getMode.mockResolvedValue({ readOnly: false });
    mockScheduled([]);
    getWaiting.mockResolvedValue({ items: [toGrace, toAda], total: 2, snoozed: 0 });
    useAppStore.setState({
      selectedChat: null,
      sendLogs: [],
      highlightedMessageId: null,
      highlightedMessageAt: null,
      composerDrafts: {},
      replyingToByChat: {},
    });
  });

  async function openWaiting(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('button', { name: /WAITING \(2\)/i }));
  }

  it('counts the rows in the tab bar and lists them as the server ordered them', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openWaiting(user);

    const grace = await screen.findByText('Found the moth yet?');
    const ada = screen.getByText('Did the engine run?');
    expect(grace.compareDocumentPosition(ada) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Delivered to Grace Hopper')).toBeInTheDocument();
    expect(screen.getByText('Ada Lovelace read this')).toBeInTheDocument();
  });

  it('jumps to the waiting message when its row is clicked', async () => {
    const user = userEvent.setup();
    renderStrip();
    await openWaiting(user);

    await user.click(await screen.findByText('Did the engine run?'));

    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(ADA);
    expect(state.highlightedMessageId).toBe('ADA-1');
    expect(state.highlightedMessageAt).toBe('2026-11-16T10:00:00Z');
  });

  it('nudges by filling the composer with the follow-up template, quoting the message, and sending nothing', async () => {
    getTemplates.mockResolvedValue([
      { id: 't1', name: 'Follow-up', body: 'Any thoughts on this?', createdAt: '', updatedAt: '', lastUsedAt: null },
    ]);
    const user = userEvent.setup();
    renderStrip();
    await openWaiting(user);

    const row = (await screen.findByText('Did the engine run?')).closest('[role="button"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Nudge/i }));

    await waitFor(() => expect(useAppStore.getState().composerDrafts[ADA]).toBe('Any thoughts on this?'));
    const state = useAppStore.getState();
    expect(state.selectedChat?.jid).toBe(ADA);
    expect(state.replyingToByChat[ADA]?.msgId).toBe('ADA-1');
    expect(state.sendConfirmData).toBeNull();
    expect(dismissWaiting).not.toHaveBeenCalled();
  });

  it('leaves a draft the operator already started alone when nudging', async () => {
    useAppStore.setState({ composerDrafts: { [ADA]: 'half a thought' } });
    const user = userEvent.setup();
    renderStrip();
    await openWaiting(user);

    const row = (await screen.findByText('Did the engine run?')).closest('[role="button"]') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /Nudge/i }));

    await waitFor(() => expect(useAppStore.getState().replyingToByChat[ADA]?.msgId).toBe('ADA-1'));
    expect(useAppStore.getState().composerDrafts[ADA]).toBe('half a thought');
  });

  it('dismisses a row with Done and refetches the list', async () => {
    dismissWaiting.mockResolvedValue({ chat: ADA, id: 'ADA-1', dismissed: true });
    const user = userEvent.setup();
    renderStrip();
    await openWaiting(user);

    const row = (await screen.findByText('Did the engine run?')).closest('[role="button"]') as HTMLElement;
    getWaiting.mockResolvedValue({ items: [toGrace], total: 1, snoozed: 0 });
    await user.click(within(row).getByRole('button', { name: /Done/i }));

    expect(dismissWaiting).toHaveBeenCalledWith({ chat: ADA, id: 'ADA-1' });
    await waitFor(() => expect(screen.queryByText('Did the engine run?')).toBeNull());
    expect(screen.getByRole('button', { name: /WAITING \(1\)/i })).toBeInTheDocument();
    // Done is not a click on the row: the chat stays where it was.
    expect(useAppStore.getState().selectedChat).toBeNull();
  });

  it('snoozes a row until a chosen reminder time', async () => {
    snoozeWaiting.mockResolvedValue({ chat: GRACE, id: 'GRACE-1', snoozedUntil: '' });
    const user = userEvent.setup();
    renderStrip();
    await openWaiting(user);

    const row = (await screen.findByText('Found the moth yet?')).closest('[role="button"]') as HTMLElement;
    getWaiting.mockResolvedValue({ items: [toAda], total: 1, snoozed: 1 });
    await user.click(within(row).getByRole('button', { name: /Remind me/i }));
    await user.click(within(row).getByRole('button', { name: /Tomorrow 9:00/i }));

    expect(snoozeWaiting).toHaveBeenCalledTimes(1);
    const { chat, id, until } = snoozeWaiting.mock.calls[0][0];
    expect({ chat, id }).toEqual({ chat: GRACE, id: 'GRACE-1' });
    expect(new Date(until).getTime()).toBeGreaterThan(Date.now());
    expect(await screen.findByText('1 hidden until a reminder')).toBeInTheDocument();
  });

  it('marks a row that is back from a reminder', async () => {
    getWaiting.mockResolvedValue({
      items: [{ ...toAda, snoozedUntil: '2026-11-17T09:00:00Z' }],
      total: 1,
      snoozed: 0,
    });
    const user = userEvent.setup();
    renderStrip();
    await user.click(await screen.findByRole('button', { name: /WAITING \(1\)/i }));

    expect(await screen.findByText(/REMINDER/)).toBeInTheDocument();
  });

  it('does not ask wacli while the app is asleep', async () => {
    getSleep.mockResolvedValue({ sleeping: true, since: '2026-11-18T08:00:00Z' });
    renderStrip();

    await screen.findByRole('button', { name: /WAITING \(0\)/i });
    await waitFor(() => expect(getSleep).toHaveBeenCalled());
    expect(getWaiting).not.toHaveBeenCalled();
  });

  it('says so when nobody owes a reply', async () => {
    getWaiting.mockResolvedValue({ items: [], total: 0, snoozed: 0 });
    const user = userEvent.setup();
    renderStrip();
    await user.click(await screen.findByRole('button', { name: /WAITING \(0\)/i }));

    expect(await screen.findByText('Nobody owes you a reply.')).toBeInTheDocument();
  });
});

describe('StatusStrip daemon state', () => {
  beforeEach(() => {
    getHealth.mockReset();
    getScheduled.mockReset();
    getActivity.mockReset();
    getActivity.mockResolvedValue({ items: [], nextCursor: null, total: 0 });
    getMode.mockResolvedValue({ readOnly: true });
    mockScheduled([]);
    useAppStore.setState({ selectedChat: null, sendLogs: [] });
  });

  it('calls a daemon switched off with --no-sync off, not stopped', async () => {
    getHealth.mockResolvedValue({ readOnly: true, processState: 'stopped', syncDisabled: true });
    renderStrip();

    expect(await screen.findByText('off (--no-sync)')).toBeInTheDocument();
    expect(screen.getByTitle('Start the daemon')).toBeInTheDocument();
  });

  it('still says stopped when nothing asked for it', async () => {
    getHealth.mockResolvedValue({ readOnly: true, processState: 'stopped', syncDisabled: false });
    renderStrip();

    expect(await screen.findByText('stopped')).toBeInTheDocument();
    expect(screen.queryByText('off (--no-sync)')).not.toBeInTheDocument();
  });
});
