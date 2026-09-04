import { Router, type Request, type Response, type NextFunction } from 'express';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import { messagePreviewText, normalizeChat, normalizeMessage } from '../wacli/normalize.js';
import { logger } from '../logger.js';
import type { ChatPreview } from '../wacli/normalize.js';
import type { RawChat, RawMessage, UnifiedChat } from '../types.js';

/**
 * How many recent messages to scan for chat-rail previews. wacli's chat record
 * carries only `last_message_ts` — no body — so the preview has to come from the
 * message table. One unfiltered `messages list` covers every chat that has been
 * active recently, for the cost of a single extra subprocess.
 *
 * Sized against the rail, which asks for 100 chats: messages cluster heavily in
 * a few busy threads, so 400 rows only reached ~37 distinct chats and the other
 * two thirds of the rail rendered with no preview at all. ~3000 covers 100
 * chats on a busy account and costs about 30ms more (~70ms, ~2MB) — cheap for a
 * read that is cached for 5s and polled every 30s. `previewCoverage` in the
 * `api` log reports what a scan actually reached, so this staying in step with
 * the rail is observable rather than assumed.
 */
const PREVIEW_SCAN_LIMIT = 3000;

/**
 * That scan returns roughly 300 KB of JSON to keep one line per chat, and
 * `/api/chats` is refetched far more often than the rail actually changes:
 * every filter tap, every settled search term, every reconnect. Holding the
 * folded map briefly collapses those bursts into one subprocess. It is
 * deliberately short — the live rail is kept current by the WebSocket, so this
 * only has to cover back-to-back requests, not a quiet minute.
 */
const PREVIEW_CACHE_TTL_MS = 5_000;

interface RawMessagesListResponse {
  messages: RawMessage[] | null;
}

let previewCache: { previews: Map<string, ChatPreview>; expiresAt: number } | null = null;

/** Test seam: the cache is module state, so suites must be able to clear it. */
export function resetChatPreviewCache(): void {
  previewCache = null;
}

/**
 * Best-effort: a preview is a nicety, so a failure here must never cost the
 * operator their chat list.
 */
async function fetchChatPreviews(): Promise<Map<string, ChatPreview>> {
  if (previewCache && Date.now() < previewCache.expiresAt) {
    return previewCache.previews;
  }

  const previews = new Map<string, ChatPreview>();
  const done = logger.time('api', 'Chat preview scan');

  try {
    const raw = await execWacli<RawMessagesListResponse | RawMessage[]>([
      'messages',
      'list',
      '--limit',
      String(PREVIEW_SCAN_LIMIT),
    ]);

    const rawList = Array.isArray(raw) ? raw : (raw?.messages ?? []);

    for (const rawMsg of rawList) {
      const msg = normalizeMessage(rawMsg);
      // wacli returns newest first, and reactions are not conversation content.
      if (!msg.chatJid || previews.has(msg.chatJid) || msg.reactionToId) continue;

      const text = messagePreviewText(msg);
      if (!text) continue;

      previews.set(msg.chatJid, { text, fromMe: msg.fromMe });
    }
    done({ scanned: rawList.length, chatsCovered: previews.size }, 'DEBUG');
  } catch (err) {
    logger.warn('api', 'Chat previews unavailable', { err });
    // A failed scan is not worth caching: the next request should try again.
    return previews;
  }

  previewCache = { previews, expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS };
  return previews;
}

function requireMutationPermission(req: Request, res: Response, next: NextFunction): void {
  const customHeader = req.headers['x-mission-control-request'];
  if (!customHeader && process.env.NODE_ENV !== 'test') {
    res.status(400).json({
      success: false,
      data: null,
      error: 'Missing required "X-Mission-Control-Request: 1" header.',
    });
    return;
  }

  if (modeManager.isReadOnly()) {
    res.status(403).json({
      success: false,
      data: null,
      error: 'Safe read-only mode is active. Chat state mutations are disabled.',
    });
    return;
  }

  next();
}

export function createChatsRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  router.get('/chats', async (req, res, next) => {
    try {
      const args = ['chats', 'list'];

      const query = req.query.query as string | undefined;
      const limit = req.query.limit as string | undefined;
      const archived = req.query.archived;
      const pinned = req.query.pinned;
      const muted = req.query.muted;
      const unread = req.query.unread;

      if (query) args.push('--query', query);
      if (limit) args.push('--limit', limit);
      if (archived === 'true') args.push('--archived');
      else if (archived === 'false') args.push('--no-archived');

      if (pinned === 'true') args.push('--pinned');
      else if (pinned === 'false') args.push('--no-pinned');

      if (muted === 'true') args.push('--muted');
      else if (muted === 'false') args.push('--no-muted');

      if (unread === 'true') args.push('--unread');
      else if (unread === 'false') args.push('--no-unread');

      const raw = await execWacli<RawChat[]>(args);
      const previews = await fetchChatPreviews();
      const chats: UnifiedChat[] = (Array.isArray(raw) ? raw : []).map((rawChat) =>
        normalizeChat(rawChat, previews.get(rawChat.jid))
      );

      // A row with no preview renders as a subtitle with nothing to say, so
      // coverage falling behind the page size is a visible defect rather than a
      // missing nicety. Saying so out loud once it affects most of the rail is
      // what turns "the list looks wrong" into a number worth acting on.
      const covered = chats.filter((chat) => chat.lastMessage !== null).length;
      const coverage = { chats: chats.length, covered, scanLimit: PREVIEW_SCAN_LIMIT };

      // Archived and muted chats are inactive by definition, so their last
      // messages sit outside any window of recent ones: thin coverage there is
      // the filter working, not a defect. Only the primary rail is a signal.
      const isPrimaryRail = !query && !pinned && !muted && !unread && archived !== 'true';

      if (isPrimaryRail && chats.length > 0 && covered * 2 < chats.length) {
        logger.warn('api', 'Most chat rows have no preview; raise PREVIEW_SCAN_LIMIT', coverage);
      } else {
        logger.debug('api', 'Chat list served', coverage);
      }

      res.json({ success: true, data: chats, error: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/chats/mark-read', requireMutationPermission, async (req, res, next) => {
    try {
      const { chat } = req.body as { chat?: string };

      if (!chat || typeof chat !== 'string') {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Field "chat" (JID) is required.',
        });
        return;
      }

      await processManager.executeExclusive(async () => {
        await execWacli(['chats', 'mark-read', '--chat', chat], { allowMutation: true });
      });

      res.json({
        success: true,
        data: { chat, unread: false, unreadCount: 0 },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
