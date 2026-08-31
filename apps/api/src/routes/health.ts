import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { normalizeDoctor } from '../wacli/normalize.js';
import { modeManager } from '../wacli/mode.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import type { MissionControlStatus, UnifiedDoctor } from '../types.js';

export function createHealthRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    let doctor: UnifiedDoctor | null = null;
    let doctorError: string | null = null;

    try {
      const rawDoctor = await execWacli<Record<string, unknown>>(['doctor']);
      doctor = normalizeDoctor(rawDoctor);
    } catch (err: unknown) {
      doctorError = err instanceof Error ? err.message : String(err);
    }

    const status: MissionControlStatus = {
      readOnly: modeManager.isReadOnly(),
      processState: processManager.getState(),
      processPid: processManager.getPid(),
      heartbeatAgeSeconds: processManager.getHeartbeatAgeSeconds(),
      lastError: doctorError || processManager.getLastError(),
      reconnectAttempts: processManager.getReconnectAttempts(),
      doctor,
    };

    res.json({ success: true, data: status, error: null });
  });

  router.post('/daemon/restart', async (_req, res) => {
    try {
      await processManager.restart();
      res.json({
        success: true,
        data: {
          state: processManager.getState(),
          pid: processManager.getPid(),
        },
        error: null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, data: null, error: msg });
    }
  });

  router.post('/daemon/start', (_req, res) => {
    try {
      processManager.start();
      res.json({
        success: true,
        data: {
          state: processManager.getState(),
          pid: processManager.getPid(),
        },
        error: null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, data: null, error: msg });
    }
  });

  router.post('/daemon/stop', async (_req, res) => {
    try {
      await processManager.stop();
      res.json({
        success: true,
        data: {
          state: processManager.getState(),
          pid: processManager.getPid(),
        },
        error: null,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ success: false, data: null, error: msg });
    }
  });

  return router;
}
