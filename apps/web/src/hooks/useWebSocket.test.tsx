import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useWebSocket } from './useWebSocket.ts';
import { useAppStore } from '../store/appStore.ts';
import type { MissionControlEvent, UnifiedChat, UnifiedMessage } from '../types.ts';

const markChatRead = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../api/client.ts', () => ({
  api: { markChatRead },
  ApiClientError: class extends Error {},
}));

/** Minimal stand-in for the browser socket: the hook only opens and listens. */
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

function chat(overrides: Partial<UnifiedChat> = {}): UnifiedChat {
  return {
    jid: 'alice@s.whatsapp.net',
    kind: 'dm',
    name: 'Alice',
    lastMessageTs: '2026-09-01T10:00:00Z',
    lastMessage: 'earlier line',
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: false,
    unreadCount: 0,
    ...overrides,
  };
}

function message(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: 'alice@s.whatsapp.net',
    chatName: 'Alice',
    msgId: 'MSG-1',
    senderJid: 'alice@s.whatsapp.net',
    senderName: 'Alice',
    ts: '2026-09-01T11:00:00Z',
    fromMe: false,
    text: 'the newest line',
    displayText: 'the newest line',
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
    ...overrides,
  };
}

let queryClient: QueryClient;
let invalidateSpy: ReturnType<typeof vi.spyOn>;

function mount() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useWebSocket(), { wrapper });
  const socket = FakeWebSocket.instances.at(-1)!;
  act(() => {
    socket.onopen?.();
  });
  // The open handshake refreshes health and chats; the assertions below are
  // about what arriving *messages* cost, so start the count from here.
  invalidateSpy.mockClear();
  return { ...view, socket };
}

describe('useWebSocket chat rail reconciliation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    useAppStore.setState({ selectedChat: null });
    markChatRead.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('patches the rail row in place instead of refetching the chat list', async () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat()]);
    const { socket, unmount } = mount();

    act(() => {
      socket.emit({ type: 'message.new', data: message(), ts: '2026-09-01T11:00:00Z' });
    });

    const rail = queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all'])!;
    expect(rail[0].lastMessage).toBe('the newest line');
    expect(rail[0].lastMessageFromMe).toBe(false);
    expect(rail[0].lastMessageTs).toBe('2026-09-01T11:00:00Z');

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['chats'] });

    unmount();
  });

  it('bumps the unread badge immediately for a chat the operator is not viewing', () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat({ unreadCount: 2, unread: true })]);
    const { socket, unmount } = mount();

    act(() => {
      socket.emit({ type: 'message.new', data: message(), ts: '2026-09-01T11:00:00Z' });
    });

    const rail = queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all'])!;
    expect(rail[0].unreadCount).toBe(3);
    expect(rail[0].unread).toBe(true);

    unmount();
  });

  it('clears unread and marks read when the message lands in the open chat', async () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat({ unreadCount: 2, unread: true })]);
    useAppStore.setState({ selectedChat: chat() });
    const { socket, unmount } = mount();

    act(() => {
      socket.emit({ type: 'message.new', data: message(), ts: '2026-09-01T11:00:00Z' });
    });

    const rail = queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all'])!;
    expect(rail[0].unreadCount).toBe(0);
    expect(rail[0].unread).toBe(false);
    expect(rail[0].lastMessage).toBe('the newest line');
    await waitFor(() => expect(markChatRead).toHaveBeenCalledWith('alice@s.whatsapp.net'));

    unmount();
  });

  it('describes media rather than leaving the preview blank', () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat()]);
    const { socket, unmount } = mount();

    act(() => {
      socket.emit({
        type: 'message.new',
        data: message({ text: '', displayText: '', mediaType: 'image', mediaCaption: null }),
        ts: '2026-09-01T11:00:00Z',
      });
    });

    const rail = queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all'])!;
    expect(rail[0].lastMessage).toBe('\u{1F4F7} Photo');

    unmount();
  });

  it('leaves the preview alone for a reaction, which is not conversation content', () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat()]);
    const { socket, unmount } = mount();

    act(() => {
      socket.emit({
        type: 'message.new',
        data: message({ msgId: 'RCT-1', reactionToId: 'MSG-0', reactionEmoji: '👍', text: '👍', displayText: '👍' }),
        ts: '2026-09-01T11:00:00Z',
      });
    });

    const rail = queryClient.getQueryData<UnifiedChat[]>(['chats', '', 'all'])!;
    expect(rail[0].lastMessage).toBe('earlier line');

    unmount();
  });

  it('refetches once — not once per message — for chats the rail has never seen', () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat()]);
    const { socket, unmount } = mount();

    act(() => {
      for (let i = 0; i < 5; i++) {
        socket.emit({
          type: 'message.new',
          data: message({ chatJid: `stranger-${i}@s.whatsapp.net`, msgId: `NEW-${i}` }),
          ts: '2026-09-01T11:00:00Z',
        });
      }
    });

    expect(invalidateSpy).not.toHaveBeenCalledWith({ queryKey: ['chats'] });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const railInvalidations = invalidateSpy.mock.calls.filter(
      (call: unknown[]) => JSON.stringify(call[0]) === JSON.stringify({ queryKey: ['chats'] })
    );
    expect(railInvalidations).toHaveLength(1);

    unmount();
  });
});
