import { describe, it, expect } from 'vitest';
import { deliveryTitle, withReceipt } from './deliveryStatus.ts';
import type { UnifiedMessage } from '../types.ts';

function sent(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: '120363000000000001@g.us',
    chatName: 'Book club',
    msgId: 'MSG-OUT',
    senderJid: '',
    senderName: '',
    ts: '2026-09-01T10:00:00Z',
    fromMe: true,
    text: 'See you Thursday',
    displayText: 'See you Thursday',
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

describe('withReceipt', () => {
  it('moves a tick forward', () => {
    expect(withReceipt(sent({ deliveryStatus: 'sent' }), 'delivered').deliveryStatus).toBe('delivered');
    // No status yet is plainly sent, so any receipt is news.
    expect(withReceipt(sent(), 'read').deliveryStatus).toBe('read');
  });

  it('never moves one backwards, and hands back the same message', () => {
    // A member's "delivered" landing after another's "read" turned blue grey.
    const read = sent({ deliveryStatus: 'read', deliveredTo: 3, readBy: 1 });
    expect(withReceipt(read, 'delivered')).toBe(read);
    expect(withReceipt(read, 'read')).toBe(read);
  });

  it('drops counts the receipt has made stale', () => {
    const upgraded = withReceipt(sent({ deliveryStatus: 'delivered', deliveredTo: 1, readBy: 0 }), 'read');
    expect(upgraded.deliveredTo).toBeUndefined();
    expect(upgraded.readBy).toBeUndefined();
  });
});

describe('deliveryTitle', () => {
  it('names the status in a direct chat', () => {
    expect(deliveryTitle(sent({ deliveryStatus: 'read', deliveredTo: 1, readBy: 1 }), false)).toBe('read');
    expect(deliveryTitle(sent({ deliveryStatus: 'pending' }), false)).toBe('sending');
    expect(deliveryTitle(sent(), false)).toBe('sent');
  });

  it('counts reporters in a group, since blue alone cannot say how many read it', () => {
    expect(deliveryTitle(sent({ deliveryStatus: 'read', deliveredTo: 5, readBy: 2 }), true)).toBe(
      'delivered to 5 · read by 2'
    );
    expect(deliveryTitle(sent({ deliveryStatus: 'sent', deliveredTo: 0, readBy: 0 }), true)).toBe(
      'sent · no reports yet'
    );
    // Live receipts drop the counts; the status is all that is left to say.
    expect(deliveryTitle(sent({ deliveryStatus: 'read' }), true)).toBe('read');
  });
});
