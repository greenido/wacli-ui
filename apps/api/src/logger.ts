import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type LogCategory =
  | 'process'
  | 'send'
  | 'ws'
  | 'api'
  | 'http'
  | 'webhook'
  | 'automation'
  | 'media';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/**
 * Whatever makes a line answer "which one?" — ids, counts, durations, the error
 * itself. Structured rather than baked into the message so a line stays
 * greppable, and so the message text stays constant across occurrences, which
 * is what lets repeats collapse.
 */
export type LogFields = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export const DEFAULT_LOG_LEVEL: LogLevel = 'INFO';

/** Unrecognised values fall back rather than silencing the log by typo. */
export function parseLogLevel(raw: string | undefined, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  const candidate = (raw ?? '').trim().toUpperCase();
  return candidate in LEVEL_WEIGHT ? (candidate as LogLevel) : fallback;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Run logs older than this are removed when a new run starts. */
export const LOG_RETENTION_DAYS = 3;

/** Beyond this a field is context turning into a wall of text. */
const MAX_VALUE_CHARS = 240;

/** Enough of a stack to place the throw; the rest is node internals. */
const MAX_STACK_FRAMES = 6;

/** Identical lines further apart than this are news again, not a flood. */
const REPEAT_WINDOW_MS = 10_000;

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

function truncate(text: string): string {
  return text.length <= MAX_VALUE_CHARS ? text : `${text.slice(0, MAX_VALUE_CHARS - 1)}…`;
}

/**
 * Bare when the value is a single plain token, quoted the moment it could blur
 * into the next `key=value` pair. Newlines are folded for the same reason: one
 * event is one line, so a multi-line value cannot fake a second event.
 */
function quote(text: string): string {
  const clean = truncate(text.replace(/\s+/g, ' ').trim());
  return clean.length > 0 && /^[\w./:@+-]+$/.test(clean) ? clean : JSON.stringify(clean);
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return quote(`${value.name}: ${value.message}`);
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  if (typeof value === 'bigint') return `${value}n`;

  try {
    return quote(JSON.stringify(value) ?? String(value));
  } catch {
    // Circular, or a getter that throws. The key still says something happened.
    return quote(String(value));
  }
}

function formatFields(fields?: LogFields): string {
  if (!fields) return '';

  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    // An absent field is noise, not information: leave the column out entirely.
    if (value === undefined) continue;
    parts.push(`${key}=${formatValue(value)}`);
  }

  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

/**
 * Frames only. The first stack line restates "Name: message", which is already
 * on the log line itself.
 */
function extractStack(value: unknown): string | null {
  if (!(value instanceof Error) || !value.stack) return null;

  const frames = value.stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_STACK_FRAMES);

  return frames.length > 0 ? frames.map((line) => `    ${line}`).join('\n') : null;
}

const COLOR: Record<LogLevel, string> = {
  DEBUG: '\u001b[90m',
  INFO: '\u001b[36m',
  WARN: '\u001b[33m',
  ERROR: '\u001b[31m',
};
const DIM = '\u001b[90m';
const RESET = '\u001b[0m';

export interface RunLoggerOptions {
  /** Lines below this are dropped. Defaults to `$LOG_LEVEL`, else INFO. */
  level?: LogLevel;
  /** Mirror to the terminal. Off under test, where it is only noise. */
  console?: boolean;
  /** ANSI colour. Defaults to "the terminal is a TTY and `$NO_COLOR` is unset". */
  color?: boolean;
}

export class RunLogger {
  private logFilePath: string;
  private logsDir: string;
  private level: LogLevel;
  private consoleEnabled: boolean;
  private useColor: boolean;

  /** The line currently repeating, and how many copies have been withheld. */
  private repeat: {
    key: string;
    level: LogLevel;
    category: LogCategory;
    message: string;
    count: number;
    lastAt: number;
  } | null = null;

