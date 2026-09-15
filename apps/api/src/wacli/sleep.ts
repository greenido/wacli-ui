import { logger } from '../logger.js';
import { modeManager } from './mode.js';
import type { EventBridge } from '../ws/event-bridge.js';
import type { SleepState } from '../types.js';

/** What sleep needs from the process manager. */
export interface SleepDaemon {
  stop(): Promise<void>;
  startSoon(): void;
}

export interface SleepControllerOptions {
  daemon: SleepDaemon;
  bridge?: Pick<EventBridge, 'broadcast'>;
  /** `--no-sync`: waking must not start a daemon that was never meant to run. */
  syncDisabled?: boolean;
}

/**
 * Sleep mode: the daemon stopped, only scheduled messages going out.
 *
 * The scheduler needs nothing from here. Its sends already run exclusive,
 * taking the store with no daemon up, and the process manager now leaves a
 * daemon nobody wants where it is. So sleeping is only three things in a fixed
 * order: record it, tell every tab, stop the daemon. Recording comes first, so
 * a crash halfway through still comes back asleep.
 */
export class SleepController {
  constructor(private readonly opts: SleepControllerOptions) {}

  public state(): SleepState {
    return modeManager.getSleepState();
  }

  public isAsleep(): boolean {
    return modeManager.isSleeping();
  }

  public async sleep(reason: string): Promise<SleepState> {
    if (modeManager.isSleeping()) return modeManager.getSleepState();

    const state = modeManager.setSleeping(true);
    logger.info('process', 'Sleep mode on', { reason });
    this.announce(state);
    await this.opts.daemon.stop();
    return state;
  }

  /**
   * Every wake names its reason in the log. Nothing automatic is supposed to
   * end sleep, and when something does anyway, this line is how to find it.
   */
  public wake(reason: string): SleepState {
    if (!modeManager.isSleeping()) return modeManager.getSleepState();

    const state = modeManager.setSleeping(false);
    logger.info('process', 'Sleep mode off', { reason });
    this.announce(state);
    if (!this.opts.syncDisabled) {
      this.opts.daemon.startSoon();
    }
    return state;
  }

  private announce(state: SleepState): void {
    this.opts.bridge?.broadcast({
      type: 'sleep.changed',
      data: state,
      ts: new Date().toISOString(),
    });
  }
}
