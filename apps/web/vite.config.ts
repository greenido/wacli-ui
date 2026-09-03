import react from '@vitejs/plugin-react';
import { createLogger, defineConfig } from 'vite';

/**
 * Socket errors that mean "the peer hung up first", not "something is broken".
 *
 * React StrictMode mounts effects twice in dev, so the first WebSocket is opened
 * and closed within a couple of milliseconds. The API's startup broadcast can
 * land in that gap, and Vite's ws proxy then writes to a socket the browser has
 * already dropped — one EPIPE and a stack trace per dev boot, describing
 * nothing the operator can act on.
 */
const BENIGN_SOCKET_CODES = new Set(['EPIPE', 'ECONNRESET', 'ECONNABORTED']);

/**
 * Vite logs those through `config.logger.error(msg, { error })`, and it attaches
 * its own socket-error listener *after* a proxy's `configure` hook has run, so a
 * handler registered there cannot pre-empt it — EventEmitter listeners do not
 * cancel one another. Filtering at the logger is the only layer that actually
 * sees the message. The `ws proxy` guard keeps a genuine `/api` reset visible.
 */
const logger = createLogger();
const logError = logger.error;
logger.error = (msg, options) => {
  const code = (options?.error as NodeJS.ErrnoException | undefined)?.code;
  if (code && BENIGN_SOCKET_CODES.has(code) && typeof msg === 'string' && msg.includes('ws proxy')) {
    return;
  }
  logError(msg, options);
};

export default defineConfig({
  plugins: [react()],
  customLogger: logger,
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
      '/internal': {
        target: 'http://127.0.0.1:3002',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:3002',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
});
