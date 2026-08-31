import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Scheduler } from '../wacli/scheduler.js';

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
