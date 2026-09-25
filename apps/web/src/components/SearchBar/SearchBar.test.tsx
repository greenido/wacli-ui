import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchBar } from './SearchBar.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat, UnifiedMessage } from '../../types.ts';

const api = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getSleep: vi.fn(),
  setSleep: vi.fn(),
  searchMessages: vi.fn(),
  markChatRead: vi.fn(),
}));

vi.mock('../../api/client.ts', () => ({ api, ApiClientError: class extends Error {} }));

function hit(i: number): UnifiedMessage {
  return {
    chatJid: 'alice@s.whatsapp.net',
    chatName: 'Alice',
    msgId: `HIT-${i}`,
    senderJid: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    ts: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(),
    fromMe: false,
    text: `engine note ${i}`,
    displayText: `engine note ${i}`,
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
    snippet: null,
  };
}

function renderSearch() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SearchBar onClose={vi.fn()} />
    </QueryClientProvider>
  );
}

describe('SearchBar keyboard navigation', () => {
  /** Every element the palette asked the browser to scroll into view, in order. */
  let scrolled: Element[];

  beforeEach(() => {
    vi.clearAllMocks();
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this);
    });
    api.getHealth.mockResolvedValue({
      wacliInstalled: true,
      wacliWorking: true,
      processState: 'running',
      statusSummary: 'ok',
    });
    api.getSleep.mockResolvedValue({ sleeping: false, since: null });
    api.searchMessages.mockResolvedValue({
      query: 'engine',
      fts: true,
      results: Array.from({ length: 30 }, (_, i) => hit(i)),
    });
  });

  it('keeps the highlighted result in view as the arrows move it', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText('Search query'), 'engine');
    await screen.findByText('engine note 29');

    // The highlight is not focus, so nothing scrolled to it: arrowing past the
    // rows that fit left it off-screen.
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(scrolled.at(-1)).toHaveAttribute('data-result-index', '3');

    // Up from the top wraps to the last result, the far end of the list.
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(scrolled.at(-1)).toHaveAttribute('data-result-index', '29');
  });
});

describe('SearchBar scope and landing', () => {
  const OPEN_CHAT: UnifiedChat = {
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
    api.markChatRead.mockResolvedValue({ marked: true });
    api.searchMessages.mockResolvedValue({
      query: 'engine',
      fts: true,
      results: Array.from({ length: 5 }, (_, i) => hit(i)),
    });
    useAppStore.setState({ selectedChat: OPEN_CHAT, highlightedMessageId: null, highlightedMessageAt: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null, highlightedMessageAt: null });
  });

  it('searches every chat unless asked otherwise', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText('Search query'), 'engine');

    await waitFor(() =>
      expect(api.searchMessages).toHaveBeenCalledWith({ q: 'engine', limit: 50, chat: undefined })
    );
    expect(screen.getByRole('button', { name: 'THIS CHAT' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('searches only the open chat when asked to', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.click(screen.getByRole('button', { name: 'THIS CHAT' }));
    await user.type(screen.getByLabelText('Search query'), 'engine');

    // Scoped by wacli itself, not by filtering a mixed top 50 down here.
    await waitFor(() =>
      expect(api.searchMessages).toHaveBeenCalledWith({
        q: 'engine',
        limit: 50,
        chat: 'alice@s.whatsapp.net',
      })
    );
    expect(screen.getByRole('button', { name: 'THIS CHAT' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('hands the thread the time of the hit along with its id', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByLabelText('Search query'), 'engine');
    await user.click(await screen.findByText('engine note 3'));

    // The time is what lets the thread open the history around an old hit.
    expect(useAppStore.getState().highlightedMessageId).toBe('HIT-3');
    expect(useAppStore.getState().highlightedMessageAt).toBe(hit(3).ts);
  });
});
