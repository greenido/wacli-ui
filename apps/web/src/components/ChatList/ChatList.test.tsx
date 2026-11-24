import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatList } from './ChatList.tsx';
import { useAppStore } from '../../store/appStore.ts';
import { flushPendingReads } from '../../lib/chatRead.ts';
import type { SleepState, UnifiedChat } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
// Health waits to hear the app is awake before it asks; these tests are awake.
const getSleep = vi.hoisted(() =>
  vi.fn(async (): Promise<SleepState> => ({ sleeping: false, since: null }))
);
const getChats = vi.hoisted(() => vi.fn());
const getTags = vi.hoisted(() => vi.fn());
const markChatRead = vi.hoisted(() => vi.fn());
const getMode = vi.hoisted(() => vi.fn(async () => ({ readOnly: false })));
const setChatState = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: { getHealth, getSleep, getChats, getTags, markChatRead, getMode, setChatState },
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

describe('ChatList opening a chat on load', () => {
  const UNREAD_ALICE = chat(ALICE.jid, 'Alice', { unread: true, unreadCount: 3 });

  beforeEach(() => {
    vi.clearAllMocks();
    getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    getChats.mockResolvedValue([UNREAD_ALICE, BOB]);
    getTags.mockResolvedValue({ tags: [], byJid: {} });
    markChatRead.mockResolvedValue({});
    useAppStore.setState({ selectedChat: null, chatFilter: 'all', tagFilter: null, searchQuery: '' });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null });
  });

  it('opens a chat by itself without sending it a read receipt', async () => {
    renderList();
    await screen.findByText('Alice');
    expect(useAppStore.getState().selectedChat?.jid).toBe(ALICE.jid);

    // Nobody chose this chat. A console opened in a background tab, or just to
    // glance at the queue, has not read it.
    flushPendingReads();
    expect(markChatRead).not.toHaveBeenCalled();
    expect(useAppStore.getState().selectedChat).toMatchObject({ unread: true, unreadCount: 3 });
  });

  it('still sends the receipt when the operator clicks that chat', async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByText('Alice'));
    flushPendingReads();

    expect(markChatRead).toHaveBeenCalledWith(ALICE.jid);
  });

  it('keeps a chat read while its receipt waits, even when the rail is fetched again', async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={client}>
        <ChatList />
      </QueryClientProvider>
    );

    await user.click(await screen.findByText('Alice'));
    expect(container.textContent).not.toContain('3');

    // The archive still says unread: the receipt has not gone yet.
    const fetchesBefore = getChats.mock.calls.length;
    await act(() => client.invalidateQueries({ queryKey: ['chats'] }));
    expect(getChats.mock.calls.length).toBeGreaterThan(fetchesBefore);

    const rail = client.getQueriesData<UnifiedChat[]>({ queryKey: ['chats'] })[0][1];
    expect(rail?.find((c) => c.jid === ALICE.jid)).toMatchObject({ unread: false, unreadCount: 0 });
    flushPendingReads();
  });
});

