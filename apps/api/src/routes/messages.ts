import { Router, type Request, type Response, type NextFunction } from 'express';
import { execWacli } from '../wacli/commands.js';
import { bookmarkStore } from '../wacli/bookmarks.js';
import { normalizeMessage } from '../wacli/normalize.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

interface RawMessagesListResponse {
  fts?: boolean;
  messages: RawMessage[] | null;
}

/**
 * Bookmarks are local-only state, so unlike a send or a chat mutation they are
 * still allowed while safe read-only mode is on: nothing reaches WhatsApp or
 * the wacli store. The custom header is still required, to keep stray scripts
 * pointed at localhost from writing here.
 */
function requireUiRequest(req: Request, res: Response, next: NextFunction): void {
  const customHeader = req.headers['x-mission-control-request'];
  if (!customHeader && process.env.NODE_ENV !== 'test') {
    res.status(400).json({
      success: false,
      data: null,
      error: 'Missing required "X-Mission-Control-Request: 1" header.',
    });
    return;
  }
  next();
}

export function createMessagesRouter(): Router {
  const router = Router();

  router.get('/messages', async (req, res, next) => {
    try {
      const args = ['messages', 'list'];

      const chat = req.query.chat as string | undefined;
      const limit = req.query.limit as string | undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;
      const asc = req.query.asc;

      if (chat) args.push('--chat', chat);
      if (limit) args.push('--limit', limit);
      if (before) args.push('--before', before);
      if (after) args.push('--after', after);
      if (asc === 'true') args.push('--asc');

      const raw = await execWacli<RawMessagesListResponse | RawMessage[]>(args);
      let rawList: RawMessage[] = [];

      if (Array.isArray(raw)) {
        rawList = raw;
      } else if (raw && Array.isArray(raw.messages)) {
        rawList = raw.messages;
      }

      const messages: UnifiedMessage[] = rawList.map((m) => {
        const norm = normalizeMessage(m);
        norm.bookmarked = Boolean(norm.msgId) && bookmarkStore.has(norm.msgId);
        return norm;
      });

      res.json({
        success: true,
        data: {
          messages,
          hasMore: messages.length >= Number(limit || 50),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/messages/bookmark - toggle this machine's local bookmark
  router.post('/messages/bookmark', requireUiRequest, (req: Request, res: Response) => {
    const { chat, id, bookmarked } = req.body as {
      chat?: string;
      id?: string;
      bookmarked?: boolean;
    };

    if (!chat || !id) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'Both "chat" and "id" are required.',
      });
      return;
    }

    const next = bookmarked !== undefined ? Boolean(bookmarked) : true;
    bookmarkStore.set(id, chat, next);

    res.json({
      success: true,
      data: { chat, id, bookmarked: next },
      error: null,
    });
  });

  return router;
}
