import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
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
        configure: (proxy) => {
          proxy.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ECONNABORTED') {
              return;
            }
          });
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', (err) => {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'EPIPE' || code === 'ECONNRESET' || code === 'ECONNABORTED') {
                return;
              }
            });
          });
        },
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
  },
});
