import { Router } from 'express';
import { execWacli } from '../wacli/commands.js';
import { wacliSupports } from '../wacli/capabilities.js';
import { logger } from '../logger.js';
import { queryString } from './query.js';

/**
 * Which chats' messages changed since the console last asked, from wacli's
 * change feed (`messages changes`, wacli 0.22+).
 *
 * The feed records every insert, edit and deletion in the message table, with
 * no message content, behind an opaque checkpoint. One small read here tells
 * the console exactly which threads to refetch, where before it re-read the
 * newest page of the open thread and the whole rail on a timer whether
 * anything had changed or not, and never re-read history it had paged back to.
 *
 * What it does not cover: receipts and chat state (pins, mutes, unread counts)
 * live in other tables, so the console keeps a slow poll for those.
 */

interface RawChange {
  operation?: string;
  chat_jid?: string;
  new_chat_jid?: string;
}

interface RawChangesPage {
  changes?: RawChange[] | null;
  has_more?: boolean;
  next_checkpoint?: string;
}

export interface ChangesAnswer {
  /** False on a wacli without the feed; the console keeps its old polling. */
  supported: boolean;
  /** Where to ask from next time. */
  checkpoint: string | null;
  /** Every chat with a changed message, once each. */
  chats: string[];
  /**
   * Start over: the checkpoint was new, expired, or from another store, or
   * more changed than one answer carries. The console refreshes everything.
   */
  reset: boolean;
}

/** Changes read per call; past this the console just refreshes everything. */
const PAGE_LIMIT = 1000;
const MAX_PAGES = 3;

/** What a checkpoint looks like: wacli's base64url token. Nothing else reaches the command line. */
const CHECKPOINT = /^[A-Za-z0-9_-]{1,2048}$/;

/** A checkpoint wacli will not read from, for a reason that a fresh one fixes. */
function checkpointRefused(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('expired checkpoint') ||
    message.includes('another store') ||
    message.includes('invalid checkpoint') ||
    message.includes('unsupported checkpoint') ||
    message.includes('malformed cursor/checkpoint')
  );
}

/**
 * A wacli that cannot serve the feed at all: an old store not yet migrated by
 * a writable open, or a build without the command.
 */
function feedUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('writable store migration') || message.includes('unknown command');
}

async function freshCheckpoint(): Promise<string | null> {
  const page = await execWacli<RawChangesPage>(['messages', 'changes', '--checkpoint']);
  return page?.next_checkpoint || null;
}

export function createChangesRouter(): Router {
  const router = Router();

  router.get('/changes', async (req, res, next) => {
    const unsupported: ChangesAnswer = { supported: false, checkpoint: null, chats: [], reset: false };
    try {
      if (!(await wacliSupports('changeFeed'))) {
        res.json({ success: true, data: unsupported, error: null });
        return;
      }

      const since = queryString(req, 'since');
      // `beginning` is wacli's word for the whole history of changes, which is a
      // full replay, not something the console ever needs.
      if (since !== undefined && (!CHECKPOINT.test(since) || since === 'beginning')) {
        res.status(400).json({ success: false, data: null, error: 'Query parameter "since" is not a checkpoint.' });
        return;
      }

      const startOver = async (): Promise<ChangesAnswer> => ({
        supported: true,
        checkpoint: await freshCheckpoint(),
        chats: [],
        reset: true,
      });

      let answer: ChangesAnswer;
      if (!since) {
        answer = await startOver();
      } else {
        const chats = new Set<string>();
        let checkpoint = since;
        let more = true;
        let pages = 0;
        try {
          while (more && pages < MAX_PAGES) {
            // `=` form: a checkpoint can start with "-", which would read as a flag.
            const page = await execWacli<RawChangesPage>([
              'messages',
              'changes',
              `--since=${checkpoint}`,
              '--limit',
              String(PAGE_LIMIT),
            ]);
            for (const change of page?.changes ?? []) {
              if (change.chat_jid) chats.add(change.chat_jid);
              if (change.new_chat_jid) chats.add(change.new_chat_jid);
            }
            checkpoint = page?.next_checkpoint || checkpoint;
            more = page?.has_more === true;
            pages += 1;
          }
          answer = more
            ? // Too much to list: refreshing everything costs less than naming it.
              { supported: true, checkpoint, chats: [], reset: true }
            : { supported: true, checkpoint, chats: [...chats], reset: false };
        } catch (err) {
          if (!checkpointRefused(err)) throw err;
          logger.info('api', 'Change feed checkpoint refused; starting over', { err });
          answer = await startOver();
        }
      }

      if (answer.chats.length > 0 || answer.reset) {
        logger.debug('api', 'Change feed read', { chats: answer.chats.length, reset: answer.reset });
      }
      res.json({ success: true, data: answer, error: null });
    } catch (err) {
      if (feedUnavailable(err)) {
        logger.warn('api', 'wacli cannot serve the change feed; the console keeps polling', { err });
        res.json({ success: true, data: unsupported, error: null });
        return;
      }
      next(err);
    }
  });

  return router;
}
