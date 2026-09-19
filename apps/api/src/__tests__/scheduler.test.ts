import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import {
  INTERRUPTED_SEND,
  Scheduler,
  keepScheduledAttachment,
  scheduledFilesDir,
  type ScheduledMessage,
  type ScheduledPage,
} from '../wacli/scheduler.js';
import type { EventBridge } from '../ws/event-bridge.js';
import { openDatabaseAt } from '../db/index.js';
import { modeManager } from '../wacli/mode.js';

/** Every record the scheduler holds, pending first, as one list. */
function listAll(scheduler: Scheduler, chat?: string): ScheduledMessage[] {
  const page = scheduler.getPage({ chat, limit: 200 });
  return [...page.pending, ...page.history];
}

describe('Scheduler Service', () => {
  let tmpSchedFile: string;

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-sched-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpSchedFile)) {
      fs.unlinkSync(tmpSchedFile);
    }
  });

  it('schedules a message and persists to file', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const scheduledAt = new Date(Date.now() + 60000).toISOString();

    const item = scheduler.schedule({
      to: '15551234567@s.whatsapp.net',
      recipientName: 'Alice',
      message: 'Happy Birthday!',
      scheduledAt,
    });

    expect(item.id).toMatch(/^sched-/);
    expect(item.status).toBe('pending');
    expect(item.to).toBe('15551234567@s.whatsapp.net');
    expect(item.scheduledAt).toBe(scheduledAt);

    // Verify retrieval
    const list = listAll(scheduler);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(item.id);

    // Verify reload from disk
    const reloaded = new Scheduler(tmpSchedFile);
    const reloadedList = listAll(reloaded);
    expect(reloadedList.length).toBe(1);
    expect(reloadedList[0].message).toBe('Happy Birthday!');
  });

  it('cancels a pending scheduled message', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduler.schedule({
      to: '15551234567@s.whatsapp.net',
      message: 'Pending message',
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
    });

    expect(item.status).toBe('pending');

    expect(scheduler.cancel(item.id)).toEqual({ ok: true });

    const list = listAll(scheduler);
    const found = list.find((i) => i.id === item.id);
    expect(found?.status).toBe('cancelled');

    // Cancelling again is refused, and says why.
    expect(scheduler.cancel(item.id)).toEqual({
      ok: false,
      error: expect.stringContaining('already "cancelled"'),
    });
  });

  it('filters scheduled list by chat JID', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule({
      to: '15551111111@s.whatsapp.net',
      message: 'Msg 1',
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
    });
    scheduler.schedule({
      to: '15552222222@s.whatsapp.net',
      message: 'Msg 2',
      scheduledAt: new Date(Date.now() + 120000).toISOString(),
    });

    expect(listAll(scheduler, '15551111111@s.whatsapp.net').length).toBe(1);
    expect(listAll(scheduler, '15552222222@s.whatsapp.net').length).toBe(1);
    expect(listAll(scheduler).length).toBe(2);
  });
});

