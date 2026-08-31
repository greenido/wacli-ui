import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { execWacli } from '../wacli/commands.js';
import { logger } from '../logger.js';

interface RawMediaDownloadResponse {
  path?: string;
  local_path?: string;
  file_path?: string;
  [key: string]: unknown;
}

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg; codecs=opus',
  '.oga': 'audio/ogg; codecs=opus',
  '.opus': 'audio/ogg; codecs=opus',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function createMediaRouter(): Router {
  const router = Router();

  // POST /api/media/download - trigger wacli media download for a message
  router.post('/media/download', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { chat, id } = req.body as { chat?: string; id?: string };
      if (!chat || !id) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Both "chat" (JID) and "id" (msgId) are required.',
        });
        return;
      }

      logger.info('media', `Downloading media for msg ${id} in ${chat}`);
      const args = ['media', 'download', '--chat', chat, '--id', id];
      const result = await execWacli<RawMediaDownloadResponse>(args, {
        timeoutMs: 60000,
      });

      const localPath =
        (typeof result === 'object' && result !== null
          ? result.path || result.local_path || result.file_path
          : null) || null;

      res.json({
        success: true,
        data: {
          downloaded: true,
          localPath,
          details: result,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/media/content - stream image/audio/video/document with range support
  router.get('/media/content', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const chat = req.query.chat as string | undefined;
      const id = req.query.id as string | undefined;
      let filePath = req.query.path as string | undefined;
      const isDownload = req.query.download === '1' || req.query.download === 'true';
      const customFilename = req.query.filename as string | undefined;

      // If filePath not given or file doesn't exist, try downloading via wacli if chat & id provided
      if ((!filePath || !fs.existsSync(filePath)) && chat && id) {
        try {
          const args = ['media', 'download', '--chat', chat, '--id', id];
          const result = await execWacli<RawMediaDownloadResponse>(args, {
            timeoutMs: 60000,
          });

          if (result && typeof result === 'object') {
            filePath = result.path || result.local_path || result.file_path || filePath;
          }
        } catch (downloadErr) {
          logger.warn('media', `Failed auto-download for ${id}: ${String(downloadErr)}`);
        }
      }

      if (!filePath || !fs.existsSync(filePath)) {
        res.status(404).json({
          success: false,
          data: null,
          error: 'Media file not found on disk or could not be downloaded.',
        });
        return;
      }

      const stat = fs.statSync(filePath);
      const contentType = getMimeType(filePath);
      const basename = customFilename || path.basename(filePath);

      // Support HTTP byte range requests for audio / video streaming & seeking
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunksize = end - start + 1;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunksize,
          'Content-Type': contentType,
          'Content-Disposition': isDownload ? `attachment; filename="${basename}"` : 'inline',
        });
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': isDownload ? `attachment; filename="${basename}"` : 'inline',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
