import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { normalizeChat } from '../wacli/normalize.js';
import type { RawChat, UnifiedChat } from '../types.js';

export function createChatsRouter(): Router {
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
      const chats: UnifiedChat[] = (Array.isArray(raw) ? raw : []).map(normalizeChat);

      res.json({ success: true, data: chats, error: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
