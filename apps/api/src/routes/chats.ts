import { Router, type Request, type Response, type NextFunction } from 'express';
import { execWacli } from '../wacli/commands.js';
import { wacliSupports } from '../wacli/capabilities.js';
import { modeManager } from '../wacli/mode.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import { messagePreviewText, normalizeChat } from '../wacli/normalize.js';
import { fetchRecentMessages, RECENT_SCAN_LIMIT, resetRecentMessages } from '../wacli/recent-messages.js';
import { fetchGroupNames } from '../wacli/group-names.js';
import { logger } from '../logger.js';
import type { ChatPreview } from '../wacli/normalize.js';
import type { RawChat, UnifiedChat, UnifiedMessage } from '../types.js';
import { queryLimit, queryString } from './query.js';

/**
 * How long a read receipt may tie up the sync daemon.
 *
 * `mark-read` is a network operation — it pushes receipts to WhatsApp — and it
 * is handed to the running daemon. The daemon carries out what it is handed one
 * at a time, sends included, so every second a receipt runs is a second a send
 * made meanwhile spends waiting. See MARK_READ_RECEIPTS for why that is now
 * short, and this budget only matters on a wacli that cannot do it that way.
 */
const MARK_READ_TIMEOUT_MS = 10_000;

/**
 * Marks a chat read by sending read receipts for its unread messages, rather
 * than through WhatsApp's chat state.
 *
 * The chat-state way replays that state in full before every write, which takes
 * seconds, and a reply typed straight after opening a chat queued behind it.
 * `--receipts` (wacli 0.19.0) skips the replay. The price is that the receipts
 * are real ones: the sender sees blue ticks, unless the account's read-receipt
 * privacy setting is off.
 */
const MARK_READ_RECEIPTS = '--receipts';

/**
 * Set once this wacli has refused `--receipts` as an unknown flag, so an older
 * binary costs one failed spawn per run, not one per chat opened.
 */
let receiptsFlagUnknown = false;

/** Forgets that verdict. For tests, which each want a wacli that has the flag. */
export function resetMarkReadReceipts(): void {
  receiptsFlagUnknown = false;
}

/**
 * Whether a mark-read failed only because `--receipts` could not be used: the
 * CLI is older than the flag, or it handed the receipt to a daemon started by
 * an older wacli, which refuses it and leaves the chat unread. Neither sent
 * anything, so running it the chat-state way is safe.
 */
function receiptsRefused(err: unknown): 'flag' | 'daemon' | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(`unknown flag: ${MARK_READ_RECEIPTS}`)) return 'flag';
  if (message.includes(`does not support ${MARK_READ_RECEIPTS}`)) return 'daemon';
  return null;
}

/**
 * Marks read only through the newest message the operator had on screen
 * (wacli 0.22). Marking is debounced, so without a boundary a message that
 * arrived inside that window was acknowledged to its sender without anyone
 * having seen it.
 */
const MARK_READ_THROUGH = '--through-message-id';

/**
 * Whether a bounded mark-read failed only because of its boundary, before
 * anything was sent: the anchor is not a stored inbound message wacli will
 * stop at, or the running daemon predates the flag and left the chat alone.
 * Either way the unbounded mark-read is what the console did before
 * boundaries existed, and still safe to run.
 */
function boundaryRefused(err: unknown): 'anchor' | 'daemon' | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('must be a stored inbound message') || message.includes('has no read boundary')) {
    return 'anchor';
  }
  if (message.includes(`does not support ${MARK_READ_THROUGH}`)) return 'daemon';
  return null;
}

/**
 * The chat-state changes the console makes: each is a `wacli chats <action>`.
 * WhatsApp syncs them to every linked device, so they change the account, not
 * just this machine, and safe mode refuses them.
 */
const CHAT_STATE_ACTIONS = new Set([
  'pin',
  'unpin',
  'mute',
  'unmute',
  'archive',
  'unarchive',
  'mark-unread',
]);

/**
 * How long a mute lasts, the way wacli spells it: whole hours, or `0` for
 * always. Narrower than wacli accepts on purpose: the console only offers a
 * handful of lengths, and nothing else needs to reach the command line.
 */
const MUTE_DURATION = /^(0|[1-9]\d{0,4}h)$/;

