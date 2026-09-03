import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadView } from './ThreadView.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { MissionControlStatus, UnifiedChat, UnifiedMessage } from '../../types.ts';

const getHealth = vi.hoisted(() => vi.fn());
const getMessages = vi.hoisted(() => vi.fn());
const getScheduled = vi.hoisted(() => vi.fn());
const bookmarkMessage = vi.hoisted(() => vi.fn());
const getHistoryCoverage = vi.hoisted(() => vi.fn());
const backfillHistory = vi.hoisted(() => vi.fn());
const exportConversation = vi.hoisted(() => vi.fn());

vi.mock('../../api/client.ts', () => ({
  api: {
    getHealth,
    getMessages,
    getScheduled,
    bookmarkMessage,
    getHistoryCoverage,
    backfillHistory,
    exportConversation,
    getMediaUrl: () => '',
  },
  ApiClientError: class extends Error {},
}));

const COVERAGE = {
  chatJid: 'alice@s.whatsapp.net',
  name: 'Alice',
  kind: 'dm',
  messageCount: 54,
  oldestTs: '2026-06-08T15:35:32Z',
  newestTs: '2026-09-03T18:08:52Z',
  lastMessageTs: '2026-09-03T18:08:52Z',
  status: 'ready',
};

const CHAT: UnifiedChat = {
  jid: 'alice@s.whatsapp.net',
  kind: 'dm',
  name: 'Alice',
  lastMessageTs: '2026-09-01T10:00:00Z',
  lastMessage: 'hi',
  lastMessageFromMe: false,
  archived: false,
  pinned: false,
  mutedUntil: 0,
  unread: false,
  unreadCount: 0,
};

const HEALTHY: Partial<MissionControlStatus> = {
  wacliInstalled: true,
  wacliWorking: true,
  processState: 'running',
  statusSummary: 'ok',
};

function message(i: number): UnifiedMessage {
  return {
    chatJid: CHAT.jid,
    chatName: 'Alice',
    msgId: `MSG-${i}`,
    senderJid: CHAT.jid,
    senderName: 'Alice',
    ts: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(),
    fromMe: false,
    text: `message body ${i}`,
    displayText: `message body ${i}`,
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
}

function renderThread() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThreadView />
    </QueryClientProvider>
  );
}

describe('ThreadView history window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    bookmarkMessage.mockResolvedValue({ bookmarked: true });
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    backfillHistory.mockResolvedValue({ chat: CHAT.jid, requested: 200 });
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('offers no local paging control when the whole local archive is loaded', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    renderThread();

    expect(await screen.findByText('message body 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /LOAD OLDER MESSAGES/i })).not.toBeInTheDocument();
  });

  it('asks wacli for a wider window when the operator loads older messages', async () => {
    const user = userEvent.setup();
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: true });
    renderThread();

    await user.click(await screen.findByRole('button', { name: /LOAD OLDER MESSAGES/i }));

    // The thread used to be pinned at a hard-coded 200 with no way to go back.
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 400 }));
  });
});

describe('ThreadView jump-to-message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('scrolls to a target inside the loaded window', async () => {
    getMessages.mockResolvedValue({ messages: [message(1), message(2)], hasMore: false });
    useAppStore.setState({ highlightedMessageId: 'MSG-2' });
    renderThread();

    await screen.findByText('message body 2');
    // The scroll is deferred to an animation frame, so wait for the frame.
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it('says so when the target is older than the loaded history', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: true });
    useAppStore.setState({ highlightedMessageId: 'MSG-ANCIENT' });
    renderThread();

    expect(await screen.findByText(/older than the history loaded here/i)).toBeInTheDocument();
  });

  it('reports an unreachable target when there is no more history to load', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    useAppStore.setState({ highlightedMessageId: 'MSG-ANCIENT' });
    renderThread();

    expect(await screen.findByText(/not in the local archive/i)).toBeInTheDocument();
  });

  it('clears a highlight it never found, so auto-scroll keeps working', async () => {
    // Timers have to be faked before the effect schedules its reset.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    useAppStore.setState({ highlightedMessageId: 'MSG-ANCIENT' });
    renderThread();

    await screen.findByText('message body 1');

    // The reset timer used to live inside the "element found" branch, so a miss
    // left the id set forever and killed the scroll-to-bottom branch with it.
    await act(async () => {
      vi.advanceTimersByTime(15000);
    });

    expect(useAppStore.getState().highlightedMessageId).toBeNull();
  });
});

