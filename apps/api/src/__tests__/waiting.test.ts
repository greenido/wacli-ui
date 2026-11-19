import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findWaiting, WaitingStore } from '../wacli/waiting.js';
import { normalizeMessage } from '../wacli/normalize.js';
import type { RawMessage, UnifiedMessage } from '../types.js';

const ADA = '15550100001@s.whatsapp.net';
const GRACE = '15550100002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
/** The operator's own phone, a second device of the same account. */
const OWN_PHONE = '15550100099:12@s.whatsapp.net';

let seq = 0;

/** A stored message as wacli lists it, normalized the way the route sees it. */
function msg(raw: RawMessage): UnifiedMessage {
  seq += 1;
  return normalizeMessage({ MsgID: `MSG-${seq}`, Text: 'hello', ...raw });
}

function mine(chat: string, ts: string, extra: RawMessage = {}): UnifiedMessage {
  return msg({ ChatJID: chat, Timestamp: ts, FromMe: true, DeliveredTo: 1, ReadBy: 0, ...extra });
}

function theirs(chat: string, ts: string, extra: RawMessage = {}): UnifiedMessage {
  return msg({ ChatJID: chat, Timestamp: ts, FromMe: false, SenderJID: chat, ...extra });
}

const ids = (list: UnifiedMessage[]) => list.map((m) => m.msgId);

describe('findWaiting', () => {
  it('lists a delivered message the other side never answered', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    expect(ids(findWaiting([sent]))).toEqual([sent.msgId]);
  });

  it('lists a read one too, and says so', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z', { ReadBy: 1 });
    const [waiting] = findWaiting([sent]);
    expect(waiting.deliveryStatus).toBe('read');
  });

  it('leaves out a message that never reached the other phone', () => {
    // No receipt at all: it may be stuck on this side, which is a send
    // problem, not a conversation waiting on someone.
    const stuck = mine(ADA, '2026-11-16T10:00:00Z', { DeliveredTo: 0, ReadBy: 0 });
    expect(findWaiting([stuck])).toEqual([]);
  });

  it('leaves out a message from a wacli too old to report receipts', () => {
    const unknown = msg({ ChatJID: ADA, Timestamp: '2026-11-16T10:00:00Z', FromMe: true });
    expect(findWaiting([unknown])).toEqual([]);
  });

  it('drops a chat once the other side replies', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z', { ReadBy: 1 });
    const reply = theirs(ADA, '2026-11-16T11:00:00Z');
    expect(findWaiting([reply, sent])).toEqual([]);
  });

  it('counts a reply that arrived before the read receipt did', () => {
    // The receipt counts only ever go up, and a reply often lands first: the
    // message still says "delivered" while the answer is already here.
    const sent = mine(ADA, '2026-11-16T10:00:00Z', { DeliveredTo: 1, ReadBy: 0 });
    const reply = theirs(ADA, '2026-11-16T10:01:00Z');
    expect(findWaiting([reply, sent])).toEqual([]);
  });

  it('treats a reply in the same second as an answer', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    const reply = theirs(ADA, '2026-11-16T10:00:00Z');
    expect(findWaiting([sent, reply])).toEqual([]);
  });

  it('does not count a reaction as a reply', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z', { ReadBy: 1 });
    const thumbs = theirs(ADA, '2026-11-16T10:05:00Z', {
      Text: '',
      ReactionToID: sent.msgId,
      ReactionEmoji: '\u{1F44D}',
    });
    expect(ids(findWaiting([thumbs, sent]))).toEqual([sent.msgId]);
  });

  it('does not make the operator’s own reaction the message being waited on', () => {
    const question = theirs(ADA, '2026-11-16T09:00:00Z');
    const reaction = mine(ADA, '2026-11-16T10:00:00Z', {
      Text: '',
      ReactionToID: question.msgId,
      ReactionEmoji: '\u{2764}\u{FE0F}',
    });
    expect(findWaiting([reaction, question])).toEqual([]);
  });

  it('counts a message sent from the operator’s phone as the operator’s', () => {
    // wacli marks every message from this account FromMe, whichever device
    // sent it; the sender JID names the phone, not this machine.
    const fromPhone = mine(ADA, '2026-11-16T10:00:00Z', { SenderJID: OWN_PHONE, ReadBy: 1 });
    expect(ids(findWaiting([fromPhone]))).toEqual([fromPhone.msgId]);
  });

  it('does not take the operator’s phone for the other side answering', () => {
    const fromHere = mine(ADA, '2026-11-16T10:00:00Z');
    const fromPhone = mine(ADA, '2026-11-16T10:10:00Z', { SenderJID: OWN_PHONE });
    expect(ids(findWaiting([fromPhone, fromHere]))).toEqual([fromPhone.msgId]);
  });

  it('waits on the newest of several unanswered messages', () => {
    const first = mine(ADA, '2026-11-16T10:00:00Z', { ReadBy: 1 });
    const second = mine(ADA, '2026-11-16T10:02:00Z', { ReadBy: 1 });
    expect(ids(findWaiting([second, first]))).toEqual([second.msgId]);
  });

  it('falls back to an earlier delivered one while the newest is still in flight', () => {
    const read = mine(ADA, '2026-11-16T10:00:00Z', { ReadBy: 1 });
    const inFlight = mine(ADA, '2026-11-16T10:02:00Z', { DeliveredTo: 0 });
    expect(ids(findWaiting([inFlight, read]))).toEqual([read.msgId]);
  });

  it('ignores a message the operator deleted', () => {
    const kept = mine(ADA, '2026-11-16T10:00:00Z');
    const deleted = mine(ADA, '2026-11-16T10:02:00Z', { Revoked: true });
    expect(ids(findWaiting([deleted, kept]))).toEqual([kept.msgId]);
  });

  it('still counts a reply the other side later deleted', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    const unsaid = theirs(ADA, '2026-11-16T10:05:00Z', { Revoked: true });
    expect(findWaiting([unsaid, sent])).toEqual([]);
  });

  it('ignores rows with nothing in them, which are not replies', () => {
    // Protocol and system rows (a disappearing-messages change, say) arrive
    // as messages with no body and no media.
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    const system = theirs(ADA, '2026-11-16T10:05:00Z', { Text: '', DisplayText: '' });
    expect(ids(findWaiting([system, sent]))).toEqual([sent.msgId]);
  });

  it('counts a photo with no caption as a reply', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    const photo = theirs(ADA, '2026-11-16T10:05:00Z', { Text: '', MediaType: 'image' });
    expect(findWaiting([photo, sent])).toEqual([]);
  });

  it('leaves group chats out', () => {
    const inGroup = mine(GROUP, '2026-11-16T10:00:00Z', { ReadBy: 3 });
    expect(findWaiting([inGroup])).toEqual([]);
  });

  it('leaves out status updates and channels', () => {
    const status = mine('status@broadcast', '2026-11-16T10:00:00Z');
    const channel = mine('120363000000000002@newsletter', '2026-11-16T10:00:00Z');
    expect(findWaiting([status, channel])).toEqual([]);
  });

  it('keeps a direct chat addressed by its LID', () => {
    const sent = mine('205000000000001@lid', '2026-11-16T10:00:00Z');
    expect(ids(findWaiting([sent]))).toEqual([sent.msgId]);
  });

  it('keeps chats apart and lists the longest wait first', () => {
    const toAda = mine(ADA, '2026-11-16T10:00:00Z');
    const toGrace = mine(GRACE, '2026-11-14T10:00:00Z');
    // Ada wrote before the operator's last message, so it answers nothing.
    const adaEarlier = theirs(ADA, '2026-11-15T10:00:00Z');
    expect(ids(findWaiting([toAda, adaEarlier, toGrace]))).toEqual([
      toGrace.msgId,
      toAda.msgId,
    ]);
  });

  it('does not depend on the order wacli lists messages in', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    const reply = theirs(ADA, '2026-11-16T11:00:00Z');
    expect(findWaiting([sent, reply])).toEqual([]);
  });

  it('compares instants, not strings, when offsets differ', () => {
    const sent = mine(ADA, '2026-11-16T10:00:00Z');
    // 09:30 UTC: before the send, so it does not answer it.
    const earlier = theirs(ADA, '2026-11-16T11:30:00+02:00');
    expect(ids(findWaiting([earlier, sent]))).toEqual([sent.msgId]);
  });
});

