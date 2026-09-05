import { describe, it, expect } from 'vitest';
import { resolveJumpTarget, usableMessageId, isSynthesisedMessageId } from './messageJump.ts';
import type { UnifiedMessage } from '../types.ts';

const CHAT = 'alice@s.whatsapp.net';

function msg(over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: CHAT,
    chatName: 'Alice',
    msgId: '3EB0AAAA',
    senderJid: '',
    senderName: 'Me',
    ts: '2026-09-04T10:00:00Z',
    fromMe: true,
    text: 'the wire went out',
    displayText: 'the wire went out',
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

describe('a placeholder id is not an id', () => {
  it('recognises what Mission Control used to invent', () => {
    // Every scheduled send already on disk carries one of these.
    expect(isSynthesisedMessageId('out-1788200061304')).toBe(true);
    expect(isSynthesisedMessageId('3EB0626F628F3B645B291E')).toBe(false);
  });

  it('offers nothing rather than an id no archive can hold', () => {
    expect(usableMessageId('out-1788200061304')).toBeNull();
    expect(usableMessageId(undefined)).toBeNull();
    expect(usableMessageId('3EB0626F628F3B645B291E')).toBe('3EB0626F628F3B645B291E');
  });
});

describe('resolving where a jump lands', () => {
  it('uses the id whenever the thread actually holds it', () => {
    const messages = [msg({ msgId: '3EB0AAAA' }), msg({ msgId: '3EB0BBBB' })];
    expect(resolveJumpTarget(messages, '3EB0BBBB', null)).toBe('3EB0BBBB');
  });

  it('finds the message from what was sent when no id was recorded', () => {
    // The case that made LATER unusable: the row has no id at all, but the
    // message it stands for is right there in the thread.
    const messages = [
      msg({ msgId: '3EB0AAAA', displayText: 'something else', text: 'something else' }),
      msg({ msgId: '3EB0BBBB', ts: '2026-09-04T12:00:00Z' }),
    ];

    const found = resolveJumpTarget(messages, null, {
      text: 'the wire went out',
      sentAfter: '2026-09-04T11:59:00Z',
    });

    expect(found).toBe('3EB0BBBB');
  });

  it('falls back to the hint when the recorded id is not in the thread', () => {
    const messages = [msg({ msgId: '3EB0BBBB', ts: '2026-09-04T12:00:00Z' })];

    const found = resolveJumpTarget(messages, 'wamid.NEVER-SYNCED', {
      text: 'the wire went out',
      sentAfter: '2026-09-04T11:59:00Z',
    });

    expect(found).toBe('3EB0BBBB');
  });

  it('takes the first send after the hint, not a later repeat of it', () => {
    const messages = [
      msg({ msgId: '3EB0OLD', ts: '2026-09-01T09:00:00Z' }),
      msg({ msgId: '3EB0WANTED', ts: '2026-09-04T12:00:00Z' }),
      msg({ msgId: '3EB0AGAIN', ts: '2026-09-05T12:00:00Z' }),
    ];

    const found = resolveJumpTarget(messages, null, {
      text: 'the wire went out',
      sentAfter: '2026-09-04T11:00:00Z',
    });

    // An identical body sent before the message was even queued is not it.
    expect(found).toBe('3EB0WANTED');
  });

  it('tolerates the clock skew between this machine and WhatsApp', () => {
    const messages = [msg({ msgId: '3EB0BBBB', ts: '2026-09-04T11:58:00Z' })];

    // The send was queued for 12:00 and WhatsApp stamped it two minutes early.
    // Demanding a strictly later timestamp would have missed it.
    expect(
      resolveJumpTarget(messages, null, {
        text: 'the wire went out',
        sentAfter: '2026-09-04T12:00:00Z',
      })
    ).toBe('3EB0BBBB');
  });

  it('never lands on an incoming message that happens to read the same', () => {
    const messages = [msg({ msgId: '3EB0THEIRS', fromMe: false, senderJid: CHAT })];

    expect(
      resolveJumpTarget(messages, null, {
        text: 'the wire went out',
        sentAfter: '2026-09-04T09:00:00Z',
      })
    ).toBeNull();
  });

  it('reports a genuine miss so the operator is still told the truth', () => {
    const messages = [msg({ msgId: '3EB0AAAA', displayText: 'nothing like it', text: 'nothing like it' })];

    expect(
      resolveJumpTarget(messages, 'wamid.GONE', {
        text: 'the wire went out',
        sentAfter: '2026-09-04T09:00:00Z',
      })
    ).toBeNull();
    expect(resolveJumpTarget(messages, null, null)).toBeNull();
  });

  it('matches a file send by the caption or name that went with it', () => {
    const messages = [
      msg({ msgId: '3EB0FILE', displayText: '', text: '', mediaType: 'document', filename: 'report.pdf' }),
    ];

    expect(
      resolveJumpTarget(messages, null, { text: 'report.pdf', sentAfter: '2026-09-04T09:00:00Z' })
    ).toBe('3EB0FILE');
  });
});
