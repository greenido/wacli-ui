import { Router } from 'express';
import type { SleepController } from '../wacli/sleep.js';

/** A reason is a label for the log ("open chat"), not a message. */
const MAX_REASON_LENGTH = 64;

export function createSleepRouter(sleep: SleepController): Router {
  const router = Router();

  router.get('/sleep', (_req, res) => {
    res.json({ success: true, data: sleep.state(), error: null });
  });

  router.post('/sleep', async (req, res) => {
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
