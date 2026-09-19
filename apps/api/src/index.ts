import './load-env.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { accessPolicy, isAllowedHost, isAllowedOrigin, type AccessPolicy } from './net/loopback.js';
import { WacliProcessManager } from './wacli/process-manager.js';
import { eventBridge, EventBridge } from './ws/event-bridge.js';
import { createHealthRouter } from './routes/health.js';
import { createSettingsRouter } from './routes/settings.js';
import { createWebhookRouter } from './routes/webhook.js';
import { createChatsRouter } from './routes/chats.js';
import { createMessagesRouter } from './routes/messages.js';
import { createSearchRouter } from './routes/search.js';
import { createHistoryRouter } from './routes/history.js';
import { createContactsRouter } from './routes/contacts.js';
import { createSendRouter } from './routes/send.js';
import { createMediaRouter } from './routes/media.js';
import { createSleepRouter } from './routes/sleep.js';
import { modeManager } from './wacli/mode.js';
import { scheduler } from './wacli/scheduler.js';
import { SleepController, sleepGate } from './wacli/sleep.js';
import { StoreLockedError } from './wacli/store-lock.js';
import {
  initDatabase,
  closeDatabase,
  DatabaseInUseError,
  DatabaseUnavailableError,
  resolveDbPath,
} from './db/index.js';
import { migrateJsonStores } from './db/migrate-json.js';
import { activityStore } from './wacli/activity.js';

export const PORT = Number(process.env.PORT ?? 3002);
export const HOST = '127.0.0.1';

export function findWebDistDir(): string | null {
  if (process.env.STATIC_WEB_DIR && fs.existsSync(process.env.STATIC_WEB_DIR)) {
    return process.env.STATIC_WEB_DIR;
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(__dirname, '../web/dist'),
    path.resolve(__dirname, '../../apps/web/dist'),
    path.resolve(process.cwd(), 'apps/web/dist'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }
  return null;
}

/**
 * A request the operator is waiting on should not take this long. Past it the
 * line is promoted so a slow read stands out without raising the log level.
 */
const SLOW_REQUEST_MS = 1_500;

/** How long a shutdown waits on connections before it stops being polite. */
const SHUTDOWN_GRACE_MS = 5_000;

/** Query params are usually the only thing separating two identical lines. */
function formatQuery(query: Request['query']): string | undefined {
  const entries = Object.entries(query);
  if (entries.length === 0) return undefined;

  return entries
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join('&');
}

/**
 * What a caller is told when its request is refused before any route runs.
 * The JSON parser's own message can quote the body back — the text of a
 * message being sent, say — so it is neither returned nor logged.
 */
const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'The request body is not valid JSON.',
  'entity.too.large': 'The request body is too large.',
};

/**
 * The 4xx a library put on an error it raised about the request itself, or
 * null. `expose` is how http-errors marks one as the caller's fault, so an
 * error that merely has a `status` of its own is not taken at its word.
 */
function clientErrorStatus(err: unknown): number | null {
  const { status, expose } = (err ?? {}) as { status?: unknown; expose?: unknown };
  return typeof status === 'number' && status >= 400 && status < 500 && expose === true
    ? status
    : null;
}

/**
 * One line per API call: verb, path, query, status, duration. This is the log
 * that answers "did the UI even ask for that, and what came back?" — where most
 * debugging starts, and the one thing the console had no record of at all.
 *
 * Static assets are skipped: they are the same handful of files on every reload
 * and would bury the calls that carry meaning.
 */
function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/internal')) {
    next();
    return;
  }

  const startedAt = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const fields = {
      status: res.statusCode,
      durationMs,
      query: formatQuery(req.query),
    };
    const message = `${req.method} ${req.path}`;

    if (res.statusCode >= 500) {
      logger.error('http', message, fields);
    } else if (res.statusCode >= 400 || durationMs >= SLOW_REQUEST_MS) {
      logger.warn('http', message, fields);
    } else {
      logger.info('http', message, fields);
    }
  });

  next();
}

