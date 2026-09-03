import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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
