import { describe, it, expect, beforeEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { BASE_TITLE, readUnreadTotal, unreadTitle } from './useUnreadBadge.ts';
import type { UnifiedChat } from '../types.ts';

function chat(jid: string, unreadCount: number, overrides: Partial<UnifiedChat> = {}): UnifiedChat {
  return {
    jid,
    kind: 'dm',
    name: jid.split('@')[0],
    lastMessageTs: null,
    lastMessage: null,
    lastMessageFromMe: false,
    archived: false,
    pinned: false,
    mutedUntil: 0,
    unread: unreadCount > 0,
    unreadCount,
    ...overrides,
  };
}

let queryClient: QueryClient;

describe('readUnreadTotal', () => {
  beforeEach(() => {
    queryClient = new QueryClient();
  });

  it('is zero before any chat list has loaded', () => {
    expect(readUnreadTotal(queryClient)).toBe(0);
  });

  it('sums unread across the rail', () => {
    queryClient.setQueryData(
      ['chats', '', 'all'],
      [chat('a@s.whatsapp.net', 2), chat('b@s.whatsapp.net', 3), chat('c@s.whatsapp.net', 0)]
    );
    expect(readUnreadTotal(queryClient)).toBe(5);
  });

  it('leaves archived chats out of the badge', () => {
    queryClient.setQueryData(
      ['chats', '', 'all'],
      [chat('a@s.whatsapp.net', 2), chat('z@s.whatsapp.net', 9, { archived: true })]
    );
    expect(readUnreadTotal(queryClient)).toBe(2);
  });

  it('counts each chat once when several filtered lists are cached', () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat('a@s.whatsapp.net', 4)]);
    queryClient.setQueryData(['chats', '', 'unread'], [chat('a@s.whatsapp.net', 4)]);
    expect(readUnreadTotal(queryClient)).toBe(4);
  });

  it('trusts the freshest list when cached lists disagree', () => {
    // A stale `unread` list still shows Alice waiting; the newer `all` list has
    // seen her read. Taking the newest entry per JID keeps the badge honest.
    queryClient.setQueryData(['chats', '', 'unread'], [chat('a@s.whatsapp.net', 4)]);
    queryClient.setQueryData(['chats', '', 'all'], [chat('a@s.whatsapp.net', 0)]);

    const stale = queryClient.getQueryCache().find({ queryKey: ['chats', '', 'unread'] })!;
    stale.state.dataUpdatedAt = Date.now() - 120_000;

    expect(readUnreadTotal(queryClient)).toBe(0);
  });

  it('ignores cache entries that are not chat lists', () => {
    queryClient.setQueryData(['chats', '', 'all'], [chat('a@s.whatsapp.net', 1)]);
    queryClient.setQueryData(['health'], { wacliInstalled: true });
    expect(readUnreadTotal(queryClient)).toBe(1);
  });
});

describe('unreadTitle', () => {
  it('leaves the title alone when nothing is waiting', () => {
    expect(unreadTitle(0)).toBe(BASE_TITLE);
  });

  it('leads with the count so a background tab reads at a glance', () => {
    expect(unreadTitle(7)).toBe(`(7) ${BASE_TITLE}`);
  });
});
