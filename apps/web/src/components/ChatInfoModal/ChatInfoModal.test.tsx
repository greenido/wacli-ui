import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatInfoModal } from './ChatInfoModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getContact = vi.hoisted(() => vi.fn());
const getGroups = vi.hoisted(() => vi.fn());
const getTags = vi.hoisted(() => vi.fn());
const setContactAlias = vi.hoisted(() => vi.fn());
const setChatTag = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getHealth, getContact, getGroups, getTags, setContactAlias, setChatTag },
  ApiClientError: class extends Error {},
}));

const DM: UnifiedChat = {
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

const GROUP: UnifiedChat = { ...DM, jid: 'team@g.us', kind: 'group', name: 'Ops Team' };

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatInfoModal />
    </QueryClientProvider>
  );
}

describe('ChatInfoModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHealth.mockResolvedValue({ wacliInstalled: true, wacliWorking: true, readOnly: false });
    getContact.mockResolvedValue({
      jid: DM.jid,
      phone: '15551234567',
      name: 'Alice',
      alias: '',
      systemName: 'Alice Anderson',
      updatedAt: '2026-09-01T10:00:00Z',
      tags: [],
      known: true,
    });
    getGroups.mockResolvedValue([
      {
        jid: GROUP.jid,
        name: 'Ops Team',
        ownerJid: 'boss@s.whatsapp.net',
        createdAt: '2025-01-05T09:00:00Z',
        leftAt: null,
        updatedAt: '2026-08-01T09:00:00Z',
      },
    ]);
    getTags.mockResolvedValue({ tags: [], byJid: {} });
    setContactAlias.mockResolvedValue({ jid: DM.jid, alias: 'Alice W' });
    setChatTag.mockResolvedValue({ jid: DM.jid, tags: ['work'] });
    useAppStore.setState({ selectedChat: DM, activeModal: 'chat-info' });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, activeModal: null });
  });

  it('stays closed until it is asked for', () => {
    useAppStore.setState({ activeModal: null });
    renderModal();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('shows the contact wacli has on file', async () => {
    renderModal();

    expect(await screen.findByText('15551234567')).toBeInTheDocument();
    expect(screen.getByText('Alice Anderson')).toBeInTheDocument();
    expect(screen.getByText(DM.jid)).toBeInTheDocument();
  });

  it('saves an alias to the wacli store', async () => {
    const user = userEvent.setup();
    renderModal();

    // The box is disabled until the contact has loaded; typing into it before
    // then would silently do nothing.
    const input = await screen.findByLabelText('Local alias');
    await waitFor(() => expect(input).toBeEnabled());

    await user.type(input, 'Alice W');
    await user.click(screen.getByRole('button', { name: /SAVE/i }));

    await waitFor(() =>
      expect(setContactAlias).toHaveBeenCalledWith({ jid: DM.jid, alias: 'Alice W' })
    );
  });

  it('disables alias editing in safe read-only mode, since it writes the store', async () => {
    getHealth.mockResolvedValue({ wacliInstalled: true, wacliWorking: true, readOnly: true });
    renderModal();

    await waitFor(() => expect(screen.getByLabelText('Local alias')).toBeDisabled());
    expect(screen.getByRole('button', { name: /SAVE/i })).toBeDisabled();
  });

  it('still lets tags be added in read-only mode, because they never reach wacli', async () => {
    const user = userEvent.setup();
    getHealth.mockResolvedValue({ wacliInstalled: true, wacliWorking: true, readOnly: true });
    renderModal();

    await user.type(await screen.findByLabelText('Add tag'), 'work');
    await user.click(screen.getByRole('button', { name: /ADD/i }));

    await waitFor(() =>
      expect(setChatTag).toHaveBeenCalledWith({ jid: DM.jid, tag: 'work', add: true })
    );
  });

  it('removes a tag when its chip is clicked', async () => {
    const user = userEvent.setup();
    getContact.mockResolvedValue({
      jid: DM.jid, phone: '15551234567', name: 'Alice', alias: '',
      systemName: '', updatedAt: null, tags: ['work'], known: true,
    });
    renderModal();

    await user.click(await screen.findByRole('button', { name: /Remove tag "work"/i }));

    await waitFor(() =>
      expect(setChatTag).toHaveBeenCalledWith({ jid: DM.jid, tag: 'work', add: false })
    );
    expect(setContactAlias).not.toHaveBeenCalled();
  });

  it('says tags are local, so they are never mistaken for WhatsApp state', async () => {
    renderModal();
    expect(await screen.findByText(/kept on this machine/i)).toBeInTheDocument();
  });

  it('shows group metadata and offers no alias box for a group', async () => {
    useAppStore.setState({ selectedChat: GROUP });
    getTags.mockResolvedValue({ tags: ['ops'], byJid: { 'team@g.us': ['ops'] } });
    renderModal();

    expect(await screen.findByText('boss@s.whatsapp.net')).toBeInTheDocument();
    expect(screen.queryByLabelText('Local alias')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Remove tag "ops"/i })).toBeInTheDocument();
  });

  it('says why group members are not listed rather than implying there are none', async () => {
    useAppStore.setState({ selectedChat: GROUP });
    renderModal();

    expect(await screen.findByText(/participants are not shown here/i)).toBeInTheDocument();
  });

  it('reports a failed alias save', async () => {
    const user = userEvent.setup();
    setContactAlias.mockRejectedValue(new Error('store is locked by another process'));
    renderModal();

    const input = await screen.findByLabelText('Local alias');
    await waitFor(() => expect(input).toBeEnabled());

    await user.type(input, 'X');
    await user.click(screen.getByRole('button', { name: /SAVE/i }));

    expect(await screen.findByText(/store is locked by another process/i)).toBeInTheDocument();
  });
});
