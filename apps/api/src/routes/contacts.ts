import { Router, type Request, type Response, type NextFunction } from 'express';
import { execWacli } from '../wacli/commands.js';
import { modeManager } from '../wacli/mode.js';
import { normalizeContact, normalizeGroup } from '../wacli/normalize.js';
import { tagStore } from '../wacli/tags.js';
import { logger } from '../logger.js';
import type { WacliProcessManager } from '../wacli/process-manager.js';
import type { RawContact, RawGroup } from '../types.js';

/**
 * An alias is written into wacli's own contact table, so it is a mutation. Tags
 * are not: they live in Mission Control's file and never reach wacli or
 * WhatsApp, so they stay available in safe read-only mode, exactly like
 * bookmarks.
 */
function requireMutationPermission(req: Request, res: Response, next: NextFunction): void {
  const customHeader = req.headers['x-mission-control-request'];
  if (!customHeader && process.env.NODE_ENV !== 'test') {
    res.status(400).json({
      success: false,
      data: null,
      error: 'Missing required "X-Mission-Control-Request: 1" header.',
    });
    return;
  }

  if (modeManager.isReadOnly()) {
    res.status(403).json({
      success: false,
      data: null,
      error: 'Safe read-only mode is active. Aliases are written to the wacli store and are disabled.',
    });
    return;
  }

  next();
}

function requireUiRequest(req: Request, res: Response, next: NextFunction): void {
  const customHeader = req.headers['x-mission-control-request'];
  if (!customHeader && process.env.NODE_ENV !== 'test') {
    res.status(400).json({
      success: false,
      data: null,
      error: 'Missing required "X-Mission-Control-Request: 1" header.',
    });
    return;
  }
  next();
}

export function createContactsRouter(processManager: WacliProcessManager): Router {
  const router = Router();

  // GET /api/contacts/show - one contact's local metadata
  router.get('/contacts/show', async (req, res, next) => {
    try {
      const jid = req.query.jid as string | undefined;
      if (!jid) {
        res.status(400).json({ success: false, data: null, error: 'Query parameter "jid" is required.' });
        return;
      }

      try {
        const raw = await execWacli<RawContact>(['contacts', 'show', '--jid', jid]);
        res.json({
          success: true,
          data: { ...normalizeContact(raw), tags: tagStore.get(jid) },
          error: null,
        });
      } catch (err) {
        // wacli answers "sql: no rows in result set" for a JID it has never
        // synced. That is an ordinary state for a new conversation, not a
        // failure worth a 500 — answer with what is actually known.
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('no rows in result set')) throw err;

        res.json({
          success: true,
          data: {
            jid,
            phone: jid.split('@')[0],
            name: '',
            alias: '',
            systemName: '',
            updatedAt: null,
            tags: tagStore.get(jid),
            known: false,
          },
          error: null,
        });
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /api/groups - local group metadata
  router.get('/groups', async (req, res, next) => {
    try {
      const query = req.query.query as string | undefined;
      const args = ['groups', 'list', '--limit', '200'];
      if (query) args.push('--query', query);

      const raw = await execWacli<RawGroup[]>(args);
      const groups = (Array.isArray(raw) ? raw : []).map(normalizeGroup);

      res.json({ success: true, data: groups, error: null });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/contacts/alias - set or clear the local alias wacli stores
  router.post('/contacts/alias', requireMutationPermission, async (req, res, next) => {
    try {
      const { jid, alias } = req.body as { jid?: string; alias?: string };

      if (!jid || typeof jid !== 'string') {
        res.status(400).json({ success: false, data: null, error: 'Field "jid" is required.' });
        return;
      }

      const trimmed = (alias ?? '').trim();
      const args = trimmed
        ? ['contacts', 'alias', 'set', '--jid', jid, '--alias', trimmed]
        : ['contacts', 'alias', 'rm', '--jid', jid];

      logger.info('api', `${trimmed ? 'Setting' : 'Clearing'} local alias for ${jid}`);

      await processManager.executeExclusive(async () => {
        await execWacli(args, { allowMutation: true });
      });

      res.json({ success: true, data: { jid, alias: trimmed }, error: null });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/tags - every tag in use, plus the full jid -> tags map
  router.get('/tags', (_req, res) => {
    res.json({
      success: true,
      data: { tags: tagStore.allTags(), byJid: tagStore.all() },
      error: null,
    });
  });

  // POST /api/tags - add or remove one of this machine's own labels
  router.post('/tags', requireUiRequest, (req: Request, res: Response) => {
    const { jid, tag, add } = req.body as { jid?: string; tag?: string; add?: boolean };

    if (!jid || !tag) {
      res.status(400).json({ success: false, data: null, error: 'Both "jid" and "tag" are required.' });
      return;
    }

    const tags = add === false ? tagStore.remove(jid, tag) : tagStore.add(jid, tag);
    res.json({ success: true, data: { jid, tags }, error: null });
  });

  return router;
}
