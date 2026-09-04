import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { scheduler } from '../wacli/scheduler.js';
import { logger } from '../logger.js';

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100 MiB cap per wacli spec
  },
});

function requireMutationPermission(req: Request, res: Response, next: NextFunction): void {
  // 1. Guard against accidental scripts / non-UI requests
  const customHeader = req.headers['x-mission-control-request'];
  if (!customHeader && process.env.NODE_ENV !== 'test') {
    res.status(400).json({
      success: false,
      data: null,
      error: 'Missing required "X-Mission-Control-Request: 1" header.',
    });
    return;
  }

  // 2. Read-only global mode check
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

export function createSendRouter(): Router {
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

      const args = ['send', 'text', '--to', to, '--message', message];
      if (replyTo) {
        args.push('--reply-to', replyTo);
      }

      logger.info('send', 'Dispatching text', { to, replyTo: replyTo || undefined });

      const result = await execWacli<Record<string, unknown>>(args, {
        allowMutation: true,
        timeoutMs: 60000,
      });

      res.json({
        success: true,
        data: {
          sent: true,
          details: result,
        },
        error: null,
      });
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

      try {
        const args = ['send', 'file', '--to', to, '--file', file.path, '--filename', file.originalname];
        if (caption) {
          args.push('--caption', caption);
        }
        if (replyTo) {
          args.push('--reply-to', replyTo);
        }

        logger.info('send', 'Dispatching file', { to, file: file.originalname, bytes: file.size });

        const result = await execWacli<Record<string, unknown>>(args, {
          allowMutation: true,
          timeoutMs: 120000,
        });

        res.json({
          success: true,
          data: {
            sent: true,
            details: result,
          },
          error: null,
        });
      } catch (err) {
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

      const args = ['send', 'react', '--to', to, '--id', id, '--reaction', reaction ?? '👍'];
      if (sender) {
        args.push('--sender', sender);
      }

      logger.info('send', 'Dispatching reaction', { to, id, reaction: reaction ?? '👍' });

      const result = await execWacli<Record<string, unknown>>(args, {
        allowMutation: true,
        timeoutMs: 30000,
      });

      res.json({
        success: true,
        data: {
          sent: true,
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

      try {
        // Move temp file to persistent scheduled directory
        const schedDir = path.join(os.tmpdir(), 'wacli-scheduled-files');
        if (!fs.existsSync(schedDir)) {
          fs.mkdirSync(schedDir, { recursive: true });
        }
        const persistentPath = path.join(schedDir, `${Date.now()}-${file.originalname}`);
        fs.renameSync(file.path, persistentPath);

        const item = scheduler.schedule({
          to,
          recipientName,
          message: caption || '',
          replyTo,
          filePath: persistentPath,
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
        next(err);
      }
    }
  );

  // GET /api/send/scheduled & /api/scheduled - list scheduled messages
  router.get(['/send/scheduled', '/scheduled'], (req: Request, res: Response) => {
    const chat = req.query.chat as string | undefined;
    const items = scheduler.getList(chat);
    res.json({
      success: true,
      data: items,
      error: null,
    });
  });

  // DELETE & POST cancel scheduled message
  router.delete(['/scheduled/:id', '/send/scheduled/:id'], (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const cancelled = id ? scheduler.cancel(id) : false;
    res.json({
      success: true,
      data: { cancelled },
      error: cancelled ? null : 'Scheduled message not found or not in pending state.',
    });
  });

  // POST resend a failed scheduled message. requireMutationPermission already
  // turns this away in safe read-only mode; the scheduler re-checks anyway so
  // the guarantee does not depend on which door the request came through.
  router.post(
    ['/scheduled/:id/resend', '/send/scheduled/:id/resend'],
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
  router.post(['/scheduled/:id/discard', '/send/scheduled/:id/discard'], (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const discarded = id ? scheduler.discard(id) : false;
    res.json({
      success: true,
      data: { discarded },
      error: discarded ? null : 'Scheduled message not found or not in failed state.',
    });
  });

  router.post(['/scheduled/:id/cancel', '/send/scheduled/:id/cancel'], (req: Request, res: Response) => {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const cancelled = id ? scheduler.cancel(id) : false;
    res.json({
      success: true,
      data: { cancelled },
      error: cancelled ? null : 'Scheduled message not found or not in pending state.',
    });
  });

  return router;
}
