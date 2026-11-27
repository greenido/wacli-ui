import { Router } from 'express';
import { execWacli, WacliCommandError } from '../wacli/commands.js';
import { collapseCallEvents } from '../wacli/calls.js';
import type { RawCallEvent } from '../types.js';
import { QueryParamError, queryString } from './query.js';

/**
 * How far past the asked-for window events are read. A call's events span up
 * to a few minutes, and a group call's up to an hour; cut at the edge, a call
 * would lose its offer and come back as the wrong call at the wrong time.
 */
const EVENT_MARGIN_MS = 60 * 60_000;

/** Every event in the window, at roughly 350 bytes each — well inside the output cap. */
const EVENT_LIMIT = 5000;

/** How an older wacli, from before `calls`, refuses the command. */
const NO_CALLS_COMMAND = /unknown command/i;

function timeParam(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new QueryParamError(`Query parameter "${name}" must be a date or time.`);
  }
  return ms;
}

export function createCallsRouter(): Router {
  const router = Router();

  // GET /api/calls?chat=<jid>&after=<time>&before=<time> - one chat's calls,
  // one record per call, oldest first.
  router.get('/calls', async (req, res, next) => {
    try {
      const chat = queryString(req, 'chat');
      if (!chat) {
        res.status(400).json({ success: false, data: null, error: 'Query parameter "chat" (JID) is required.' });
        return;
      }
      const after = timeParam('after', queryString(req, 'after'));
      const before = timeParam('before', queryString(req, 'before'));

      // Not `--chat`: the phone's own accept or decline is filed under our
      // JID, not the caller's, and only grouping by call id puts it back.
      const args = ['calls', 'list', '--limit', String(EVENT_LIMIT)];
      if (after !== undefined) args.push('--after', new Date(after - EVENT_MARGIN_MS).toISOString());
      if (before !== undefined) args.push('--before', new Date(before + EVENT_MARGIN_MS).toISOString());

      let rows: RawCallEvent[];
      try {
        const raw = await execWacli<{ calls: RawCallEvent[] | null }>(args);
        rows = raw?.calls ?? [];
      } catch (err) {
        if (err instanceof WacliCommandError && NO_CALLS_COMMAND.test(err.message)) {
          res.json({ success: true, data: { calls: [], supported: false }, error: null });
          return;
        }
        throw err;
      }

      const calls = collapseCallEvents(rows).filter((call) => {
        if (call.chatJid !== chat) return false;
        const at = Date.parse(call.ts);
        return (after === undefined || at >= after) && (before === undefined || at <= before);
      });

      res.json({ success: true, data: { calls, supported: true }, error: null });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
