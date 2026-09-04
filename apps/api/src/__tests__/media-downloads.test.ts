import { describe, it, expect, vi } from 'vitest';
import { MediaDownloadCoordinator } from '../wacli/media-downloads.js';

describe('MediaDownloadCoordinator', () => {
  /** A task that reports peak concurrency across all its invocations. */
  function makeTracker() {
    const state = { active: 0, peak: 0, calls: 0 };
    const task = async () => {
      state.calls += 1;
      state.active += 1;
      state.peak = Math.max(state.peak, state.active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      state.active -= 1;
      return 'ok';
    };
    return { state, task };
  }

  it('caps how many downloads run at once', async () => {
    const coordinator = new MediaDownloadCoordinator({ concurrency: 3 });
    const { state, task } = makeTracker();

    // A freshly opened thread asking for 40 attachments at once.
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => coordinator.run(`chat:${i}`, task))
    );

    expect(state.calls).toBe(40);
    expect(state.peak).toBeLessThanOrEqual(3);
  });

  it('collapses concurrent requests for the same media into one download', async () => {
    const coordinator = new MediaDownloadCoordinator();
    const task = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'downloaded';
    });

    const results = await Promise.all([
      coordinator.run('chat:msg1', task),
      coordinator.run('chat:msg1', task),
      coordinator.run('chat:msg1', task),
    ]);

    expect(task).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['downloaded', 'downloaded', 'downloaded']);
  });

  it('runs again once an earlier download has finished', async () => {
    const coordinator = new MediaDownloadCoordinator();
    const task = vi.fn(async () => 'downloaded');

    await coordinator.run('chat:msg1', task);
    await coordinator.run('chat:msg1', task);

    // Single-flight dedupes concurrent callers, it is not a success cache.
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('remembers a failure instead of re-running a doomed download', async () => {
    const coordinator = new MediaDownloadCoordinator({ failureTtlMs: 60_000 });
    const task = vi.fn(async () => {
      throw new Error('download failed with status code 403');
    });

    await expect(coordinator.run('chat:expired', task)).rejects.toThrow('403');
    await expect(coordinator.run('chat:expired', task)).rejects.toThrow('403');
    await expect(coordinator.run('chat:expired', task)).rejects.toThrow('403');

    // Expired media never becomes downloadable, so scrolling past it must not
    // keep spawning wacli.
    expect(task).toHaveBeenCalledTimes(1);
  });

  it('retries a remembered failure once the TTL has passed', async () => {
    let now = 1_000_000;
    const coordinator = new MediaDownloadCoordinator({
      failureTtlMs: 5000,
      now: () => now,
    });
    const task = vi.fn(async () => {
      throw new Error('sql: no rows in result set');
    });

    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    now += 4999;
    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    expect(task).toHaveBeenCalledTimes(1);

    now += 2;
    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('never caches a store-lock failure, which is transient by definition', async () => {
    const coordinator = new MediaDownloadCoordinator({ failureTtlMs: 60_000 });
    const task = vi.fn(async () => {
      throw new Error('store is locked (another wacli is running?): store locked');
    });

    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();

    expect(task).toHaveBeenCalledTimes(2);
  });

  it('lets an explicit operator retry through a remembered failure', async () => {
    const coordinator = new MediaDownloadCoordinator({ failureTtlMs: 60_000 });
    let shouldFail = true;
    const task = vi.fn(async () => {
      if (shouldFail) throw new Error('download failed with status code 403');
      return 'downloaded';
    });

    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    // The auto path stays blocked...
    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    expect(task).toHaveBeenCalledTimes(1);

    // ...but pressing Retry must actually try again.
    shouldFail = false;
    await expect(
      coordinator.run('chat:msg', task, { ignoreFailureCache: true })
    ).resolves.toBe('downloaded');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('clears a remembered failure once the media downloads', async () => {
    const coordinator = new MediaDownloadCoordinator({ failureTtlMs: 60_000 });
    let shouldFail = true;
    const task = async () => {
      if (shouldFail) throw new Error('download failed with status code 403');
      return 'downloaded';
    };

    await expect(coordinator.run('chat:msg', task)).rejects.toThrow();
    shouldFail = false;
    await coordinator.run('chat:msg', task, { ignoreFailureCache: true });

    expect(coordinator.getStats().cachedFailures).toBe(0);
  });

  it('releases its slot when a download throws, rather than leaking capacity', async () => {
    const coordinator = new MediaDownloadCoordinator({ concurrency: 1, failureTtlMs: 0 });
    const failing = async () => {
      throw new Error('boom');
    };

    for (let i = 0; i < 5; i++) {
      await expect(coordinator.run(`chat:${i}`, failing)).rejects.toThrow('boom');
    }

    // A leaked slot would leave active pinned at the cap and deadlock the queue.
    expect(coordinator.getStats().active).toBe(0);
    await expect(coordinator.run('chat:ok', async () => 'fine')).resolves.toBe('fine');
  });
});
