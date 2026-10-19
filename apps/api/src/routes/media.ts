import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { refuseAsleep } from '../wacli/sleep.js';
import { logger } from '../logger.js';
import { mediaDownloads } from '../wacli/media-downloads.js';
import { isStoreLockMessage } from '../wacli/store-lock.js';
import { isTransientFailure, parseHttpStatus } from '../wacli/failures.js';
import { wacliSupports } from '../wacli/capabilities.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';

/**
 * Why a download failed, in the operator's terms.
 *
 * WhatsApp expires media on its servers, and an old thread routinely holds
 * messages the local store never backfilled. Both are the normal outcome of
 * scrolling back, not incidents — reporting them at ERROR is what turned an
 * ordinary scroll into pages of red. The message stays constant so a thread
 * full of expired attachments collapses into one line and a count.
 *
 * A timeout against WhatsApp's media host is not routine, so it stays at WARN —
 * but it gets a name of its own rather than falling through to `unknown`, which
 * is where every one of them used to land once the truncated URL had eaten the
 * cause. Note that the status is read from prose only: matching a bare `403`
 * against the whole message meant a media URL whose random path happened to
 * contain those digits was reported as expired.
 */
export function describeDownloadFailure(err: unknown): { reason: string; expected: boolean } {
  const message = err instanceof Error ? err.message : String(err);

  if (isStoreLockMessage(message)) return { reason: 'store-locked', expected: true };
  if (parseHttpStatus(message) === 403) return { reason: 'expired-on-whatsapp', expected: true };
  if (message.includes('no rows in result set')) return { reason: 'not-in-local-store', expected: true };
  if (isTransientFailure(message)) return { reason: 'whatsapp-unreachable', expected: false };

  return { reason: 'unknown', expected: false };
}

/**
 * Statuses with which WhatsApp's media host says the file is gone from it:
 * expired, or never kept. The phone that sent or received it may still have
 * it, and wacli 0.22 can ask (`--retry-on-phone`).
 */
const GONE_STATUSES = new Set([403, 404, 410]);

/**
 * What to tell the operator when asking the phone did not work. wacli reports
 * the outcome as `media recovery <status> for <chat>/<id>: ...`.
 */
