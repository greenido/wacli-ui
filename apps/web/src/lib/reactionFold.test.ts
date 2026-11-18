import { describe, it, expect } from 'vitest';
import { foldReactions } from './reactionFold.ts';
import type { UnifiedMessage } from '../types.ts';

function message(overrides: Partial<UnifiedMessage>): UnifiedMessage {
  return {
    chatJid: '15550100001@s.whatsapp.net',
    chatName: 'Ada Lovelace',
    msgId: 'M1',
    senderJid: '15550100001@s.whatsapp.net',
    senderName: 'Ada Lovelace',
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
    ...overrides,
  };
}

function reaction(id: string, emoji: string, at: string, overrides: Partial<UnifiedMessage> = {}) {
  return message({ msgId: id, reactionToId: 'M1', reactionEmoji: emoji, ts: at, text: '', ...overrides });
}

describe('foldReactions', () => {
  it('keeps reaction rows out of the thread and sorts what is left oldest first', () => {
    const later = message({ msgId: 'M2', ts: '2026-09-01T11:00:00Z' });
    const { messages } = foldReactions(
      [later, reaction('R1', '👍', '2026-09-01T10:05:00Z'), message({})],
      {}
    );

    expect(messages.map((m) => m.msgId)).toEqual(['M1', 'M2']);
  });

  it('shows only the newest reaction per reactor', () => {
    const { reactionsMap } = foldReactions(
      [
        message({}),
        reaction('R2', '❤️', '2026-09-01T10:06:00Z'),
        reaction('R1', '👍', '2026-09-01T10:05:00Z'),
      ],
      {}
    );

    expect(reactionsMap.get('M1')).toEqual([
      { emoji: '❤️', fromMe: false, sender: 'Ada Lovelace' },
    ]);
  });

  it('lets an empty reaction take an earlier one back', () => {
    const { reactionsMap } = foldReactions(
      [message({}), reaction('R1', '👍', '2026-09-01T10:05:00Z'), reaction('R2', '', '2026-09-01T10:06:00Z')],
      {}
    );

    expect(reactionsMap.has('M1')).toBe(false);
  });

  it('lays a pending reaction of ours over the archive until the archive moves', () => {
    const pending = { M1: { emoji: '🎉', was: '' } };

    const before = foldReactions([message({})], pending);
    expect(before.reactionsMap.get('M1')).toEqual([{ emoji: '🎉', fromMe: true, sender: 'Me' }]);

    // The archive caught up with something else (another device): it wins.
    const after = foldReactions(
      [message({}), reaction('R1', '😮', '2026-09-01T10:05:00Z', { fromMe: true })],
      pending
    );
    expect(after.reactionsMap.get('M1')?.map((r) => r.emoji)).toEqual(['😮']);
    expect(after.myArchivedReactions.get('M1')).toBe('😮');
  });
});