export function createApp(
  processManager: WacliProcessManager,
  bridge: EventBridge = eventBridge,
  access: AccessPolicy = accessPolicy({ port: PORT })
): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // A Host this machine does not answer to is DNS rebinding: somebody else's
  // name, pointed at this port after their page loaded.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isAllowedHost(req.headers.host, access)) {
      res.status(403).json({
        success: false,
        data: null,
        error: 'Requests must address this machine by a local name.',
        code: 'FORBIDDEN_HOST',
      });
      return;
    }
    next();
  });

  // Refused outright rather than merely left without CORS headers: a simple
  // cross-origin POST still runs when the browser only hides its answer.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (isAllowedOrigin(origin, access)) {
      next();
      return;
    }
    logger.warn('http', 'Refused a request from another page', {
      origin,
      route: `${req.method} ${req.path}`,
    });
    res.status(403).json({
      success: false,
      data: null,
      error: 'Only pages served by Mission Control may call it.',
      code: 'FORBIDDEN_ORIGIN',
    });
  });

  // Every origin still here is allowed. The headers matter only when the UI
  // calls across origins, which it does only when VITE_API_URL points it here.
  app.use(cors({ origin: (origin, callback) => callback(null, isAllowedOrigin(origin, access)) }));

  app.use(requestLogger);

  // Raw body parser specifically for internal webhook HMAC verification
  app.use('/internal/wacli', express.raw({
    type: '*/*',
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }));

  // JSON body parser for REST API. WhatsApp allows 65,536 characters in a
  // message; in Hebrew that is 128 KB of UTF-8, so the old 64 KB limit refused
  // a long message with a 500 before any route saw it.
  app.use('/api', express.json({ limit: '512kb' }));

  const sleep = new SleepController({
    daemon: processManager,
    bridge,
    syncDisabled: process.env.WACLI_DISABLE_SYNC === '1',
  });

  // Ahead of every router: asleep, reads that would reach wacli are refused
  // and writes that would reach it wake the app first. See SLEEP_ROUTES.
  app.use('/api', sleepGate(sleep));

  // Mount routers
  app.use('/api', createHealthRouter(processManager));
  app.use('/api', createSettingsRouter(bridge));
  app.use('/api', createSleepRouter(sleep));
  app.use('/api', createChatsRouter(processManager));
  app.use('/api', createMessagesRouter());
  app.use('/api', createSearchRouter());
  app.use('/api', createHistoryRouter(processManager));
  app.use('/api', createContactsRouter(processManager));
  app.use('/api', createSendRouter(processManager));
  app.use('/api', createMediaRouter());
  app.use('/internal/wacli', createWebhookRouter(processManager, bridge));

  // Serve static UI assets if built
  const staticWebDir = findWebDistDir();
  if (staticWebDir) {
    app.use(express.static(staticWebDir));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/internal')) {
        res.sendFile(path.join(staticWebDir, 'index.html'));
        return;
      }
      next();
    });
  }

  // Global Error Handler
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    // The route that failed is the first thing you want to know, and the only
    // thing the error itself cannot tell you.
    const route = `${req.method} ${req.path}`;

    if (err instanceof StoreLockedError) {
      logger.warn('api', 'Store locked', { route, lockHolderPid: err.lockHolderPid, err });
      res.status(503).json({
        success: false,
        data: null,
        error: err.message,
        code: err.code,
        lockHolderPid: err.lockHolderPid,
      });
      return;
    }

    // A request the caller got wrong — malformed JSON, a body over the limit —
    // arrives with its own 4xx from the library that refused it. Answering 500
    // told the caller to retry what could only fail the same way, and logged
    // an ERROR for something that was never the server's fault.
    const clientStatus = clientErrorStatus(err);
    if (clientStatus !== null) {
      const { type, headers } = err as { type?: string; headers?: Record<string, string> };
      logger.warn('api', 'Refused a request it could not use', { route, status: clientStatus, type });
      if (headers) res.set(headers);
      res.status(clientStatus).json({
        success: false,
        data: null,
        error: (type && CLIENT_ERROR_MESSAGES[type]) ?? http.STATUS_CODES[clientStatus] ?? 'Bad request',
      });
      return;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('api', 'Unhandled API error', { route, err });
    res.status(500).json({ success: false, data: null, error: errorMsg });
  });

  return app;
}

export interface ServerInstance {
  server: http.Server;
  app: express.Express;
  processManager: WacliProcessManager;
}

/** Everything a shutdown has to put down, narrowed so a test can stand it up. */
export interface ShutdownDeps {
  server: Pick<http.Server, 'close'>;
  processManager: Pick<WacliProcessManager, 'stop'>;
  bridge: Pick<EventBridge, 'close'>;
  /** The scheduler's timer, which keeps the event loop alive on its own. */
  jobs: { stop: () => void };
  /** What "done" means. Separated so this is testable without leaving. */
  exit: () => void;
  graceMs?: number;
}

/**
 * Puts the process down in an order that actually reaches its own last line.
 *
 * `http.Server.close()` waits for every connection still standing, and an
 * upgraded WebSocket closes only when told to — so with a browser tab open its
 * callback never ran, `exit` never fired, and Ctrl+C did nothing until it was
 * pressed a second time. The scheduler's interval holds the loop open the same
 * way. Both go first, and the order is the point: releasing them after
 * `server.close()` would be releasing them after the wait they cause.
 */
export async function shutdown(signal: string, deps: ShutdownDeps): Promise<void> {
  const { server, processManager, bridge, jobs, exit, graceMs = SHUTDOWN_GRACE_MS } = deps;

  logger.info('process', 'Shutting down gracefully', { signal });

  jobs.stop();
  bridge.close();

  try {
    await processManager.stop();
  } catch (err) {
    logger.debug('process', 'Sync daemon did not stop cleanly', { err });
  }

  // Whatever else is still in flight — a media stream mid-body, a wacli read
  // that has not come back — is not worth hanging a shutdown on. Unref'd, so it
  // is only ever a backstop: when the close lands first the process exits on
  // its own and this never fires.
  const forceExit = setTimeout(() => {
    logger.warn('process', 'Shutdown timed out with connections still open; exiting anyway');
    closeDatabase();
    logger.close();
    exit();
  }, graceMs);
  forceExit.unref();

  server.close(() => {
    clearTimeout(forceExit);
    // After the scheduler's timer and every in-flight request, so nothing is
    // still mid-write when the handle goes. WAL checkpoints on close.
    closeDatabase();
    // Flush the tail of any collapsed repeat before the process is gone.
    logger.close();
    exit();
  });
}

