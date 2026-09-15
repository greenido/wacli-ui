import { Router, type NextFunction, type Request, type Response } from 'express';
import type { SleepController } from '../wacli/sleep.js';

/** A reason is a label for the log ("open chat"), not a message. */
const MAX_REASON_LENGTH = 64;

/**
 * Sleep stops the daemon, so it takes the same custom header as the other
 * local writes: a stray script pointed at localhost should not be able to put
 * the console to sleep.
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

export function createSleepRouter(sleep: SleepController): Router {
  const router = Router();

  router.get('/sleep', (_req, res) => {
    res.json({ success: true, data: sleep.state(), error: null });
  });

  router.post('/sleep', requireUiRequest, async (req, res) => {
    const { sleeping, reason } = (req.body ?? {}) as { sleeping?: unknown; reason?: unknown };
    if (typeof sleeping !== 'boolean') {
      res.status(400).json({ success: false, data: null, error: 'Field "sleeping" must be a boolean.' });
      return;
    }

    const label =
      typeof reason === 'string' && reason.trim()
        ? reason.trim().slice(0, MAX_REASON_LENGTH)
        : sleeping
          ? 'sleep requested'
          : 'wake requested';

    const state = sleeping ? await sleep.sleep(label) : sleep.wake(label);
    res.json({ success: true, data: state, error: null });
  });

  return router;
}
