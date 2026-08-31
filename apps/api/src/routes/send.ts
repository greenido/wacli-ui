import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import os from 'node:os';
import fs from 'node:fs';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
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
    logger.warn('send', `Blocked send attempt while read-only safe mode active (${req.path})`);
    res.status(403).json({
      success: false,
      data: null,
      error: 'Safe read-only mode is active. Outgoing sends and reactions are disabled.',
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

      logger.info('send', `Dispatching text to ${to} (replyTo: ${replyTo || 'none'})`);

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
  router.post(
    '/send/file',
    upload.single('file'),
    requireMutationPermission,
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

        logger.info('send', `Dispatching file ${file.originalname} (${file.size} bytes) to ${to}`);

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

      logger.info('send', `Dispatching reaction "${reaction ?? '👍'}" to msg ${id} in ${to}`);

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

  return router;
}
