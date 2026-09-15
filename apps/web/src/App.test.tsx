import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { App } from './App.tsx';
import { useAppStore } from './store/appStore.ts';
import { POLL_CHATS_MS, POLL_MESSAGES_MS } from './lib/queryOptions.ts';
import type {
  MissionControlEvent,
  ScheduledMessage,
  SleepState,
  UnifiedChat,
  UnifiedMessage,
} from './types.ts';

const CHAT: UnifiedChat = {
  jid: '15550100001@s.whatsapp.net',
  kind: 'dm',
  name: 'Ada Lovelace',
  lastMessageTs: '2026-09-15T21:00:00.000Z',
  lastMessage: 'See you at six',
  lastMessageFromMe: false,
  archived: false,
  pinned: false,
  mutedUntil: 0,
  unread: false,
  unreadCount: 0,
};

const AWAKE: SleepState = { sleeping: false, since: null };
const ASLEEP: SleepState = { sleeping: true, since: '2026-09-15T22:14:00.000Z' };

/**
 * Every client method is a mock, made on first use and answering with
 * something harmless, so any request the console makes at all shows up as a
 * call — including one to a method nobody thought to list.
 */
const client = vi.hoisted(() => {
  const answers: Record<string, unknown> = {
    getSleep: { sleeping: false, since: null },
    getHealth: {
      readOnly: false,
      processState: 'running',
      processPid: 4242,
      heartbeatAgeSeconds: 2,
      lastError: null,
      reconnectAttempts: 0,
      doctor: null,
      wacliInstalled: true,
      wacliWorking: true,
      wacliVersion: 'wacli test',
      wacliBinaryPath: null,
      statusSummary: 'ok',
      statusMessage: null,
      storeLockHeld: false,
      storeLockHolderPid: null,
    },
    getMode: { readOnly: false },
    getSettings: { readOnly: false },
    getChats: [],
    getMessages: { messages: [], hasMore: false },
    getHistoryCoverage: [],
    getTags: { tags: [], byJid: {} },
    getScheduled: { pending: [], history: [], nextCursor: null, totalPending: 0, totalHistory: 0 },
    getActivity: { items: [], nextCursor: null, total: 0 },
  };
  const mocks = new Map<string, Mock>();
  const api = new Proxy({} as Record<string, Mock>, {
    get(_target, name) {
      if (typeof name !== 'string') return undefined;
      if (!mocks.has(name)) mocks.set(name, vi.fn(async () => answers[name] ?? null));
      return mocks.get(name);
    },
  });
  return { api, mocks };
});

