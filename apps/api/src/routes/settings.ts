import { Router } from 'express';
import { modeManager } from '../wacli/mode.js';
import { logger } from '../logger.js';
import type { EventBridge } from '../ws/event-bridge.js';

export function createSettingsRouter(eventBridge?: EventBridge): Router {
  const router = Router();

  // Mode endpoints
  router.get('/mode', (_req, res) => {
    res.json({ success: true, data: { readOnly: modeManager.isReadOnly() }, error: null });
  });

  router.post('/mode', (req, res) => {
    const { readOnly } = req.body as { readOnly?: boolean };
    if (typeof readOnly !== 'boolean') {
      res.status(400).json({ success: false, data: null, error: 'Field "readOnly" must be a boolean.' });
      return;
    }

    modeManager.setReadOnly(readOnly);
    logger.info('api', 'Read-only mode changed', { readOnly });

    if (eventBridge) {
      eventBridge.broadcast({
        type: 'connection.status',
        data: { state: 'connected', reason: `Mode updated: readOnly=${readOnly}` },
        ts: new Date().toISOString(),
      });
    }

    res.json({ success: true, data: { readOnly: modeManager.isReadOnly() }, error: null });
  });

  // Settings endpoints
  router.get('/settings', (_req, res) => {
    const settings = modeManager.getSettings();
    res.json({
      success: true,
      data: {
        ...settings,
        currentLogFile: logger.getFilePath() ?? undefined,
      },
      error: null,
    });
  });

  router.post('/settings', (req, res) => {
    const body = req.body as { storeDir?: string; account?: string; readOnly?: boolean };
    const updated = modeManager.updateSettings({
      storeDir: body.storeDir || undefined,
      account: body.account || undefined,
      readOnly: body.readOnly !== undefined ? Boolean(body.readOnly) : undefined,
    });

    res.json({ success: true, data: updated, error: null });
  });

  return router;
}
