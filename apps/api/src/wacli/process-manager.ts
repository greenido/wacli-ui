import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { logger } from '../logger.js';
import { modeManager } from './mode.js';
import type { MissionControlStatus } from '../types.js';

export type ProcessState = MissionControlStatus['processState'];

export interface ProcessManagerOptions {
  apiPort: number;
  onStateChange?: (state: ProcessState, reason?: string) => void;
  onLifecycleEvent?: (event: Record<string, unknown>) => void;
  /**
   * How long to wait after an exclusive command before bringing the sync
   * daemon back. The daemon needs roughly 600ms to reach "connected", so
   * respawning the instant a command finishes means a command arriving just
   * afterwards kills a daemon that never got to connect.
   */
  respawnDebounceMs?: number;
}

export const DEFAULT_RESPAWN_DEBOUNCE_MS = 750;

/**
 * Cleanups of every live manager, run when this process goes down. The hooks
 * used to be registered per instance, which added three process listeners per
 * construction and tripped Node's MaxListenersExceededWarning as soon as a test
 * file built more than a handful of managers. One shared hook over this
 * registry keeps the count at three however many managers exist.
 */
const shutdownCleanups = new Set<() => void>();
const SHUTDOWN_EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const;
let shutdownHooksRegistered = false;

/** Named so tests can pick it out of the process's other listeners. */
function wacliShutdownHook(): void {
  for (const cleanup of shutdownCleanups) {
    cleanup();
  }
}

function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;
  for (const event of SHUTDOWN_EVENTS) {
    process.once(event, wacliShutdownHook);
  }
}

function unregisterShutdownHooks(): void {
  if (!shutdownHooksRegistered) return;
  shutdownHooksRegistered = false;
  for (const event of SHUTDOWN_EVENTS) {
    process.off(event, wacliShutdownHook);
  }
}

