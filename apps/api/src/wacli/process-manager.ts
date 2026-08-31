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
  private onStateChange?: (state: ProcessState, reason?: string) => void;
  private onLifecycleEvent?: (event: Record<string, unknown>) => void;

  constructor(options: ProcessManagerOptions) {
    this.apiPort = options.apiPort;
    this.webhookSecret = crypto.randomBytes(32).toString('hex');
    this.onStateChange = options.onStateChange;
    this.onLifecycleEvent = options.onLifecycleEvent;

    // Clean up any child processes on exit/signals
    this.registerProcessHooks();
  }

  private registerProcessHooks(): void {
    const cleanup = () => {
      if (this.child && !this.child.killed) {
        try {
          this.child.kill('SIGINT');
        } catch {
          // ignore
        }
      }
    };
    process.once('exit', cleanup);
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
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
    this.spawnSyncProcess();
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
        this.setState('running', 'Connected to WhatsApp');
        this.lastError = null;
      } else if (parsed.event === 'logged_out' || parsed.type === 'logged_out') {
        this.setState('logged_out', 'WhatsApp session was logged out or revoked');
      } else if (parsed.event === 'error') {
        const data = parsed.data as { message?: string } | undefined;
        this.lastError = data?.message || JSON.stringify(parsed.data || parsed);
        logger.error('process', `Sync process error event: ${this.lastError}`);
      } else if (parsed.event === 'disconnected') {
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
    const prevMutex = this.pauseMutex;
    let releaseMutex: () => void;
    this.pauseMutex = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });

    await prevMutex;

    try {
      logger.info('process', 'Pausing sync process for exclusive lock action');
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
      this.isPaused = false;
      this.spawnSyncProcess();
      releaseMutex!();
    }
  }
}