describe('Scheduler dispatch', () => {
  let tmpSchedFile: string;

  const dueMessage = {
    to: '15551234567@s.whatsapp.net',
    message: 'Due now',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-dispatch-${Date.now()}-${Math.random()}.db`);
    execWacliMock.mockReset();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    if (fs.existsSync(tmpSchedFile)) {
      fs.unlinkSync(tmpSchedFile);
    }
  });

  it('sends a due message exactly once when ticks overlap a slow send', async () => {
    // A real send can take up to 120s while the timer fires every 3s.
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    execWacliMock.mockImplementation(async () => {
      await inFlight;
      return { messageId: 'wamid.SLOW' };
    });

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);

    // Three overlapping ticks, as the interval would produce.
    const ticks = [
      scheduler.checkDueMessages(),
      scheduler.checkDueMessages(),
      scheduler.checkDueMessages(),
    ];

    release();
    await Promise.all(ticks);

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    expect(listAll(scheduler)[0].status).toBe('sent');
  });

  it('refuses to cancel a message that is already being sent', async () => {
    // A message mid-dispatch still reads "pending", so a cancel used to answer
    // "cancelled" while the send went out and the record flipped to "sent".
    let release: () => void = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    execWacliMock.mockImplementation(async () => {
      started();
      await sending;
      return { messageId: 'wamid.TOO_LATE' };
    });

    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduler.schedule(dueMessage);
    const tick = scheduler.checkDueMessages();
    await dispatched;

    expect(scheduler.cancel(item.id)).toEqual({
      ok: false,
      error: expect.stringMatching(/already being sent/),
    });

    release();
    await tick;

    // One send, and the record says what happened to it.
    expect(execWacliMock).toHaveBeenCalledTimes(1);
    expect(scheduler.getPage().history).toMatchObject([{ id: item.id, status: 'sent' }]);
  });

  it('fails a due message loudly while safe read-only mode is active', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.NOPE' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();

    // Visibly failed with a reason, not silently stuck pending.
    const item = listAll(scheduler)[0];
    expect(item.status).toBe('failed');
    expect(item.error).toContain('safe read-only mode');
  });

  it('persists the safe-mode failure so it survives a restart', async () => {
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();

    const reloaded = listAll(new Scheduler(tmpSchedFile))[0];
    expect(reloaded.status).toBe('failed');
    expect(reloaded.error).toContain('safe read-only mode');
  });

  it('never turns safe mode off as a side effect of dispatching', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.NOPE' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();

    expect(modeManager.isReadOnly()).toBe(true);
  });

  it('does not resurrect a safe-mode failure after the operator unlocks', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.LATER' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();
    expect(listAll(scheduler)[0].status).toBe('failed');

    // Unlocking must not quietly send a message the operator was told failed.
    modeManager.setReadOnly(false);
    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)[0].status).toBe('failed');
  });

  it('marks a message failed when the send errors, without retrying it', async () => {
    execWacliMock.mockRejectedValue(new Error('wacli exploded'));

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);

    await scheduler.checkDueMessages();
    await scheduler.checkDueMessages();

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    const item = listAll(scheduler)[0];
    expect(item.status).toBe('failed');
    expect(item.error).toContain('wacli exploded');
  });

  it('fails a message with an unparseable scheduledAt instead of looping on it', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule({ ...dueMessage, scheduledAt: 'not-a-date' });

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)[0].status).toBe('failed');
  });
});

describe('Scheduler resend', () => {
  let tmpSchedFile: string;

  const dueMessage = {
    to: '15551234567@s.whatsapp.net',
    message: 'Due now',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-resend-${Date.now()}-${Math.random()}.db`);
    execWacliMock.mockReset();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    modeManager.setReadOnly(false);
    if (fs.existsSync(tmpSchedFile)) {
      fs.unlinkSync(tmpSchedFile);
    }
  });

  /** Drives a scheduled message into the failed state the resend UI acts on. */
  async function failedItem(scheduler: Scheduler, overrides: Record<string, unknown> = {}) {
    execWacliMock.mockRejectedValueOnce(new Error('wacli exploded'));
    const item = scheduler.schedule({ ...dueMessage, ...overrides });
    await scheduler.checkDueMessages();
    expect(listAll(scheduler)[0].status).toBe('failed');
    // Drop the setup call so each test's call count means "sends the resend caused".
    execWacliMock.mockClear();
    return item;
  }

  it('resends a failed message and marks the same record sent', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    execWacliMock.mockResolvedValueOnce({ messageId: 'wamid.RETRY' });
    const outcome = await scheduler.resend(item.id);

    expect(outcome.ok).toBe(true);

    // One record, not two: the queue does not grow a duplicate on every retry.
    const list = listAll(scheduler);
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(item.id);
    expect(list[0].status).toBe('sent');
    expect(list[0].sentMessageId).toBe('wamid.RETRY');
    expect(list[0].resendCount).toBe(1);
    expect(list[0].error).toBeUndefined();
  });

  it('refuses to resend a message that already went out', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    execWacliMock.mockResolvedValueOnce({ messageId: 'wamid.RETRY' });
    await scheduler.resend(item.id);
    execWacliMock.mockClear();

    // The operator clicking RESEND twice must not put the message out twice.
    const second = await scheduler.resend(item.id);

    expect(second.ok).toBe(false);
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)[0].status).toBe('sent');
  });

  it('sends only once when two resends of the same message overlap', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    execWacliMock.mockImplementation(async () => {
      await inFlight;
      return { messageId: 'wamid.SLOW_RETRY' };
    });

    // A double click, or two browser tabs, hitting the endpoint together.
    const both = [scheduler.resend(item.id), scheduler.resend(item.id)];
    release();
    const [first, second] = await Promise.all(both);

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(listAll(scheduler)[0].status).toBe('sent');
  });

  it('does not let a scheduler tick double-send a message being resent', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    execWacliMock.mockImplementation(async () => {
      await inFlight;
      return { messageId: 'wamid.SLOW_RETRY' };
    });

    // A resend backdates scheduledAt to now, so the 3s tick sees a due pending
    // item mid-dispatch. The inFlight lock is what stops it sending again.
    const resending = scheduler.resend(item.id);
    const ticks = [scheduler.checkDueMessages(), scheduler.checkDueMessages()];
    release();
    await Promise.all([resending, ...ticks]);

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    expect(listAll(scheduler)[0].status).toBe('sent');
  });

  it('leaves the record failed and resendable when the retry also fails', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    execWacliMock.mockRejectedValueOnce(new Error('still broken'));
    const outcome = await scheduler.resend(item.id);

    expect(outcome.ok).toBe(true);
    const failed = listAll(scheduler)[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('still broken');
    expect(failed.resendCount).toBe(1);

    // Still eligible, and the counter keeps climbing across attempts.
    execWacliMock.mockResolvedValueOnce({ messageId: 'wamid.THIRD' });
    await scheduler.resend(item.id);
    expect(listAll(scheduler)[0].resendCount).toBe(2);
    expect(listAll(scheduler)[0].status).toBe('sent');
  });

  it('refuses an immediate resend while safe read-only mode is active', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    modeManager.setReadOnly(true);
    execWacliMock.mockClear();
    const outcome = await scheduler.resend(item.id);

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toContain('read-only');
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)[0].status).toBe('failed');
  });

  it('requeues a failed message for a later time without dispatching it', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    const future = new Date(Date.now() + 60000).toISOString();
    const outcome = await scheduler.resend(item.id, { scheduledAt: future });

    expect(outcome.ok).toBe(true);
    expect(execWacliMock).not.toHaveBeenCalled();
    const queued = listAll(scheduler)[0];
    expect(queued.status).toBe('pending');
    expect(queued.scheduledAt).toBe(future);
    expect(queued.error).toBeUndefined();

    // Still not due, so the ticks leave it alone.
    await scheduler.checkDueMessages();
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)[0].status).toBe('pending');
  });

  it('dispatches a requeued message exactly once when it comes due', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    execWacliMock.mockImplementation(async () => {
      await inFlight;
      return { messageId: 'wamid.LATER_RETRY' };
    });

    // Requeued for a time that has already passed: the next tick owns it, and
    // overlapping ticks must not turn that into two messages.
    await scheduler.resend(item.id, { scheduledAt: new Date(Date.now() - 1000).toISOString() });
    expect(execWacliMock).not.toHaveBeenCalled();

    const ticks = [scheduler.checkDueMessages(), scheduler.checkDueMessages()];
    release();
    await Promise.all(ticks);

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    expect(listAll(scheduler)[0].status).toBe('sent');
  });

  it('refuses to resend a pending message that has not failed', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduler.schedule({
      ...dueMessage,
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
    });

    const outcome = await scheduler.resend(item.id);

    expect(outcome.ok).toBe(false);
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)[0].status).toBe('pending');
  });

  it('rejects a resend for an unknown id or an unparseable time', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    expect((await scheduler.resend('sched-nope')).ok).toBe(false);
    expect((await scheduler.resend(item.id, { scheduledAt: 'not-a-date' })).ok).toBe(false);
    expect(listAll(scheduler)[0].status).toBe('failed');
  });

  it('discards a failed message and refuses to discard a pending one', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const failed = await failedItem(scheduler);
    const pending = scheduler.schedule({
      ...dueMessage,
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
    });

    expect(scheduler.discard(pending.id)).toBe(false);
    expect(scheduler.discard(failed.id)).toBe(true);
    expect(scheduler.discard(failed.id)).toBe(false);

    const remaining = listAll(scheduler);
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(pending.id);

    // Gone from disk too, not just from memory.
    expect(listAll(new Scheduler(tmpSchedFile)).length).toBe(1);
  });

  it('reports a failed file message whose attachment has gone from disk', async () => {
    const attachment = path.join(os.tmpdir(), `wacli-test-attach-${Date.now()}.txt`);
    fs.writeFileSync(attachment, 'payload');

    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler, { filePath: attachment, fileName: 'notes.txt' });

    expect(listAll(scheduler)[0].attachmentMissing).toBe(false);

    fs.unlinkSync(attachment);
    expect(listAll(scheduler)[0].attachmentMissing).toBe(true);

    // The derived flag is never written back into the persisted record: there is
    // no column for it, so a reload cannot resurrect a stale answer.
    const columns = (
      openDatabaseAt(tmpSchedFile).prepare('PRAGMA table_info(scheduled)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(columns).not.toContain('attachment_missing');

    // Discarding a failed file message cleans up any attachment still around.
    expect(scheduler.discard(item.id)).toBe(true);
  });
});