function describePhoneRecoveryFailure(message: string): string | null {
  const status = /media recovery (\w+) for /.exec(message)?.[1];
  if (status === 'no_response') {
    // Silence is not deletion: an offline or asleep phone says nothing either.
    return 'Your phone did not answer in time. Make sure it is online, then ask again.';
  }
  if (status === 'not_on_phone') return 'Your phone no longer has this file either.';
  return null;
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
 * Resolves a caller-supplied media path and confirms it stays inside the
 * store's media directory. Without this the endpoint streams any file the API
 * process can read.
 *
 * The media directory, not the store: the store root also holds `session.db`,
 * the linked device's keys, and `wacli.db`, the whole archive. Neither is an
 * attachment, and serving them turned any page that could reach this route
 * into a copy of the account.
 */
export function resolveMediaPath(candidate: string): string | null {
  const resolved = realpathAllowingMissing(candidate);
  const root = realpathAllowingMissing(getMediaOutputDir());

  return resolved.startsWith(root + path.sep) ? resolved : null;
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

/**
 * What the browser is told a file is: only what this list says, by extension,
 * and anything else is opaque bytes. Never a guess from the name a download is
 * given, which the caller chooses.
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

/**
 * What this route and `send` say about the file itself. When serving fails
 * before anything has gone out, the error is answered in JSON, and these would
 * label that answer as the file: a 416 for a seek past the end arriving as
 * video/mp4, or as a download named after the attachment.
 */
const FILE_HEADERS = [
  'Content-Disposition',
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
  'ETag',
  'Last-Modified',
];

export function createMediaRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  // POST /api/media/download - trigger wacli media download for a message
  router.post('/media/download', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { chat, id, fromPhone } = req.body as { chat?: string; id?: string; fromPhone?: boolean };
      if (!chat || !id) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Both "chat" (JID) and "id" (msgId) are required.',
        });
        return;
      }

      const outputDir = getMediaOutputDir();
      const args = ['media', 'download', '--chat', chat, '--id', id, '--output', outputDir];
      let result: RawMediaDownloadResponse;

      if (fromPhone === true) {
        // Asking the phone is a request to WhatsApp and a write to the store,
        // which is exactly what safe mode is for refusing.
        if (modeManager.isReadOnly()) {
          res.status(403).json({
            success: false,
            data: null,
            error: 'Safe read-only mode is active. Asking your phone for media is disabled.',
          });
          return;
        }
        if (!(await wacliSupports('phoneMediaRecovery'))) {
          res.status(501).json({
            success: false,
            data: null,
            error: 'Asking your phone for media needs wacli 0.22 or later.',
          });
          return;
        }

        logger.info('media', 'Asking the phone for media WhatsApp no longer serves', { chat, id });
        try {
          // The daemon carries it out on its own connection, without pausing
          // and outside the send queue. With no daemon to take it, wacli makes
          // its own connection, and the daemon is held down meanwhile like
          // for any other command that needs the store.
          result = await processManager.runDelegated((lock) =>
            execWacli<RawMediaDownloadResponse>([...args, '--retry-on-phone'], {
              allowMutation: true,
              timeoutMs: 60000,
              ...lock,
            })
          );
        } catch (err) {
          const explained = describePhoneRecoveryFailure(err instanceof Error ? err.message : String(err));
          if (!explained) throw err;
          logger.info('media', 'The phone could not supply the media', { chat, id, err });
          res.status(404).json({ success: false, data: null, error: explained, code: 'PHONE_RECOVERY_FAILED' });
          return;
        }
        // The file is on disk now; forget that this message had failed.
        mediaDownloads.forget(`${chat}:${id}`);
      } else {
        logger.info('media', 'Downloading media', { chat, id });
        try {
          // An explicit retry from the operator always reaches wacli; replaying a
          // remembered failure would make the Retry button look broken.
          result = await mediaDownloads.run(
            `${chat}:${id}`,
            () => execWacli<RawMediaDownloadResponse>(args, { timeoutMs: 60000 }),
            { ignoreFailureCache: true }
          );
        } catch (err) {
          const status = parseHttpStatus(err instanceof Error ? err.message : String(err));
          if (status === null || !GONE_STATUSES.has(status)) throw err;
          // Not a fault, and worth saying plainly: the next step is the phone.
          logger.debug('media', 'Media gone from WhatsApp', { chat, id, status });
          res.status(410).json({
            success: false,
            data: null,
            error: 'WhatsApp no longer has this file. Your phone may still have it.',
            code: 'MEDIA_EXPIRED',
          });
          return;
        }
      }

      const localPath =
        (typeof result === 'object' && result !== null
          ? result.path || result.local_path || result.file_path
          : null) || null;

      res.json({
        success: true,
        data: {
          downloaded: true,
          localPath,
          // `cache`, `server` or `phone` on wacli 0.22; absent before.
          source: typeof result?.source === 'string' ? result.source : null,
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

      // Asleep, what is on disk is all there is. Scrolling a frozen thread asks
      // for every attachment on screen, and none of them may cost a wacli
      // download, or wake the app.
      if ((!filePath || !fs.existsSync(filePath)) && chat && id && modeManager.isSleeping()) {
        refuseAsleep(res);
        return;
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

      // A folder under media is not an attachment either, and `send` would
      // answer one as a server error.
      if (!filePath || !fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        res.status(404).json({
          success: false,
          data: null,
          error: 'Media file not found on disk or could not be downloaded.',
        });
        return;
      }

      // An SVG rendered inline executes script on this origin, which would give a
      // contact-supplied file access to the whole console. Always hand it over as
      // a download instead.
      const forceAttachment = isDownload || path.extname(filePath).toLowerCase() === '.svg';
      if (forceAttachment) {
        // Any name, a Hebrew one included: it goes out as RFC 6266 filename*.
        // Writing it into the header raw failed the whole download instead.
        res.attachment(customFilename || path.basename(filePath));
      } else {
        res.setHeader('Content-Disposition', 'inline');
      }
      // After attachment(), which sets a type from the name it was given — a
      // name the caller chose. The allowlist has the last word.
      res.setHeader('Content-Type', getMimeType(filePath));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Kept, but checked before each use: a repeat load is a 304 rather than
      // the whole file, and never a copy of something the store has replaced.
      res.setHeader('Cache-Control', 'no-cache');

      // Ranges for seeking audio and video, conditional requests, HEAD. The store
      // is usually ~/.wacli, which `send` would refuse as a dotfile path.
      res.sendFile(filePath, { dotfiles: 'allow' }, (err?: NodeJS.ErrnoException) => {
        // Done, or the client left first: a seek, a closed tab, a paused video.
        if (!err || err.code === 'ECONNABORTED') return;
        if (!res.headersSent) {
          // A 416, or a read that failed before the first byte. The error
          // handler answers it, with the headers the error carries.
          for (const header of FILE_HEADERS) res.removeHeader(header);
          next(err);
          return;
        }
        // A file deleted, unmounted or truncated while it was being served.
        // Headers are out, so there is no status left to send; cut the body off,
        // which the client sees as a truncated download.
        logger.warn('media', 'Media stream failed mid-body', { path: filePath, err });
        res.destroy();
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
