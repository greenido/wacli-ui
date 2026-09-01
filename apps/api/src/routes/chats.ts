import { Router, type Request, type Response, type NextFunction } from 'express';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import { normalizeChat } from '../wacli/normalize.js';
import type { RawChat, UnifiedChat } from '../types.js';

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
      const chats: UnifiedChat[] = (Array.isArray(raw) ? raw : []).map(normalizeChat);

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
