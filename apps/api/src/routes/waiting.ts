import { Router, type Request, type Response, type NextFunction } from 'express';
import { chatDisplayName } from '../wacli/normalize.js';
import { fetchRecentMessages } from '../wacli/recent-messages.js';
import { findWaiting, waitingStore, type WaitingStore } from '../wacli/waiting.js';
import type { UnifiedMessage } from '../types.js';
import { queryLimit } from './query.js';

export interface WaitingItem {
  chatJid: string;
  chatName: string;
  /** The operator's message that has had no answer since. */
  message: UnifiedMessage;
  /** Set when this row is back from a reminder that has come due. */
  snoozedUntil: string | null;
}

const DEFAULT_WAITING_LIMIT = 100;
const MAX_WAITING_LIMIT = 200;

/** Further out than this is not a reminder, it is a dismissal with extra steps. */
const MAX_SNOOZE_MS = 366 * 24 * 60 * 60 * 1000;

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, data: null, error });
}

/** `chat` and `id` from a mutation's body, or null after answering 400. */
function target(req: Request, res: Response): { chat: string; id: string } | null {
  const { chat, id } = (req.body ?? {}) as { chat?: unknown; id?: unknown };
  if (typeof chat !== 'string' || !chat || typeof id !== 'string' || !id) {
    badRequest(res, 'Both "chat" and "id" are required.');
    return null;
  }
  return { chat, id };
}

/**
 * WAITING: the operator's messages that reached the other phone and have had
 * no reply since.
 *
 * Worked out on each read from the same scan of recent messages the chat rail
 * uses, so it costs no wacli subprocess of its own. Dismissing and snoozing
 * are Mission Control's own state, like bookmarks: they stay open in safe
 * read-only mode, and nothing about them reaches WhatsApp.
 */
export function createWaitingRouter(store: WaitingStore = waitingStore): Router {
  const router = Router();

  router.get('/waiting', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = Math.min(queryLimit(req) ?? DEFAULT_WAITING_LIMIT, MAX_WAITING_LIMIT);
      const candidates = findWaiting(await fetchRecentMessages());
      const marks = store.marksFor(candidates.map((m) => m.msgId));
      const now = new Date();

      let snoozed = 0;
      const items: WaitingItem[] = [];
      for (const message of candidates) {
        const mark = marks.get(message.msgId);
        if (store.isHidden(mark, now)) {
          if (!mark?.dismissed) snoozed += 1;
          continue;
        }
        items.push({
          chatJid: message.chatJid,
          chatName: chatDisplayName(message.chatJid, message.chatName),
          message,
          snoozedUntil: mark?.snoozedUntil ?? null,
        });
      }

      res.json({
        success: true,
        data: { items: items.slice(0, limit), total: items.length, snoozed },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/waiting/dismiss', (req: Request, res: Response, next: NextFunction) => {
    const t = target(req, res);
    if (!t) return;
    try {
      store.dismiss(t.id, t.chat);
      res.json({ success: true, data: { ...t, dismissed: true }, error: null });
    } catch (err) {
      next(err);
    }
  });

  router.post('/waiting/snooze', (req: Request, res: Response, next: NextFunction) => {
    const t = target(req, res);
    if (!t) return;

    const { until } = req.body as { until?: unknown };
    const at = typeof until === 'string' ? Date.parse(until) : NaN;
    const now = Date.now();
    if (Number.isNaN(at) || at <= now || at - now > MAX_SNOOZE_MS) {
      badRequest(res, '"until" must be a date and time within the next year.');
      return;
    }

    try {
      const snoozedUntil = new Date(at).toISOString();
      store.snooze(t.id, t.chat, snoozedUntil);
      res.json({ success: true, data: { ...t, snoozedUntil }, error: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
