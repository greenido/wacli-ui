import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type LogCategory = 'process' | 'send' | 'ws' | 'api' | 'webhook' | 'automation' | 'media';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run logs older than this are removed when a new run starts. */
export const LOG_RETENTION_DAYS = 3;

/**
 * Exactly the filename this class writes: `run-` + an ISO timestamp with `:`
 * and `.` swapped for `-`. Deliberately strict — `logsDir` is caller-supplied,
 * so nothing that we did not write is ever a deletion candidate.
 */
const RUN_LOG_PATTERN = /^run-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.log$/;

/** When the run that owns this file started, or null if the name is not ours. */
function runStartedAt(fileName: string): number | null {
  const match = RUN_LOG_PATTERN.exec(fileName);
  if (!match) return null;

  const [, date, hours, minutes, seconds, millis] = match;
  const parsed = Date.parse(`${date}T${hours}:${minutes}:${seconds}.${millis}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export class RunLogger {
  private logFilePath: string;
  private logsDir: string;

  constructor(customLogsDir?: string) {
    this.logsDir = customLogsDir ?? path.resolve(__dirname, '../logs');
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o755 });
    }

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(this.logsDir, `run-${timestamp}.log`);

    try {
      fs.writeFileSync(this.logFilePath, '', { encoding: 'utf8', mode: 0o644 });
      this.write('INFO', 'process', `Run log initialized at ${this.logFilePath}`);
    } catch (err) {
      console.error('Failed to create log file:', err);
    }

    // Every run leaves a file behind and nothing used to clear them out.
    this.pruneExpiredLogs();
  }

  /**
   * Deletes run logs past the retention window. Only files named the way this
   * class names them are touched, and never the current run's own file — a
   * long-lived process must not delete the log it is still writing to. A
   * failure here is not worth refusing to start over, so it stays quiet.
   */
  private pruneExpiredLogs(): void {
    const cutoff = Date.now() - LOG_RETENTION_DAYS * DAY_MS;
    let removed = 0;

    let entries: string[];
    try {
      entries = fs.readdirSync(this.logsDir);
    } catch {
      return;
    }

    for (const name of entries) {
      const startedAt = runStartedAt(name);
      if (startedAt === null || startedAt >= cutoff) continue;

      const filePath = path.join(this.logsDir, name);
      if (filePath === this.logFilePath) continue;

      try {
        fs.unlinkSync(filePath);
        removed++;
      } catch {
        // A log we cannot remove is not a reason to fail the run.
      }
    }

    if (removed > 0) {
      this.write(
        'INFO',
        'process',
        `Pruned ${removed} run log${removed === 1 ? '' : 's'} older than ${LOG_RETENTION_DAYS} days`
      );
    }
  }

  public getFilePath(): string {
    return this.logFilePath;
  }

  public write(level: LogLevel, category: LogCategory, message: string): void {
    const iso = new Date().toISOString();
    const line = `[${iso}] [${level}] [${category}] ${message}\n`;

    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o755 });
      }
      fs.appendFileSync(this.logFilePath, line, 'utf8');
    } catch (err) {
      console.error('Failed to append to log file:', err);
    }

    if (level === 'ERROR') {
      console.error(line.trim());
    } else if (level === 'WARN') {
      console.warn(line.trim());
    }
  }

  public info(category: LogCategory, message: string): void {
    this.write('INFO', category, message);
  }

  public warn(category: LogCategory, message: string): void {
    this.write('WARN', category, message);
  }

  public error(category: LogCategory, message: string): void {
    this.write('ERROR', category, message);
  }

  public close(): void {
    // No-op for appendFileSync, but preserves API contract
  }
}

export const logger = new RunLogger();
