import { Router, type Request, type Response } from 'express';
import { execWacli, WacliCommandError } from '../wacli/commands.js';
import { bookmarkStore } from '../wacli/bookmarks.js';
import { normalizeMessage } from '../wacli/normalize.js';
import { fetchGroupNames, withGroupSubject } from '../wacli/group-names.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

interface RawMessagesListResponse {
  fts?: boolean;
  messages: RawMessage[] | null;
  /** wacli 0.22+. */
  page?: { has_more?: boolean; next_cursor?: string };
}

/**
 * Whether there is more past this page: wacli's own answer when it gives one
 * (0.22, from one extra row it reads), otherwise the guess that a full page has
 * a next — which costs an empty fetch at the end of every history.
 *
 * `page.next_cursor` is deliberately not used for paging. Any write to the
 * store invalidates every cursor, and the sync daemon writes each message as
 * it arrives, so in a live chat a cursor would rarely survive to be used. The
 * thread keeps paging by timestamp and dedupes by message id instead.
 */
function hasMoreFrom(raw: RawMessagesListResponse | RawMessage[] | null, count: number, limit: number): boolean {
  if (raw && !Array.isArray(raw) && typeof raw.page?.has_more === 'boolean') {
    return raw.page.has_more;
  }
  return count >= limit;
}

/**
 * Export is capped well below `execWacli`'s 10 MB output buffer — roughly
 * 800 bytes a message in practice — so a long conversation comes back
 * truncated rather than as an unparseable half-response.
 */
const EXPORT_DEFAULT_LIMIT = 1000;
const EXPORT_MAX_LIMIT = 5000;

/** How `messages show` says the store has no such message. */
const NOT_STORED = /no rows in result set|not found/i;

export function createMessagesRouter(): Router {
  const router = Router();

  router.get('/messages', async (req, res, next) => {
    try {
      const args = ['messages', 'list'];

      const chat = req.query.chat as string | undefined;
      const limit = req.query.limit as string | undefined;
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;
      const asc = req.query.asc;

      if (chat) args.push('--chat', chat);
      if (limit) args.push('--limit', limit);
      if (before) args.push('--before', before);
      if (after) args.push('--after', after);
      if (asc === 'true') args.push('--asc');

      const raw = await execWacli<RawMessagesListResponse | RawMessage[]>(args);
      let rawList: RawMessage[] = [];

      if (Array.isArray(raw)) {
        rawList = raw;
      } else if (raw && Array.isArray(raw.messages)) {
        rawList = raw.messages;
      }

      const messages: UnifiedMessage[] = rawList.map((m) => {
        const norm = normalizeMessage(m);
        norm.bookmarked = Boolean(norm.msgId) && bookmarkStore.has(norm.msgId);
        return norm;
      });

      res.json({
        success: true,
        data: {
          messages,
          hasMore: hasMoreFrom(raw, messages.length, Number(limit || 50)),
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/messages/show - one message by id, wherever it sits in the archive.
  // A reply names the message it quotes by id alone, and jumping to one that
  // is not loaded needs its time to open a window around it.
  router.get('/messages/show', async (req, res, next) => {
    try {
      const chat = req.query.chat as string | undefined;
      const id = req.query.id as string | undefined;
      if (!chat || !id) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Query parameters "chat" (JID) and "id" are required.',
        });
        return;
      }

      let raw: RawMessage;
      try {
        raw = await execWacli<RawMessage>(['messages', 'show', '--chat', chat, '--id', id]);
      } catch (err) {
        // A quote often points past what sync ever pulled. That is an answer,
        // not a fault: the archive does not hold it.
        if (err instanceof WacliCommandError && NOT_STORED.test(err.message)) {
          res.status(404).json({
            success: false,
            data: null,
            error: 'That message is not in the local archive.',
          });
          return;
        }
        throw err;
      }

      const message = normalizeMessage(raw);
      message.bookmarked = Boolean(message.msgId) && bookmarkStore.has(message.msgId);
      res.json({ success: true, data: message, error: null });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/messages/export - a whole conversation, for keeping or reading elsewhere
  router.get('/messages/export', async (req, res, next) => {
    try {
      const chat = req.query.chat as string | undefined;
      if (!chat) {
        res.status(400).json({
          success: false,
          data: null,
          error: 'Query parameter "chat" (JID) is required.',
        });
        return;
      }

      const requested = Number(req.query.limit ?? EXPORT_DEFAULT_LIMIT);
      const limit = Number.isFinite(requested)
        ? Math.min(Math.max(Math.trunc(requested), 1), EXPORT_MAX_LIMIT)
        : EXPORT_DEFAULT_LIMIT;

      const args = ['messages', 'export', '--chat', chat, '--limit', String(limit)];
      const before = req.query.before as string | undefined;
      const after = req.query.after as string | undefined;
      if (before) args.push('--before', before);
      if (after) args.push('--after', after);

      const [raw, groupNames] = await Promise.all([
        execWacli<RawMessagesListResponse | RawMessage[]>(args, { timeoutMs: 60000 }),
        fetchGroupNames(),
      ]);
      const rawList = Array.isArray(raw) ? raw : (raw?.messages ?? []);
      const messages = rawList.map((m) => {
        // The first message's chat name heads the transcript.
        const norm = withGroupSubject(normalizeMessage(m), groupNames);
        norm.bookmarked = Boolean(norm.msgId) && bookmarkStore.has(norm.msgId);
        return norm;
      });

      res.json({
        success: true,
        data: {
          chatJid: chat,
          chatName: messages[0]?.chatName ?? chat.split('@')[0],
          exportedAt: new Date().toISOString(),
          count: messages.length,
          // Say so rather than letting the operator assume they have it all.
          truncated: hasMoreFrom(raw, messages.length, limit),
          messages,
        },
        error: null,
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/messages/bookmark - toggle this machine's local bookmark.
  // Bookmarks are local-only state, so unlike a send or a chat mutation they
  // are still allowed while safe read-only mode is on: nothing reaches WhatsApp
  // or the wacli store.
  router.post('/messages/bookmark', (req: Request, res: Response) => {
    const { chat, id, bookmarked } = req.body as {
      chat?: string;
      id?: string;
      bookmarked?: boolean;
    };

    if (!chat || !id) {
      res.status(400).json({
        success: false,
        data: null,
        error: 'Both "chat" and "id" are required.',
      });
      return;
    }

    const next = bookmarked !== undefined ? Boolean(bookmarked) : true;
    bookmarkStore.set(id, chat, next);

    res.json({
      success: true,
      data: { chat, id, bookmarked: next },
      error: null,
    });
  });

  return router;
}