describe('Scheduler records only a real message ID', () => {
  let tmpSchedFile: string;

  const dueMessage = {
    to: '15551234567@s.whatsapp.net',
    message: 'Due now',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-sentid-${Date.now()}-${Math.random()}.db`);
    execWacliMock.mockReset();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    if (fs.existsSync(tmpSchedFile)) {
      fs.unlinkSync(tmpSchedFile);
    }
  });

  it('keeps the ID wacli reports under its own name for the field', async () => {
    // wacli calls it `id`; the code only ever looked for `messageId`, so every
    // real send fell through to the fabricated fallback below.
    execWacliMock.mockResolvedValue({ sent: true, to: dueMessage.to, id: '3EB0A1B2C3' });

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();

    const item = listAll(scheduler)[0];
    expect(item.status).toBe('sent');
    expect(item.sentMessageId).toBe('3EB0A1B2C3');
  });

  it('leaves the ID unset rather than inventing one wacli never gave', async () => {
    execWacliMock.mockResolvedValue({ sent: true, to: dueMessage.to });

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();

    const item = listAll(scheduler)[0];
    expect(item.status).toBe('sent');
    // The old fallback stamped every sent item with `out-<now>`. Clicking the
    // row in LATER then asked the thread to focus an ID the archive could never
    // hold, and the operator was told the message was not in the local archive
    // when it plainly was.
    expect(item.sentMessageId).toBeUndefined();
  });
});

describe('Scheduler drops placeholder ids already on disk', () => {
  let tmpSchedFile: string;

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-heal-${Date.now()}-${Math.random()}.db`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpSchedFile)) {
      fs.unlinkSync(tmpSchedFile);
    }
  });

  it('heals records written before wacli\'s id was read correctly', () => {
    // Exactly what is on disk today: every sent item stamped `out-<millis>`,
    // a value no archive can match, so clicking the row in LATER could only
    // ever answer "that message is not in the local archive".
    const seed = openDatabaseAt(tmpSchedFile);
    const insert = seed.prepare(
      `INSERT INTO scheduled (id, to_jid, message, scheduled_at, created_at, status, sent_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insert.run(
      'sched-legacy',
      '15551234567@s.whatsapp.net',
      'the one with the placeholder',
      '2026-09-04T10:00:00Z',
      '2026-09-04T09:00:00Z',
      'sent',
      'out-1788203211119'
    );
    insert.run(
      'sched-real',
      '15551234567@s.whatsapp.net',
      'and this one is fine',
      '2026-09-04T10:00:00Z',
      '2026-09-04T09:00:00Z',
      'sent',
      '3EB0626F628F3B645B291E'
    );

    const list = listAll(new Scheduler(tmpSchedFile));
    expect(list.find((i) => i.id === 'sched-legacy')?.sentMessageId).toBeUndefined();
    expect(list.find((i) => i.id === 'sched-real')?.sentMessageId).toBe('3EB0626F628F3B645B291E');

    // Healed in the table too, so it is a one-off rather than a filter on every read.
    const stored = seed
      .prepare('SELECT sent_message_id FROM scheduled WHERE id = ?')
      .get('sched-legacy') as { sent_message_id: string | null };
    expect(stored.sent_message_id).toBeNull();
  });
});

describe('Scheduler paging', () => {
  let tmpSchedFile: string;

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-page-${Date.now()}-${Math.random()}.db`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpSchedFile)) {
      fs.unlinkSync(tmpSchedFile);
    }
  });

  /** Seeds `count` resolved messages plus `pending` still-queued ones. */
  function seed(scheduler: Scheduler, resolved: number, pending: number): void {
    for (let i = 0; i < resolved; i++) {
      const item = scheduler.schedule({
        to: 'alice@s.whatsapp.net',
        message: `done ${i}`,
        scheduledAt: new Date(Date.now() + 600_000).toISOString(),
      });
      scheduler.cancel(item.id);
    }
    for (let i = 0; i < pending; i++) {
      scheduler.schedule({
        to: 'alice@s.whatsapp.net',
        message: `queued ${i}`,
        // Deliberately far out, so a "newest ten" rule would page them away.
        scheduledAt: new Date(Date.now() + (i + 1) * 86_400_000).toISOString(),
      });
    }
  }

  it('returns ten resolved messages by default', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    seed(scheduler, 25, 0);

    const page = scheduler.getPage();
    expect(page.history).toHaveLength(10);
    expect(page.totalHistory).toBe(25);
    expect(page.nextCursor).not.toBeNull();
  });

  it('never pages away a pending message, however far out it is scheduled', () => {
    // The whole point of the tab: a queue that hides what is about to go out
    // because it fell past row ten is a queue the operator cannot trust.
    const scheduler = new Scheduler(tmpSchedFile);
    seed(scheduler, 30, 4);

    const page = scheduler.getPage();
    expect(page.pending).toHaveLength(4);
    expect(page.totalPending).toBe(4);
    expect(page.history).toHaveLength(10);
  });

  it('orders pending soonest-first, because it is a queue and not a history', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    seed(scheduler, 0, 3);

    const due = scheduler.getPage().pending.map((i) => i.scheduledAt);
    expect([...due]).toEqual([...due].sort());
  });

  it('walks the resolved history through its cursor without repeating a row', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    seed(scheduler, 25, 0);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = scheduler.getPage({ before: cursor ?? undefined });
      seen.push(...page.history.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('filters to one chat without losing the paging', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    seed(scheduler, 12, 2);
    scheduler.schedule({
      to: 'bob@s.whatsapp.net',
      message: 'someone else',
      scheduledAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const page = scheduler.getPage({ chat: 'alice@s.whatsapp.net' });
    expect(page.pending).toHaveLength(2);
    expect(page.totalHistory).toBe(12);
    expect(page.history).toHaveLength(10);
  });
});

describe('Scheduled attachments', () => {
  let tmpSchedFile: string;
  let workDir: string;

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-files-${Date.now()}-${Math.random()}.db`);
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-test-upload-'));
    execWacliMock.mockReset();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpSchedFile, { force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /** An upload as multer leaves it: a nameless temp file. */
  function upload(contents = '%PDF-1.7 signed contract'): string {
    const file = path.join(workDir, crypto.randomUUID());
    fs.writeFileSync(file, contents);
    return file;
  }

  function scheduleFile(scheduler: Scheduler, filePath: string, dueInMs = -1000) {
    return scheduler.schedule({
      to: '15550100001@s.whatsapp.net',
      message: 'Here is the signed contract',
      filePath,
      fileName: 'contract.pdf',
      scheduledAt: new Date(Date.now() + dueInMs).toISOString(),
    });
  }

  it('keeps an upload beside the database, where only the operator can read it', () => {
    const uploaded = upload();

    const kept = keepScheduledAttachment(uploaded, 'Signed contract (final).pdf');

    expect(path.dirname(kept)).toBe(scheduledFilesDir());
    expect(scheduledFilesDir()).toBe(
      path.join(path.dirname(process.env.WACLI_DB_FILE!), 'scheduled-files')
    );
    expect(path.extname(kept)).toBe('.pdf');
    expect(fs.readFileSync(kept, 'utf8')).toBe('%PDF-1.7 signed contract');
    expect(fs.statSync(kept).mode & 0o777).toBe(0o600);
    expect(fs.statSync(scheduledFilesDir()).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(uploaded)).toBe(false);
    fs.rmSync(kept);
  });

  it('copies the upload when it sits on another filesystem', () => {
    const uploaded = upload();
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    });

    const kept = keepScheduledAttachment(uploaded, 'contract.pdf');

    expect(fs.readFileSync(kept, 'utf8')).toBe('%PDF-1.7 signed contract');
    expect(fs.existsSync(uploaded)).toBe(false);
    fs.rmSync(kept);
  });

  it('fails a file message whose attachment has gone, and sends nothing', async () => {
    // What a reboot does to a file in the temp directory. The caption used to
    // go out on its own, and the record said "sent".
    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduleFile(scheduler, path.join(workDir, 'gone.pdf'));

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(scheduler.getPage().history).toMatchObject([
      { id: item.id, status: 'failed', error: expect.stringMatching(/no longer on disk/) },
    ]);
  });

  it('sends the file when it is there, and deletes it afterwards', async () => {
    execWacliMock.mockResolvedValue({ id: 'wamid.FILE' });
    const scheduler = new Scheduler(tmpSchedFile);
    const kept = keepScheduledAttachment(upload(), 'contract.pdf');
    scheduleFile(scheduler, kept);

    await scheduler.checkDueMessages();

    const args = execWacliMock.mock.calls[0][0] as string[];
    expect(args.slice(0, 2)).toEqual(['send', 'file']);
    expect(args).toContain(kept);
    expect(fs.existsSync(kept)).toBe(false);
  });

  it('deletes the attachment when the message is cancelled', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const kept = keepScheduledAttachment(upload(), 'contract.pdf');
    const item = scheduleFile(scheduler, kept, 60_000);

    expect(scheduler.cancel(item.id)).toEqual({ ok: true });

    expect(fs.existsSync(kept)).toBe(false);
  });

  it('refuses to resend a file message whose attachment has gone', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const kept = keepScheduledAttachment(upload(), 'contract.pdf');
    const item = scheduleFile(scheduler, kept);
    execWacliMock.mockRejectedValueOnce(new Error('wacli exploded'));
    await scheduler.checkDueMessages();
    fs.rmSync(kept);
    execWacliMock.mockClear();

    const outcome = await scheduler.resend(item.id);

    expect(outcome).toEqual({ ok: false, error: expect.stringMatching(/no longer on disk/) });
    expect(execWacliMock).not.toHaveBeenCalled();
  });
});

describe('Scheduler sends at most once', () => {
  let tmpSchedFile: string;

  const due = {
    to: '15551234567@s.whatsapp.net',
    message: 'Due now',
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  };

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-once-${Date.now()}-${Math.random()}.db`);
    execWacliMock.mockReset();
    modeManager.setReadOnly(false);
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(`${tmpSchedFile}${suffix}`, { force: true });
    }
  });

  /** The row as another reader of the file sees it, which is what a restart reads. */
  function statusOnDisk(id: string): string | undefined {
    const reader = new DatabaseSync(tmpSchedFile);
    try {
      const row = reader.prepare('SELECT status FROM scheduled WHERE id = ?').get(id) as
        | { status: string }
        | undefined;
      return row?.status;
    } finally {
      reader.close();
    }
  }

  const failWritesOnce = (scheduler: Scheduler) =>
    vi
      .spyOn(scheduler as unknown as { writeRow: (item: unknown) => void }, 'writeRow')
      .mockImplementationOnce(() => {
        throw new Error('disk I/O error');
      });

  it('has the message marked sending on disk before wacli is asked', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduler.schedule(due);
    let onDiskDuringSend: string | undefined;
    execWacliMock.mockImplementation(async () => {
      onDiskDuringSend = statusOnDisk(item.id);
      return { id: 'wamid.ONCE' };
    });

    await scheduler.checkDueMessages();

    // What a crash at that moment would leave behind. It used to be
    // `pending`, which the next boot finds due and sends again.
    expect(onDiskDuringSend).toBe('sending');
    expect(statusOnDisk(item.id)).toBe('sent');
  });

  it('marks a message a restart finds mid-send failed, and does not send it again', async () => {
    const first = new Scheduler(tmpSchedFile);
    const item = first.schedule(due);
    let reachedWacli: () => void = () => {};
    const inWacli = new Promise<void>((resolve) => {
      reachedWacli = resolve;
    });
    // wacli never answers: the process goes down with the send on the wire.
    execWacliMock.mockImplementation(() => {
      reachedWacli();
      return new Promise(() => {});
    });
    void first.checkDueMessages();
    await inWacli;
    execWacliMock.mockReset();

    // The next boot, on the same file.
    const restarted = new Scheduler(tmpSchedFile);
    await restarted.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(restarted)).toMatchObject([
      { id: item.id, status: 'failed', error: INTERRUPTED_SEND },
    ]);
    expect(statusOnDisk(item.id)).toBe('failed');
  });

  it('sends nothing when it cannot record the send first', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduler.schedule(due);
    failWritesOnce(scheduler);

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(listAll(scheduler)).toMatchObject([
      { id: item.id, status: 'failed', error: expect.stringMatching(/^Not sent: .*disk I\/O error/) },
    ]);
  });

  it('shows a message on its way out as sending, and keeps it in the queue', async () => {
    const statuses: string[] = [];
    const bridge = {
      broadcast: (event: { type: string; data: { status?: string } }) => {
        if (event.type === 'scheduled.update' && event.data.status) statuses.push(event.data.status);
      },
    } as unknown as EventBridge;
    const scheduler = new Scheduler(tmpSchedFile, bridge);
    const item = scheduler.schedule(due);
    let pageDuringSend: ScheduledPage | undefined;
    execWacliMock.mockImplementation(async () => {
      pageDuringSend = scheduler.getPage();
      return { id: 'wamid.ONCE' };
    });

    await scheduler.checkDueMessages();

    expect(statuses).toEqual(['pending', 'sending', 'sent']);
    expect(pageDuringSend?.pending).toMatchObject([{ id: item.id, status: 'sending' }]);
    expect(pageDuringSend?.history).toEqual([]);
  });

  it('refuses a message the table will not store, and keeps storing the rest', () => {
    const scheduler = new Scheduler(tmpSchedFile);

    // The whole queue used to be rewritten in one transaction, so this one
    // record rolled back every save after it, and only a warning said so.
    expect(() => scheduler.schedule({ ...due, message: { not: 'text' } as unknown as string })).toThrow();
    const kept = scheduler.schedule({ ...due, message: 'scheduled after the bad one' });
    const cancelled = scheduler.schedule({ ...due, message: 'scheduled, then cancelled' });
    expect(scheduler.cancel(cancelled.id)).toEqual({ ok: true });

    const reloaded = listAll(new Scheduler(tmpSchedFile));
    expect(reloaded.map((i) => [i.id, i.status]).sort()).toEqual(
      [
        [kept.id, 'pending'],
        [cancelled.id, 'cancelled'],
      ].sort()
    );
  });

  it('writes only its own row', () => {
    // A save used to delete every row its map did not hold, so a second
    // process on the file erased what the first had scheduled since.
    const a = new Scheduler(tmpSchedFile);
    const b = new Scheduler(tmpSchedFile);
    b.getPage();
    const fromA = a.schedule({ ...due, message: 'from A' });
    const fromB = b.schedule({ ...due, message: 'from B' });

    const ids = listAll(new Scheduler(tmpSchedFile)).map((i) => i.id);
    expect(ids.sort()).toEqual([fromA.id, fromB.id].sort());
  });

  it('refuses a cancel it cannot record, rather than one a restart would undo', () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = scheduler.schedule({ ...due, scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    failWritesOnce(scheduler);

    expect(() => scheduler.cancel(item.id)).toThrow(/still scheduled.*disk I\/O error/);
    expect(listAll(scheduler)[0].status).toBe('pending');
    expect(statusOnDisk(item.id)).toBe('pending');
  });
});