describe('WaitingStore', () => {
  let dir: string;
  let file: string;
  const now = new Date('2026-11-18T12:00:00Z');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-waiting-'));
    file = path.join(dir, 'waiting.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a dismissal across a restart', () => {
    new WaitingStore(file).dismiss('MSG-1', ADA);
    const marks = new WaitingStore(file).marksFor(['MSG-1', 'MSG-2']);
    expect(marks.get('MSG-1')?.dismissed).toBe(true);
    expect(marks.has('MSG-2')).toBe(false);
  });

  it('hides a snoozed message until its time, then lets it back', () => {
    const store = new WaitingStore(file);
    store.snooze('MSG-1', ADA, '2026-11-19T09:00:00.000Z');

    const mark = store.marksFor(['MSG-1']).get('MSG-1')!;
    expect(mark.dismissed).toBe(false);
    expect(mark.snoozedUntil).toBe('2026-11-19T09:00:00.000Z');
    expect(store.isHidden(mark, now)).toBe(true);
    expect(store.isHidden(mark, new Date('2026-11-19T09:00:01Z'))).toBe(false);
  });

  it('moves a snooze rather than stacking a second one', () => {
    const store = new WaitingStore(file);
    store.snooze('MSG-1', ADA, '2026-11-19T09:00:00.000Z');
    store.snooze('MSG-1', ADA, '2026-11-25T09:00:00.000Z');
    expect(store.marksFor(['MSG-1']).get('MSG-1')?.snoozedUntil).toBe('2026-11-25T09:00:00.000Z');
  });

  it('lets a dismissal win over a snooze set before or after it', () => {
    const store = new WaitingStore(file);
    store.snooze('MSG-1', ADA, '2026-11-19T09:00:00.000Z');
    store.dismiss('MSG-1', ADA);
    store.snooze('MSG-1', ADA, '2026-11-20T09:00:00.000Z');

    const mark = store.marksFor(['MSG-1']).get('MSG-1')!;
    expect(mark.dismissed).toBe(true);
    expect(store.isHidden(mark, new Date('2027-01-01T00:00:00Z'))).toBe(true);
  });

  it('reads any number of ids in one go', () => {
    const store = new WaitingStore(file);
    const many = Array.from({ length: 1200 }, (_, i) => `MSG-${i}`);
    store.dismiss('MSG-1100', ADA);
    expect([...store.marksFor(many).keys()]).toEqual(['MSG-1100']);
  });
});
