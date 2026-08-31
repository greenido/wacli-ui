import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { normalizeMessage } from '../wacli/normalize.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

interface RawSearchResponse {
  fts?: boolean;
  messages: RawMessage[] | null;
}

export function createSearchRouter(): Router {
  const router = Router();

  router.get('/search', async (req, res, next) => {
    try {
      const q = req.query.q as string | undefined;
      if (!q || !q.trim()) {
        res.json({ success: true, data: { query: '', fts: true, results: [] }, error: null });
        return;
      }

      const args = ['messages', 'search', q.trim()];

      const chat = req.query.chat as string | undefined;
      const limit = req.query.limit as string | undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;
      const type = req.query.type as string | undefined;

      if (chat) args.push('--chat', chat);
      if (limit) args.push('--limit', limit);
      if (before) args.push('--before', before);
      if (after) args.push('--after', after);
      if (type) args.push('--type', type);

      const raw = await execWacli<RawSearchResponse | RawMessage[]>(args);
      let rawList: RawMessage[] = [];
      let fts = true;

      if (Array.isArray(raw)) {
        rawList = raw;
      } else if (raw) {
        rawList = raw.messages || [];
        fts = raw.fts !== false;
      }

      const results: UnifiedMessage[] = rawList.map(normalizeMessage);

      res.json({
        success: true,
        data: {
          query: q,
          fts,
          results,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