describe('ThreadView archive boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    backfillHistory.mockResolvedValue({ chat: CHAT.jid, requested: 200 });
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('offers to ask the phone once local paging has run out', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    renderThread();

    expect(await screen.findByRole('button', { name: /REQUEST OLDER FROM PHONE/i })).toBeInTheDocument();
  });

  it('does not offer a phone request while the local archive still has pages', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: true });
    renderThread();

    expect(await screen.findByRole('button', { name: /LOAD OLDER MESSAGES/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /REQUEST OLDER FROM PHONE/i })).not.toBeInTheDocument();
  });

  it('says where the local archive starts, so the wall is explained', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    renderThread();

    expect(await screen.findByText(/Local archive for this chat starts/i)).toBeInTheDocument();
  });

  it('requests a backfill and refreshes the thread from it', async () => {
    const user = userEvent.setup();
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    renderThread();

    await user.click(await screen.findByRole('button', { name: /REQUEST OLDER FROM PHONE/i }));

    await waitFor(() =>
      expect(backfillHistory).toHaveBeenCalledWith({ chat: CHAT.jid, count: 200 })
    );
    expect(
      await screen.findByText(/Your phone answers on its own schedule/i)
    ).toBeInTheDocument();
  });

  it('refuses the request in safe read-only mode and says why', async () => {
    getHealth.mockResolvedValue({ ...HEALTHY, readOnly: true });
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    renderThread();

    const button = await screen.findByRole('button', { name: /REQUEST OLDER FROM PHONE/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringContaining('read-only'));
  });

  it('surfaces a failed backfill instead of looking like nothing happened', async () => {
    const user = userEvent.setup();
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    backfillHistory.mockRejectedValue(new Error('store is locked by another process'));
    renderThread();

    await user.click(await screen.findByRole('button', { name: /REQUEST OLDER FROM PHONE/i }));

    expect(await screen.findByText(/store is locked by another process/i)).toBeInTheDocument();
  });

  it('shows how far back the archive reaches in the header', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    renderThread();

    expect(await screen.findByText(/ARCHIVE .* · 54 MSG/)).toBeInTheDocument();
  });
});

describe('ThreadView conversation export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    exportConversation.mockResolvedValue({
      chatJid: CHAT.jid,
      chatName: 'Alice',
      exportedAt: '2026-09-03T12:00:00.000Z',
      count: 1,
      truncated: false,
      messages: [message(1)],
    });
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('keeps the format choice behind the button until it is asked for', async () => {
    const user = userEvent.setup();
    renderThread();

    expect(screen.queryByRole('menuitem', { name: /Text transcript/i })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /EXPORT/i }));
    expect(await screen.findByRole('menuitem', { name: /Text transcript/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /JSON/i })).toBeInTheDocument();
  });

  it('exports the selected conversation', async () => {
    const user = userEvent.setup();
    renderThread();

    await user.click(await screen.findByRole('button', { name: /EXPORT/i }));
    await user.click(await screen.findByRole('menuitem', { name: /Text transcript/i }));

    await waitFor(() => expect(exportConversation).toHaveBeenCalledWith({ chat: CHAT.jid }));
  });

  it('warns when the export was capped rather than implying it is complete', async () => {
    const user = userEvent.setup();
    exportConversation.mockResolvedValue({
      chatJid: CHAT.jid,
      chatName: 'Alice',
      exportedAt: '2026-09-03T12:00:00.000Z',
      count: 5000,
      truncated: true,
      messages: [message(1)],
    });
    renderThread();

    await user.click(await screen.findByRole('button', { name: /EXPORT/i }));
    await user.click(await screen.findByRole('menuitem', { name: /JSON/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/size cap/i);
  });

  it('reports an export that failed', async () => {
    const user = userEvent.setup();
    exportConversation.mockRejectedValue(new Error('store is locked by another process'));
    renderThread();

    await user.click(await screen.findByRole('button', { name: /EXPORT/i }));
    await user.click(await screen.findByRole('menuitem', { name: /JSON/i }));

    expect(await screen.findByRole('status')).toHaveTextContent(/store is locked/i);
  });
});
