import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatList } from './ChatList.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getChats = vi.hoisted(() => vi.fn());
const getTags = vi.hoisted(() => vi.fn());
const markChatRead = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getHealth, getChats, getTags, markChatRead },
  ApiClientError: class extends Error {},
}));

function chat(jid: string, name: string, overrides: Partial<UnifiedChat> = {}): UnifiedChat {
  return {
    jid,
    kind: 'dm',
    name,
    lastMessageTs: '2026-09-01T10:00:00Z',
    lastMessage: 'hello',
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: false,
    unreadCount: 0,
    ...overrides,
  };
}

const ALICE = chat('alice@s.whatsapp.net', 'Alice');
const BOB = chat('bob@s.whatsapp.net', 'Bob');

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatList />
    </QueryClientProvider>
  );
}

describe('ChatList tag filter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    getChats.mockResolvedValue([ALICE, BOB]);
    markChatRead.mockResolvedValue({});
    useAppStore.setState({ selectedChat: null, chatFilter: 'all', tagFilter: null, searchQuery: '' });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, chatFilter: 'all', tagFilter: null, searchQuery: '' });
  });

  it('shows no tag row until some chat has been tagged', async () => {
    getTags.mockResolvedValue({ tags: [], byJid: {} });
    renderList();

    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'work' })).not.toBeInTheDocument();
  });

  it('narrows the rail to the chats carrying a tag', async () => {
    const user = userEvent.setup();
    getTags.mockResolvedValue({ tags: ['work'], byJid: { 'alice@s.whatsapp.net': ['work'] } });
    renderList();

    expect(await screen.findByText('Bob')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'work' }));

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
  });

  it('clears the filter when the active tag is clicked again', async () => {
    const user = userEvent.setup();
    getTags.mockResolvedValue({ tags: ['work'], byJid: { 'alice@s.whatsapp.net': ['work'] } });
    renderList();

    const tagButton = await screen.findByRole('button', { name: 'work' });
    await user.click(tagButton);
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();

    await user.click(tagButton);
    expect(await screen.findByText('Bob')).toBeInTheDocument();
  });

  it('marks the active tag as pressed, so the narrowed rail is explained', async () => {
    const user = userEvent.setup();
    getTags.mockResolvedValue({ tags: ['work'], byJid: { 'alice@s.whatsapp.net': ['work'] } });
    renderList();

    const tagButton = await screen.findByRole('button', { name: 'work' });
    expect(tagButton).toHaveAttribute('aria-pressed', 'false');

    await user.click(tagButton);
    expect(tagButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('combines a tag with the chat filters rather than replacing them', async () => {
    const user = userEvent.setup();
    getChats.mockResolvedValue([
      chat('alice@s.whatsapp.net', 'Alice', { unread: true, unreadCount: 2 }),
      chat('bob@s.whatsapp.net', 'Bob', { unread: true, unreadCount: 1 }),
      chat('carol@s.whatsapp.net', 'Carol'),
    ]);
    getTags.mockResolvedValue({
      tags: ['work'],
      byJid: { 'alice@s.whatsapp.net': ['work'], 'carol@s.whatsapp.net': ['work'] },
    });
    renderList();

    await user.click(await screen.findByRole('button', { name: 'work' }));
    await user.click(screen.getByRole('button', { name: 'unread' }));

    // Tagged AND unread: Alice only. Bob is unread but untagged; Carol is
    // tagged but read.
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('Bob')).not.toBeInTheDocument();
    expect(screen.queryByText('Carol')).not.toBeInTheDocument();
  });
});

describe('ChatList keyboard navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    getChats.mockResolvedValue([ALICE, BOB]);
    getTags.mockResolvedValue({ tags: [], byJid: {} });
    markChatRead.mockResolvedValue({});
    useAppStore.setState({
      selectedChat: null,
      chatFilter: 'all',
      tagFilter: null,
      searchQuery: '',
      uiCommand: null,
      chatFocusIntent: 'composer',
    });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, uiCommand: null });
  });

  it('walks the rail on chat:next and wraps at the end', async () => {
    renderList();
    // The rail opens on the first chat by itself.
    await screen.findByText('Alice');
    expect(useAppStore.getState().selectedChat?.jid).toBe(ALICE.jid);

    act(() => useAppStore.getState().runCommand('chat:next'));
    expect(useAppStore.getState().selectedChat?.jid).toBe(BOB.jid);

    act(() => useAppStore.getState().runCommand('chat:next'));
    expect(useAppStore.getState().selectedChat?.jid).toBe(ALICE.jid);

    act(() => useAppStore.getState().runCommand('chat:prev'));
    expect(useAppStore.getState().selectedChat?.jid).toBe(BOB.jid);
  });

  it('keeps focus out of the composer when the rail is driven by key', async () => {
    renderList();
    await screen.findByText('Alice');

    act(() => useAppStore.getState().runCommand('chat:next'));

    // Anything else would let the composer swallow the next navigation key.
    expect(useAppStore.getState().chatFocusIntent).toBe('rail');
  });

  it('sends the operator to the composer when a chat is clicked', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByText('Bob'));

    expect(useAppStore.getState().selectedChat?.jid).toBe(BOB.jid);
    expect(useAppStore.getState().chatFocusIntent).toBe('composer');
  });

  it('puts the caret in the filter box on chatlist:focus-filter', async () => {
    renderList();
    await screen.findByText('Alice');

    act(() => useAppStore.getState().runCommand('chatlist:focus-filter'));

    expect(screen.getByLabelText('Filter chats by name or JID')).toHaveFocus();
  });
});

describe('ChatList preview direction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    getTags.mockResolvedValue([]);
    markChatRead.mockResolvedValue({});
    useAppStore.setState({ selectedChat: null, chatFilter: 'all', tagFilter: null, searchQuery: '' });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, chatFilter: 'all', tagFilter: null, searchQuery: '' });
  });

  it('turns a Hebrew preview around to face the right edge', async () => {
    getChats.mockResolvedValue([chat(ALICE.jid, 'Alice', { lastMessage: 'נדבר מחר בבוקר' })]);
    renderList();

    const preview = await screen.findByText('נדבר מחר בבוקר');
    expect(preview.closest('[dir]')).toHaveAttribute('dir', 'rtl');
  });

  it('is not thrown off by the You: prefix on an outbound Hebrew preview', async () => {
    // The prefix is two Latin letters ahead of the message. First-strong would
    // read it as English and left-align every reply the operator sent.
    getChats.mockResolvedValue([
      chat(ALICE.jid, 'Alice', { lastMessage: 'אני מגיע בעוד רבע שעה', lastMessageFromMe: true }),
    ]);
    renderList();

    const preview = await screen.findByText('אני מגיע בעוד רבע שעה');
    expect(preview.closest('[dir]')).toHaveAttribute('dir', 'rtl');
  });

  it('leaves an English preview alone', async () => {
    getChats.mockResolvedValue([chat(ALICE.jid, 'Alice', { lastMessage: 'running ten late' })]);
    renderList();

    const preview = await screen.findByText('running ten late');
    expect(preview.closest('[dir]')).toHaveAttribute('dir', 'ltr');
  });
});