/**
 * The same budget as a read receipt, for the same reason: the daemon runs what
 * it is handed one at a time, so this is how long a send could wait behind it.
 */
const CHAT_STATE_TIMEOUT_MS = 10_000;

/** Test seam: the scan is cached module state, so suites must be able to clear it. */
export function resetChatPreviewCache(): void {
  resetRecentMessages();
}

/**
 * One line per chat from the shared scan of recent messages. wacli's chat
 * record carries only `last_message_ts` — no body — so the preview has to come
 * from the message table.
 *
 * Best-effort: a preview is a nicety, so a failure here must never cost the
 * operator their chat list.
 */
async function fetchChatPreviews(): Promise<Map<string, ChatPreview>> {
  const previews = new Map<string, ChatPreview>();
  let messages: UnifiedMessage[];
  try {
    messages = await fetchRecentMessages();
  } catch (err) {
    logger.warn('api', 'Chat previews unavailable', { err });
    return previews;
  }

  for (const msg of messages) {
    // wacli returns newest first, and reactions are not conversation content.
    if (!msg.chatJid || previews.has(msg.chatJid) || msg.reactionToId) continue;

    const text = messagePreviewText(msg);
    if (!text) continue;

    previews.set(msg.chatJid, { text, fromMe: msg.fromMe });
  }
  return previews;
}

