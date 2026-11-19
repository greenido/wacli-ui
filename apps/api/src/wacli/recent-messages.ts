import { execWacli } from './commands.js';
import { normalizeMessage } from './normalize.js';
import { logger } from '../logger.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

/**
 * How many of the newest messages, across every chat, one scan reads. The chat
 * rail's previews and the WAITING tab both work from this one list, so a
 * single unfiltered `messages list` serves both instead of a subprocess per
 * chat.
 *
 * Sized against the rail, which asks for 100 chats: messages cluster heavily in
 * a few busy threads, so 400 rows only reached ~37 distinct chats and the other
 * two thirds of the rail rendered with no preview at all. ~3000 covers 100
 * chats on a busy account and costs about 30ms more (~70ms, ~2MB) — cheap for a
 * read that is cached for 5s and polled every 30s. `previewCoverage` in the
 * `api` log reports what a scan actually reached, so this staying in step with
 * the rail is observable rather than assumed.
 *
 * The list is the newest messages of the whole archive, so for any chat it
 * reaches it holds that chat's latest messages in full. A chat whose last word
 * is older than the scan's reach is simply not in it.
 */
export const RECENT_SCAN_LIMIT = 3000;

/**
 * That scan returns about 2 MB of JSON, and `/api/chats` is refetched far more
 * often than the rail actually changes: every filter tap, every settled search
 * term, every reconnect. Holding the list briefly collapses those bursts, and
 * the WAITING poll that lands beside a rail poll, into one subprocess. It is
 * deliberately short — the live rail is kept current by the WebSocket, so this
 * only has to cover back-to-back requests, not a quiet minute.
 */
const RECENT_CACHE_TTL_MS = 5_000;

interface RawMessagesListResponse {
  messages: RawMessage[] | null;
}

let cache: { messages: UnifiedMessage[]; expiresAt: number } | null = null;

/**
 * The scan in flight, if any.
 *
 * The cache alone only collapses requests that arrive after one has finished.
 * Two `/api/chats` in the same tick — a reconnect invalidating the rail while a
 * poll is already running — both miss it and both run the scan. Sharing the
 * promise makes the second one free, the same way `/api/health` shares its
 * doctor probe.
 */
let inFlight: Promise<UnifiedMessage[]> | null = null;

/** Test seam: the cache is module state, so suites must be able to clear it. */
export function resetRecentMessages(): void {
  cache = null;
  inFlight = null;
}

/**
 * The newest messages across all chats, newest first, normalized. Throws when
 * wacli fails; a failure is not cached, so the next caller tries again.
 */
export async function fetchRecentMessages(): Promise<UnifiedMessage[]> {
  if (cache && Date.now() < cache.expiresAt) return cache.messages;
  if (inFlight) return inFlight;

  inFlight = scan().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function scan(): Promise<UnifiedMessage[]> {
  const done = logger.time('api', 'Recent message scan');
  const raw = await execWacli<RawMessagesListResponse | RawMessage[]>([
    'messages',
    'list',
    '--limit',
    String(RECENT_SCAN_LIMIT),
  ]);
  const rawList = Array.isArray(raw) ? raw : (raw?.messages ?? []);
  const messages = rawList.map(normalizeMessage);
  done({ scanned: messages.length }, 'DEBUG');

  cache = { messages, expiresAt: Date.now() + RECENT_CACHE_TTL_MS };
  return messages;
}
