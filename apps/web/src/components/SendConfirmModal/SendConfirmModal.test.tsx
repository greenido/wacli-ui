import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Composer } from '../Composer/Composer.tsx';
import { SendConfirmModal } from './SendConfirmModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

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
function renderConsole() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Composer />
      <SendConfirmModal />
    </QueryClientProvider>
  );
}

const composerBox = () => screen.getByPlaceholderText(/Message Alice/);
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

    await user.type(composerBox(), 'ping');
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

    await user.type(composerBox(), 'ping');
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

  it('cancels on Escape and keeps the draft', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(composerBox(), 'ping');
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(sendText).not.toHaveBeenCalled();
    expect(useAppStore.getState().composerDrafts[CHAT.jid]).toBe('ping');
    expect(composerBox()).toHaveFocus();
  });

  it('schedules on Enter from the dispatch time field', async () => {
    const user = userEvent.setup();
    renderConsole();

    await user.type(composerBox(), 'later');
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