/**
 * Opens the database before anything can want it, and refuses to boot without
 * it.
 *
 * There is no degraded mode worth having here. Safe mode lives in this file:
 * a server that came up with an unreadable store would answer every send check
 * from a compiled-in default instead of the operator's own choice, which is the
 * one failure that sends messages nobody authorised. The scheduled queue would
 * likewise look empty rather than unavailable, and a queue that reports "no
 * pending messages" when it simply cannot see them is worse than no queue.
 *
 * So this is loud and fatal, and it says which file and why.
 */
export function bootDatabase(exit: (code: number) => never = process.exit): void {
  try {
    // Exclusive: this server is the only thing that may use the file while it
    // runs. A second one would run a second scheduler over the same queue.
    const db = initDatabase(resolveDbPath(), { exclusive: true });
    migrateJsonStores(db);
    // Here rather than on a timer: a console left open for a month is not the
    // case worth a background job, and a restart is when the count is visible.
    activityStore.prune();
  } catch (err) {
    const dbPath = err instanceof DatabaseUnavailableError ? err.dbPath : resolveDbPath();
    const detail = err instanceof Error ? err.message : String(err);

    logger.error('api', 'Cannot start: the Mission Control database is unavailable', {
      file: dbPath,
      err,
    });
    // Straight to stderr as well: an operator who started this from a terminal
    // gets the reason and the fix on screen, not only in a log file they would
    // have to go find.
    process.stderr.write(
      [
        '',
        '  wacli Mission Control cannot start.',
        '',
        `  ${detail}`,
        '',
        ...(err instanceof DatabaseInUseError
          ? [
              '  Two consoles on one database would each send every scheduled message.',
              '  Stop the other one first, or set WACLI_DB_FILE to give this one its own.',
            ]
          : [
              '  This database holds safe mode, the scheduled queue and the activity log,',
              '  so the console will not run without it. Check that the file is readable and',
              '  the disk is not full, or set WACLI_DB_FILE to a writable path.',
            ]),
        '',
      ].join('\n')
    );
    logger.close();
    exit(1);
  }
}

/**
 * Brings the daemon up at boot, unless it was switched off: by `--no-sync`, or
 * by sleep mode, which is persisted precisely so that a restart comes back
 * asleep rather than quietly reconnecting.
 */
export function startSyncAtBoot(pm: Pick<WacliProcessManager, 'start'>): void {
  if (process.env.WACLI_DISABLE_SYNC === '1') return;
  if (modeManager.isSleeping()) {
    logger.info('process', 'Started asleep; sync daemon left off', {
      since: modeManager.getSleepState().since ?? undefined,
    });
    return;
  }
  pm.start();
}

export function startServer(port = PORT, host = HOST): ServerInstance {
  bootDatabase();

  const pm = new WacliProcessManager({
    apiPort: port,
    onStateChange: (state, reason) => {
      eventBridge.broadcast({
        type: 'connection.status',
        data: { state, reason },
        ts: new Date().toISOString(),
      });
    },
    onLifecycleEvent: (event) => {
      eventBridge.broadcast({
        type: 'sync.progress',
        data: { phase: String(event.event || event.type || 'sync'), detail: JSON.stringify(event) },
        ts: new Date().toISOString(),
      });
    },
  });

  // `npm run dev` passes --dev-ui, so the Vite pages it serves may call in.
  const access = accessPolicy({ port, devUi: process.argv.includes('--dev-ui') });
  const app = createApp(pm, eventBridge, access);
  const server = http.createServer(app);

  eventBridge.initialize(server, access);
  scheduler.setEventBridge(eventBridge);
  // Due messages fire on a timer, so they collide with the running sync daemon
  // exactly the way an interactive send does. Same fix: pause it for the send.
  scheduler.setExclusiveRunner(pm);
  scheduler.start();

  server.listen(port, host, () => {
    // Where the log lives and how loud it is, said once at the top of every run
    // — otherwise finding the file is its own small investigation.
    logger.info('api', 'Mission Control API listening', {
      url: `http://${host}:${port}`,
      logFile: logger.getFilePath() ?? undefined,
      logLevel: logger.getLevel(),
    });
    startSyncAtBoot(pm);
  });

  const gracefulShutdown = (signal: string) =>
    shutdown(signal, {
      server,
      processManager: pm,
      bridge: eventBridge,
      jobs: scheduler,
      exit: () => process.exit(0),
    });

  process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  return { server, app, processManager: pm };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
