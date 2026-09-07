import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from '../Composer/Composer.tsx';
import { SendConfirmModal } from './SendConfirmModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import { flattenMessagePages, type MessagePages } from '../../lib/messagePages.ts';
import type { UnifiedChat, UnifiedMessage } from '../../types.ts';

const getMode = vi.hoisted(() => vi.fn());
const setMode = vi.hoisted(() => vi.fn());
const sendText = vi.hoisted(() => vi.fn());
const sendFile = vi.hoisted(() => vi.fn());
const scheduleText = vi.hoisted(() => vi.fn());
const scheduleFile = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getMode, setMode, sendText, sendFile, scheduleText, scheduleFile },
  ApiClientError: class extends Error {},
}));

const CHAT: UnifiedChat = {
  jid: 'alice@s.whatsapp.net',
  kind: 'dm',
  name: 'Alice',
  lastMessageTs: null,
  lastMessage: null,
  lastMessageFromMe: false,
  archived: false,
  pinned: false,
  mutedUntil: 0,
  unread: false,
  unreadCount: 0,
};

/** Composer and dialog together, as App mounts them: one drives the other. */
function renderConsole(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <Composer />
      <SendConfirmModal />
    </QueryClientProvider>
  );
}

/**
 * The composer only renders a live textarea once the server has confirmed that
 * safe mode is off — it starts locked, so this waits rather than assuming.
 */
const composerBox = () => screen.findByPlaceholderText(/Message Alice/);
const composerBoxNow = () => screen.getByPlaceholderText(/Message Alice/);
const confirmButton = () =>
  within(screen.getByRole('dialog')).getByRole('button', { name: /CONFIRM & SEND/i });

describe('SendConfirmModal keyboard flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMode.mockResolvedValue({ readOnly: false });
    setMode.mockResolvedValue({ readOnly: false });
    sendText.mockResolvedValue({ sent: true, messageId: 'wamid.1' });
    scheduleText.mockResolvedValue({ id: 'sched-1' });
    useAppStore.setState({
      selectedChat: CHAT,
      activeModal: null,
      sendConfirmData: null,
      composerDrafts: {},
      composerFiles: {},
      replyingToByChat: {},
    });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, activeModal: null, sendConfirmData: null });
  });

  it('dispatches a message without ever leaving the keyboard', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(await composerBox(), 'ping');
    await user.keyboard('{Enter}');

    // The dialog opens on the primary action, so the next Enter dispatches
    // rather than hitting the close button and discarding the draft.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(confirmButton()).toHaveFocus();

    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(sendText).toHaveBeenCalledWith({
        to: CHAT.jid,
        message: 'ping',
        replyTo: undefined,
        confirm: true,
      })
    );
  });

  it('does not dispatch on the auto-repeat of the Enter that opened it', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(await composerBox(), 'ping');
    // Enter held down: one press opens the dialog, and the repeats that follow
    // land on the now-focused CONFIRM button. Sending on those would mean a
    // message went out with no confirmation at all.
    await user.keyboard('{Enter>3/}');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(sendText).not.toHaveBeenCalled();

    // A deliberate second press still works.
    await user.keyboard('{Enter}');
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
  });

  it('opens on the scheduling flow when the composer asks for LATER', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(await composerBox(), 'later');
    await user.click(screen.getByRole('button', { name: 'LATER' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('SCHEDULE OUTBOUND DISPATCH');
    expect(within(dialog).getByLabelText('Dispatch time')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /SCHEDULE DISPATCH/i })).toHaveFocus();
  });

  it('does not carry a previous opening\'s scheduling into the next send', async () => {
    const user = userEvent.setup();
    renderConsole();

    // The dialog is mounted for the life of the app, so state from the LATER
    // opening is still there when the next, immediate send opens it.
    await user.type(await composerBox(), 'later');
    await user.click(screen.getByRole('button', { name: 'LATER' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    (await composerBox()).focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading')).toHaveTextContent('CONFIRM OUTBOUND DISPATCH');
    expect(within(dialog).queryByLabelText('Dispatch time')).not.toBeInTheDocument();
  });

  it('cancels on Escape and keeps the draft', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(await composerBox(), 'ping');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sendText).not.toHaveBeenCalled();
    expect(useAppStore.getState().composerDrafts[CHAT.jid]).toBe('ping');
    expect(composerBoxNow()).toHaveFocus();
  });

  it('schedules on Enter from the dispatch time field', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(await composerBox(), 'later');
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: 'SEND LATER' }));
    const timeField = within(dialog).getByLabelText('Dispatch time');
    timeField.focus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(scheduleText).toHaveBeenCalledTimes(1));
    expect(scheduleText.mock.calls[0][0]).toMatchObject({
      to: CHAT.jid,
      message: 'later',
      confirm: true,
    });
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe('SendConfirmModal teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMode.mockResolvedValue({ readOnly: false });
    sendText.mockResolvedValue({ sent: true, messageId: 'wamid.1' });
    useAppStore.setState({
      selectedChat: CHAT,
      activeModal: null,
      sendConfirmData: null,
      composerDrafts: {},
      composerFiles: {},
      replyingToByChat: {},
    });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, activeModal: null, sendConfirmData: null });
  });

  it('does not let a finished send close a confirmation it knows nothing about', async () => {
    const user = userEvent.setup();
    const view = renderConsole();

    await user.type(await composerBox(), 'ping');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));

    // The dialog holds its "sent" tick for a moment before closing itself.
    // Tear it down inside that window — a chat switch, a reload, the end of a
    // test — and then stage the next dispatch, as the composer would.
    view.unmount();
    useAppStore.setState({
      activeModal: 'send-confirm',
      sendConfirmData: {
        toJid: CHAT.jid,
        recipientName: CHAT.name,
        messageText: 'the next one',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 600));

    // The first send's timer used to survive its dialog and fire into whatever
    // was on screen 400ms later, closing this one on its way past.
    expect(useAppStore.getState().activeModal).toBe('send-confirm');
    expect(useAppStore.getState().sendConfirmData?.messageText).toBe('the next one');
  });
});

