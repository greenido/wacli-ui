import { describe, expect, it } from 'vitest';
import {
  applyChatState,
  describeChatState,
  isChatMuted,
  isMarkedUnread,
  toggleArchive,
  togglePin,
} from './chatState.ts';
import type { UnifiedChat } from '../types.ts';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);

function chat(overrides: Partial<UnifiedChat> = {}): UnifiedChat {
  return {
    jid: '15550100001@s.whatsapp.net',
    kind: 'dm',
    name: 'Ada Lovelace',
    lastMessageTs: null,
    lastMessage: null,
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: false,
    unreadCount: 0,
    ...overrides,
  };
}

describe('isChatMuted', () => {
  it('reads -1 as muted for always', () => {
    expect(isChatMuted(chat({ mutedUntil: -1 }), NOW)).toBe(true);
  });

  it('reads a future end as muted, and a past one as not', () => {
    expect(isChatMuted(chat({ mutedUntil: NOW / 1000 + 60 }), NOW)).toBe(true);
    expect(isChatMuted(chat({ mutedUntil: NOW / 1000 - 60 }), NOW)).toBe(false);
  });

  it('reads 0 as not muted', () => {
    expect(isChatMuted(chat(), NOW)).toBe(false);
  });
});

describe('isMarkedUnread', () => {
  it('is the flag without a count', () => {
    expect(isMarkedUnread(chat({ unread: true }))).toBe(true);
    expect(isMarkedUnread(chat({ unread: true, unreadCount: 3 }))).toBe(false);
    expect(isMarkedUnread(chat())).toBe(false);
  });
});

describe('applyChatState', () => {
  it('pins, archives and marks unread', () => {
    expect(applyChatState(chat(), { action: 'pin' }).pinned).toBe(true);
    expect(applyChatState(chat({ pinned: true }), { action: 'unpin' }).pinned).toBe(false);
    expect(applyChatState(chat(), { action: 'archive' }).archived).toBe(true);
    expect(applyChatState(chat({ archived: true }), { action: 'unarchive' }).archived).toBe(false);
    expect(applyChatState(chat(), { action: 'mark-unread' }).unread).toBe(true);
  });

  it('mutes for a length the way wacli stores it', () => {
    const muted = applyChatState(chat(), { action: 'mute', duration: '8h' }, NOW);
    expect(muted.mutedUntil).toBe(NOW / 1000 + 8 * 3600);
    expect(isChatMuted(muted, NOW)).toBe(true);
  });

  it('mutes for always as -1', () => {
    expect(applyChatState(chat(), { action: 'mute', duration: '0' }, NOW).mutedUntil).toBe(-1);
    expect(applyChatState(chat(), { action: 'mute' }, NOW).mutedUntil).toBe(-1);
  });

  it('unmutes', () => {
    expect(applyChatState(chat({ mutedUntil: -1 }), { action: 'unmute' }).mutedUntil).toBe(0);
  });

  it('leaves the original alone', () => {
    const original = chat();
    applyChatState(original, { action: 'pin' });
    expect(original.pinned).toBe(false);
  });
});

describe('describeChatState', () => {
  it('names the chat and what happened to it', () => {
    expect(describeChatState({ action: 'pin' }, 'Ada')).toBe('Pinned Ada');
    expect(describeChatState({ action: 'mark-unread' }, 'Ada')).toBe('Marked Ada unread');
    expect(describeChatState({ action: 'mute', duration: '168h' }, 'Ada')).toBe('Muted Ada for 1 week');
    expect(describeChatState({ action: 'mute', duration: '0' }, 'Ada')).toBe('Muted Ada');
  });
});

describe('toggles', () => {
  it('flip what the chat is now', () => {
    expect(togglePin(chat())).toEqual({ action: 'pin' });
    expect(togglePin(chat({ pinned: true }))).toEqual({ action: 'unpin' });
    expect(toggleArchive(chat({ archived: true }))).toEqual({ action: 'unarchive' });
  });
});