function requireMutationPermission(req: Request, res: Response, next: NextFunction): void {
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

      const query = queryString(req, 'query');
      const limit = queryLimit(req);
      const archived = req.query.archived;
      const pinned = req.query.pinned;
      const muted = req.query.muted;
      const unread = req.query.unread;

      if (query) args.push('--query', query);
      if (limit) args.push('--limit', String(limit));
      if (archived === 'true') args.push('--archived');
      else if (archived === 'false') args.push('--no-archived');

      if (pinned === 'true') args.push('--pinned');
      else if (pinned === 'false') args.push('--no-pinned');

      if (muted === 'true') args.push('--muted');
      else if (muted === 'false') args.push('--no-muted');

      if (unread === 'true') args.push('--unread');
      else if (unread === 'false') args.push('--no-unread');

      const raw = await execWacli<RawChat[]>(args);
      const [previews, groupNames] = await Promise.all([fetchChatPreviews(), fetchGroupNames()]);
      const chats: UnifiedChat[] = (Array.isArray(raw) ? raw : []).map((rawChat) =>
        normalizeChat(rawChat, previews.get(rawChat.jid), groupNames.get(rawChat.jid))
      );

      // A row with no preview renders as a subtitle with nothing to say, so
      // coverage falling behind the page size is a visible defect rather than a
      // missing nicety. Saying so out loud once it affects most of the rail is
      // what turns "the list looks wrong" into a number worth acting on.
      const covered = chats.filter((chat) => chat.lastMessage !== null).length;
      const coverage = { chats: chats.length, covered, scanLimit: RECENT_SCAN_LIMIT };

      // Archived and muted chats are inactive by definition, so their last
      // messages sit outside any window of recent ones: thin coverage there is
      // the filter working, not a defect. Only the primary rail is a signal.
      const isPrimaryRail = !query && !pinned && !muted && !unread && archived !== 'true';

      if (isPrimaryRail && chats.length > 0 && covered * 2 < chats.length) {
        logger.warn('api', 'Most chat rows have no preview; raise RECENT_SCAN_LIMIT', coverage);
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
      const { chat, through } = req.body as { chat?: string; through?: unknown };

      if (!chat || typeof chat !== 'string') {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Field "chat" (JID) is required.',
        });
        return;
      }

      // Handed to the running daemon, which stays up. Under the default 30s, one
      // slow receipt could keep a send queued for most of half a minute; ten is
      // already generous for an operation whose only job is to tell WhatsApp
      // what the operator has already seen. When the daemon cannot take it,
      // `mark-read` runs exclusive instead: the daemon is killed before it
      // starts and respawned after, so there the budget is downtime.
      const markRead = (receipts: boolean, boundary?: string) =>
        processManager.runDelegated(async (lock) => {
          const args = ['chats', 'mark-read', '--chat', chat];
          if (receipts) args.push(MARK_READ_RECEIPTS);
          if (boundary) args.push(MARK_READ_THROUGH, boundary);
          return execWacli<Record<string, unknown> | null>(args, {
            allowMutation: true,
            timeoutMs: MARK_READ_TIMEOUT_MS,
            ...lock,
          });
        });

      // wacli wants the id exactly, and refuses one with surrounding space.
      const boundary =
        typeof through === 'string' && through !== '' && through === through.trim() &&
        (await wacliSupports('readBoundary'))
          ? through
          : undefined;
      let bounded = false;

      const markReadThrough = async (receipts: boolean) => {
        if (boundary) {
          try {
            const result = await markRead(receipts, boundary);
            bounded = true;
            return result;
          } catch (boundaryErr) {
            const refused = boundaryRefused(boundaryErr);
            if (!refused) throw boundaryErr;
            logger.warn('api', 'wacli would not mark read through that message; marking the whole chat', {
              chat,
              refused,
            });
          }
        }
        return markRead(receipts);
      };

      let result: Record<string, unknown> | null;
      try {
        try {
          result = await markReadThrough(!receiptsFlagUnknown);
        } catch (receiptsErr) {
          const refused = receiptsFlagUnknown ? null : receiptsRefused(receiptsErr);
          if (!refused) throw receiptsErr;
          if (refused === 'flag') receiptsFlagUnknown = true;
          logger.warn('api', 'wacli cannot mark read with receipts; using chat state instead', {
            chat,
            refused,
          });
          result = await markReadThrough(false);
        }
      } catch (markErr) {
        // A receipt that did not land is not a server fault, and nothing is
        // waiting on it — the UI clears the badge optimistically and never reads
        // this response. Reporting it as a 500 filed a best-effort action as an
        // incident, which is what put `Unhandled API error` in the log every
        // time WhatsApp was slow to answer.
        const message = markErr instanceof Error ? markErr.message : String(markErr);
        logger.warn('api', 'Could not mark chat read', { chat, err: markErr });

        res.json({
          success: true,
          data: { chat, unread: false, unreadCount: 0, marked: false, reason: message },
          error: null,
        });
        return;
      }

      res.json({
        success: true,
        data: {
          chat,
          unread: false,
          unreadCount: 0,
          marked: true,
          // How far it marked: through this message, or the whole chat.
          through: bounded ? boundary : null,
          // Nothing was stored to acknowledge, so only this machine's unread
          // state was cleared; no sender heard about it (wacli 0.22).
          localOnly: result?.local_only === true,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Pin, mute, archive or mark unread, and their inverses. Handed to the
   * running daemon (wacli 0.20+ takes them without blocking its send queue);
   * an older daemon refuses the hand-off and the command runs exclusive.
   *
   * Unlike a read receipt, a failure here is reported: the operator asked for
   * it, and the UI has to take back what it showed.
   */
  router.post('/chats/state', requireMutationPermission, async (req, res, next) => {
    try {
      const { chat, action, duration } = req.body as {
        chat?: unknown;
        action?: unknown;
        duration?: unknown;
      };

      if (typeof chat !== 'string' || chat === '' || chat !== chat.trim()) {
        res.status(400).json({ success: false, data: null, error: 'Field "chat" (JID) is required.' });
        return;
      }
      if (typeof action !== 'string' || !CHAT_STATE_ACTIONS.has(action)) {
        res.status(400).json({
          success: false,
          data: null,
          error: `Field "action" must be one of: ${[...CHAT_STATE_ACTIONS].join(', ')}.`,
        });
        return;
      }
      if (duration !== undefined && (action !== 'mute' || typeof duration !== 'string' || !MUTE_DURATION.test(duration))) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Field "duration" applies to mute only, in whole hours ("8h") or "0" for always.',
        });
        return;
      }

      const args = ['chats', action, '--chat', chat];
      // wacli's own default is forever too; saying so keeps the command line
      // honest in the log.
      if (action === 'mute') args.push('--duration', typeof duration === 'string' ? duration : '0');

      await processManager.runDelegated((lock) =>
        execWacli<Record<string, unknown> | null>(args, {
          allowMutation: true,
          timeoutMs: CHAT_STATE_TIMEOUT_MS,
          ...lock,
        })
      );

      logger.info('api', 'Chat state changed', { chat, action, duration });
      res.json({ success: true, data: { chat, action }, error: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