describe('SendConfirmModal thread reconciliation', () => {
  let client: QueryClient;

  const HISTORY: UnifiedMessage = {
    chatJid: CHAT.jid,
    chatName: 'Alice',
    msgId: 'MSG-OLD',
    senderJid: CHAT.jid,
    senderName: 'Alice',
    ts: '2026-09-07T12:00:00.000Z',
    fromMe: false,
    text: 'earlier line',
    displayText: 'earlier line',
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getMode.mockResolvedValue({ readOnly: false });
    sendText.mockResolvedValue({ sent: true, messageId: 'wamid.1' });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    useAppStore.setState({
      selectedChat: CHAT,
      activeModal: null,
      sendConfirmData: null,
      composerDrafts: {},
      composerFiles: {},
      replyingToByChat: {},
      sendLogs: [],
    });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, activeModal: null, sendConfirmData: null });
  });

  /** The thread as the infinite query holds it: pages, newest first. */
  function seedThread(): void {
    client.setQueryData<MessagePages>(['messages', CHAT.jid], {
      pages: [{ messages: [HISTORY], hasMore: false }],
      pageParams: [undefined],
    });
  }

  function thread(): MessagePages {
    return client.getQueryData<MessagePages>(['messages', CHAT.jid])!;
  }

  async function dispatch(): Promise<void> {
    const user = userEvent.setup();
    await user.type(await composerBox(), 'shalom');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(sendText).toHaveBeenCalledTimes(1));
  }

  it('puts a sent message at the front of an open thread', async () => {
    seedThread();
    renderConsole(client);

    await dispatch();

    // The dialog used to write the thread as a flat `{ messages }` object,
    // which is not the shape an infinite query holds. Spreading the `messages`
    // that were not there threw, so an open thread never saw its own send.
    await waitFor(() =>
      expect(flattenMessagePages(thread()).map((m) => m.msgId)).toEqual(['wamid.1', 'MSG-OLD'])
    );
  });

  it('does not report a delivered message as failed', async () => {
    seedThread();
    renderConsole(client);

    await dispatch();

    // That throw landed in the send's own catch, which overwrote the success it
    // had already recorded and told the operator to send a message that had
    // gone out — the one thing a dispatch console must never do. The dialog
    // stayed open on its error banner instead of closing on the sent tick.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useAppStore.getState().sendLogs[0]?.status).toBe('success');
    expect(useAppStore.getState().sendLogs[0]?.error).toBeUndefined();
  });

  it('still closes the dialog when the caches cannot be painted', async () => {
    seedThread();
    const boom = new Error('cache is wedged');
    vi.spyOn(client, 'setQueriesData').mockImplementation(() => {
      throw boom;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderConsole(client);

    await dispatch();

    // Local bookkeeping is not the dispatch. Whatever goes wrong after the
    // message has left, the operator is told it left.
    await waitFor(() => expect(useAppStore.getState().activeModal).toBeNull());
    expect(useAppStore.getState().sendLogs[0]?.status).toBe('success');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