vi.mock('./api/client.ts', () => ({
  api: client.api,
  ApiClientError: class extends Error {},
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.readyState = 3;
  }

  emit(event: MissionControlEvent) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

/** Calls so far, per client method. */
function callCounts(): Record<string, number> {
  return Object.fromEntries([...client.mocks].map(([name, mock]) => [name, mock.mock.calls.length]));
}

/** What was asked for since `before`, per method, leaving out what was not. */
function callsSince(before: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(callCounts())
      .map(([name, count]) => [name, count - (before[name] ?? 0)] as const)
      .filter(([, delta]) => delta > 0)
  );
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

let queryClient: QueryClient;

/** Waits until nothing is in flight, so a count taken next is a settled one. */
const settled = () => waitFor(() => expect(queryClient.isFetching()).toBe(0));

const now = () => new Date().toISOString();

describe('App asleep', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    FakeWebSocket.instances = [];
    Element.prototype.scrollIntoView = vi.fn();
    for (const mock of client.mocks.values()) mock.mockClear();
    client.api.getSleep.mockResolvedValue(AWAKE);
    client.api.getChats.mockResolvedValue([CHAT]);
    useAppStore.setState({ selectedChat: CHAT, activeModal: null, sendLogs: [] });
    // The production defaults, so focus refetches are part of what is tested.
    queryClient = new QueryClient({
      defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: false } },
    });
  });

  afterEach(() => {
    queryClient.clear();
    focusManager.setFocused(undefined);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('asks for nothing while asleep, lets the queue catch up, and resumes on wake', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    // Awake, the console loads as it always has.
    await waitFor(() => expect(client.api.getMessages).toHaveBeenCalled());
    const ws = FakeWebSocket.instances[0];
    act(() => ws.onopen?.());
    await settled();

    // Sleep arrives as a push, as it does from this tab's moon or another tab's.
    client.api.getSleep.mockResolvedValue(ASLEEP);
    act(() => ws.emit({ type: 'sleep.changed', data: ASLEEP, ts: now() }));
    expect(await screen.findByRole('status', { name: /sleep mode/i })).toBeInTheDocument();
    await settled();
    const asleep = callCounts();

    // Ten minutes of every interval there is, and the operator coming back to
    // the window: nothing at all.
    await advance(10 * 60_000);
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(1_000);
    expect(callsSince(asleep)).toEqual({});

    // The socket drops and comes back, as it does across the laptop's own
    // sleep. It re-reads sleep and the queue, both Mission Control's own, and
    // nothing that reaches wacli.
    let mark = callCounts();
    act(() => ws.onopen?.());
    await settled();
    expect(callsSince(mark)).toEqual({ getSleep: 1, getScheduled: 2 });

    // Two scheduled messages go out: one to the chat on screen, one to a chat
    // the rail has never seen. LATER catches up from the app's own database
    // (the queue, and this chat's slice of it) and the first is patched into
    // the thread. The second would ordinarily cost a chat-list refetch; asleep,
    // that waits for the wake.
    const sent: ScheduledMessage = {
      id: 'sched-1',
      to: CHAT.jid,
      recipientName: CHAT.name,
      message: 'Good morning',
      scheduledAt: now(),
      createdAt: '2026-09-15T20:00:00.000Z',
      status: 'sent',
    };
    const sentMessage: UnifiedMessage = {
      chatJid: CHAT.jid,
      chatName: CHAT.name,
      msgId: 'STUBMSG0001',
      senderJid: '',
      senderName: 'Me',
      ts: now(),
      fromMe: true,
      text: 'Good morning',
      displayText: 'Good morning',
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
      deliveryStatus: 'sent',
    };
    mark = callCounts();
    act(() => {
      ws.emit({ type: 'scheduled.update', data: sent, ts: now() });
      ws.emit({ type: 'message.new', data: sentMessage, ts: now() });
      ws.emit({
        type: 'message.new',
        data: {
          ...sentMessage,
          chatJid: '15550100002@s.whatsapp.net',
          chatName: 'Grace Hopper',
          msgId: 'STUBMSG0002',
        },
        ts: now(),
      });
    });
    // Past the window the chat-list refetch is coalesced over.
    await advance(2_000);
    await settled();

    expect(callsSince(mark)).toEqual({ getScheduled: 2 });
    // In the thread, and as the rail's preview for the chat.
    expect(await screen.findAllByText('Good morning')).toHaveLength(2);

    // Wake: health is read straight away and the polls come back. The rail and
    // thread were patched a moment ago, so they wait for their next poll rather
    // than refetching what is already fresh.
    const beforeWake = callCounts();
    client.api.getSleep.mockResolvedValue(AWAKE);
    act(() => ws.emit({ type: 'sleep.changed', data: AWAKE, ts: now() }));
    await advance(Math.max(POLL_CHATS_MS, POLL_MESSAGES_MS) + 1_000);

    const resumed = callsSince(beforeWake);
    expect(resumed.getHealth).toBeGreaterThanOrEqual(2);
    expect(resumed.getChats).toBeGreaterThanOrEqual(1);
    expect(resumed.getMessages).toBeGreaterThanOrEqual(1);
    expect(resumed.getActivity).toBeGreaterThanOrEqual(1);
  });
});
