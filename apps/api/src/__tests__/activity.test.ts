import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ActivityStore, ACTIVITY_PAGE_SIZE } from '../wacli/activity.js';

describe('ActivityStore', () => {
  let dir: string;
  let store: ActivityStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wacli-activity-'));
    store = new ActivityStore(path.join(dir, 'activity.db'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Seeds `count` sends, oldest first, one minute apart. */
  function seed(count: number): void {
    const base = Date.parse('2026-09-01T00:00:00.000Z');
    for (let i = 0; i < count; i++) {
      store.record({
        to: 'alice@s.whatsapp.net',
        message: `send ${i}`,
        status: 'success',
        timestamp: new Date(base + i * 60_000).toISOString(),
      });
    }
  }

  it('survives a restart, which the in-browser log never did', () => {
    store.record({ to: 'alice@s.whatsapp.net', message: 'hello', status: 'success' });

    const reopened = new ActivityStore(path.join(dir, 'activity.db'));
    expect(reopened.list().items).toHaveLength(1);
  });

  it('returns ten rows by default, newest first', () => {
    seed(25);

    const page = store.list();
    expect(page.items).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(page.items[0].message).toBe('send 24');
    expect(page.items[9].message).toBe('send 15');
    expect(page.total).toBe(25);
    expect(page.nextCursor).not.toBeNull();
  });

  it('walks the whole log through its cursor without repeating or skipping a row', () => {
    seed(25);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<ActivityStore['list']> = store.list({
        before: cursor ?? undefined,
      });
      seen.push(...page.items.map((i) => i.message));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen[0]).toBe('send 24');
    expect(seen[24]).toBe('send 0');
  });

  it('does not let two sends in the same millisecond hide each other', () => {
    // Paging on timestamp alone drops every tie past the page boundary; the
    // cursor carries the id for exactly this case.
    const stamp = '2026-09-01T00:00:00.000Z';
    for (let i = 0; i < 6; i++) {
      store.record({
        to: 'alice@s.whatsapp.net',
        message: `tie ${i}`,
        status: 'success',
        timestamp: stamp,
      });
    }

    const first = store.list({ limit: 3 });
    const second = store.list({ limit: 3, before: first.nextCursor! });

    expect(first.items).toHaveLength(3);
    expect(second.items).toHaveLength(3);
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(6);
  });

  it('reports no next cursor once the last row is on the page', () => {
    seed(3);
    expect(store.list({ limit: 3 }).nextCursor).toBeNull();
  });

  it('settles a pending send into its outcome', () => {
    const id = store.record({ to: 'alice@s.whatsapp.net', message: 'sending', status: 'pending' });
    store.settle(id, { status: 'success', messageId: '3EB0626F628F3B645B291E' });

    const [entry] = store.list().items;
    expect(entry.status).toBe('success');
    expect(entry.messageId).toBe('3EB0626F628F3B645B291E');
  });

  it('keeps the failure reason on a send that did not go out', () => {
    const id = store.record({ to: 'alice@s.whatsapp.net', message: 'nope', status: 'pending' });
    store.settle(id, { status: 'error', error: 'store is locked' });

    const [entry] = store.list().items;
    expect(entry.status).toBe('error');
    expect(entry.error).toBe('store is locked');
  });

  it('caps a page that asks for more than the log will hand out at once', () => {
    seed(30);
    expect(store.list({ limit: 10_000 }).items.length).toBeLessThanOrEqual(200);
  });

  it('expires entries past the retention window and keeps the rest', () => {
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString();
    store.record({ to: 'alice@s.whatsapp.net', message: 'ancient', status: 'success', timestamp: old });
    store.record({ to: 'alice@s.whatsapp.net', message: 'recent', status: 'success' });

    expect(store.prune()).toBe(1);
    expect(store.list().items.map((i) => i.message)).toEqual(['recent']);
  });
});
