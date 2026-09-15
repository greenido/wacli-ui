import { execWacli } from './commands.js';
import { logger } from '../logger.js';
import type { RawGroup } from '../types.js';

/**
 * How long one read of the group table is trusted. wacli writes that table from
 * group metadata (`groups refresh` and its kin), never from the message stream,
 * so this is not racing incoming messages; it only bounds how long a refreshed
 * subject takes to show. The rail polls every 30s, so this costs one
 * `groups list` a minute rather than one per request.
 */
const GROUP_NAMES_TTL_MS = 60_000;

/**
 * `groups list` stops at 50 unless told otherwise. A group past the limit only
 * falls back to wacli's own name for it, so this just has to clear any real
 * account comfortably.
 */
const GROUP_NAMES_LIMIT = 10_000;

const NONE: ReadonlyMap<string, string> = new Map();

let known: ReadonlyMap<string, string> | null = null;
let expiresAt = 0;
let inFlight: Promise<ReadonlyMap<string, string>> | null = null;

/** Test seam: the cache is module state, so suites must be able to clear it. */
export function resetGroupNameCache(): void {
  known = null;
  expiresAt = 0;
  inFlight = null;
}

/**
 * Group subjects by JID, from wacli's group table.
 *
 * wacli's chat row cannot be trusted to name a group. Every incoming message
 * rewrites it with whatever wacli's `ResolveChatName` returns, and when the
 * live group-info lookup behind that fails, it falls back to the message's
 * push name — the *sender's* — or failing that to the bare JID. An active group
 * ended up wearing the name of whoever last spoke in it, a reaction included:
 * on one real account 302 of 367 named groups carried a member's name or the
 * group's own JID. Messages are stamped with the same value, and the webhook's
 * `ChatName` is read straight off that row.
 *
 * The group table is written only from group metadata, so its subject is never
 * a person. A group missing from it keeps wacli's name, as before.
 */
export async function fetchGroupNames(): Promise<ReadonlyMap<string, string>> {
  if (known && Date.now() < expiresAt) {
    return known;
  }

  if (inFlight) {
    return inFlight;
  }

  inFlight = readGroupNames().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Whatever was last read, without waiting on wacli. For the live message path:
 * a webhook is not held for a subprocess, and the rail's poll keeps this warm.
 */
export function cachedGroupNames(): ReadonlyMap<string, string> {
  return known ?? NONE;
}

/** The message, with its group's subject in place of the chat name wacli stamped on it. */
export function withGroupSubject<T extends { chatJid: string; chatName: string }>(
  msg: T,
  groupNames: ReadonlyMap<string, string>
): T {
  const subject = groupNames.get(msg.chatJid);
  return subject ? { ...msg, chatName: subject } : msg;
}

async function readGroupNames(): Promise<ReadonlyMap<string, string>> {
  try {
    const raw = await execWacli<RawGroup[] | null>([
      'groups',
      'list',
      '--limit',
      String(GROUP_NAMES_LIMIT),
    ]);

    const names = new Map<string, string>();
    for (const group of Array.isArray(raw) ? raw : []) {
      const name = (group.Name ?? '').trim();
      if (group.JID && name) names.set(group.JID, name);
    }

    known = names;
    expiresAt = Date.now() + GROUP_NAMES_TTL_MS;
    return names;
  } catch (err) {
    // Best-effort, like the previews: a name is a nicety, so a failure must
    // never cost the operator their chat list. Not cached, so the next request
    // tries again — and until then the last good read beats reverting every
    // group to the name wacli stamped on it.
    logger.warn('api', 'Group names unavailable', { err });
    return known ?? NONE;
  }
}
