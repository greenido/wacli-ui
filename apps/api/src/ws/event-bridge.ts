import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import { logger } from '../logger.js';
import type { MissionControlEvent } from '../types.js';

export class EventBridge {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  public initialize(server: Server): void {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      this.clients.add(ws);
      const ip = req.socket.remoteAddress;
      logger.info('ws', 'Client connected', { ip, clients: this.clients.size });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('ws', 'Client disconnected', { clients: this.clients.size });
      });

      ws.on('error', (err) => {
        logger.warn('ws', 'WebSocket client error', { err });
        this.clients.delete(ws);
      });

      // Send initial heartbeat acknowledgment
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({
            type: 'connection.status',
            data: { state: 'connected', reason: 'Initial connection established' },
            ts: new Date().toISOString(),
          }));
        } catch {
          // ignore if socket disconnected during handshake
        }
      }
    });
  }

  public broadcast(event: MissionControlEvent): void {
    const payload = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (err: unknown) {
          logger.warn('ws', 'Failed to send to client', { err });
        }
      }
    }
  }

  public getConnectedClientCount(): number {
    return this.clients.size;
  }

  public close(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
  }
}

export const eventBridge = new EventBridge();
