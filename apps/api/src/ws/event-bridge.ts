import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'node:http';
import { logger } from '../logger.js';
import { isAllowedUpgrade } from '../net/loopback.js';
import type { MissionControlEvent } from '../types.js';

export class EventBridge {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();

  public initialize(server: Server): void {
    this.wss = new WebSocketServer({
      server,
      path: '/ws',
      // The socket carries every message the account receives, and an upgrade
      // ignores the same-origin policy the REST layer relies on — so this is
      // the only thing standing between the feed and any page the operator
      // happens to have open. Refused before the handshake completes, so a
      // rejected caller never reaches the client set at all.
      verifyClient: ({ origin, req }: { origin: string; req: IncomingMessage }) => {
        if (isAllowedUpgrade(origin, req.headers.host)) return true;
        logger.warn('ws', 'Refused WebSocket upgrade from a non-loopback caller', {
          origin: origin || undefined,
          host: req.headers.host,
        });
        return false;
      },
    });

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

  /**
   * Drops every client and stops accepting new ones.
   *
   * `wss.close()` on its own only closes the listener: an already-upgraded
   * socket stays open, and `http.Server.close()` waits for every one of them.
   * That is what made Ctrl+C hang for as long as a browser tab was open, which
   * on this console is always. Terminating rather than closing politely is
   * deliberate — a closing handshake needs the peer to answer, and a shutdown
   * cannot be left waiting on a client that never will. The tab sees the socket
   * drop and its own reconnect loop takes it from there.
   */
  public close(): void {
    for (const client of this.clients) {
      try {
        client.terminate();
      } catch {
        // Already gone; nothing left to release.
      }
    }
    this.clients.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

export const eventBridge = new EventBridge();
