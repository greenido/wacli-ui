import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  markChatAsRead,
  clearChatUnreadInCache,
  flushPendingReads,
  MARK_READ_DEBOUNCE_MS,
} from './chatRead.ts';
import type { UnifiedChat } from '../types.ts';

const markChatRead = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock('../api/client.ts', () => ({ api: { markChatRead } }));

const ALICE = 'alice@s.whatsapp.net';
const BOB = 'bob@s.whatsapp.net';

function chat(jid: string): UnifiedChat {
  return {
    jid,
    kind: 'dm',
    name: jid,
    lastMessageTs: '2026-09-01T10:00:00Z',
    lastMessage: 'hi',
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: true,
    unreadCount: 4,
  };
}

let queryClient: QueryClient;

describe('markChatAsRead', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    markChatRead.mockClear();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['chats', '', 'all'], [chat(ALICE), chat(BOB)]);
  });

  afterEach(() => {
    // Drain anything still waiting so it cannot fire inside the next test.
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS * 2);
    vi.useRealTimers();
  });

  function unreadFor(jid: string): number {
    const rail = queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all'])!;
    return rail.find((c) => c.jid === jid)!.unreadCount;
  }

  it('clears the badge immediately, before any receipt is sent', () => {
    markChatAsRead(queryClient, ALICE);

    // The local half is free and the operator has in fact read the chat.
    expect(unreadFor(ALICE)).toBe(0);
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it('sends the receipt once the burst has settled', () => {
    markChatAsRead(queryClient, ALICE);
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);

    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(ALICE);
  });

  it('collapses a burst for one chat into a single receipt', () => {
    for (let i = 0; i < 10; i++) {
      markChatAsRead(queryClient, ALICE);
      vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS / 3);
    }
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);

    // Each receipt costs a sync-daemon teardown and respawn, so ten of them for
    // ten messages in one chat was ten cold reconnects to WhatsApp.
    expect(markChatRead).toHaveBeenCalledTimes(1);
  });

  it('debounces per chat rather than globally', () => {
    markChatAsRead(queryClient, ALICE);
    markChatAsRead(queryClient, BOB);
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);

    expect(markChatRead).toHaveBeenCalledTimes(2);
    expect(markChatRead).toHaveBeenCalledWith(ALICE);
    expect(markChatRead).toHaveBeenCalledWith(BOB);
  });

  it('sends again for a chat re-read after the window has closed', () => {
    markChatAsRead(queryClient, ALICE);
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);
    markChatAsRead(queryClient, ALICE);
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);

    // Debounced, not suppressed: a later read is still worth reporting.
    expect(markChatRead).toHaveBeenCalledTimes(2);
  });

  it('keeps the optimistic clear when the receipt fails', async () => {
    markChatRead.mockRejectedValueOnce(new Error('wacli chats mark-read timed out'));
    markChatAsRead(queryClient, ALICE);
    await vi.advanceTimersByTimeAsync(MARK_READ_DEBOUNCE_MS);

    // Refetching would restore a stale unread count from the store.
    expect(unreadFor(ALICE)).toBe(0);
  });

  it('flushes anything still pending on demand', () => {
    markChatAsRead(queryClient, ALICE);
    expect(markChatRead).not.toHaveBeenCalled();

    flushPendingReads();

    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(ALICE);

    // The flushed timer must not fire a second time.
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS * 2);
    expect(markChatRead).toHaveBeenCalledTimes(1);
  });

  it('leaves other chats alone when clearing one', () => {
    clearChatUnreadInCache(queryClient, ALICE);

    expect(unreadFor(ALICE)).toBe(0);
    expect(unreadFor(BOB)).toBe(4);
  });
});
