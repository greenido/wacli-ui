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
const sendReact = vi.hoisted(() => vi.fn());
const getMediaUrl = vi.hoisted(() =>
  vi.fn((_params: { chat?: string; id?: string; path?: string }) => '')
);

vi.mock('../../api/client.ts', () => ({
  api: {
    getHealth,
    getMessages,
    getScheduled,
    bookmarkMessage,
    getHistoryCoverage,
    backfillHistory,
    exportConversation,
    getMediaUrl,
    sendReact,
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

describe('ThreadView media across a chat switch', () => {
  const OTHER_CHAT: UnifiedChat = { ...CHAT, jid: 'bob@s.whatsapp.net', name: 'Bob' };

  function imageMessage(): UnifiedMessage {
    return { ...message(1), msgId: 'MEDIA-1', mediaType: 'image', mimeType: 'image/jpeg' };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getMediaUrl.mockReturnValue('');
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('asks for media using the chat the message is in', async () => {
    getMessages.mockResolvedValue({ messages: [imageMessage()], hasMore: false });
    renderThread();

    await waitFor(() => expect(getMediaUrl).toHaveBeenCalled());
    expect(getMediaUrl).toHaveBeenCalledWith(
      expect.objectContaining({ chat: CHAT.jid, id: 'MEDIA-1' })
    );
  });

  it('does not pair the previous thread\'s messages with the chat being opened', async () => {
    getMessages.mockResolvedValue({ messages: [imageMessage()], hasMore: false });
    renderThread();
    await waitFor(() => expect(getMediaUrl).toHaveBeenCalled());

    // Switching chats leaves the previous thread on screen while the new one
    // loads (`keepPreviousData`), and the selected JID has already changed.
    getMessages.mockReturnValue(new Promise(() => {}));
    getMediaUrl.mockClear();
    act(() => {
      useAppStore.setState({ selectedChat: OTHER_CHAT });
    });

    await waitFor(() => expect(getMediaUrl).toHaveBeenCalled());

    // Every request for this message must still name the chat it belongs to.
    // Pairing it with the newly selected chat was a guaranteed 404 and a doomed
    // `wacli media download` for every attachment in the outgoing thread.
    for (const [params] of getMediaUrl.mock.calls) {
      if (params.id === 'MEDIA-1') {
        expect(params).toMatchObject({ chat: CHAT.jid });
      }
    }
    expect(getMediaUrl).not.toHaveBeenCalledWith(
      expect.objectContaining({ chat: OTHER_CHAT.jid, id: 'MEDIA-1' })
    );
  });
});

describe('ThreadView jump across a chat switch', () => {
  const BOB: UnifiedChat = { ...CHAT, jid: 'bob@s.whatsapp.net', name: 'Bob' };

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('does not accuse the archive while the previous chat is still on screen', async () => {
    let deliverBob: ((page: { messages: UnifiedMessage[]; hasMore: boolean }) => void) | undefined;
    getMessages.mockImplementation(({ chat }: { chat: string }) =>
      chat === CHAT.jid
        ? Promise.resolve({ messages: [message(1)], hasMore: false })
        : new Promise((resolve) => {
            deliverBob = resolve;
          })
    );
    renderThread();
    await screen.findByText('message body 1');

    // Opening a message from another conversation: the selection changes at
    // once, but `keepPreviousData` keeps Alice's thread rendered until Bob's
    // arrives. Judging the target against Alice's messages is what produced the
    // "not in the local archive" notice for a message that was in Bob's.
    act(() => {
      useAppStore.getState().setSelectedChat(BOB);
      useAppStore.getState().setHighlightedMessageId('MSG-7');
    });

    await waitFor(() =>
      expect(getMessages).toHaveBeenCalledWith(expect.objectContaining({ chat: BOB.jid }))
    );
    expect(screen.queryByText(/not in the local archive/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/older than the history loaded here/i)).not.toBeInTheDocument();

    const bobsMessage = { ...message(7), chatJid: BOB.jid, chatName: 'Bob' };
    await act(async () => {
      deliverBob?.({ messages: [bobsMessage], hasMore: false });
    });

    expect(await screen.findByText('message body 7')).toBeInTheDocument();
    expect(screen.queryByText(/not in the local archive/i)).not.toBeInTheDocument();
  });

});

describe('ThreadView keeps the operator where a jump put them', () => {
  const scrollTopWrites: number[] = [];
  let originalScrollTop: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    scrollTopWrites.length = 0;
    originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    // jsdom lays nothing out, so a scroll-to-bottom is only observable as the
    // write itself.
    Object.defineProperty(Element.prototype, 'scrollTop', {
      configurable: true,
      get: () => 0,
      set: (value: number) => {
        scrollTopWrites.push(value);
      },
    });
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalScrollTop) {
      Object.defineProperty(Element.prototype, 'scrollTop', originalScrollTop);
    }
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('opens a thread at the newest message when nothing was jumped to', async () => {
    getMessages.mockResolvedValue({ messages: [message(1), message(2)], hasMore: false });
    renderThread();

    await screen.findByText('message body 2');
    await waitFor(() => expect(scrollTopWrites.length).toBeGreaterThan(0));
  });

  it('does not throw the thread back to the newest message when the highlight fades', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getMessages.mockResolvedValue({ messages: [message(1), message(2)], hasMore: false });
    useAppStore.setState({ highlightedMessageId: 'MSG-1' });
    renderThread();

    await screen.findByText('message body 1');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    scrollTopWrites.length = 0;

    // The highlight is deliberately short-lived. Clearing it used to fall
    // through to the scroll-to-newest branch, so the operator was shown the
    // message they asked for and then yanked away from it seconds later.
    await act(async () => {
      vi.advanceTimersByTime(6000);
    });

    expect(useAppStore.getState().highlightedMessageId).toBeNull();
    expect(scrollTopWrites).toEqual([]);
  });
});

describe('ThreadView reactions', () => {
  function reactionRow(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
    return {
      ...message(9),
      msgId: 'RX-1',
      text: '',
      displayText: '',
      fromMe: true,
      senderJid: '',
      senderName: 'Me',
      reactionToId: 'MSG-1',
      reactionEmoji: '\u{1F44D}',
      ...over,
    };
  }

  /** Opens the drawer on the only message on screen and picks a quick emoji. */
  async function react(user: ReturnType<typeof userEvent.setup>, emoji: string) {
    await user.click(await screen.findByTitle('React with emoji'));
    await user.click(await screen.findByTitle(emoji));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    sendReact.mockResolvedValue({ sent: true });
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null });
  });

  afterEach(() => {
    useAppStore.setState({ selectedChat: null, highlightedMessageId: null });
  });

  it('shows the emoji on click rather than a wacli round trip later', async () => {
    const user = userEvent.setup();
    // Never settles: anything on screen is there because the click put it there.
    sendReact.mockReturnValue(new Promise(() => {}));
    renderThread();

    await screen.findByText('message body 1');
    await react(user, '\u{1F44D}');

    // Sending costs a wacli spawn, the store lock and a post-send wait, and the
    // row only reaches the thread on the poll after that — up to half a minute
    // of a click looking like it did nothing.
    expect(await screen.findByText('\u{1F44D}')).toBeInTheDocument();
    expect(sendReact).toHaveBeenCalledWith(
      expect.objectContaining({ to: CHAT.jid, id: 'MSG-1', reaction: '\u{1F44D}', confirm: true })
    );
  });

  it('asks for the thread again instead of waiting out the poll', async () => {
    const user = userEvent.setup();
    renderThread();

    await screen.findByText('message body 1');
    getMessages.mockClear();
    await react(user, '\u{1F44D}');

    await waitFor(() => expect(getMessages).toHaveBeenCalled());
  });

  it('shows one emoji, not two, once the archive reports the same reaction', async () => {
    const user = userEvent.setup();
    renderThread();
    await screen.findByText('message body 1');

    // The refetch a successful reaction triggers carries wacli's own row, which
    // has a real message id and cannot be matched to the optimistic one by id.
    getMessages.mockResolvedValue({ messages: [message(1), reactionRow()], hasMore: false });
    await react(user, '\u{1F44D}');

    await waitFor(() => expect(getMessages).toHaveBeenCalledTimes(2));
    expect(await screen.findAllByText('\u{1F44D}')).toHaveLength(1);
  });

  it('takes the emoji back and says why when the send is refused', async () => {
    const user = userEvent.setup();
    sendReact.mockRejectedValue(new Error('Safe read-only mode is active.'));
    renderThread();

    await screen.findByText('message body 1');
    await react(user, '\u{1F525}');

    // Showing a reaction before it lands is only honest if a refusal undoes it.
    expect(await screen.findByRole('alert')).toHaveTextContent(/Safe read-only mode is active/i);
    await waitFor(() => expect(screen.queryByText('\u{1F525}')).not.toBeInTheDocument());
  });

  it('keeps one reaction per person, newest first', async () => {
    getMessages.mockResolvedValue({
      messages: [
        message(1),
        reactionRow({ msgId: 'RX-OLD', reactionEmoji: '\u{1F44D}', ts: '2026-09-01T10:00:00Z' }),
        reactionRow({ msgId: 'RX-NEW', reactionEmoji: '❤️', ts: '2026-09-01T11:00:00Z' }),
      ],
      hasMore: false,
    });
    renderThread();

    await screen.findByText('message body 1');
    // Changing a reaction replaces it on WhatsApp; appending every row left the
    // old emoji sitting next to the new one.
    expect(await screen.findAllByText('❤️')).toHaveLength(1);
    expect(screen.queryByText('\u{1F44D}')).not.toBeInTheDocument();
  });
});