describe('ChatList chat actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem('wacli_safe_mode');
    getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    getChats.mockResolvedValue([ALICE, BOB]);
    getTags.mockResolvedValue({ tags: [], byJid: {} });
    getMode.mockResolvedValue({ readOnly: false });
    markChatRead.mockResolvedValue({});
    setChatState.mockImplementation(async ({ chat, action }) => ({ chat, action }));
    useAppStore.setState({
      selectedChat: null,
      chatFilter: 'all',
      tagFilter: null,
      searchQuery: '',
      uiCommand: null,
    });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, uiCommand: null });
    localStorage.removeItem('wacli_safe_mode');
  });

  /** Live mode, as the server has confirmed it. */
  async function renderLive() {
    renderList();
    await screen.findByText('Alice');
    await waitFor(() => expect(getMode).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem('wacli_safe_mode')).toBe('false'));
  }

  it('pins a chat from its row menu, and says so', async () => {
    const user = userEvent.setup();
    await renderLive();

    await user.click(screen.getByRole('button', { name: 'Actions for Bob' }));
    await user.click(screen.getByRole('menuitem', { name: /Pin chat/ }));

    expect(setChatState).toHaveBeenCalledWith({ chat: BOB.jid, action: 'pin' });
    expect(await screen.findByRole('status')).toHaveTextContent('Pinned Bob');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('offers the three mute lengths, and sends the one picked', async () => {
    const user = userEvent.setup();
    await renderLive();

    await user.click(screen.getByRole('button', { name: 'Actions for Alice' }));
    expect(screen.getByRole('menuitem', { name: /Mute for 8 hours/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Mute always/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: /Mute for 1 week/ }));

    expect(setChatState).toHaveBeenCalledWith({ chat: ALICE.jid, action: 'mute', duration: '168h' });
  });

  it('opening the menu does not open the chat', async () => {
    const user = userEvent.setup();
    await renderLive();
    expect(useAppStore.getState().selectedChat?.jid).toBe(ALICE.jid);

    await user.click(screen.getByRole('button', { name: 'Actions for Bob' }));

    expect(useAppStore.getState().selectedChat?.jid).toBe(ALICE.jid);
  });

  it('acts on the open chat from the shortcuts', async () => {
    await renderLive();

    act(() => useAppStore.getState().runCommand('chat:toggle-pin'));
    await waitFor(() => expect(setChatState).toHaveBeenCalledWith({ chat: ALICE.jid, action: 'pin' }));

    act(() => useAppStore.getState().runCommand('chat:toggle-archive'));
    await waitFor(() =>
      expect(setChatState).toHaveBeenCalledWith({ chat: ALICE.jid, action: 'archive' })
    );

    act(() => useAppStore.getState().runCommand('chat:toggle-unread'));
    await waitFor(() =>
      expect(setChatState).toHaveBeenCalledWith({ chat: ALICE.jid, action: 'mark-unread' })
    );
  });

  it('asks how long on M, and moves straight to the lengths', async () => {
    await renderLive();

    act(() => useAppStore.getState().runCommand('chat:mute'));

    expect(await screen.findByRole('menuitem', { name: /Mute for 8 hours/ })).toHaveFocus();
    expect(setChatState).not.toHaveBeenCalled();
  });

  it('unmutes on M without asking', async () => {
    getChats.mockResolvedValue([{ ...ALICE, mutedUntil: -1 }, BOB]);
    await renderLive();

    act(() => useAppStore.getState().runCommand('chat:mute'));

    await waitFor(() => expect(setChatState).toHaveBeenCalledWith({ chat: ALICE.jid, action: 'unmute' }));
  });

  it('marks a chat read again on U, through the receipt path', async () => {
    getChats.mockResolvedValue([{ ...ALICE, unread: true }, BOB]);
    await renderLive();

    act(() => useAppStore.getState().runCommand('chat:toggle-unread'));

    expect(await screen.findByRole('status')).toHaveTextContent('Marked Alice read');
    expect(setChatState).not.toHaveBeenCalled();
  });

  it('shows a chat marked unread with a dot', async () => {
    getChats.mockResolvedValue([ALICE, { ...BOB, unread: true }]);
    renderList();

    expect(await screen.findByRole('img', { name: 'Marked unread' })).toBeInTheDocument();
  });

  it('counts a chat muted for always as muted', async () => {
    getChats.mockResolvedValue([ALICE, { ...BOB, mutedUntil: -1 }]);
    useAppStore.setState({ chatFilter: 'muted' });
    renderList();

    expect(await screen.findByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('takes the change back and says why when WhatsApp refuses it', async () => {
    const user = userEvent.setup();
    setChatState.mockRejectedValue(new Error('pin chat: connection lost'));
    await renderLive();

    await user.click(screen.getByRole('button', { name: 'Actions for Bob' }));
    await user.click(screen.getByRole('menuitem', { name: /Pin chat/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not pin Bob: pin chat: connection lost');
    // The rail asks the archive again rather than keeping what it guessed.
    await waitFor(() => expect(getChats.mock.calls.length).toBeGreaterThan(1));
  });

  it('changes nothing in safe mode, and says why', async () => {
    getMode.mockResolvedValue({ readOnly: true });
    renderList();
    await screen.findByText('Alice');
    await waitFor(() => expect(localStorage.getItem('wacli_safe_mode')).toBe('true'));

    act(() => useAppStore.getState().runCommand('chat:toggle-pin'));

    expect(await screen.findByRole('status')).toHaveTextContent('Safe mode is on');
    expect(setChatState).not.toHaveBeenCalled();
  });

  it('greys the menu out in safe mode', async () => {
    const user = userEvent.setup();
    getMode.mockResolvedValue({ readOnly: true });
    renderList();
    await screen.findByText('Alice');

    await user.click(screen.getByRole('button', { name: 'Actions for Bob' }));

    expect(screen.getByRole('menuitem', { name: /Pin chat/ })).toBeDisabled();
    expect(screen.getByRole('menu')).toHaveTextContent('Safe mode is on');
  });
});
