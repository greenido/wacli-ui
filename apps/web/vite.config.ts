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
    // The API trusts pages from this port only under `npm run dev` (its
    // --dev-ui flag), so a busy port must fail loudly rather than drift to one
    // the API refuses.
    port: 5174,
    strictPort: true,
    // Vite checks Host against DNS rebinding the way the API does. The API
    // reads /etc/hosts for extra local names; here it is listed, for the
    // `127.0.0.1 wacli-ui` line the README suggests.
    allowedHosts: ['wacli-ui'],
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
        // Leave Origin alone. rewriteWsOrigin would rewrite
        // http://127.0.0.1:5174 → ws://127.0.0.1:3002, and the API only
        // accepts http page origins — so the upgrade would be refused even
        // though the caller is this UI.
      },
    },
  },
  // strictPort, allowedHosts and the proxy carry over from `server`.
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
});
