import { describe, it, expect } from 'vitest';
import {
  exportFileName,
  formatExportJson,
  formatTranscript,
} from './conversationExport.ts';
import type { ConversationExport, UnifiedMessage } from '../types.ts';

function message(overrides: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: 'alice@s.whatsapp.net',
    chatName: 'Alice',
    msgId: 'MSG-1',
    senderJid: 'alice@s.whatsapp.net',
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
    ...overrides,
  };
}

function exported(messages: UnifiedMessage[], overrides: Partial<ConversationExport> = {}): ConversationExport {
  return {
    chatJid: 'alice@s.whatsapp.net',
    chatName: 'Alice',
    exportedAt: '2026-09-03T12:00:00.000Z',
    count: messages.length,
    truncated: false,
    messages,
    ...overrides,
  };
}

describe('formatTranscript', () => {
  it('reads oldest first, the other way round from how wacli returns them', () => {
    const transcript = formatTranscript(
      exported([
        message({ msgId: 'MSG-2', ts: '2026-09-01T11:00:00Z', text: 'second', displayText: 'second' }),
        message({ msgId: 'MSG-1', ts: '2026-09-01T10:00:00Z', text: 'first', displayText: 'first' }),
      ])
    );

    expect(transcript.indexOf('first')).toBeLessThan(transcript.indexOf('second'));
  });

  it('names the operator as Me and the other party by name', () => {
    const transcript = formatTranscript(
      exported([
        message({ fromMe: true, senderName: '', text: 'mine', displayText: 'mine' }),
        message({ msgId: 'MSG-0', text: 'theirs', displayText: 'theirs' }),
      ])
    );

    expect(transcript).toContain('Me: mine');
    expect(transcript).toContain('Alice: theirs');
  });

  it('describes media rather than dropping the line', () => {
    const transcript = formatTranscript(
      exported([message({ text: '', displayText: '', mediaType: 'image', mediaCaption: null })])
    );

    expect(transcript).toContain('\u{1F4F7} Photo');
  });

  it('renders a reaction as a reaction, not as a stray emoji message', () => {
    const transcript = formatTranscript(
      exported([message({ reactionToId: 'MSG-0', reactionEmoji: '👍', text: '👍', displayText: '👍' })])
    );

    expect(transcript).toContain('reacted 👍 to an earlier message');
  });

  it('carries the header, so an exported file says what it is', () => {
    const transcript = formatTranscript(exported([message()]));

    expect(transcript).toContain('Conversation: Alice');
    expect(transcript).toContain('JID: alice@s.whatsapp.net');
    expect(transcript).toContain('Exported: 2026-09-03T12:00:00.000Z');
    expect(transcript).toContain('Messages: 1');
  });

  it('admits in the file itself when the export was truncated', () => {
    const transcript = formatTranscript(exported([message()], { truncated: true, count: 5000 }));

    expect(transcript).toContain('truncated');
  });

  it('survives a message with no readable content', () => {
    const transcript = formatTranscript(
      exported([message({ text: '', displayText: '', mediaCaption: null })])
    );

    expect(transcript).toContain('(no content)');
  });
});

describe('exportFileName', () => {
  it('uses the chat name and the current date', () => {
    expect(exportFileName('Alice', 'alice@s.whatsapp.net', 'txt')).toMatch(
      /^Alice-\d{4}-\d{2}-\d{2}\.txt$/
    );
  });

  it('strips characters a filesystem would object to', () => {
    const name = exportFileName('Ops / Team: "live"', 'team@g.us', 'json');
    expect(name).not.toMatch(/[/:"]/);
    expect(name).toMatch(/\.json$/);
  });

  it('falls back to the JID when the chat has no name', () => {
    expect(exportFileName('', '15551234567@s.whatsapp.net', 'txt')).toMatch(/^15551234567-/);
  });

  it('falls back again when nothing usable survives sanitising', () => {
    expect(exportFileName('///', '@@@', 'txt')).toMatch(/^conversation-/);
  });
});

describe('formatExportJson', () => {
  it('keeps every field, indented for reading', () => {
    const json = formatExportJson(exported([message({ starred: true })]));
    const parsed = JSON.parse(json) as ConversationExport;

    expect(parsed.messages[0].starred).toBe(true);
    expect(parsed.messages[0].msgId).toBe('MSG-1');
    expect(json).toContain('\n  ');
  });
});
