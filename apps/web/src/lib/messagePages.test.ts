import { describe, it, expect } from 'vitest';
import {
  flattenMessagePages,
  hasMessage,
  isHistoryWindow,
  newerCursor,
  newerPage,
  olderCursor,
  patchMessages,
  prependMessage,
  shouldPollThread,
  windowPage,
  type MessagePage,
  type MessagePages,
} from './messagePages.ts';
import type { UnifiedMessage } from '../types.ts';

function message(id: string, ts: string, over: Partial<UnifiedMessage> = {}): UnifiedMessage {
  return {
    chatJid: '15551234567@s.whatsapp.net',
    chatName: 'Alice',
    msgId: id,
    senderJid: '15551234567@s.whatsapp.net',
    senderName: 'Alice',
    ts,
    fromMe: false,
    text: id,
    displayText: id,
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

/** Newest first within a page, and newest page first — as wacli and the thread order them. */
function pages(...groups: UnifiedMessage[][]): MessagePages {
  return {
    pages: groups.map<MessagePage>((messages, i) => ({
      messages,
      hasMore: i === groups.length - 1,
    })),
    pageParams: groups.map((_, i) => (i === 0 ? undefined : `cursor-${i}`)),
  };
}

describe('flattenMessagePages', () => {
  it('concatenates pages without a merge step', () => {
    const data = pages(
      [message('c', '2026-09-03T10:00:00Z'), message('b', '2026-09-02T10:00:00Z')],
      [message('a', '2026-09-01T10:00:00Z')]
    );
    expect(flattenMessagePages(data).map((m) => m.msgId)).toEqual(['c', 'b', 'a']);
  });

  it('has an answer before anything is loaded', () => {
    expect(flattenMessagePages(undefined)).toEqual([]);
  });
});

describe('olderCursor', () => {
  it('points at the oldest message of the page, which is the last one', () => {
    const page: MessagePage = {
      messages: [message('c', '2026-09-03T10:00:00Z'), message('b', '2026-09-02T10:00:00Z')],
      hasMore: true,
    };
    expect(olderCursor(page)).toBe('2026-09-02T10:00:00Z');
  });

  it('has no cursor to offer for an empty or missing page', () => {
    expect(olderCursor({ messages: [], hasMore: false })).toBeUndefined();
    expect(olderCursor(undefined)).toBeUndefined();
  });
});

describe('prependMessage', () => {
  it('puts a live message on the front of the newest page', () => {
    const data = pages([message('b', '2026-09-02T10:00:00Z')], [message('a', '2026-09-01T10:00:00Z')]);
    const next = prependMessage(data, message('c', '2026-09-03T10:00:00Z'));

    expect(next!.pages[0].messages.map((m) => m.msgId)).toEqual(['c', 'b']);
    expect(next!.pages[1].messages.map((m) => m.msgId)).toEqual(['a']);
  });

  it('dedupes against every page, not just the newest', () => {
    // The socket redelivering a message the operator has already scrolled back
    // past must not plant a second copy at the top of the thread.
    const data = pages([message('b', '2026-09-02T10:00:00Z')], [message('a', '2026-09-01T10:00:00Z')]);
    expect(prependMessage(data, message('a', '2026-09-01T10:00:00Z'))).toBe(data);
  });

  it('leaves an unloaded thread alone, so the fetch in flight carries it', () => {
    expect(prependMessage(undefined, message('a', '2026-09-01T10:00:00Z'))).toBeUndefined();
    const empty: MessagePages = { pages: [], pageParams: [] };
    expect(prependMessage(empty, message('a', '2026-09-01T10:00:00Z'))).toBe(empty);
  });
});

describe('patchMessages', () => {
  it('reaches messages sitting in older pages', () => {
    // A receipt or a bookmark can land on a message the operator scrolled back
    // to; patching only the newest page silently dropped those.
    const data = pages([message('b', '2026-09-02T10:00:00Z')], [message('a', '2026-09-01T10:00:00Z')]);
    const next = patchMessages(
      data,
      (m) => m.msgId === 'a',
      (m) => ({ ...m, bookmarked: true })
    );

    expect(next!.pages[1].messages[0].bookmarked).toBe(true);
    expect(next!.pages[0].messages[0].bookmarked).toBe(false);
  });

  it('has nothing to do before the thread is loaded', () => {
    expect(patchMessages(undefined, () => true, (m) => m)).toBeUndefined();
  });
});

describe('hasMessage', () => {
  it('looks across every loaded page', () => {
    const data = pages([message('b', '2026-09-02T10:00:00Z')], [message('a', '2026-09-01T10:00:00Z')]);
    expect(hasMessage(data, 'a')).toBe(true);
    expect(hasMessage(data, 'zzz')).toBe(false);
  });
});

describe('shouldPollThread', () => {
  it('polls the newest page and stops once history is loaded behind it', () => {
    // Refetching an infinite query re-reads every retained page, so a deep
    // thread on a 30s timer would spawn one wacli per page. Older pages are
    // settled history, and the socket keeps the newest one live regardless.
    expect(shouldPollThread(1)).toBe(true);
    expect(shouldPollThread(2)).toBe(false);
    expect(shouldPollThread(6)).toBe(false);
  });
});

describe('history windows', () => {
  const a = message('a', '2026-07-01T10:00:00Z');
  const b = message('b', '2026-07-01T10:01:00Z');
  const hit = message('hit', '2026-07-01T10:02:00Z');
  const c = message('c', '2026-07-01T10:03:00Z');
  const d = message('d', '2026-07-01T10:04:00Z');

  it('opens on the hit and what surrounds it, newest first like every page', () => {
    const page = windowPage(
      // Up to and including the hit, newest first.
      { messages: [hit, b, a], hasMore: true },
      // After it, oldest first, as `--asc` answers.
      { messages: [c, d], hasMore: false }
    );

    expect(page.messages.map((m) => m.msgId)).toEqual(['d', 'c', 'hit', 'b', 'a']);
    expect(page.hasMore).toBe(true);
    expect(page.hasNewer).toBe(false);
  });

  it('turns a page read forward around, and says whether more lies past it', () => {
    const page = newerPage({ messages: [c, d], hasMore: true });

    expect(page.messages.map((m) => m.msgId)).toEqual(['d', 'c']);
    expect(page.hasNewer).toBe(true);
    expect(newerCursor(page)).toBe(d.ts);
  });

  it('is told apart from the live thread by its page params', () => {
    const live = pages([b], [a]);
    const window: MessagePages = {
      pages: [{ messages: [c, hit, b], hasMore: true, hasNewer: true }],
      pageParams: [{ around: hit.ts }],
    };

    expect(isHistoryWindow(live)).toBe(false);
    expect(isHistoryWindow(window)).toBe(true);
  });

  it('takes no live messages, which would read as coming right after it', () => {
    const window: MessagePages = {
      pages: [{ messages: [c, hit, b], hasMore: true, hasNewer: true }],
      pageParams: [{ around: hit.ts }],
    };

    expect(prependMessage(window, message('live', '2026-09-24T10:00:00Z'))).toBe(window);
  });

  it('still takes a bookmark or a receipt, like the live thread', () => {
    const window: MessagePages = {
      pages: [{ messages: [c, hit, b], hasMore: true, hasNewer: true }],
      pageParams: [{ around: hit.ts }],
    };

    const next = patchMessages(
      window,
      (m) => m.msgId === 'hit',
      (m) => ({ ...m, bookmarked: true })
    );

    expect(flattenMessagePages(next).find((m) => m.msgId === 'hit')?.bookmarked).toBe(true);
  });
});
