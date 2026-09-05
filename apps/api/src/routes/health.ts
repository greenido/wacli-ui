import { Router } from 'express';
import { execWacli, checkWacliInstalled } from '../wacli/commands.js';
import { normalizeDoctor } from '../wacli/normalize.js';
import { modeManager } from '../wacli/mode.js';
import { isStoreLockMessage, parseLockHolderPid } from '../wacli/store-lock.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import type { MissionControlStatus, UnifiedDoctor } from '../types.js';

/** How long a `wacli doctor` result is reused before probing the store again. */
export const DOCTOR_CACHE_TTL_MS = 10_000;

export function createHealthRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  // `wacli doctor` opens the store, so every health poll competes with the sync
  // daemon for the lock — and each open tab polls on its own timer. Caching the
  // result, and collapsing simultaneous polls into one probe, keeps a wall of
  // dashboards from generating a wall of store access.
  let doctorCache: { at: number; doctor: UnifiedDoctor } | null = null;
  let doctorInFlight: Promise<UnifiedDoctor> | null = null;

  async function probeDoctor(fresh: boolean): Promise<UnifiedDoctor> {
    if (fresh) {
      doctorCache = null;
    } else if (doctorCache && Date.now() - doctorCache.at < DOCTOR_CACHE_TTL_MS) {
      return doctorCache.doctor;
    }

    if (doctorInFlight) {
      return doctorInFlight;
    }

    doctorInFlight = (async () => {
      try {
        const rawDoctor = await execWacli<Record<string, unknown>>(['doctor']);
        const normalized = normalizeDoctor(rawDoctor);
        doctorCache = { at: Date.now(), doctor: normalized };
        return normalized;
      } finally {
        doctorInFlight = null;
      }
    })();

    return doctorInFlight;
  }

  /**
   * A doctor probe run alongside our own daemon is refused by that daemon's
   * store lock and reports `locked_by_other_process` — a statement about the
   * probe, not about the daemon. When the lock belongs to us, the daemon's own
   * connected/disconnected events are the authority.
   */
  function reconcileWithDaemon(doctor: UnifiedDoctor): UnifiedDoctor {
    if (doctor.connectionState !== 'locked_by_other_process') {
      return doctor;
    }
    if (processManager.getPid() === null) {
      // Nothing of ours is running, so somebody else really does hold it.
      return doctor;
    }
    if (processManager.isDaemonConnected()) {
      return { ...doctor, connected: true, connectionState: 'connected' };
    }
    return { ...doctor, connected: false, connectionState: 'connecting' };
  }

  /**
   * The PID holding the store lock, when it is not one of ours.
   *
   * `wacli doctor` names the lock holder on every probe, so this is a direct
   * answer available whenever the store is locked. The checks below it needed
   * one of our own commands to have already failed with a lock error so a PID
   * could be regexed out of the message, or the daemon to be sitting in
   * `stopped`/`failed` — neither of which holds during the restart loop an
   * external lock holder actually produces, where the state is `restarting`
   * and `getPid()` is null. That combination reported "sync daemon is starting"
   * indefinitely, which is the one diagnosis this route exists to avoid.
   *
   * A PID we spawned ourselves is never external, even once it has exited: the
   * doctor result is cached for a few seconds and can still name the daemon
   * that just died.
   */
  function externalLockHolderPid(doctor: UnifiedDoctor): number | null {
    if (!doctor.lockHeld || doctor.lockOwnerPid === null) return null;
    if (processManager.hasSpawnedPid(doctor.lockOwnerPid)) return null;
    return doctor.lockOwnerPid;
  }

  router.get('/health', async (req, res) => {
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';
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
        doctor = reconcileWithDaemon(await probeDoctor(fresh));

        if (!doctor.authenticated) {
          wacliWorking = false;
          statusSummary = 'not_authenticated';
          statusMessage = 'wacli is installed but WhatsApp session is not paired. Run "wacli auth" in terminal to pair.';
        } else if (processManager.getState() === 'failed' || processManager.getState() === 'logged_out') {
          wacliWorking = false;
          statusSummary = processManager.getState() === 'logged_out' ? 'not_authenticated' : 'daemon_error';
          statusMessage = processManager.getLastError() || `Sync daemon is in ${processManager.getState()} state.`;
        } else {
          const processState = processManager.getState();
          const daemonPid = processManager.getPid();
          const lastError = processManager.getLastError();
          const lockPidFromError = lastError && isStoreLockMessage(lastError)
            ? parseLockHolderPid(lastError)
            : null;

          const externalPid = externalLockHolderPid(doctor);

          if (externalPid !== null) {
            wacliWorking = false;
            statusSummary = 'store_locked_external';
            statusMessage = `Another wacli process (pid ${externalPid}) holds the store lock. Stop it or restart the sync daemon.`;
          } else if (
            lockPidFromError &&
            daemonPid &&
            lockPidFromError !== daemonPid
          ) {
            wacliWorking = false;
            statusSummary = 'store_locked_external';
            statusMessage = `Another wacli process (pid ${lockPidFromError}) holds the store lock. Stop it or restart the sync daemon.`;
          } else if (
            doctor.lockHeld &&
            (processState === 'stopped' || processState === 'failed') &&
            doctor.connectionState === 'locked_by_other_process'
          ) {
            wacliWorking = false;
            statusSummary = 'store_locked_external';
            statusMessage = 'Another wacli process holds the store lock. Stop other wacli instances or restart the sync daemon.';
          } else if (processState === 'starting' || processState === 'restarting') {
            wacliWorking = false;
            statusSummary = 'sync_starting';
            statusMessage = 'Sync daemon is starting. Read queries will be available shortly.';
          } else {
            wacliWorking = true;
            statusSummary = 'ok';
            statusMessage = 'wacli is installed and working normally.';
          }
        }
      } catch (err: unknown) {
        doctorError = err instanceof Error ? err.message : String(err);
        wacliWorking = false;
        statusSummary = 'error';
        statusMessage = `wacli doctor error: ${doctorError}`;
      }
    }

    const lastError = doctorError || processManager.getLastError() || installStatus.error;
    // The LOCK file is the authority on who holds it, and doctor reads it on
    // every probe. The error text is the fallback for a wacli old enough not to
    // report `lock_owner_pid`, and for the case where doctor itself failed.
    const storeLockHolderPid =
      doctor?.lockOwnerPid ??
      (lastError && isStoreLockMessage(lastError) ? parseLockHolderPid(lastError) : null);

    const status: MissionControlStatus = {
      readOnly: modeManager.isReadOnly(),
      processState: processManager.getState(),
      processPid: processManager.getPid(),
      heartbeatAgeSeconds: processManager.getHeartbeatAgeSeconds(),
      lastError,
      reconnectAttempts: processManager.getReconnectAttempts(),
      doctor,
      wacliInstalled: installStatus.installed,
      wacliWorking,
      wacliVersion: installStatus.version,
      wacliBinaryPath: installStatus.binPath,
      statusSummary,
      statusMessage,
      storeLockHeld: doctor?.lockHeld ?? false,
      storeLockHolderPid,
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
