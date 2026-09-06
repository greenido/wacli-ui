import type { UnifiedMessage } from '../types.ts';

/** One page of thread history, exactly as `/api/messages` answers. */
export interface MessagePage {
  messages: UnifiedMessage[];
  hasMore: boolean;
}

/**
 * The thread cache as React Query holds it for an infinite query.
 *
 * Everything that writes into a thread — the socket's live inserts, a receipt,
 * a bookmark toggle — goes through the helpers below instead of reaching into
 * `pages` itself. One module knowing the shape is what lets the thread page
 * without every writer having to learn that it did.
 */
export interface MessagePages {
  pages: MessagePage[];
  pageParams: unknown[];
}

/**
 * How many pages a thread may hold and still be worth polling.
 *
 * Polling is only the safety net — the socket inserts live messages and
 * receipts into this cache directly, costing no wacli call at all. React Query
 * refetches *every* retained page when an infinite query refetches, and the
 * thread used to widen a single `limit` instead, so the sixth "load older"
 * re-read all 1200 messages every 30 seconds. Refetching six pages on that same
 * timer would trade one oversized subprocess for six ordinary ones and be no
 * cheaper. Older pages are settled history that cannot change, so the timer
 * stands down as soon as there is any: the poll only ever covers the newest
 * page, a flat cost however far back the operator has scrolled.
 */
export const MAX_POLLED_PAGES = 1;

/** Whether the safety-net poll should still run for a thread this deep. */
export function shouldPollThread(pageCount: number): boolean {
  return pageCount <= MAX_POLLED_PAGES;
}

/**
 * Every loaded message, newest first — the order wacli returns and the order
 * each page is stored in, so pages concatenate without a merge step.
 */
export function flattenMessagePages(data: MessagePages | undefined): UnifiedMessage[] {
  if (!data) return [];
  return data.pages.flatMap((page) => page.messages);
}

/**
 * Where the next page back starts.
 *
 * `wacli messages list --before` takes a time rather than a message id, so the
 * cursor is the oldest loaded message's timestamp. Messages sharing that exact
 * timestamp can therefore repeat across a page boundary, which is why every
 * reader dedupes by `msgId` rather than trusting the pages to be disjoint.
 */
export function olderCursor(page: MessagePage | undefined): string | undefined {
  if (!page) return undefined;
  return page.messages[page.messages.length - 1]?.ts;
}

/** True when this message is already somewhere in the loaded history. */
export function hasMessage(data: MessagePages, msgId: string): boolean {
  return data.pages.some((page) => page.messages.some((m) => m.msgId === msgId));
}

/**
 * A live message belongs on the front of the newest page. Pages behind it hold
 * older history, so a message already anywhere in the thread is a duplicate —
 * the socket redelivering, or a poll having raced it here first.
 */
export function prependMessage(
  data: MessagePages | undefined,
  msg: UnifiedMessage
): MessagePages | undefined {
  // Nothing loaded yet: the fetch already in flight will carry it.
  if (!data || data.pages.length === 0) return data;
  if (hasMessage(data, msg.msgId)) return data;

  const [newest, ...rest] = data.pages;
  return {
    ...data,
    pages: [{ ...newest, messages: [msg, ...newest.messages] }, ...rest],
  };
}

/**
 * Rewrite matching messages wherever they sit in the loaded history. A receipt
 * or a bookmark can land on a message the operator has scrolled back to, not
 * just on a recent one, so this walks every page rather than only the newest.
 */
export function patchMessages(
  data: MessagePages | undefined,
  matches: (msg: UnifiedMessage) => boolean,
  patch: (msg: UnifiedMessage) => UnifiedMessage
): MessagePages | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      messages: page.messages.map((m) => (matches(m) ? patch(m) : m)),
    })),
  };
}
