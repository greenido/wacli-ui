import { Router, type NextFunction, type Request, type Response } from 'express';
import { execWacli, postSendWaitArgs } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { activityStore } from '../wacli/activity.js';
import { sentMessageIdFrom } from '../wacli/normalize.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import { logger } from '../logger.js';

/**
 * Editing, unsending and forwarding: things done to a message that already
 * exists. Each one reaches other people's phones (or, for delete-for-me, every
 * device on this account), so each is refused in safe mode and needs the same
 * explicit `confirm: true` a send does.
 *
 * wacli hands an edit to the running daemon. Revoke, delete-for-me and forward
 * it does not (as of 0.26), so those take the daemon down for the length of the
 * command: `runDelegated` tries the hand-off once, and wacli's lock refusal is
 * what sends it the exclusive way.
 */

/**
 * wacli's own refusals: the message is the wrong kind, or out of time. These
 * are the operator's request meeting WhatsApp's rules, not a server fault, so
 * they come back as 409 with wacli's own words, which already say why.
 */
const REFUSALS = [
  'edit window',
  'was not sent by me',
  'is already deleted',
  'was deleted for me',
  'is deleted',
  'cannot be forwarded',
  'only text messages can be',
  'message not found',
];

function refusalFrom(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  return REFUSALS.some((pattern) => message.includes(pattern)) ? message : null;
}

function requireMutationPermission(req: Request, res: Response, next: NextFunction): void {
  if (modeManager.isReadOnly()) {
    logger.warn('send', 'Blocked message change; read-only safe mode is active', { route: req.path });
    res.status(403).json({
      success: false,
      data: null,
      error: 'Safe read-only mode is active. Editing, deleting and forwarding are disabled.',
    });
    return;
  }
  next();
}

/** A field that must be a nonempty string with no surrounding space. */
function exact(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value === value.trim();
}

/** A label the console sends for the activity log only; wacli never sees it. */
function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined;
}

function badRequest(res: Response, error: string): void {
  res.status(400).json({ success: false, data: null, error });
}

export function createMessageActionsRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  /**
   * Runs one command against a message, keeping the activity row honest: it
   * is written before the command and settled after, so a command that never
   * returns still leaves a trace that it was attempted.
   *
   * Null means wacli refused and the 409 has already been sent; a result,
   * even an empty one, means the caller still owes the response.
   */
  async function run(
    res: Response,
    args: string[],
    timeoutMs: number,
    activity: { to: string; chatName?: string; message: string; messageId?: string } | null
  ): Promise<{ result: Record<string, unknown> | null } | null> {
    const logId = activity ? activityStore.record({ ...activity, status: 'pending' }) : null;
    try {
      const result = await processManager.runDelegated((lock, handedOver) =>
        execWacli<Record<string, unknown>>([...args, ...postSendWaitArgs(handedOver)], {
          allowMutation: true,
          timeoutMs,
          ...lock,
        })
      );
      if (logId) {
        activityStore.settle(logId, {
          status: 'success',
          messageId: activity?.messageId ?? sentMessageIdFrom(result) ?? undefined,
        });
      }
      return { result };
    } catch (err) {
      if (logId) {
        activityStore.settle(logId, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const refusal = refusalFrom(err);
      if (refusal) {
        logger.warn('send', 'wacli refused a message change', { cmd: args.slice(0, 2).join(' '), refusal });
        res.status(409).json({ success: false, data: null, error: refusal });
        return null;
      }
      throw err;
    }
  }

  // POST /api/messages/edit — one of your own recent texts, within WhatsApp's
  // edit window (wacli enforces it, and says so when it has passed).
  router.post('/messages/edit', requireMutationPermission, async (req, res, next) => {
    try {
      const { chat, id, message, confirm } = req.body as Record<string, unknown>;
      if (confirm !== true) return badRequest(res, 'Explicit "confirm: true" parameter required in request body.');
      if (!exact(chat) || !exact(id)) return badRequest(res, 'Fields "chat" (JID) and "id" are required.');
      if (typeof message !== 'string' || !message.trim()) {
        return badRequest(res, 'Field "message" (the new text) is required.');
      }

      logger.info('send', 'Editing message', { chat, id });
      const outcome = await run(res, ['messages', 'edit', '--chat', chat, '--id', id, '--message', message], 30_000, {
        to: chat,
        chatName: label(req.body?.chatName),
        message: `Edited: ${message}`,
        messageId: id,
      });
      if (outcome) res.json({ success: true, data: { edited: true, chat, id }, error: null });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/messages/delete — for everyone (your own message, a revoke) or
  // for you (any message, on every device of this account).
  router.post('/messages/delete', requireMutationPermission, async (req, res, next) => {
    try {
      const { chat, id, forEveryone, confirm } = req.body as Record<string, unknown>;
      if (confirm !== true) return badRequest(res, 'Explicit "confirm: true" parameter required in request body.');
      if (!exact(chat) || !exact(id)) return badRequest(res, 'Fields "chat" (JID) and "id" are required.');
      if (typeof forEveryone !== 'boolean') {
        return badRequest(res, 'Field "forEveryone" must be true (unsend) or false (delete for me).');
      }

      logger.info('send', forEveryone ? 'Deleting message for everyone' : 'Deleting message for me', { chat, id });
      const args = forEveryone
        ? ['messages', 'revoke', '--chat', chat, '--id', id]
        : ['messages', 'delete', '--chat', chat, '--id', id, '--for-me'];
      // Only an unsend reaches anyone else, so only it joins the send log.
      const activity = forEveryone
        ? {
            to: chat,
            chatName: label(req.body?.chatName),
            message: `Deleted for everyone: ${label(req.body?.preview) ?? '(message)'}`,
            messageId: id,
          }
        : null;
      const outcome = await run(res, args, 30_000, activity);
      if (outcome) res.json({ success: true, data: { deleted: true, forEveryone, chat, id }, error: null });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/messages/forward — a stored message, text or media, to another chat.
  router.post('/messages/forward', requireMutationPermission, async (req, res, next) => {
    try {
      const { chat, id, to, confirm } = req.body as Record<string, unknown>;
      if (confirm !== true) return badRequest(res, 'Explicit "confirm: true" parameter required in request body.');
      if (!exact(chat) || !exact(id) || !exact(to)) {
        return badRequest(res, 'Fields "chat" (JID), "id" and "to" (JID) are required.');
      }

      logger.info('send', 'Forwarding message', { chat, id, to });
      const outcome = await run(res, ['messages', 'forward', '--chat', chat, '--id', id, '--to', to], 60_000, {
        to,
        chatName: label(req.body?.toName),
        message: `Forwarded: ${label(req.body?.preview) ?? '(message)'}`,
      });
      if (outcome) {
        res.json({
          success: true,
          data: { forwarded: true, to, messageId: sentMessageIdFrom(outcome.result) },
          error: null,
        });
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
