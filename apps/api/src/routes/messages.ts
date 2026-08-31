import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { normalizeMessage } from '../wacli/normalize.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

interface RawMessagesListResponse {
  fts?: boolean;
  messages: RawMessage[] | null;
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

      const messages: UnifiedMessage[] = rawList.map(normalizeMessage);

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

  return router;
}
