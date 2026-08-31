import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { normalizeMessage } from '../wacli/normalize.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

interface RawMessagesListResponse {
  fts?: boolean;
  messages: RawMessage[] | null;
}

// In-memory / persistent star overrides map: msgId -> boolean
const starOverrides = new Map<string, boolean>();

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
        if (norm.msgId && starOverrides.has(norm.msgId)) {
          norm.starred = starOverrides.get(norm.msgId)!;
        }
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

  // POST /api/messages/star - toggle star status of a message
  router.post('/messages/star', async (req, res, next) => {
    try {
      const { chat, id, starred } = req.body as {
        chat?: string;
        id?: string;
        starred?: boolean;
      };

      if (!chat || !id) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Both "chat" and "id" are required.',
        });
        return;
      }

      const isStarred = starred !== undefined ? Boolean(starred) : true;
      starOverrides.set(id, isStarred);

      res.json({
        success: true,
        data: {
          chat,
          id,
          starred: isStarred,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
