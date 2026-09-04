import { logger } from '../logger.js';
import { isStoreLockMessage } from './store-lock.js';

export const DEFAULT_MEDIA_CONCURRENCY = 3;
export const DEFAULT_FAILURE_TTL_MS = 5 * 60 * 1000;

export interface MediaDownloadCoordinatorOptions {
  /** Simultaneous `wacli media download` processes allowed. */
  concurrency?: number;
  /** How long a failed download is remembered before it is attempted again. */
  failureTtlMs?: number;
  now?: () => number;
}

interface CachedFailure {
  at: number;
  message: string;
}

/**
 * Serialises the media downloads the thread view kicks off.
 *
 * Opening a chat renders every attachment at once, and each one that is not on
 * disk shells out a `wacli media download`. Unbounded, that is dozens of
 * processes all contending for the single-writer store lock, which starves the
 * sync daemon. Three things keep that under control:
 *
 *  - a concurrency cap, so a thread of 40 attachments is a queue, not a stampede;
 *  - single-flight, so the same message requested twice downloads once;
 *  - a short negative cache, because expired media (HTTP 403) and messages
 *    missing from the store never succeed, and without it every scroll past
 *    them spawns the same doomed command again.
 *
 * Store-lock failures are deliberately never cached: those are transient by
 * definition and the caller's own retry should get through.
 */
export class MediaDownloadCoordinator {
  private concurrency: number;
  private failureTtlMs: number;
  private now: () => number;

  private active = 0;
  private queue: Array<() => void> = [];
  private inFlight = new Map<string, Promise<unknown>>();
  private failures = new Map<string, CachedFailure>();

  constructor(options: MediaDownloadCoordinatorOptions = {}) {
    this.concurrency = options.concurrency ?? DEFAULT_MEDIA_CONCURRENCY;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Runs `task` under the cap, collapsing concurrent callers for the same key.
   * Pass `ignoreFailureCache` for an explicit operator retry, which must always
   * reach wacli rather than replaying a remembered failure.
   */
  public run<T>(
    key: string,
    task: () => Promise<T>,
    options: { ignoreFailureCache?: boolean } = {}
  ): Promise<T> {
    if (options.ignoreFailureCache) {
      this.failures.delete(key);
    } else {
      const cached = this.getCachedFailure(key);
      if (cached) {
        return Promise.reject(new Error(cached.message));
      }
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = this.acquire()
      .then(async () => {
        try {
          return await task();
        } finally {
          this.release();
        }
      })
      .then(
        (value) => {
          // A success clears whatever we remembered about this media.
          this.failures.delete(key);
          return value;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!isStoreLockMessage(message)) {
            this.failures.set(key, { at: this.now(), message });
          }
          throw err;
        }
      )
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Drops a remembered failure, e.g. once the media arrives another way. */
  public forget(key: string): void {
    this.failures.delete(key);
  }

  public getStats(): { active: number; queued: number; cachedFailures: number } {
    return {
      active: this.active,
      queued: this.queue.length,
      cachedFailures: this.failures.size,
    };
  }

  private getCachedFailure(key: string): CachedFailure | null {
    const cached = this.failures.get(key);
    if (!cached) return null;

    if (this.now() - cached.at >= this.failureTtlMs) {
      this.failures.delete(key);
      return null;
    }

    logger.info('media', `Skipping download for ${key}; it failed recently: ${cached.message}`);
    return cached;
  }

  private acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Shared by both media routes so one cap covers every download path. */
export const mediaDownloads = new MediaDownloadCoordinator();
