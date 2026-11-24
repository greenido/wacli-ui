import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessageActionModal } from './MessageActionModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { MessageActionKind } from '../../lib/messageActions.ts';
import type { SleepState, UnifiedChat, UnifiedMessage } from '../../types.ts';

const getMode = vi.hoisted(() => vi.fn());
const getHealth = vi.hoisted(() => vi.fn());
const getSleep = vi.hoisted(() => vi.fn(async (): Promise<SleepState> => ({ sleeping: false, since: null })));
const getChats = vi.hoisted(() => vi.fn());
const editMessage = vi.hoisted(() => vi.fn());
const deleteMessage = vi.hoisted(() => vi.fn());
const forwardMessage = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getMode, getHealth, getSleep, getChats, editMessage, deleteMessage, forwardMessage },
  ApiClientError: class extends Error {},
}));

const ADA = '15550100001@s.whatsapp.net';
const CHARLES: UnifiedChat = {
  jid: '15550100002@s.whatsapp.net',
  kind: 'dm',
  name: 'Charles Babbage',
  lastMessageTs: null,
  lastMessage: null,
  lastMessageFromMe: false,
  archived: false,
  pinned: false,
  mutedUntil: 0,
  unread: false,
  unreadCount: 0,
};

function msg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: ADA,
    chatName: 'Ada Lovelace',
    msgId: 'MSG000001',
    senderJid: '15550100000@s.whatsapp.net',
    senderName: 'Me',
    ts: new Date(Date.now() - 5 * 60_000).toISOString(),
    fromMe: true,
    text: 'see you at 9',
    displayText: 'see you at 9',
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
    ...overrides,
  };
}

