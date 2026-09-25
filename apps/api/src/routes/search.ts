import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { normalizeMessage } from '../wacli/normalize.js';
import { fetchGroupNames, withGroupSubject } from '../wacli/group-names.js';
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

      const args = ['messages', 'search'];

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

      // Last, behind `--`, because a query is text however it starts. As a bare
      // operand, "-x" reached wacli as an unknown option and "--help" as a
      // request for its usage, so the search failed instead of running.
      args.push('--', q.trim());

      const [raw, groupNames] = await Promise.all([
        execWacli<RawSearchResponse | RawMessage[]>(args),
        fetchGroupNames(),
      ]);
      let rawList: RawMessage[] = [];
      let fts = true;

      if (Array.isArray(raw)) {
        rawList = raw;
      } else if (raw) {
        rawList = raw.messages || [];
        fts = raw.fts !== false;
      }

      // A hit's chat name titles the thread it opens, so a group's has to be
      // its subject rather than the member wacli stamped on the message.
      const results: UnifiedMessage[] = rawList.map((rawMsg) =>
        withGroupSubject(normalizeMessage(rawMsg), groupNames)
      );

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
