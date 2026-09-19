import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import { execWacli, POST_SEND_WAIT } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { keepScheduledAttachment, scheduler } from '../wacli/scheduler.js';
import { activityStore } from '../wacli/activity.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import { sentMessageIdFrom } from '../wacli/normalize.js';
import { logger } from '../logger.js';

/**
 * A query-string page size, or undefined to let the store pick its default.
 * Anything that is not a positive integer is treated as absent rather than
 * coerced, so `?limit=abc` does not silently become a page of NaN.
 */
function parsePositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MiB cap per wacli spec
  },
});

function requireMutationPermission(req: Request, res: Response, next: NextFunction): void {
  // Read-only global mode check
  if (modeManager.isReadOnly()) {
    logger.warn('send', 'Blocked send attempt; read-only safe mode is active', { route: req.path });
    res.status(403).json({
      success: false,
      data: null,
      error: 'Safe read-only mode is active. Outgoing sends, reactions, and scheduled jobs are disabled.',
    });
    return;
  }

  next();
}

/**
 * Every outgoing command here runs through `runDelegated`.
 *
 * The sync daemon holds the store lock for as long as it is up, and it does not
 * let go between polls — so a send run as a second wacli loses that race every
 * time, and `execWacli`'s own three retries are three more losses, not a
 * recovery. That is what put `503 store is locked (another wacli is running?)`
 * on a plain text send. wacli's answer is to hand the send to the daemon over a
 * socket in the store, and `runDelegated` lets it: the daemon stays connected,
 * and nothing that arrives during the send waits for a respawn.
 *
 * When the daemon cannot take it (not connected yet, or a wacli from before
 * delegation) the send runs the old way: the daemon paused for the duration,
 * queued behind the other exclusive commands. Then the timeouts below are
 * downtime budgets as much as patience settings.
 */