function open(kind: MessageActionKind, message: UnifiedMessage = msg()) {
  useAppStore.getState().openMessageAction({ kind, msg: message, chatJid: ADA, chatName: 'Ada Lovelace' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessageActionModal />
    </QueryClientProvider>
  );
}

/** Live mode, as the server has confirmed it. */
async function live() {
  await waitFor(() => expect(localStorage.getItem('wacli_safe_mode')).toBe('false'));
}

describe('MessageActionModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('wacli_safe_mode');
    getMode.mockResolvedValue({ readOnly: false });
    getHealth.mockResolvedValue({ wacliInstalled: true, wacliWorking: true, processState: 'running', statusSummary: 'ok' });
    getChats.mockResolvedValue([CHARLES]);
    editMessage.mockResolvedValue({ edited: true });
    deleteMessage.mockResolvedValue({ deleted: true });
    forwardMessage.mockResolvedValue({ forwarded: true, to: CHARLES.jid, messageId: 'MSG000099' });
  });

  afterEach(() => {
    useAppStore.getState().openMessageAction(null);
    localStorage.removeItem('wacli_safe_mode');
  });

  describe('edit', () => {
    it('shows the text as it stands, and saves only a real change', async () => {
      const user = userEvent.setup();
      open('edit');
      await live();

      const save = screen.getByRole('button', { name: 'SAVE EDIT' });
      expect(save).toBeDisabled();
      expect(screen.getByText(/min left to edit/)).toBeInTheDocument();

      const box = screen.getByRole('textbox');
      await user.clear(box);
      await user.type(box, 'see you at 10');
      await user.click(save);

      expect(editMessage).toHaveBeenCalledWith({
        chat: ADA,
        id: 'MSG000001',
        message: 'see you at 10',
        chatName: 'Ada Lovelace',
        confirm: true,
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('says when the window has passed, and will not save', async () => {
      const user = userEvent.setup();
      open('edit', msg({ ts: new Date(Date.now() - 30 * 60_000).toISOString() }));
      await live();

      await user.type(screen.getByRole('textbox'), '!');

      expect(screen.getByText(/only allows edits for 20 minutes/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'SAVE EDIT' })).toBeDisabled();
    });

    it('keeps the dialog open with the reason when WhatsApp refuses', async () => {
      const user = userEvent.setup();
      editMessage.mockRejectedValue(new Error("older than WhatsApp's 20m0s edit window"));
      open('edit');
      await live();

      await user.type(screen.getByRole('textbox'), '!');
      await user.click(screen.getByRole('button', { name: 'SAVE EDIT' }));

      expect(await screen.findByText(/edit window/)).toBeInTheDocument();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('delete', () => {
    it('offers both on your own recent message', async () => {
      const user = userEvent.setup();
      open('delete');
      await live();

      await user.click(screen.getByRole('button', { name: 'DELETE FOR EVERYONE' }));

      expect(deleteMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chat: ADA, id: 'MSG000001', forEveryone: true, preview: 'see you at 9', confirm: true })
      );
    });

    it('offers only for-me on someone else’s message', async () => {
      const user = userEvent.setup();
      open('delete', msg({ fromMe: false }));
      await live();

      expect(screen.queryByRole('button', { name: 'DELETE FOR EVERYONE' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'DELETE FOR ME' }));

      expect(deleteMessage).toHaveBeenCalledWith(expect.objectContaining({ forEveryone: false }));
    });

    it('starts on Cancel, since neither can be undone', async () => {
      open('delete');
      await live();
      expect(screen.getByRole('button', { name: 'CANCEL' })).toHaveFocus();
    });
  });

  describe('forward', () => {
    it('reads the chosen chat back before forwarding', async () => {
      const user = userEvent.setup();
      open('forward');
      await live();

      const forward = screen.getByRole('button', { name: 'FORWARD' });
      expect(forward).toBeDisabled();

      await user.click(await screen.findByRole('option', { name: /Charles Babbage/ }));
      expect(screen.getByText(CHARLES.jid, { exact: false })).toBeInTheDocument();
      await user.click(forward);

      expect(forwardMessage).toHaveBeenCalledWith({
        chat: ADA,
        id: 'MSG000001',
        to: CHARLES.jid,
        toName: 'Charles Babbage',
        preview: 'see you at 9',
        confirm: true,
      });
    });

    it('ignores Enter until the list answers what was typed', async () => {
      const user = userEvent.setup();
      getChats.mockImplementation(async ({ query }: { query?: string }) =>
        query ? [CHARLES] : [{ ...CHARLES, jid: ADA, name: 'Ada Lovelace' }, CHARLES]
      );
      open('forward');
      await live();
      await screen.findByRole('option', { name: /Ada Lovelace/ });

      // Typed and Entered inside the debounce: the list on screen is the old one.
      await user.type(screen.getByRole('textbox'), 'char{Enter}');
      expect(screen.getByText('Pick a chat to forward to.')).toBeInTheDocument();

      await waitFor(() => expect(screen.queryByRole('option', { name: /Ada Lovelace/ })).not.toBeInTheDocument());
      await user.keyboard('{Enter}');
      expect(screen.getByRole('option', { name: /Charles Babbage/ })).toHaveAttribute('aria-selected', 'true');
    });

    it('picks from the keyboard, but Enter alone never forwards', async () => {
      const user = userEvent.setup();
      open('forward');
      await live();
      await screen.findByRole('option', { name: /Charles Babbage/ });

      await user.keyboard('{Enter}');

      expect(screen.getByRole('option', { name: /Charles Babbage/ })).toHaveAttribute('aria-selected', 'true');
      expect(forwardMessage).not.toHaveBeenCalled();
    });
  });

  it('greys everything out in safe mode, and says why', async () => {
    getMode.mockResolvedValue({ readOnly: true });
    open('delete');
    await waitFor(() => expect(localStorage.getItem('wacli_safe_mode')).toBe('true'));

    expect(screen.getByText(/Safe mode is on/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DELETE FOR ME' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'DELETE FOR EVERYONE' })).toBeDisabled();
  });
});
