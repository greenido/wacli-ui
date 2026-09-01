import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '../logger.js';
import { normalizeWebhookMessage } from '../wacli/normalize.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import type { EventBridge } from '../ws/event-bridge.js';
import type { RawWebhookChatPresence, RawWebhookMessage, RawWebhookReceipt } from '../types.js';

function normalizePresenceState(state: string | undefined): 'composing' | 'paused' | null {
  const normalized = (state ?? '').toLowerCase();
  if (normalized === 'paused') return 'paused';
  if (normalized === 'composing') return 'composing';
  return null;
}

export function createWebhookRouter(
  processManager: WacliProcessManager,
  eventBridge: EventBridge
): Router {
  const router = Router();

  router.post('/webhook', (req: Request, res: Response) => {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || '')));
    const signatureHeader = req.headers['x-wacli-signature'];

    if (!signatureHeader || typeof signatureHeader !== 'string') {
      logger.warn('webhook', 'Missing X-Wacli-Signature header');
      res.status(401).json({ error: 'Missing X-Wacli-Signature header' });
      return;
    }

    const secret = processManager.getWebhookSecret();
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(rawBody);
    const expectedSig = `sha256=${hmac.digest('hex')}`;

    // Timing safe comparison
    const sigBuffer = Buffer.from(signatureHeader);
    const expBuffer = Buffer.from(expectedSig);

    if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
      logger.warn('webhook', 'Invalid HMAC signature on webhook payload');
      res.status(403).json({ error: 'Invalid HMAC signature' });
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      logger.warn('webhook', 'Failed to parse webhook JSON body');
      res.status(400).json({ error: 'Malformed JSON payload' });
      return;
    }

    logger.info('webhook', `Received valid webhook event: ${JSON.stringify(payload)}`);
    const ts = new Date().toISOString();

    if (payload.EventType === 'receipt') {
      const receipt = payload as unknown as RawWebhookReceipt;
      const status = receipt.Type === 'read' || receipt.Type === 'played' ? receipt.Type : 'delivered';
      eventBridge.broadcast({
        type: 'message.receipt',
        data: {
          chatJid: receipt.Chat,
          messageIds: receipt.MessageIDs || [],
          status,
          sender: receipt.Sender,
          isFromMe: Boolean(receipt.IsFromMe),
        },
        ts,
      });
    } else if (payload.EventType === 'chat_presence') {
      const presence = payload as unknown as RawWebhookChatPresence;
      const state = normalizePresenceState(presence.State);
      if (!state) {
        res.status(200).json({ status: 'ok' });
        return;
      }
      eventBridge.broadcast({
        type: 'chat.presence',
        data: {
          chatJid: presence.Chat,
          senderJid: presence.Sender,
          state,
          media: presence.Media === 'audio' ? 'audio' : '',
        },
        ts,
      });
    } else {
      // Default to live message
      const msg = payload as unknown as RawWebhookMessage;
      const unified = normalizeWebhookMessage(msg);
      eventBridge.broadcast({
        type: 'message.new',
        data: unified,
        ts,
      });
    }

    res.status(200).json({ status: 'ok' });
  });

  return router;
}