export function createSendRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  // POST /api/send/text
  router.post('/send/text', requireMutationPermission, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { to, message, replyTo, confirm } = req.body as {
        to?: string;
        message?: string;
        replyTo?: string;
        confirm?: boolean;
      };

      if (confirm !== true) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Explicit "confirm: true" parameter required in request body.',
        });
        return;
      }

      if (!to || typeof to !== 'string' || !message || typeof message !== 'string') {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Both "to" (JID or phone) and "message" are required.',
        });
        return;
      }

      const args = ['send', 'text', '--to', to, '--message', message, '--post-send-wait', POST_SEND_WAIT];
      if (replyTo) {
        args.push('--reply-to', replyTo);
      }

      logger.info('send', 'Dispatching text', { to, replyTo: replyTo || undefined });

      // Recorded before the send, settled after, so a send that never returns
      // leaves a row saying it was attempted rather than no row at all.
      const logId = activityStore.record({
        to,
        chatName: typeof req.body?.chatName === 'string' ? req.body.chatName : undefined,
        message,
        status: 'pending',
      });

      try {
        const result = await processManager.runDelegated((lock) =>
          execWacli<Record<string, unknown>>(args, {
            allowMutation: true,
            timeoutMs: 60000,
            ...lock,
          })
        );

        const messageId = sentMessageIdFrom(result);
        activityStore.settle(logId, { status: 'success', messageId: messageId ?? undefined });

        res.json({
          success: true,
          data: {
            sent: true,
            // Hoisted out of the raw result so the console can jump to what it
            // just sent. Buried inside `details` it was never read, and the send
            // log had no id to point the thread at.
            messageId,
            details: result,
          },
          error: null,
        });
      } catch (err) {
        activityStore.settle(logId, {
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /api/send/file
  // The permission gate runs before multer so a blocked request never writes a
  // temp file that nothing would clean up.
  router.post(
    '/send/file',
    requireMutationPermission,
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      const file = req.file;
      const { to, caption, replyTo, confirm } = req.body as {
        to?: string;
        caption?: string;
        replyTo?: string;
        confirm?: string | boolean;
      };

      if (!file) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'No file attachment provided in "file" field.',
        });
        return;
      }

      if (confirm !== true && confirm !== 'true') {
        // Clean up temp file immediately
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        res.status(400).json({
          success: false,
          data: null,
          error: 'Explicit "confirm: true" parameter required in request body.',
        });
        return;
      }

      if (!to) {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        res.status(400).json({
          success: false,
          data: null,
          error: 'Recipient "to" is required.',
        });
        return;
      }

      // Declared out here so the catch can settle a row the try may not have
      // reached yet — an argument-building throw must not settle nothing.
      let logId: string | undefined;

      try {
        const args = ['send', 'file', '--to', to, '--file', file.path, '--filename', file.originalname, '--post-send-wait', POST_SEND_WAIT];
        if (caption) {
          args.push('--caption', caption);
        }
        if (replyTo) {
          args.push('--reply-to', replyTo);
        }

        logger.info('send', 'Dispatching file', { to, file: file.originalname, bytes: file.size });

        // The caption alone would leave an attachment-only send as a blank row,
        // so the filename stands in for what was actually sent.
        logId = activityStore.record({
          to,
          chatName: typeof req.body?.chatName === 'string' ? req.body.chatName : undefined,
          message: caption || file.originalname,
          status: 'pending',
        });

        const result = await processManager.runDelegated((lock) =>
          execWacli<Record<string, unknown>>(args, {
            allowMutation: true,
            timeoutMs: 120000,
            ...lock,
          })
        );

        const messageId = sentMessageIdFrom(result);
        activityStore.settle(logId, { status: 'success', messageId: messageId ?? undefined });

        res.json({
          success: true,
          data: {
            sent: true,
            messageId,
            details: result,
          },
          error: null,
        });
      } catch (err) {
        if (logId) {
          activityStore.settle(logId, {
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
        next(err);
      } finally {
        // Always clean up temp file
        if (file.path && fs.existsSync(file.path)) {
          try {
            fs.unlinkSync(file.path);
          } catch {
            // ignore cleanup error
          }
        }
      }
    }
  );

  // POST /api/send/react
  router.post('/send/react', requireMutationPermission, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { to, id, reaction, sender, confirm } = req.body as {
        to?: string;
        id?: string;
        reaction?: string;
        sender?: string;
        confirm?: boolean;
      };

      if (confirm !== true) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Explicit "confirm: true" parameter required.',
        });
        return;
      }

      if (!to || !id) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Both "to" and "id" are required.',
        });
        return;
      }

      const args = ['send', 'react', '--to', to, '--id', id, '--reaction', reaction ?? '👍', '--post-send-wait', POST_SEND_WAIT];
      if (sender) {
        args.push('--sender', sender);
      }

      logger.info('send', 'Dispatching reaction', { to, id, reaction: reaction ?? '👍' });

      const result = await processManager.runDelegated((lock) =>
        execWacli<Record<string, unknown>>(args, {
          allowMutation: true,
          timeoutMs: 30000,
          ...lock,
        })
      );

      res.json({
        success: true,
        data: {
          sent: true,
          messageId: sentMessageIdFrom(result),
          details: result,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/send/schedule (Send Later text)
  router.post('/send/schedule', requireMutationPermission, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { to, recipientName, message, replyTo, scheduledAt, confirm } = req.body as {
        to?: string;
        recipientName?: string;
        message?: string;
        replyTo?: string;
        scheduledAt?: string;
        confirm?: boolean;
      };

      if (confirm !== true) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Explicit "confirm: true" parameter required in request body.',
        });
        return;
      }

      if (!to || !message || !scheduledAt) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Fields "to", "message", and "scheduledAt" are required.',
        });
        return;
      }

      const item = scheduler.schedule({
        to,
        recipientName,
        message,
        replyTo,
        scheduledAt,
      });

      res.json({
        success: true,
        data: {
          scheduled: true,
          item,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/send/schedule-file (Send Later file)
  router.post(
    '/send/schedule-file',
    requireMutationPermission,
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      const file = req.file;
      const { to, recipientName, caption, replyTo, scheduledAt, confirm } = req.body as {
        to?: string;
        recipientName?: string;
        caption?: string;
        replyTo?: string;
        scheduledAt?: string;
        confirm?: string | boolean;
      };

      if (!file) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'No file attachment provided in "file" field.',
        });
        return;
      }

      if (confirm !== true && confirm !== 'true') {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        res.status(400).json({
          success: false,
          data: null,
          error: 'Explicit "confirm: true" parameter required in request body.',
        });
        return;
      }

      if (!to || !scheduledAt) {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        res.status(400).json({
          success: false,
          data: null,
          error: 'Fields "to" and "scheduledAt" are required.',
        });
        return;
      }

      let keptPath: string | undefined;
      try {
        keptPath = keepScheduledAttachment(file.path, file.originalname);

        const item = scheduler.schedule({
          to,
          recipientName,
          message: caption || '',
          replyTo,
          filePath: keptPath,
          fileName: file.originalname,
          mimeType: file.mimetype,
          scheduledAt,
        });

        res.json({
          success: true,
          data: {
            scheduled: true,
            item,
          },
          error: null,
        });
      } catch (err) {
        // No record owns the kept file, so nothing else would delete it.
        if (keptPath) fs.rmSync(keptPath, { force: true });
        next(err);
      } finally {
        // Gone already when the move worked; still here when it did not.
        fs.rmSync(file.path, { force: true });
      }
    }
  );

  // GET /api/send/scheduled & /api/scheduled - list scheduled messages
  //
  // Everything pending, always, plus one page of resolved history. See
  // Scheduler.getPage for why pending is never paged.
  router.get('/send/scheduled', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: scheduler.getPage({
        chat: req.query.chat as string | undefined,
        limit: parsePositiveInt(req.query.limit),
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
      }),
      error: null,
    });
  });

  // GET /api/activity - the send audit stream, newest first
  router.get('/activity', (req: Request, res: Response) => {
    res.json({
      success: true,
      data: activityStore.list({
        limit: parsePositiveInt(req.query.limit),
        before: typeof req.query.before === 'string' ? req.query.before : undefined,
      }),
      error: null,
    });
  });

  /**
   * Answers a request that changed nothing as a failure.
   *
   * These used to reply `success: true` *with* an error string, which the
   * client reads as success and shows as done — so cancelling a message that
   * had already gone out, or discarding one twice, looked like it worked. 409
   * rather than 404 because the id usually does exist; it is the state that
   * refuses, which is what the message has to say.
   */
  function answerStateChange(
    res: Response,
    changed: boolean,
    field: 'cancelled' | 'discarded',
    reason: string
  ): void {
    if (!changed) {
      res.status(409).json({ success: false, data: { [field]: false }, error: reason });
      return;
    }
    res.json({ success: true, data: { [field]: true }, error: null });
  }

  /** Cancels through the scheduler, which says why when it refuses. */
  function cancelScheduled(req: Request, res: Response): void {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const outcome = id
      ? scheduler.cancel(id)
      : { ok: false as const, error: 'Scheduled message id is required.' };
    answerStateChange(res, outcome.ok, 'cancelled', outcome.ok ? '' : outcome.error);
  }

  // DELETE cancels a scheduled message
  router.delete('/send/scheduled/:id', cancelScheduled);

  // POST resend a failed scheduled message. requireMutationPermission already
  // turns this away in safe read-only mode; the scheduler re-checks anyway so
  // the guarantee does not depend on which door the request came through.
  router.post(
    '/send/scheduled/:id/resend',
    requireMutationPermission,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawId = req.params.id;
        const id = Array.isArray(rawId) ? rawId[0] : rawId;
        const { confirm, scheduledAt } = req.body as {
          confirm?: boolean;
          scheduledAt?: string;
        };

        if (confirm !== true) {
          res.status(400).json({
            success: false,
            data: null,
            error: 'Explicit "confirm: true" parameter required in request body.',
          });
          return;
        }

        if (!id) {
          res.status(400).json({
            success: false,
            data: null,
            error: 'Scheduled message id is required.',
          });
          return;
        }

        const outcome = await scheduler.resend(id, scheduledAt ? { scheduledAt } : {});

        if (!outcome.ok) {
          // A rejected resend is the guard doing its job, not a server fault:
          // 409 so the UI can show the reason instead of a generic failure.
          res.status(409).json({
            success: false,
            data: null,
            error: outcome.error,
          });
          return;
        }

        res.json({
          success: true,
          data: {
            resent: outcome.item.status === 'sent',
            item: outcome.item,
          },
          error: null,
        });
      } catch (err) {
        next(err);
      }
    }
  );

  // POST discard a failed scheduled message (drops the record for good)
  router.post('/send/scheduled/:id/discard', (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const discarded = id ? scheduler.discard(id) : false;
    answerStateChange(
      res,
      discarded,
      'discarded',
      'Scheduled message not found, or not in a failed state.'
    );
  });

  return router;
}
