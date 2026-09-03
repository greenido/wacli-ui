import { Router, type Request, type Response, type NextFunction } from 'express';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { normalizeCoverage } from '../wacli/normalize.js';
import { logger } from '../logger.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import type { RawChatCoverage } from '../types.js';

interface RawCoverageResponse {
  coverage: RawChatCoverage[] | null;
}

/**
 * How many messages one backfill request asks the primary device for, and how
 * long to wait for it. wacli's own defaults wait a full minute per request;
 * these are tightened because the request holds the store lock, which every
 * read in the console is also queueing for.
 */
const BACKFILL_DEFAULT_COUNT = 50;
const BACKFILL_MAX_COUNT = 500;
const BACKFILL_WAIT = '30s';
const BACKFILL_TIMEOUT_MS = 60_000;

/**
 * A backfill reaches the phone and writes the local store, so it is a mutation
 * even though nothing is sent to another person — the same bar `chats
 * mark-read` clears.
 */
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
      error: 'Safe read-only mode is active. History backfill writes the local store and is disabled.',
    });
    return;
  }

  next();
}

export function createHistoryRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  // GET /api/history/coverage - how far back the local archive actually reaches
  router.get('/history/coverage', async (req, res, next) => {
    try {
      const chat = req.query.chat as string | undefined;
      const args = ['history', 'coverage', '--limit', chat ? '1' : '100'];
      if (chat) args.push('--chat', chat);

      const raw = await execWacli<RawCoverageResponse | RawChatCoverage[]>(args);
      const rows = Array.isArray(raw) ? raw : (raw?.coverage ?? []);

      res.json({
        success: true,
        data: rows.map(normalizeCoverage),
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/history/backfill - ask the primary device for older messages
  router.post('/history/backfill', requireMutationPermission, async (req, res, next) => {
    try {
      const { chat, count } = req.body as { chat?: string; count?: number };

      if (!chat || typeof chat !== 'string') {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Field "chat" (JID) is required.',
        });
        return;
      }

      const requested = Number(count ?? BACKFILL_DEFAULT_COUNT);
      const messageCount = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), BACKFILL_MAX_COUNT)
        : BACKFILL_DEFAULT_COUNT;

      logger.info('api', `Requesting ${messageCount} older messages for ${chat} from the primary device`);

      const result = await processManager.executeExclusive(async () =>
        execWacli<Record<string, unknown>>(
          [
            'history',
            'backfill',
            '--chat',
            chat,
            '--count',
            String(messageCount),
            '--requests',
            '1',
            '--wait',
            BACKFILL_WAIT,
          ],
          { allowMutation: true, timeoutMs: BACKFILL_TIMEOUT_MS }
        )
      );

      res.json({
        success: true,
        data: { chat, requested: messageCount, details: result },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
