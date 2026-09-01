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

  it('holds a due message while safe read-only mode is active', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.NOPE' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);

    await scheduler.checkDueMessages();

    expect(execWacliMock).not.toHaveBeenCalled();
    // Held, not failed — it still goes out once the operator unlocks.
    expect(scheduler.getList()[0].status).toBe('pending');
  });

  it('never turns safe mode off as a side effect of dispatching', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.NOPE' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();

    expect(modeManager.isReadOnly()).toBe(true);
  });

  it('sends a held message once safe mode is lifted', async () => {
    execWacliMock.mockResolvedValue({ messageId: 'wamid.LATER' });
    modeManager.setReadOnly(true);

    const scheduler = new Scheduler(tmpSchedFile);
    scheduler.schedule(dueMessage);
    await scheduler.checkDueMessages();
    expect(execWacliMock).not.toHaveBeenCalled();

    modeManager.setReadOnly(false);
    await scheduler.checkDueMessages();

    expect(execWacliMock).toHaveBeenCalledTimes(1);
    expect(scheduler.getList()[0].status).toBe('sent');
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
