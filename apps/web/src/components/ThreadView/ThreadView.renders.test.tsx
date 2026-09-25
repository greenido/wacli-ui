import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Profiler } from 'react';
import { render, screen, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThreadView } from './ThreadView.tsx';
import { useAppStore } from '../../store/appStore.ts';
import type { UnifiedChat, UnifiedMessage } from '../../types.ts';

const api = vi.hoisted(() => ({
  getHealth: vi.fn(),
  getSleep: vi.fn(),
  setSleep: vi.fn(),
  getMessages: vi.fn(),
  getScheduled: vi.fn(),
  cancelScheduled: vi.fn(),
  bookmarkMessage: vi.fn(),
  getHistoryCoverage: vi.fn(),
  backfillHistory: vi.fn(),
  exportConversation: vi.fn(),
  getMediaUrl: vi.fn(() => ''),
  sendReact: vi.fn(),
}));

vi.mock('../../api/client.ts', () => ({ api, ApiClientError: class extends Error {} }));

/**
 * Every text bubble works out its own direction once per render, which makes
 * this a count of message rows drawn. Passed through to the real thing.
 */
const detectTextDirection = vi.hoisted(() => vi.fn());
vi.mock('../../lib/textDirection.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/textDirection.ts')>();
  detectTextDirection.mockImplementation(actual.detectTextDirection);
  return { ...actual, detectTextDirection };
});

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

function message(i: number): UnifiedMessage {
  return {
    chatJid: CHAT.jid,
    chatName: 'Alice',
    msgId: `MSG-${i}`,
    senderJid: CHAT.jid,
    senderName: 'Alice',
    ts: new Date(Date.UTC(2026, 8, 1, 10, i)).toISOString(),
    fromMe: i % 3 === 0,
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

/** A thread of 200 messages, settled: loaded, laid out, nothing pending. */
async function renderSettledThread(onRender: () => void = () => {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Profiler id="thread" onRender={onRender}>
        <ThreadView />
      </Profiler>
    </QueryClientProvider>
  );
  expect(await screen.findByText('message body 199')).toBeInTheDocument();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe('ThreadView render cost', () => {
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
    api.getScheduled.mockResolvedValue({ pending: [], history: [], nextCursor: null });
    api.getHistoryCoverage.mockResolvedValue([]);
    api.getMessages.mockResolvedValue({
      messages: Array.from({ length: 200 }, (_, i) => message(i)),
      hasMore: false,
    });
    useAppStore.setState({ selectedChat: CHAT, highlightedMessageId: null, presenceMap: {} });
  });

  it('does not redraw for typing in another chat', async () => {
    let commits = 0;
    await renderSettledThread(() => {
      commits += 1;
    });
    commits = 0;

    // Subscribed to the whole presence map, the thread was redrawn, every
    // bubble of it, for each of these.
    for (let i = 0; i < 20; i++) {
      act(() =>
        useAppStore.getState().setPresence(`bob${i}@s.whatsapp.net`, 'composing', `bob${i}@s.whatsapp.net`)
      );
    }

    expect(commits).toBe(0);
  });

  it('shows typing in the open chat without redrawing its messages', async () => {
    await renderSettledThread();
    detectTextDirection.mockClear();

    act(() => useAppStore.getState().setPresence(CHAT.jid, 'composing', CHAT.jid));

    expect(screen.getByText(/typing\.\.\./)).toBeInTheDocument();
    expect(detectTextDirection).not.toHaveBeenCalled();
  });
});
