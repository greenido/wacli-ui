import { describe, it, expect } from 'vitest';
import { chatDisplayName } from './chatDisplayName.ts';
import { chatFromMessage } from './chatFromMessage.ts';
import type { UnifiedMessage } from '../types.ts';

const message = (over: Partial<UnifiedMessage>): UnifiedMessage => ({
  chatJid: '15551234567@s.whatsapp.net',
  chatName: 'Alice',
  msgId: 'MSG-1',
  senderJid: '15551234567@s.whatsapp.net',
  senderName: 'Alice',
  ts: '2026-09-05T21:00:00Z',
  fromMe: false,
  text: 'hi',
  displayText: 'hi',
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
});

describe('chatDisplayName', () => {
  it('keeps the name it is given', () => {
    expect(chatDisplayName('120363111111111111@g.us', 'Ops Team')).toBe('Ops Team');
    expect(chatDisplayName('15551234567@s.whatsapp.net', 'Alice')).toBe('Alice');
  });

  it('falls back to the phone number for a DM', () => {
    expect(chatDisplayName('15551234567@s.whatsapp.net', '')).toBe('15551234567');
  });

  it('labels an unnamed group instead of showing its group id as a name', () => {
    // The 18-digit id identifies nothing a human recognises, and shown bare it
    // reads as a phone number. The tail keeps two unnamed groups distinguishable.
    expect(chatDisplayName('120363111111111111@g.us', '')).toBe('Group 111111');
    expect(chatDisplayName('120363222222222222@g.us', '')).toBe('Group 222222');
    expect(chatDisplayName('120363111111111111@g.us', '  ')).toBe('Group 111111');
    expect(chatDisplayName('120363111111111111@g.us')).toBe('Group 111111');
  });

  it('has something to say even for a malformed group jid', () => {
    expect(chatDisplayName('@g.us', '')).toBe('Unnamed group');
  });
});

describe('chatFromMessage naming', () => {
  it('uses the message chat name when the live event carries one', () => {
    const chat = chatFromMessage(message({ chatJid: '120363111111111111@g.us', chatName: 'Ops Team' }));
    expect(chat.name).toBe('Ops Team');
    expect(chat.kind).toBe('group');
  });

  it('labels the group when the live event carries no chat name', () => {
    const chat = chatFromMessage(message({ chatJid: '120363111111111111@g.us', chatName: '' }));
    expect(chat.name).toBe('Group 111111');
  });
});
