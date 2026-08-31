import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type LogCategory = 'process' | 'send' | 'ws' | 'api' | 'webhook' | 'automation' | 'media';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

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