  constructor(customLogsDir?: string, options: RunLoggerOptions = {}) {
    this.logsDir = customLogsDir ?? path.resolve(__dirname, '../logs');
    this.level = options.level ?? parseLogLevel(process.env.LOG_LEVEL);

    const underTest = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
    this.consoleEnabled = options.console ?? !underTest;
    this.useColor = options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);

    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o755 });
    }

    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    this.logFilePath = path.join(this.logsDir, `run-${timestamp}.log`);

    try {
      fs.writeFileSync(this.logFilePath, '', { encoding: 'utf8', mode: 0o644 });
      // A log that cannot say which process wrote it, at what verbosity, is a
      // log you have to guess about three days later.
      this.info('process', 'Run log initialized', {
        file: this.logFilePath,
        pid: process.pid,
        node: process.version,
        level: this.level,
      });
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
      this.info(
        'process',
        `Pruned ${removed} run log${removed === 1 ? '' : 's'} older than ${LOG_RETENTION_DAYS} days`
      );
    }
  }

  public getFilePath(): string {
    return this.logFilePath;
  }

  public getLevel(): LogLevel {
    return this.level;
  }

  /** Turn the volume up or down without a restart, e.g. from a debug toggle. */
  public setLevel(level: LogLevel): void {
    this.level = level;
  }

  public isEnabled(level: LogLevel): boolean {
    return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level];
  }

  public write(level: LogLevel, category: LogCategory, message: string, fields?: LogFields): void {
    if (!this.isEnabled(level)) return;

    // Collapsing costs the fields of every copy after the first, which is only
    // a good trade for a flood — and floods are failures repeating. A routine
    // INFO line recurring is a separate event whose status and duration are the
    // reason it was logged at all, so those are always kept in full.
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT.WARN) {
      this.flushRepeat();
      this.emit(level, category, message, fields);
      return;
    }

    // Fields are excluded from the key on purpose: one failure per attachment
    // differs only by id, and collapsing those is the entire point.
    const key = `${level}|${category}|${message}`;
    const now = Date.now();

    if (this.repeat && this.repeat.key === key && now - this.repeat.lastAt <= REPEAT_WINDOW_MS) {
      this.repeat.count += 1;
      this.repeat.lastAt = now;
      return;
    }

    this.flushRepeat();
    this.repeat = { key, level, category, message, count: 0, lastAt: now };
    this.emit(level, category, message, fields);
  }

  /**
   * Reports the copies withheld while a line was repeating. Called before any
   * different line and on close, so a flood costs two lines instead of forty
   * and nothing disappears silently. It restates the message rather than
   * pointing at "the previous line", which is ambiguous the moment the tally
   * lands next to something else.
   */
  private flushRepeat(): void {
    const pending = this.repeat;
    this.repeat = null;
    if (!pending || pending.count === 0) return;

    this.emit(pending.level, pending.category, `${pending.message} (repeated ${pending.count}x more)`);
  }

  private emit(level: LogLevel, category: LogCategory, message: string, fields?: LogFields): void {
    const iso = new Date().toISOString();
    const stack = fields ? extractStack(fields.err ?? fields.error) : null;
    const fieldText = formatFields(fields);

    const fileLine = `[${iso}] [${level}] [${category}] ${message}${fieldText}`;
    this.appendToFile(stack ? `${fileLine}\n${stack}\n` : `${fileLine}\n`);
    this.writeToConsole(iso, level, category, message, fieldText, stack);
  }

  private appendToFile(text: string): void {
    try {
      if (!fs.existsSync(this.logsDir)) {
        fs.mkdirSync(this.logsDir, { recursive: true, mode: 0o755 });
      }
      // Synchronous on purpose: a crash must not take the lines explaining it
      // down with it, and a local console writes nowhere near enough to care.
      fs.appendFileSync(this.logFilePath, text, 'utf8');
    } catch (err) {
      console.error('Failed to append to log file:', err);
    }
  }

  /**
   * The terminal gets the same event in a shape meant for a human watching it
   * scroll: wall-clock time rather than a full ISO stamp, and fixed-width
   * columns so level and category line up down the page.
   */
  private writeToConsole(
    iso: string,
    level: LogLevel,
    category: LogCategory,
    message: string,
    fieldText: string,
    stack: string | null
  ): void {
    if (!this.consoleEnabled) return;

    const time = iso.slice(11, 23);
    const head = `${this.paint(DIM, time)} ${this.paint(COLOR[level], level.padEnd(5))} ${this.paint(
      DIM,
      category.padEnd(9)
    )}`;
    const body = `${head} ${message}${this.paint(DIM, fieldText)}`;
    const stream = LEVEL_WEIGHT[level] >= LEVEL_WEIGHT.WARN ? process.stderr : process.stdout;

    stream.write(stack ? `${body}\n${this.paint(DIM, stack)}\n` : `${body}\n`);
  }

  private paint(color: string, text: string): string {
    return this.useColor && text.length > 0 ? `${color}${text}${RESET}` : text;
  }

  public debug(category: LogCategory, message: string, fields?: LogFields): void {
    this.write('DEBUG', category, message, fields);
  }

  public info(category: LogCategory, message: string, fields?: LogFields): void {
    this.write('INFO', category, message, fields);
  }

  public warn(category: LogCategory, message: string, fields?: LogFields): void {
    this.write('WARN', category, message, fields);
  }

  public error(category: LogCategory, message: string, fields?: LogFields): void {
    this.write('ERROR', category, message, fields);
  }

  /**
   * Times a unit of work: call the returned function when it finishes. "Slow"
   * becomes a number you can grep for (`durationMs=`) instead of a hunch, which
   * is most of what makes a subprocess-heavy app debuggable.
   */
  public time(
    category: LogCategory,
    message: string,
    fields?: LogFields
  ): (extra?: LogFields, level?: LogLevel) => number {
    const startedAt = Date.now();

    return (extra?: LogFields, level: LogLevel = 'INFO') => {
      const durationMs = Date.now() - startedAt;
      this.write(level, category, message, { ...fields, ...extra, durationMs });
      return durationMs;
    };
  }

  public close(): void {
    this.flushRepeat();
  }
}

export const logger = new RunLogger();
