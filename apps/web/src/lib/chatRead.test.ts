import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  markChatAsRead,
  readBoundary,
  clearChatUnreadInCache,
  flushPendingReads,
  MARK_READ_DEBOUNCE_MS,
} from './chatRead.ts';
import type { UnifiedChat, UnifiedMessage } from '../types.ts';

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

    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(ALICE, undefined);
  });

  it('collapses a burst for one chat into a single receipt', () => {
    for (let i = 0; i < 10; i++) {
      markChatAsRead(queryClient, ALICE);
      vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS / 3);
    }
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);

    // Each receipt costs the sync daemon seconds, and sends queue behind it, so
    // ten of them for ten messages in one chat would keep a reply waiting
    // behind all ten.
    expect(markChatRead).toHaveBeenCalledTimes(1);
  });

  it('debounces per chat rather than globally', () => {
    markChatAsRead(queryClient, ALICE);
    markChatAsRead(queryClient, BOB);
    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);

    expect(markChatRead).toHaveBeenCalledTimes(2);
    expect(markChatRead).toHaveBeenCalledWith(ALICE, undefined);
    expect(markChatRead).toHaveBeenCalledWith(BOB, undefined);
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

describe('readBoundary', () => {
  function msg(msgId: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
    return {
      chatJid: ALICE,
      chatName: 'Alice',
      msgId,
      senderJid: ALICE,
      senderName: 'Alice',
      ts: '2026-09-01T10:00:00Z',
      fromMe: false,
      text: 'hello',
      displayText: 'hello',
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
      ...over,
    };
  }

  /** The live thread, newest first, the way the pages hold it. */
  function seedThread(client: QueryClient, messages: UnifiedMessage[]): void {
    client.setQueryData(['messages', ALICE], {
      pages: [{ messages, hasMore: false }],
      pageParams: [undefined],
    });
  }

  it('stops at the newest message from the other side that wacli takes as an anchor', () => {
    const client = new QueryClient();
    seedThread(client, [
      msg('MSG-MINE', { fromMe: true }),
      msg('MSG-REACTION', { reactionToId: 'MSG-2', reactionEmoji: '👍' }),
      msg('MSG-DELETED', { revoked: true }),
      msg('MSG-NOTICE', { text: '', displayText: '(message)' }),
      msg('MSG-2'),
      msg('MSG-1'),
    ]);

    expect(readBoundary(client, ALICE)).toBe('MSG-2');
  });

  it('takes a photo without a caption as an anchor', () => {
    const client = new QueryClient();
    seedThread(client, [msg('MSG-PHOTO', { text: '', displayText: '', mediaType: 'image' })]);

    expect(readBoundary(client, ALICE)).toBe('MSG-PHOTO');
  });

  it('gives none for a thread that is not loaded, so the whole chat is marked as before', () => {
    expect(readBoundary(new QueryClient(), ALICE)).toBeUndefined();
  });

  it('gives none while the thread is being fetched, rather than one short of what is on screen', () => {
    const client = new QueryClient();
    seedThread(client, [msg('MSG-STALE')]);
    void client.fetchQuery({ queryKey: ['messages', ALICE], queryFn: () => new Promise(() => {}) });

    expect(readBoundary(client, ALICE)).toBeUndefined();
  });

  it('is sent with the receipt when the debounce fires', () => {
    vi.useFakeTimers();
    const client = new QueryClient();
    client.setQueryData(['chats', '', 'all'], [chat(ALICE)]);
    markChatRead.mockClear();
    markChatAsRead(client, ALICE);
    // Arrived and drawn during the debounce: covered, since it is on screen.
    seedThread(client, [msg('MSG-LATEST'), msg('MSG-1')]);

    vi.advanceTimersByTime(MARK_READ_DEBOUNCE_MS);
    expect(markChatRead).toHaveBeenCalledExactlyOnceWith(ALICE, 'MSG-LATEST');
    vi.useRealTimers();
  });
});