describe('ThreadView jump without a message id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    getHealth.mockResolvedValue(HEALTHY);
    getScheduled.mockResolvedValue([]);
    getHistoryCoverage.mockResolvedValue([COVERAGE]);
    useAppStore.setState({
      selectedChat: CHAT,
      highlightedMessageId: null,
      highlightedMessageHint: null,
    });
  });

  afterEach(() => {
    useAppStore.setState({
      selectedChat: null,
      highlightedMessageId: null,
      highlightedMessageHint: null,
    });
  });

  function sentMessage(): UnifiedMessage {
    return {
      ...message(4),
      msgId: '3EB0626F628F3B645B291E',
      fromMe: true,
      senderJid: '',
      senderName: 'Me',
      text: 'Ma kore gever?',
      displayText: 'Ma kore gever?',
    };
  }

  it('focuses the message a sidebar row describes when it carries no id', async () => {
    getMessages.mockResolvedValue({ messages: [message(1), sentMessage()], hasMore: false });
    useAppStore.setState({
      highlightedMessageHint: { text: 'Ma kore gever?', sentAfter: '2026-09-01T10:00:00Z' },
    });
    renderThread();

    await screen.findByText('Ma kore gever?');
    // Every scheduled send already on disk reaches the thread this way, with no
    // id wacli ever produced.
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(screen.queryByText(/not in the local archive/i)).not.toBeInTheDocument();
  });

  it('falls back to the description when the recorded id is not in the thread', async () => {
    getMessages.mockResolvedValue({ messages: [message(1), sentMessage()], hasMore: false });
    useAppStore.setState({
      highlightedMessageId: 'wamid.NOT-IN-THE-ARCHIVE',
      highlightedMessageHint: { text: 'Ma kore gever?', sentAfter: '2026-09-01T10:00:00Z' },
    });
    renderThread();

    await screen.findByText('Ma kore gever?');
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(screen.queryByText(/not in the local archive/i)).not.toBeInTheDocument();
  });

  it('still says so when neither the id nor the description can be found', async () => {
    getMessages.mockResolvedValue({ messages: [message(1)], hasMore: false });
    useAppStore.setState({
      highlightedMessageHint: { text: 'never sent from here', sentAfter: '2026-09-01T10:00:00Z' },
    });
    renderThread();

    // The notice has to keep working: it is only wrong when it fires for a
    // message that is present.
    expect(await screen.findByText(/not in the local archive/i)).toBeInTheDocument();
  });
});
