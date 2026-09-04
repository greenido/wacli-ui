import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execWacliMock = vi.hoisted(() => vi.fn());

vi.mock('../wacli/commands.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../wacli/commands.js')>();
  return { ...actual, execWacli: execWacliMock };
});

import { Scheduler } from '../wacli/scheduler.js';
import { modeManager } from '../wacli/mode.js';

describe('Scheduler Service', () => {
  let tmpSchedFile: string;

  beforeEach(() => {
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-sched-${Date.now()}.json`);
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
    const list = scheduler.getList();
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(item.id);

    // Verify reload from disk
    const reloaded = new Scheduler(tmpSchedFile);
    const reloadedList = reloaded.getList();
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

    const cancelled = scheduler.cancel(item.id);
    expect(cancelled).toBe(true);

    const list = scheduler.getList();
    const found = list.find((i) => i.id === item.id);
    expect(found?.status).toBe('cancelled');

    // Cancelling again returns false
    expect(scheduler.cancel(item.id)).toBe(false);
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

    expect(scheduler.getList('15551111111@s.whatsapp.net').length).toBe(1);
    expect(scheduler.getList('15552222222@s.whatsapp.net').length).toBe(1);
    expect(scheduler.getList().length).toBe(2);
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
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-dispatch-${Date.now()}-${Math.random()}.json`);
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
    expect(scheduler.getList()[0].status).toBe('sent');
  });

  it('fails a due message loudly while safe read-only mode is active', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.NOPE' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();

    // Visibly failed with a reason, not silently stuck pending.
    const item = scheduler.getList()[0];
    expect(item.status).toBe('failed');
    expect(item.error).toContain('safe read-only mode');
  });

  it('persists the safe-mode failure so it survives a restart', async () => {
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();

    const reloaded = new Scheduler(tmpSchedFile).getList()[0];
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
    expect(scheduler.getList()[0].status).toBe('failed');

    // Unlocking must not quietly send a message the operator was told failed.
    modeManager.setReadOnly(false);
    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(scheduler.getList()[0].status).toBe('failed');
  });

  it('marks a message failed when the send errors, without retrying it', async () => {
    execWacliMock.mockRejectedValue(new Error('wacli exploded'));

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);

    await scheduler.checkDueMessages();
    await scheduler.checkDueMessages();

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    const item = scheduler.getList()[0];
    expect(item.status).toBe('failed');
    expect(item.error).toContain('wacli exploded');
  });

  it('fails a message with an unparseable scheduledAt instead of looping on it', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule({ ...dueMessage, scheduledAt: 'not-a-date' });

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    expect(scheduler.getList()[0].status).toBe('failed');
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
    tmpSchedFile = path.join(os.tmpdir(), `wacli-test-resend-${Date.now()}-${Math.random()}.json`);
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
    expect(scheduler.getList()[0].status).toBe('failed');
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
    const list = scheduler.getList();
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
    expect(scheduler.getList()[0].status).toBe('sent');
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
    expect(scheduler.getList()[0].status).toBe('sent');
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
    expect(scheduler.getList()[0].status).toBe('sent');
  });

  it('leaves the record failed and resendable when the retry also fails', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    execWacliMock.mockRejectedValueOnce(new Error('still broken'));
    const outcome = await scheduler.resend(item.id);

    expect(outcome.ok).toBe(true);
    const failed = scheduler.getList()[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('still broken');
    expect(failed.resendCount).toBe(1);

    // Still eligible, and the counter keeps climbing across attempts.
    execWacliMock.mockResolvedValueOnce({ messageId: 'wamid.THIRD' });
    await scheduler.resend(item.id);
    expect(scheduler.getList()[0].resendCount).toBe(2);
    expect(scheduler.getList()[0].status).toBe('sent');
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
    expect(scheduler.getList()[0].status).toBe('failed');
  });

  it('requeues a failed message for a later time without dispatching it', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    const future = new Date(Date.now() + 60000).toISOString();
    const outcome = await scheduler.resend(item.id, { scheduledAt: future });

    expect(outcome.ok).toBe(true);
    expect(execWacliMock).not.toHaveBeenCalled();
    const queued = scheduler.getList()[0];
    expect(queued.status).toBe('pending');
    expect(queued.scheduledAt).toBe(future);
    expect(queued.error).toBeUndefined();

    // Still not due, so the ticks leave it alone.
    await scheduler.checkDueMessages();
    expect(execWacliMock).not.toHaveBeenCalled();
    expect(scheduler.getList()[0].status).toBe('pending');
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
    expect(scheduler.getList()[0].status).toBe('sent');
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
    expect(scheduler.getList()[0].status).toBe('pending');
  });

  it('rejects a resend for an unknown id or an unparseable time', async () => {
    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler);

    expect((await scheduler.resend('sched-nope')).ok).toBe(false);
    expect((await scheduler.resend(item.id, { scheduledAt: 'not-a-date' })).ok).toBe(false);
    expect(scheduler.getList()[0].status).toBe('failed');
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

    const remaining = scheduler.getList();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(pending.id);

    // Gone from disk too, not just from memory.
    expect(new Scheduler(tmpSchedFile).getList().length).toBe(1);
  });

  it('reports a failed file message whose attachment has gone from disk', async () => {
    const attachment = path.join(os.tmpdir(), `wacli-test-attach-${Date.now()}.txt`);
    fs.writeFileSync(attachment, 'payload');

    const scheduler = new Scheduler(tmpSchedFile);
    const item = await failedItem(scheduler, { filePath: attachment, fileName: 'notes.txt' });

    expect(scheduler.getList()[0].attachmentMissing).toBe(false);

    fs.unlinkSync(attachment);
    expect(scheduler.getList()[0].attachmentMissing).toBe(true);

    // The derived flag is never written back into the persisted record.
    const raw = JSON.parse(fs.readFileSync(tmpSchedFile, 'utf8')) as Record<string, unknown>[];
    expect(raw[0].attachmentMissing).toBeUndefined();

    // Discarding a failed file message cleans up any attachment still around.
    expect(scheduler.discard(item.id)).toBe(true);
  });
});
