import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
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
import { scheduler } from './wacli/scheduler.js';
import { StoreLockedError } from './wacli/store-lock.js';

export const PORT = Number(process.env.PORT ?? 3002);
export const HOST = '127.0.0.1';

export function isLoopbackHost(hostHeader?: string): boolean {
  if (!hostHeader) return false;
  try {
    const rawHost = hostHeader.startsWith('[')
      ? hostHeader.slice(1, hostHeader.indexOf(']'))
      : hostHeader.split(':')[0];
    const h = (rawHost ?? '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const h = url.hostname;
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]')
    );
  } catch {
    return false;
  }
}

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

/** Query params are usually the only thing separating two identical lines. */
function formatQuery(query: Request['query']): string | undefined {
  const entries = Object.entries(query);
  if (entries.length === 0) return undefined;

  return entries
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join('&');
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
  bridge: EventBridge = eventBridge
): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Loopback host header validation
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    if (host && !isLoopbackHost(host) && process.env.NODE_ENV !== 'test') {
      res.status(403).json({ error: { code: 'FORBIDDEN_HOST', message: 'Requests must target localhost.' } });
      return;
    }
    next();
  });

  // Loopback CORS
  app.use(cors({
    origin(origin, callback) {
      if (!origin || isLoopbackOrigin(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not allowed by CORS.'));
    },
  }));

  app.use(requestLogger);

  // Raw body parser specifically for internal webhook HMAC verification
  app.use('/internal/wacli', express.raw({
    type: '*/*',
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    },
  }));

  // JSON body parser for REST API
  app.use('/api', express.json({ limit: '64kb' }));

  // Mount routers
  app.use('/api', createHealthRouter(processManager));
  app.use('/api', createSettingsRouter(bridge));
  app.use('/api', createChatsRouter(processManager));
  app.use('/api', createMessagesRouter());
  app.use('/api', createSearchRouter());
  app.use('/api', createHistoryRouter(processManager));
  app.use('/api', createContactsRouter(processManager));
  app.use('/api', createSendRouter());
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

export function startServer(port = PORT, host = HOST): ServerInstance {
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

  const app = createApp(pm);
  const server = http.createServer(app);

  eventBridge.initialize(server);
  scheduler.setEventBridge(eventBridge);
  scheduler.start();

  server.listen(port, host, () => {
    // Where the log lives and how loud it is, said once at the top of every run
    // — otherwise finding the file is its own small investigation.
    logger.info('api', 'Mission Control API listening', {
      url: `http://${host}:${port}`,
      logFile: logger.getFilePath(),
      logLevel: logger.getLevel(),
    });
    if (process.env.WACLI_DISABLE_SYNC !== '1') {
      pm.start();
    }
  });

  const gracefulShutdown = async (signal: string) => {
    logger.info('process', 'Shutting down gracefully', { signal });
    try {
      await pm.stop();
    } catch (err) {
      logger.debug('process', 'Sync daemon did not stop cleanly', { err });
    }
    server.close(() => {
      // Flush the tail of any collapsed repeat before the process is gone.
      logger.close();
      process.exit(0);
    });
  };

  process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

  return { server, app, processManager: pm };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
