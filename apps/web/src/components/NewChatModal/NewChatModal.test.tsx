import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewChatModal } from './NewChatModal.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat } from '../../types.ts';

const api = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getSleep: vi.fn(),
  setSleep: vi.fn(),
  getChats: vi.fn(),
  markChatRead: vi.fn(),
}));

vi.mock('../../api/client.ts', () => ({ api, ApiClientError: class extends Error {} }));

function chat(jid: string, name: string, kind: UnifiedChat['kind'] = 'dm'): UnifiedChat {
  return {
    jid,
    kind,
    name,
    lastMessageTs: null,
    lastMessage: null,
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: false,
    unreadCount: 0,
  };
}

const APT_GROUP = chat('120363000000000001@g.us', 'Apt 4B residents', 'group');
const ROOM_GROUP = chat('120363000000000002@g.us', 'Room 101 planning', 'group');
const ALICE = chat('15550100001@s.whatsapp.net', 'Alice');
const BOB = chat('15550100002@s.whatsapp.net', 'Bob');

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NewChatModal />
    </QueryClientProvider>
  );
}

const input = () => screen.getByPlaceholderText(/Search contact name/);
const selectedRow = () => document.querySelector('[aria-current="true"]');

describe('NewChatModal keyboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    api.getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    api.getSleep.mockResolvedValue({ sleeping: false, since: null });
    api.getChats.mockImplementation(async ({ query }: { query?: string }) => {
      if (!query) return [ALICE, BOB];
      if (query.startsWith('Apt')) return [APT_GROUP];
      if (query.startsWith('Room')) return [ROOM_GROUP];
      if (query === 'nobody') return [];
      return [ALICE];
    });
    useAppStore.setState({ activeModal: 'new-chat', selectedChat: null });
  });

  afterEach(() => {
    useAppStore.setState({ activeModal: null, selectedChat: null });
  });

  it('opens the matching chat when its name has a digit in it', async () => {
    // Any digit used to route Enter to "message this number directly", so
    // "Apt 4B" opened a DM with 4@s.whatsapp.net instead of the group.
    const user = userEvent.setup();
    renderModal();

    await user.type(input(), 'Apt 4B');
    await screen.findByText('Apt 4B residents');
    await user.keyboard('{Enter}');

    expect(useAppStore.getState().selectedChat?.jid).toBe(APT_GROUP.jid);
    expect(useAppStore.getState().activeModal).toBeNull();
  });

  it('prefers a result over the direct row when the query reads as a name', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(input(), 'Room 101');
    await screen.findByText('Room 101 planning');
    // Three digits are enough to offer the direct row, but it is not the default.
    expect(screen.getByText(/directly/)).toBeInTheDocument();
    expect(selectedRow()).toHaveTextContent('Room 101 planning');

    await user.keyboard('{Enter}');
    expect(useAppStore.getState().selectedChat?.jid).toBe(ROOM_GROUP.jid);
  });

  it('starts a direct chat when the query is a phone number', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(input(), '+1 555 0100 999');
    await screen.findByText('Alice');
    expect(selectedRow()).toHaveTextContent(/directly/);

    await user.keyboard('{Enter}');
    expect(useAppStore.getState().selectedChat?.jid).toBe('15550100999@s.whatsapp.net');
  });

  it('moves the highlight with the arrow keys and opens the highlighted chat', async () => {
    const user = userEvent.setup();
    renderModal();

    await screen.findByText('Bob');
    expect(selectedRow()).toHaveTextContent('Alice');

    await user.keyboard('{ArrowDown}');
    expect(selectedRow()).toHaveTextContent('Bob');
    // Wraps, the way the search palette does.
    await user.keyboard('{ArrowDown}');
    expect(selectedRow()).toHaveTextContent('Alice');
    await user.keyboard('{ArrowUp}');
    expect(selectedRow()).toHaveTextContent('Bob');

    await user.keyboard('{Enter}');
    expect(useAppStore.getState().selectedChat?.jid).toBe(BOB.jid);
  });

  it('can arrow from a result up to the direct row', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(input(), 'Room 101');
    await screen.findByText('Room 101 planning');
    await user.keyboard('{ArrowUp}');
    expect(selectedRow()).toHaveTextContent(/directly/);

    await user.keyboard('{Enter}');
    expect(useAppStore.getState().selectedChat?.jid).toBe('101@s.whatsapp.net');
  });

  it('starts the highlight over when the query changes', async () => {
    const user = userEvent.setup();
    renderModal();

    await screen.findByText('Bob');
    await user.keyboard('{ArrowDown}');
    expect(selectedRow()).toHaveTextContent('Bob');

    await user.type(input(), 'Apt');
    await screen.findByText('Apt 4B residents');
    expect(selectedRow()).toHaveTextContent('Apt 4B residents');
  });

  it('does nothing on Enter when there is nothing to open', async () => {
    // A name with no match used to become a chat with "@s.whatsapp.net".
    const user = userEvent.setup();
    renderModal();

    await user.type(input(), 'nobody');
    await screen.findByText(/No matching contacts found/);
    await user.keyboard('{Enter}');

    expect(useAppStore.getState().selectedChat).toBeNull();
    expect(useAppStore.getState().activeModal).toBe('new-chat');
  });

  it('forgets the highlight once closed', async () => {
    const user = userEvent.setup();
    renderModal();

    await screen.findByText('Bob');
    await user.keyboard('{ArrowDown}');
    expect(selectedRow()).toHaveTextContent('Bob');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(useAppStore.getState().activeModal).toBeNull());

    useAppStore.setState({ activeModal: 'new-chat' });
    await screen.findByText('Bob');
    expect(selectedRow()).toHaveTextContent('Alice');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(input());
    await user.keyboard('{Escape}');

    await waitFor(() => expect(useAppStore.getState().activeModal).toBeNull());
  });
});