export class WacliProcessManager {
  private child: ChildProcess | null = null;
  private state: ProcessState = 'stopped';
  private webhookSecret: string;
  private apiPort: number;
  private reconnectAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private uptimeTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private isPaused = false;
  private pauseMutex = Promise.resolve();
  /** Exclusive actions queued or running; the daemon stays down until it hits 0. */
  private exclusiveWaiters = 0;
  private respawnTimer: NodeJS.Timeout | null = null;
  private respawnDebounceMs: number;
  /** Last connection state the daemon reported about itself. */
  private daemonConnected = false;
  private onStateChange?: (state: ProcessState, reason?: string) => void;
  private onLifecycleEvent?: (event: Record<string, unknown>) => void;
  /** SIGINTs the daemon if this process goes down; held so dispose() can drop it. */
  private readonly shutdownCleanup = (): void => {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill('SIGINT');
      } catch {
        // ignore
      }
    }
  };

  constructor(options: ProcessManagerOptions) {
    this.apiPort = options.apiPort;
    this.respawnDebounceMs = options.respawnDebounceMs ?? DEFAULT_RESPAWN_DEBOUNCE_MS;
    this.webhookSecret = crypto.randomBytes(32).toString('hex');
    this.onStateChange = options.onStateChange;
    this.onLifecycleEvent = options.onLifecycleEvent;

    // Clean up any child processes on exit/signals
    this.registerProcessHooks();
  }

  private registerProcessHooks(): void {
    shutdownCleanups.add(this.shutdownCleanup);
    registerShutdownHooks();
  }

  /**
   * Detaches this manager from the process-wide shutdown hooks. Production keeps
   * one manager for the life of the process and never needs this; tests build
   * many, and each one left registered holds its child-kill closure - and the
   * manager with it - alive. Only the hook is dropped: stop() the daemon first
   * if one is running, or nothing will be left to shut it down.
   */
  public dispose(): void {
    shutdownCleanups.delete(this.shutdownCleanup);
    if (shutdownCleanups.size === 0) {
      unregisterShutdownHooks();
    }
  }

  public getWebhookSecret(): string {
    return this.webhookSecret;
  }

  public getState(): ProcessState {
    return this.state;
  }

  public getPid(): number | null {
    return this.child?.pid ?? null;
  }

  public getLastError(): string | null {
    return this.lastError;
  }

  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Whether our own sync daemon reports itself connected to WhatsApp. This is
   * the only trustworthy answer while the daemon holds the store lock, because
   * a `wacli doctor` probe run alongside it is refused by that very lock and
   * reports "locked_by_other_process" about a process that is working fine.
   */
  public isDaemonConnected(): boolean {
    return this.daemonConnected && this.child !== null;
  }

  /** Exposed for the health route's "is a command holding the daemon down" check. */
  public hasPendingExclusiveWork(): boolean {
    return this.exclusiveWaiters > 0;
  }

  public getHeartbeatAgeSeconds(): number | null {
    const settings = modeManager.getSettings();
    const defaultStore = process.platform === 'linux'
      ? path.join(os.homedir(), '.local/state/wacli')
      : path.join(os.homedir(), '.wacli');
    const storeDir = settings.storeDir ?? process.env.WACLI_STORE_DIR ?? defaultStore;
    const heartbeatPath = path.join(storeDir, 'HEARTBEAT');

    try {
      if (fs.existsSync(heartbeatPath)) {
        const raw = fs.readFileSync(heartbeatPath, 'utf8').trim();
        const date = new Date(raw);
        if (!isNaN(date.getTime())) {
          return Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  private setState(state: ProcessState, reason?: string): void {
    this.state = state;
    logger.info('process', `State transitioned to ${state}${reason ? `: ${reason}` : ''}`);
    if (this.onStateChange) {
      this.onStateChange(state, reason);
    }
  }

  public start(): void {
    if (this.child || this.state === 'running' || this.state === 'starting') {
      return;
    }

    this.isPaused = false;
    this.cancelPendingRespawn();
    this.spawnSyncProcess();
  }

  /**
   * Brings the daemon back after the exclusive queue drains, but only once it
   * has stayed drained for the debounce window. Any exclusive action starting
   * in the meantime cancels it, so a burst of commands produces one respawn at
   * the end instead of one per command.
   */
  private scheduleRespawn(): void {
    this.cancelPendingRespawn();
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      if (this.isPaused || this.exclusiveWaiters > 0 || this.child) {
        return;
      }
      this.spawnSyncProcess();
    }, this.respawnDebounceMs);
  }

  private cancelPendingRespawn(): void {
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
  }

  private spawnSyncProcess(): void {
    const bin = process.env.WACLI_BIN ?? 'wacli';
    const settings = modeManager.getSettings();
    const webhookUrl = `http://127.0.0.1:${this.apiPort}/internal/wacli/webhook`;

    const args = [
      'sync',
      '--follow',
      '--events',
      '--webhook',
      webhookUrl,
      '--webhook-secret',
      this.webhookSecret,
      '--webhook-allow-private',
      '--webhook-events',
      'message,receipt,chat_presence',
      '--stale-threshold',
      '2m',
      '--max-db-size',
      '2GB',
    ];

    const storeDir = settings.storeDir ?? process.env.WACLI_STORE_DIR;
    const account = settings.account ?? process.env.WACLI_ACCOUNT;

    if (storeDir) {
      args.push('--store', storeDir);
    } else if (account) {
      args.push('--account', account);
    }

    this.setState('starting');
    logger.info('process', `Spawning ${bin} ${args.join(' ')}`);

    // IMPORTANT: Never pass WACLI_READONLY to sync process!
    const env = { ...process.env };
    delete env.WACLI_READONLY;

    try {
      const child = spawn(bin, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.child = child;

      // Handle stderr NDJSON lifecycle stream
      if (child.stderr) {
        const rl = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
        rl.on('line', (line) => {
          this.handleStderrLine(line);
        });
      }

      // Discard stdout or log if needed
      if (child.stdout) {
        child.stdout.resume();
      }

      child.on('spawn', () => {
        this.setState('running');
        // If it runs stably for 60s, reset reconnect counter
        if (this.uptimeTimer) clearTimeout(this.uptimeTimer);
        this.uptimeTimer = setTimeout(() => {
          if (this.state === 'running') {
            this.reconnectAttempts = 0;
            logger.info('process', 'Sync process achieved 60s stable uptime; backoff reset.');
          }
        }, 60000);
      });

      child.on('error', (err) => {
        this.lastError = err.message;
        logger.error('process', `Spawn error: ${err.message}`);
        this.handleProcessExit(-1, null);
      });

      child.on('close', (code, signal) => {
        this.handleProcessExit(code, signal);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      this.setState('failed', msg);
    }
  }

  public async restart(): Promise<void> {
    await this.stop();
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.start();
  }

  private handleStderrLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      logger.info('process', `Event from sync: ${JSON.stringify(parsed)}`);

      if (parsed.event === 'connected') {
        this.daemonConnected = true;
        this.setState('running', 'Connected to WhatsApp');
        this.lastError = null;
      } else if (parsed.event === 'logged_out' || parsed.type === 'logged_out') {
        this.daemonConnected = false;
        this.setState('logged_out', 'WhatsApp session was logged out or revoked');
      } else if (parsed.event === 'error') {
        const data = parsed.data as { message?: string } | undefined;
        this.lastError = data?.message || JSON.stringify(parsed.data || parsed);
        logger.error('process', `Sync process error event: ${this.lastError}`);
      } else if (parsed.event === 'disconnected') {
        this.daemonConnected = false;
        logger.warn('process', `Sync process disconnected event: ${JSON.stringify(parsed)}`);
      }

      if (this.onLifecycleEvent) {
        this.onLifecycleEvent(parsed);
      }
    } catch {
      // Non-JSON line from wacli stderr (e.g. human logging)
      const lower = trimmed.toLowerCase();
      if (lower.includes('error') || lower.includes('fatal') || lower.includes('panic') || lower.includes('locked')) {
        this.lastError = trimmed;
      }
      logger.info('process', `wacli stderr: ${trimmed}`);
    }
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    this.daemonConnected = false;
    if (this.uptimeTimer) {
      clearTimeout(this.uptimeTimer);
      this.uptimeTimer = null;
    }

    if (this.isPaused) {
      this.setState('paused');
      return;
    }

    if (this.state === 'logged_out') {
      logger.warn('process', 'Sync process terminated due to logged_out event; not restarting.');
      return;
    }

    const baseReason = signal ? `killed by ${signal}` : `exited with code ${code}`;
    const reason = this.lastError ? `${baseReason} (${this.lastError})` : baseReason;
    logger.warn('process', `Sync process exited: ${reason}`);

    // Schedule backoff restart
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 30000);

    this.setState('restarting', `${reason}. Restarting in ${delay}ms (attempt #${this.reconnectAttempts})`);

    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.spawnSyncProcess();
    }, delay);
  }

  public async stop(): Promise<void> {
    this.isPaused = true;
    this.cancelPendingRespawn();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.child) {
      this.setState('stopped');
      return;
    }

    return new Promise<void>((resolve) => {
      const child = this.child;
      if (!child) {
        this.setState('stopped');
        resolve();
        return;
      }

      const forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
      }, 3000);

      child.once('close', () => {
        clearTimeout(forceKillTimer);
        this.child = null;
        this.setState('stopped');
        resolve();
      });

      try {
        child.kill('SIGINT');
      } catch {
        child.kill('SIGTERM');
      }
    });
  }

  public async executeExclusive<T>(action: () => Promise<T>): Promise<T> {
    // Counted before awaiting the mutex so a caller still queueing already
    // blocks the respawn below. Without that, the daemon is spawned the instant
    // one command finishes and killed microseconds later by the next one in
    // line, and it never survives the ~600ms it needs to connect.
    this.exclusiveWaiters += 1;

    const prevMutex = this.pauseMutex;
    let releaseMutex: () => void;
    this.pauseMutex = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });

    try {
      // Inside the try so a rejection here still runs the finally. A leaked
      // waiter count would keep the daemon down permanently, which is a worse
      // failure than the thrash this guard exists to prevent.
      await prevMutex;

      logger.info('process', 'Pausing sync process for exclusive lock action');
      this.cancelPendingRespawn();
      this.isPaused = true;
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }

      if (this.child) {
        await new Promise<void>((resolve) => {
          const child = this.child;
          if (!child) return resolve();

          const killTimer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
          }, 3000);

          child.once('close', () => {
            clearTimeout(killTimer);
            this.child = null;
            this.setState('paused', 'Paused for exclusive command');
            resolve();
          });

          try {
            child.kill('SIGINT');
          } catch {
            resolve();
          }
        });
      } else {
        this.setState('paused', 'Paused for exclusive command');
      }

      // Execute exclusive action
      const result = await action();
      return result;
    } finally {
      this.exclusiveWaiters -= 1;
      // Stay paused while more exclusive work is queued: the next caller would
      // only have to kill the daemon again.
      if (this.exclusiveWaiters === 0) {
        this.isPaused = false;
        this.scheduleRespawn();
      }
      releaseMutex!();
    }
  }
}
