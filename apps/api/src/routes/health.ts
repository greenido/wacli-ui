import { Router } from 'express';
import { execWacli, checkWacliInstalled } from '../wacli/commands.js';
import { normalizeDoctor } from '../wacli/normalize.js';
import { modeManager } from '../wacli/mode.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import type { MissionControlStatus, UnifiedDoctor } from '../types.js';

export function createHealthRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const installStatus = await checkWacliInstalled();
    let doctor: UnifiedDoctor | null = null;
    let doctorError: string | null = null;
    let wacliWorking: boolean;
    let statusSummary: MissionControlStatus['statusSummary'];
    let statusMessage: string | null;

    if (!installStatus.installed) {
      doctorError = installStatus.error;
      wacliWorking = false;
      statusSummary = 'not_installed';
      statusMessage = installStatus.error || 'wacli CLI binary is not installed or not in PATH.';
    } else {
      try {
        const rawDoctor = await execWacli<Record<string, unknown>>(['doctor']);
        doctor = normalizeDoctor(rawDoctor);

        if (!doctor.authenticated) {
          wacliWorking = false;
          statusSummary = 'not_authenticated';
          statusMessage = 'wacli is installed but WhatsApp session is not paired. Run "wacli auth" in terminal to pair.';
        } else if (processManager.getState() === 'failed' || processManager.getState() === 'logged_out') {
          wacliWorking = false;
          statusSummary = processManager.getState() === 'logged_out' ? 'not_authenticated' : 'daemon_error';
          statusMessage = processManager.getLastError() || `Sync daemon is in ${processManager.getState()} state.`;
        } else {
          wacliWorking = true;
          statusSummary = 'ok';
          statusMessage = 'wacli is installed and working normally.';
        }
      } catch (err: unknown) {
        doctorError = err instanceof Error ? err.message : String(err);
        wacliWorking = false;
        statusSummary = 'error';
        statusMessage = `wacli doctor error: ${doctorError}`;
      }
    }

    const status: MissionControlStatus = {
      readOnly: modeManager.isReadOnly(),
      processState: processManager.getState(),
      processPid: processManager.getPid(),
      heartbeatAgeSeconds: processManager.getHeartbeatAgeSeconds(),
      lastError: doctorError || processManager.getLastError() || installStatus.error,
      reconnectAttempts: processManager.getReconnectAttempts(),
      doctor,
      wacliInstalled: installStatus.installed,
      wacliWorking,
      wacliVersion: installStatus.version,
      wacliBinaryPath: installStatus.binPath,
      statusSummary,
      statusMessage,
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
