import type { DatabaseSync } from 'node:sqlite';
import { getDb, openDatabaseAt } from '../db/index.js';
import { logger } from '../logger.js';
import { messagePreviewText } from './normalize.js';
import type { UnifiedMessage } from '../types.js';

/**
 * Only direct chats. In a group, "no reply since" has no good answer: a
 * message there is rarely a question to everyone, the next thing anybody says
 * is usually about something else, and the read count is one per member. A
 * group counted as answered by any message would clear almost every row; one
 * counted only by the person asked would need to know who that was. Both would
 * fill the tab with noise, so groups wait for a rule worth having.
 *
 * A direct chat is a phone-number JID or, on newer accounts, a LID one.
 * Broadcast lists, status updates and channels are none of these.
 */
export function isDirectChat(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

/** The other phone has the message: a receipt said delivered, read or played. */
function reachedThem(msg: UnifiedMessage): boolean {
  return msg.deliveryStatus === 'delivered' || msg.deliveryStatus === 'read' || msg.deliveryStatus === 'played';
}

/**
 * Whether a message is something said. Reactions are not, and neither is a
 * protocol row with no body and no media, which is how wacli stores things
 * like a change to disappearing messages. A message the other side deleted
 * still counts: they did answer, and then thought better of it.
 */
function isConversation(msg: UnifiedMessage): boolean {
  if (msg.reactionToId) return false;
  return messagePreviewText(msg) !== '';
}

function instant(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * The operator's messages that are still waiting on an answer: one per direct
 * chat, the newest one the other side has received, as long as nothing they
 * said is as new as it. Oldest first, since that is the one most overdue.
 *
 * Built only from order and `FromMe`, never from when a receipt arrived. wacli
 * keeps receipt counts, not receipt times, and a reply regularly lands before
 * the read receipt does, so the message can still say "delivered" while the
 * answer is already in the chat. A reply in the same second counts as one,
 * because the archive's timestamps cannot say which came first and a missed
 * nudge costs less than a wrong one.
 *
 * `FromMe` covers every device on the account, so a message sent from the
 * operator's phone waits here like one sent from this console.
 */
export function findWaiting(messages: readonly UnifiedMessage[]): UnifiedMessage[] {
  const latestTheirs = new Map<string, number>();
  const latestMine = new Map<string, UnifiedMessage>();

  for (const msg of messages) {
    if (!msg.chatJid || !isDirectChat(msg.chatJid) || !isConversation(msg)) continue;
    const at = instant(msg.ts);

    if (!msg.fromMe) {
      latestTheirs.set(msg.chatJid, Math.max(at, latestTheirs.get(msg.chatJid) ?? -Infinity));
      continue;
    }
    // A message the operator deleted is not one to chase.
    if (msg.revoked || !reachedThem(msg)) continue;
    const current = latestMine.get(msg.chatJid);
    if (!current || at > instant(current.ts)) latestMine.set(msg.chatJid, msg);
  }

  const waiting: UnifiedMessage[] = [];
  for (const [chatJid, msg] of latestMine) {
    const replied = latestTheirs.get(chatJid);
    if (replied === undefined || replied < instant(msg.ts)) waiting.push(msg);
  }
  return waiting.sort((a, b) => instant(a.ts) - instant(b.ts));
}

export interface WaitingMark {
  dismissed: boolean;
  snoozedUntil: string | null;
}

interface WaitingMarkRow {
  msg_id: string;
  dismissed_at: string | null;
  snoozed_until: string | null;
}

const BATCH_CHUNK_SIZE = 500;

/**
 * The operator's decisions about waiting messages: dismissed for good, or
 * snoozed until a time. Local state like bookmarks, so it stays writable in
 * safe read-only mode; nothing here reaches WhatsApp or the wacli store.
 */
export class WaitingStore {
  /** Set only when a caller asked for its own file, so tests get one store per case. */
  private ownDb: DatabaseSync | null = null;

  constructor(customDbPath?: string) {
    this.ownDb = customDbPath ? openDatabaseAt(customDbPath) : null;
  }

  private db(): DatabaseSync {
    return this.ownDb ?? getDb();
  }

  public dismiss(msgId: string, chatJid: string): void {
    const now = new Date().toISOString();
    this.db()
      .prepare(
        `INSERT INTO waiting_marks (msg_id, chat_jid, dismissed_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(msg_id) DO UPDATE SET
           dismissed_at = COALESCE(waiting_marks.dismissed_at, excluded.dismissed_at),
           updated_at   = excluded.updated_at`
      )
      .run(msgId, chatJid, now, now);
  }

  /** Moves the reminder rather than adding one; a later call wins. */
  public snooze(msgId: string, chatJid: string, until: string): void {
    this.db()
      .prepare(
        `INSERT INTO waiting_marks (msg_id, chat_jid, snoozed_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(msg_id) DO UPDATE SET
           snoozed_until = excluded.snoozed_until,
           updated_at    = excluded.updated_at`
      )
      .run(msgId, chatJid, until, new Date().toISOString());
  }

  /** The marks on any of `msgIds`, in as few queries as the batch allows. */
  public marksFor(msgIds: readonly string[]): Map<string, WaitingMark> {
    const marks = new Map<string, WaitingMark>();
    const ids = msgIds.filter(Boolean);
    try {
      for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
        const slice = ids.slice(i, i + BATCH_CHUNK_SIZE);
        const rows = this.db()
          .prepare(
            `SELECT msg_id, dismissed_at, snoozed_until FROM waiting_marks
             WHERE msg_id IN (${slice.map(() => '?').join(',')})`
          )
          .all(...slice) as unknown as WaitingMarkRow[];
        for (const r of rows) {
          marks.set(r.msg_id, { dismissed: r.dismissed_at !== null, snoozedUntil: r.snoozed_until });
        }
      }
    } catch (err) {
      // Showing a dismissed row again is a nuisance; losing the whole tab to
      // a read error would be worse.
      logger.warn('api', 'Failed to read waiting marks', { err });
    }
    return marks;
  }

  public isHidden(mark: WaitingMark | undefined, now: Date): boolean {
    if (!mark) return false;
    if (mark.dismissed) return true;
    return mark.snoozedUntil !== null && Date.parse(mark.snoozedUntil) > now.getTime();
  }
}

export const waitingStore = new WaitingStore();
