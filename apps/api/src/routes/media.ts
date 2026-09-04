import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { logger } from '../logger.js';
import { mediaDownloads } from '../wacli/media-downloads.js';
import { isStoreLockMessage } from '../wacli/store-lock.js';

/**
 * Why a download failed, in the operator's terms.
 *
 * WhatsApp expires media on its servers, and an old thread routinely holds
 * messages the local store never backfilled. Both are the normal outcome of
 * scrolling back, not incidents — reporting them at ERROR is what turned an
 * ordinary scroll into pages of red. The message stays constant so a thread
 * full of expired attachments collapses into one line and a count.
 */
function describeDownloadFailure(err: unknown): { reason: string; expected: boolean } {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes('403')) return { reason: 'expired-on-whatsapp', expected: true };
  if (message.includes('no rows in result set')) return { reason: 'not-in-local-store', expected: true };
  if (isStoreLockMessage(message)) return { reason: 'store-locked', expected: true };

  return { reason: 'unknown', expected: false };
}

interface RawMediaDownloadResponse {
  path?: string;
  local_path?: string;
  file_path?: string;
  [key: string]: unknown;
}

function getStoreDir(): string {
  const settings = modeManager.getSettings();
  const defaultStore = process.platform === 'linux'
    ? path.join(os.homedir(), '.local/state/wacli')
    : path.join(os.homedir(), '.wacli');
  return settings.storeDir ?? process.env.WACLI_STORE_DIR ?? defaultStore;
}

function getMediaOutputDir(): string {
  const mediaDir = path.join(getStoreDir(), 'media');
  try {
    fs.mkdirSync(mediaDir, { recursive: true });
  } catch {
    // ignore
  }
  return mediaDir;
}

/**
 * Resolves a caller-supplied media path and confirms it stays inside the wacli
 * store. Without this the endpoint streams any file the API process can read.
 */
export function resolveMediaPath(candidate: string): string | null {
  const resolved = realpathAllowingMissing(candidate);
  const roots = [getStoreDir(), getMediaOutputDir()].map(realpathAllowingMissing);

  const isContained = roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );

  return isContained ? resolved : null;
}

/**
 * realpath that tolerates a missing leaf. Resolving symlinks matters because a
 * store under a symlinked directory (macOS /tmp, a symlinked home) would
 * otherwise fail containment; tolerating a missing leaf keeps "not downloaded
 * yet" a 404 instead of a spurious 403.
 */
function realpathAllowingMissing(target: string): string {
  const absolute = path.resolve(target);
  let existing = absolute;
  const trailing: string[] = [];

  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...trailing);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute; // hit the filesystem root
      trailing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/** Strips characters that would break out of the quoted Content-Disposition value. */
function sanitizeFilename(name: string): string {
  return path.basename(name).replace(/["\\\r\n]/g, '_') || 'download';
}

/**
 * Parses a single byte range, clamped to the file. Returns null for absent,
 * malformed, or unsatisfiable ranges so the caller falls back to a full body —
 * previously a suffix range like `bytes=-500` produced NaN offsets and threw.
 */
export function parseRangeHeader(
  header: string,
  size: number
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return null;

  const [, rawStart, rawEnd] = match;
  let start: number;
  let end: number;

  if (rawStart === '') {
    if (rawEnd === '') return null;
    // Suffix range: the last N bytes.
    const suffixLength = Number(rawEnd);
    if (suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;

  return { start, end };
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

      logger.info('media', 'Downloading media', { chat, id });
      const outputDir = getMediaOutputDir();
      const args = ['media', 'download', '--chat', chat, '--id', id, '--output', outputDir];
      // An explicit retry from the operator always reaches wacli; replaying a
      // remembered failure would make the Retry button look broken.
      const result = await mediaDownloads.run(
        `${chat}:${id}`,
        () => execWacli<RawMediaDownloadResponse>(args, { timeoutMs: 60000 }),
        { ignoreFailureCache: true }
      );

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
      const requestedPath = req.query.path as string | undefined;
      const isDownload = req.query.download === '1' || req.query.download === 'true';
      const customFilename = req.query.filename as string | undefined;

      // Reject out-of-store paths up front rather than treating them as "missing"
      // and silently re-downloading over them.
      let filePath: string | undefined;
      if (requestedPath) {
        const safePath = resolveMediaPath(requestedPath);
        if (!safePath) {
          logger.warn('media', 'Rejected out-of-store media path', { requestedPath });
          res.status(403).json({
            success: false,
            data: null,
            error: 'Requested path is outside the wacli media store.',
          });
          return;
        }
        filePath = safePath;
      }

      // If filePath not given or file doesn't exist, try downloading via wacli if chat & id provided
      if ((!filePath || !fs.existsSync(filePath)) && chat && id) {
        try {
          const outputDir = getMediaOutputDir();
          const args = ['media', 'download', '--chat', chat, '--id', id, '--output', outputDir];
          // Every attachment in a freshly opened thread lands here at once, so
          // this is the path that has to be capped, deduped and cached.
          const result = await mediaDownloads.run(`${chat}:${id}`, () =>
            execWacli<RawMediaDownloadResponse>(args, { timeoutMs: 60000 })
          );

          if (result && typeof result === 'object') {
            const downloaded = result.path || result.local_path || result.file_path;
            if (downloaded) {
              filePath = resolveMediaPath(downloaded) ?? filePath;
            }
          }
        } catch (downloadErr) {
          const { reason, expected } = describeDownloadFailure(downloadErr);
          const fields = { chat, id, reason, err: downloadErr };

          if (expected) {
            logger.debug('media', 'Media unavailable', fields);
          } else {
            logger.warn('media', 'Auto-download failed', fields);
          }
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
      const basename = sanitizeFilename(customFilename || path.basename(filePath));

      // An SVG rendered inline executes script on this origin, which would give a
      // contact-supplied file access to the whole console. Always hand it over as
      // a download instead.
      const forceAttachment = isDownload || path.extname(filePath).toLowerCase() === '.svg';
      const disposition = forceAttachment ? `attachment; filename="${basename}"` : 'inline';

      // Support HTTP byte range requests for audio / video streaming & seeking
      const range = req.headers.range;
      const parsedRange = range ? parseRangeHeader(range, stat.size) : null;

      if (parsedRange) {
        const { start, end } = parsedRange;
        const fileStream = fs.createReadStream(filePath, { start, end });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': contentType,
          'Content-Disposition': disposition,
          'X-Content-Type-Options': 'nosniff',
        });
        fileStream.pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': stat.size,
          'Content-Type': contentType,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': disposition,
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(filePath).pipe(res);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
