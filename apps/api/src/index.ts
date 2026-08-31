import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import http from 'node:http';
import { logger } from './logger.js';
import { WacliProcessManager } from './wacli/process-manager.js';
import { eventBridge, EventBridge } from './ws/event-bridge.js';
import { createHealthRouter } from './routes/health.js';
import { createSettingsRouter } from './routes/settings.js';
import { createWebhookRouter } from './routes/webhook.js';
import { createChatsRouter } from './routes/chats.js';
import { createMessagesRouter } from './routes/messages.js';
import { createSearchRouter } from './routes/search.js';
import { createSendRouter } from './routes/send.js';
import { createMediaRouter } from './routes/media.js';
import { scheduler } from './wacli/scheduler.js';

export const PORT = Number(process.env.PORT ?? 3002);
export const HOST = '127.0.0.1';

const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`,
  `127.0.0.1:${PORT}`,
  `[::1]:${PORT}`,
]);

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

export function createApp(
  processManager: WacliProcessManager,
  bridge: EventBridge = eventBridge
): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // Loopback host header validation
  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host;
    if (host && !ALLOWED_HOSTS.has(host) && process.env.NODE_ENV !== 'test') {
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
  app.use('/api', createChatsRouter());
  app.use('/api', createMessagesRouter());
  app.use('/api', createSearchRouter());
  app.use('/api', createSendRouter());
  app.use('/api', createMediaRouter());
  app.use('/internal/wacli', createWebhookRouter(processManager, bridge));

  // Global Error Handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('api', `Unhandled API error: ${errorMsg}`);
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
    logger.info('api', `wacli Mission Control API listening on http://${host}:${port}`);
    if (process.env.WACLI_DISABLE_SYNC !== '1') {
      pm.start();
    }
  });

  return { server, app, processManager: pm };
}

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
