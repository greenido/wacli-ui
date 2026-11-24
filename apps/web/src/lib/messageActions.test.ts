import { describe, expect, it } from 'vitest';
import { canDeleteForMe, canEdit, canForward, canUnsend, editMinutesLeft } from './messageActions.ts';
import type { UnifiedMessage } from '../types.ts';

const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function msg(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: '15550100001@s.whatsapp.net',
    chatName: 'Ada Lovelace',
    msgId: 'MSG000001',
    senderJid: '15550100000@s.whatsapp.net',
    senderName: 'Me',
    ts: minutesAgo(5),
    fromMe: true,
    text: 'see you at 9',
    displayText: 'see you at 9',
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
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

describe('canEdit', () => {
  it('allows your own recent text', () => {
    expect(canEdit(msg(), NOW)).toBe(true);
  });

  it('stops at the 20-minute window', () => {
    expect(canEdit(msg({ ts: minutesAgo(19) }), NOW)).toBe(true);
    expect(canEdit(msg({ ts: minutesAgo(21) }), NOW)).toBe(false);
  });

  it('refuses someone else’s message, media, a deletion and a send still in flight', () => {
    expect(canEdit(msg({ fromMe: false }), NOW)).toBe(false);
    expect(canEdit(msg({ mediaType: 'image' }), NOW)).toBe(false);
    expect(canEdit(msg({ revoked: true }), NOW)).toBe(false);
    expect(canEdit(msg({ deliveryStatus: 'pending' }), NOW)).toBe(false);
  });
});

describe('editMinutesLeft', () => {
  it('rounds up, and never goes below zero', () => {
    expect(editMinutesLeft(msg({ ts: minutesAgo(5) }), NOW)).toBe(15);
    expect(editMinutesLeft(msg({ ts: new Date(NOW - 19.5 * 60_000).toISOString() }), NOW)).toBe(1);
    expect(editMinutesLeft(msg({ ts: minutesAgo(30) }), NOW)).toBe(0);
  });

  it('never promises more than the window, even for a timestamp ahead of this clock', () => {
    expect(editMinutesLeft(msg({ ts: minutesAgo(-10) }), NOW)).toBe(20);
  });
});

describe('canUnsend', () => {
  it('allows your own message for about two and a half days', () => {
    expect(canUnsend(msg({ ts: minutesAgo(59 * 60) }), NOW)).toBe(true);
    expect(canUnsend(msg({ ts: minutesAgo(61 * 60) }), NOW)).toBe(false);
  });

  it('allows media, but not someone else’s message', () => {
    expect(canUnsend(msg({ mediaType: 'image', text: '' }), NOW)).toBe(true);
    expect(canUnsend(msg({ fromMe: false }), NOW)).toBe(false);
  });
});

describe('canDeleteForMe', () => {
  it('allows any message still there', () => {
    expect(canDeleteForMe(msg({ fromMe: false, ts: minutesAgo(100_000) }))).toBe(true);
    expect(canDeleteForMe(msg({ revoked: true }))).toBe(false);
    expect(canDeleteForMe(msg({ reactionToId: 'MSG000002' }))).toBe(false);
  });
});

describe('canForward', () => {
  it('allows text and media, from anyone', () => {
    expect(canForward(msg({ fromMe: false }))).toBe(true);
    expect(canForward(msg({ text: '', displayText: '', mediaType: 'document' }))).toBe(true);
  });

  it('refuses an empty message and a deletion', () => {
    expect(canForward(msg({ text: '', displayText: '' }))).toBe(false);
    expect(canForward(msg({ revoked: true }))).toBe(false);
  });
});
