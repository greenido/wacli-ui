import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
import { modeManager } from './mode.js';
import type { EventBridge } from '../ws/event-bridge.js';
import type { SleepState } from '../types.js';

/** The code a refused request carries, so a client can tell asleep from broken. */
export const ASLEEP_CODE = 'ASLEEP';

/**
 * Every /api route, by what it does while the app is asleep. A test walks the
 * app's registered routes and fails on any route missing from here, or in two
 * places, so a new route cannot quietly reach wacli from a sleeping app.
 */
export const SLEEP_ROUTES = {
  // Reads that reach wacli. Asleep, the console has stopped asking for these;
  // one that arrives anyway (a stale tab, a script) is refused, not served.
  refuse: [
    'GET /api/health',
    'GET /api/chats',
    'GET /api/messages',
    'GET /api/messages/export',
    'GET /api/history/coverage',
    'GET /api/contacts/show',
    'GET /api/groups',
    'GET /api/search',
  ],
  // Writes that reach wacli. These are the operator acting, which is what
  // waking is for, so they wake the app and then run.
  wake: [
    'POST /api/send/text',
    'POST /api/send/file',
    'POST /api/send/react',
    'POST /api/chats/mark-read',
    'POST /api/contacts/alias',
    'POST /api/history/backfill',
    'POST /api/media/download',
    'POST /api/daemon/restart',
  ],
  // Mission Control's own state, and the scheduler, which is the one thing
  // sleep keeps doing: a resend is the scheduler's own send.
  allow: [
    'GET /api/mode',
    'POST /api/mode',
    'GET /api/settings',
    'GET /api/sleep',
    'POST /api/sleep',
    'GET /api/tags',
    'POST /api/tags',
    'POST /api/tags/rename',
    'POST /api/tags/delete',
    'POST /api/messages/bookmark',
    'GET /api/activity',
    'GET /api/send/scheduled',
    'POST /api/send/schedule',
    'POST /api/send/schedule-file',
    'DELETE /api/send/scheduled/:id',
    'POST /api/send/scheduled/:id/resend',
    'POST /api/send/scheduled/:id/discard',
    // Serves what is already on disk, and makes its own call about the wacli
    // download it would otherwise fall back to (see routes/media.ts).
    'GET /api/media/content',
  ],
} as const satisfies Record<string, readonly string[]>;

/** Answers a request that would have to reach wacli, while the app is asleep. */
export function refuseAsleep(res: Response): void {
  res.status(409).json({
    success: false,
    data: null,
    error: 'Mission Control is asleep. Wake it to read from WhatsApp.',
    code: ASLEEP_CODE,
  });
}

/**
 * "METHOD /api/path" for a request, spelled the way the table spells it.
 *
 * Express answers HEAD with the GET handler, and matches paths regardless of
 * case or a trailing slash, so the key does too. Otherwise `HEAD /api/Chats/`
 * would reach wacli from a sleeping app by walking past the table.
 */
function routeKey(req: Request): string {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const path = `${req.baseUrl}${req.path}`.toLowerCase().replace(/\/+$/, '');
  return `${method} ${path}`;
}

/**
 * Enforces SLEEP_ROUTES. Mounted on /api ahead of every router, so no route
 * decides for itself, except media content (see above).
 */
export function sleepGate(sleep: Pick<SleepController, 'isAsleep' | 'wake'>): RequestHandler {
  const refused = new Set<string>(SLEEP_ROUTES.refuse);
  const waking = new Set<string>(SLEEP_ROUTES.wake);

  return (req: Request, res: Response, next: NextFunction) => {
    if (!sleep.isAsleep()) {
      next();
      return;
    }

    const key = routeKey(req);
    if (refused.has(key)) {
      refuseAsleep(res);
      return;
    }
    if (waking.has(key)) {
      sleep.wake(key);
    }
    next();
  };
}

/** What sleep needs from the process manager. */
export interface SleepDaemon {
  stop(): Promise<void>;
  startSoon(): void;
}

export interface SleepControllerOptions {
  daemon: SleepDaemon;
  bridge?: Pick<EventBridge, 'broadcast'>;
  /** `--no-sync`: waking must not start a daemon that was never meant to run. */
  syncDisabled?: boolean;
}

/**
 * Sleep mode: the daemon stopped, only scheduled messages going out.
 *
 * The scheduler needs nothing from here. Its sends already run exclusive,
 * taking the store with no daemon up, and the process manager now leaves a
 * daemon nobody wants where it is. So sleeping is only three things in a fixed
 * order: record it, tell every tab, stop the daemon. Recording comes first, so
 * a crash halfway through still comes back asleep.
 */
export class SleepController {
  constructor(private readonly opts: SleepControllerOptions) {}

  public state(): SleepState {
    return modeManager.getSleepState();
  }

  public isAsleep(): boolean {
    return modeManager.isSleeping();
  }

  public async sleep(reason: string): Promise<SleepState> {
    if (modeManager.isSleeping()) return modeManager.getSleepState();

    const state = modeManager.setSleeping(true);
    logger.info('process', 'Sleep mode on', { reason });
    this.announce(state);
    await this.opts.daemon.stop();
    return state;
  }

  /**
   * Every wake names its reason in the log. Nothing automatic is supposed to
   * end sleep, and when something does anyway, this line is how to find it.
   */
  public wake(reason: string): SleepState {
    if (!modeManager.isSleeping()) return modeManager.getSleepState();

    const state = modeManager.setSleeping(false);
    logger.info('process', 'Sleep mode off', { reason });
    this.announce(state);
    if (!this.opts.syncDisabled) {
      this.opts.daemon.startSoon();
    }
    return state;
  }

  private announce(state: SleepState): void {
    this.opts.bridge?.broadcast({
      type: 'sleep.changed',
      data: state,
      ts: new Date().toISOString(),
    });
  }
}
