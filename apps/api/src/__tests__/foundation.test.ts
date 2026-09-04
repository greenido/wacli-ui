import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  messagePreviewText,
  normalizeChat,
  normalizeMessage,
  normalizeDoctor,
  normalizeWebhookMessage,
} from '../wacli/normalize.js';
import { ModeManager } from '../wacli/mode.js';
import { isDiskLoggingEnabled, LOG_RETENTION_DAYS, parseLogLevel, RunLogger } from '../logger.js';
import type { RawChat, RawMessage, UnifiedMessage } from '../types.js';

describe('Normalize utilities', () => {
  it('normalizes raw chats with various kinds and formats', () => {
    const rawDm: RawChat = {
      jid: '15551234567@s.whatsapp.net',
      name: 'Alice',
      last_message_ts: '2026-08-31T01:00:00Z',
      archived: false,
      pinned: true,
      muted_until: 0,
      unread: true,
      unread_count: 3,
    };

    const chat = normalizeChat(rawDm);
    expect(chat.jid).toBe('15551234567@s.whatsapp.net');
    expect(chat.kind).toBe('dm');
    expect(chat.name).toBe('Alice');
    expect(chat.pinned).toBe(true);
    expect(chat.unread).toBe(true);
    expect(chat.unreadCount).toBe(3);

    const rawGroup: RawChat = {
      jid: '120363000000000000@g.us',
      name: 'Test Group',
    };
    expect(normalizeChat(rawGroup).kind).toBe('group');
  });

  it('normalizes raw messages', () => {
    const rawMsg: RawMessage = {
      ChatJID: '15551234567@s.whatsapp.net',
      ChatName: 'Alice',
      MsgID: 'MSG-1234',
      SenderJID: '15551234567@s.whatsapp.net',
      SenderName: 'Alice',
      Timestamp: '2026-08-31T12:00:00Z',
      FromMe: false,
      Text: 'Hello world',
      DisplayText: 'Hello world',
      IsForwarded: true,
      Starred: true,
    };

    const msg = normalizeMessage(rawMsg);
    expect(msg.chatJid).toBe('15551234567@s.whatsapp.net');
    expect(msg.msgId).toBe('MSG-1234');
    expect(msg.fromMe).toBe(false);
    expect(msg.text).toBe('Hello world');
    expect(msg.isForwarded).toBe(true);
    expect(msg.starred).toBe(true);
  });

  it('normalizes webhook messages', () => {
    const rawWh = {
      Chat: '15551234567@s.whatsapp.net',
      ID: 'WH-999',
      Timestamp: '2026-08-31T12:05:00Z',
      FromMe: true,
      Text: 'Sent from phone',
      ChatName: 'Alice',
    };

    const msg = normalizeWebhookMessage(rawWh);
    expect(msg.chatJid).toBe('15551234567@s.whatsapp.net');
    expect(msg.msgId).toBe('WH-999');
    expect(msg.fromMe).toBe(true);
    expect(msg.text).toBe('Sent from phone');
  });

  it('normalizes doctor output', () => {
    const rawDoc = {
      store_dir: '/home/user/.wacli',
      lock_held: false,
      authenticated: true,
      linked_jid: '15551234567@s.whatsapp.net',
      connected: true,
      connection_state: 'connected',
      fts_enabled: true,
      store: {
        messages: 500,
        chats: 20,
        contacts: 15,
        groups: 5,
        last_sync_at: '2026-08-31T10:00:00Z',
        last_activity_at: '2026-08-31T10:01:00Z',
      },
    };

    const doc = normalizeDoctor(rawDoc);
    expect(doc.storeDir).toBe('/home/user/.wacli');
    expect(doc.authenticated).toBe(true);
    expect(doc.connected).toBe(true);
    expect(doc.store.messages).toBe(500);
    expect(doc.store.chats).toBe(20);
  });
});

describe('ModeManager', () => {
  let tmpSettingsPath: string;

  beforeEach(() => {
    tmpSettingsPath = path.join(os.tmpdir(), `wacli-test-settings-${Date.now()}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpSettingsPath)) {
      fs.unlinkSync(tmpSettingsPath);
    }
  });

  it('defaults to readOnly = true on first run (no settings file yet)', () => {
    const mm = new ModeManager(tmpSettingsPath);
    expect(mm.isReadOnly()).toBe(true);
  });

  it('persists and updates readOnly state', () => {
    const mm = new ModeManager(tmpSettingsPath);
    expect(mm.isReadOnly()).toBe(true);

    mm.setReadOnly(false);
    expect(mm.isReadOnly()).toBe(false);

    // Reload from disk
    const mm2 = new ModeManager(tmpSettingsPath);
    expect(mm2.isReadOnly()).toBe(false);
  });

  it('keeps the operator in write mode across restarts once they unlock', () => {
    const first = new ModeManager(tmpSettingsPath);
    first.setReadOnly(false);

    // Safe mode is a first-run default only; it must never be re-imposed.
    for (let restart = 0; restart < 3; restart++) {
      expect(new ModeManager(tmpSettingsPath).isReadOnly()).toBe(false);
    }
  });

  it('does not let an unrelated settings save erase the stored mode', () => {
    const mm = new ModeManager(tmpSettingsPath);
    mm.setReadOnly(false);

    // Mirrors POST /api/settings sending only storeDir.
    mm.updateSettings({ storeDir: '/tmp/store', account: undefined, readOnly: undefined });

    expect(mm.isReadOnly()).toBe(false);
    expect(new ModeManager(tmpSettingsPath).isReadOnly()).toBe(false);

    const onDisk = JSON.parse(fs.readFileSync(tmpSettingsPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.readOnly).toBe(false);
    expect(onDisk.storeDir).toBe('/tmp/store');
  });
});

describe('RunLogger', () => {
  let tmpLogsDir: string;
  const previousLog = process.env.LOG;

  beforeEach(() => {
    tmpLogsDir = path.join(os.tmpdir(), `wacli-test-logs-${Date.now()}`);
    delete process.env.LOG;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousLog === undefined) delete process.env.LOG;
    else process.env.LOG = previousLog;
    if (fs.existsSync(tmpLogsDir)) {
      fs.rmSync(tmpLogsDir, { recursive: true, force: true });
    }
  });

  /** Names a run log the way RunLogger does, for a chosen start time. */
  const runLogName = (iso: string) => `run-${iso.replace(/[:.]/g, '-')}.log`;
  const seed = (name: string) => {
    fs.mkdirSync(tmpLogsDir, { recursive: true });
    fs.writeFileSync(path.join(tmpLogsDir, name), 'previous run');
    return path.join(tmpLogsDir, name);
  };

  it('does not write a run log to disk unless LOG=1 or file logging is enabled', () => {
    const defaultDir = path.join(tmpLogsDir, 'default');
    const logger = new RunLogger(defaultDir, { console: false });
    logger.info('process', 'console only');

    expect(logger.getFilePath()).toBeNull();
    expect(fs.existsSync(defaultDir)).toBe(false);
  });

  it('writes a run log to disk when LOG=1', () => {
    process.env.LOG = '1';
    const logger = new RunLogger(tmpLogsDir, { console: false });
    logger.info('process', 'disk enabled');

    const filePath = logger.getFilePath();
    expect(filePath).not.toBeNull();
    expect(fs.readFileSync(filePath!, 'utf8')).toContain('[INFO] [process] disk enabled');
  });

  it('creates log file and writes structured lines', async () => {
    const logger = new RunLogger(tmpLogsDir, { file: true });
    logger.info('process', 'Process started');
    logger.warn('api', 'Rate limit near');
    logger.error('send', 'Send failed');
    logger.close();

    const filePath = logger.getFilePath();
    expect(fs.existsSync(filePath)).toBe(true);

    const contents = fs.readFileSync(filePath, 'utf8');
    expect(contents).toContain('[INFO] [process] Process started');
    expect(contents).toContain('[WARN] [api] Rate limit near');
    expect(contents).toContain('[ERROR] [send] Send failed');
  });

  it(`deletes run logs older than ${LOG_RETENTION_DAYS} days and keeps newer ones`, () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    const stale = seed(runLogName('2026-06-11T12:00:00.000Z')); // 4 days old
    const fresh = seed(runLogName('2026-06-13T12:00:00.000Z')); // 2 days old

    new RunLogger(tmpLogsDir, { file: true });

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('keeps a log that is exactly at the retention boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    const boundary = seed(runLogName('2026-06-12T12:00:00.000Z')); // exactly 3 days

    new RunLogger(tmpLogsDir, { file: true });

    expect(fs.existsSync(boundary)).toBe(true);
  });

  it('only removes files it wrote itself', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    // The logs directory is caller-supplied, so anything not matching the name
    // this logger writes is none of its business, however old it looks.
    const bystanders = [
      seed('notes.txt'),
      seed('run-2020-01-01.log'),
      seed('run-nonsense.log'),
      seed('wacli.db'),
      seed('run-2020-01-01T00-00-00-000Z.log.bak'),
    ];

    new RunLogger(tmpLogsDir, { file: true });

    for (const file of bystanders) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('never deletes the log the current run is writing to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    const first = new RunLogger(tmpLogsDir, { file: true });

    // A later run, far enough ahead that the earlier log has expired.
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    const second = new RunLogger(tmpLogsDir, { file: true });
    second.info('process', 'still running');

    expect(fs.existsSync(first.getFilePath()!)).toBe(false);
    expect(fs.existsSync(second.getFilePath()!)).toBe(true);
    expect(fs.readFileSync(second.getFilePath()!, 'utf8')).toContain('still running');
  });

  it('records the prune in the new run log', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    seed(runLogName('2026-06-01T09:00:00.000Z'));
    seed(runLogName('2026-06-02T09:00:00.000Z'));

    const logger = new RunLogger(tmpLogsDir, { file: true });

    expect(fs.readFileSync(logger.getFilePath()!, 'utf8')).toContain(
      `Pruned 2 run logs older than ${LOG_RETENTION_DAYS} days`
    );
  });

  it('starts a run normally when the logs directory cannot be read', () => {
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    try {
      const logger = new RunLogger(tmpLogsDir, { file: true });
      logger.info('process', 'started anyway');
      expect(fs.readFileSync(logger.getFilePath()!, 'utf8')).toContain('started anyway');
    } finally {
      readdir.mockRestore();
    }
  });

  it('skips retention pruning when disk logging is off', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    const stale = seed(runLogName('2026-06-01T12:00:00.000Z'));
    new RunLogger(tmpLogsDir, { file: false, console: false });

    expect(fs.existsSync(stale)).toBe(true);
  });
});

describe('RunLogger structured output', () => {
  let tmpLogsDir: string;

  beforeEach(() => {
    tmpLogsDir = path.join(os.tmpdir(), `wacli-test-fields-${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpLogsDir)) {
      fs.rmSync(tmpLogsDir, { recursive: true, force: true });
    }
  });

  /** Console output is noise under test; every case here reads the file. */
  const make = (level?: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR') =>
    new RunLogger(tmpLogsDir, { console: false, color: false, level, file: true });

  const read = (logger: RunLogger) => fs.readFileSync(logger.getFilePath()!, 'utf8');

  it('renders fields as key=value alongside the message', () => {
    const logger = make();
    logger.info('api', 'Chat list served', { chats: 100, covered: 98 });

    expect(read(logger)).toContain('[INFO] [api] Chat list served chats=100 covered=98');
  });

  it('quotes values that would otherwise blur into the next field', () => {
    const logger = make();
    logger.info('media', 'Media unavailable', { reason: 'expired on whatsapp', id: 'AC85DD9A' });

    const contents = read(logger);
    expect(contents).toContain('reason="expired on whatsapp"');
    // A plain token stays bare, so the common case reads like prose.
    expect(contents).toContain('id=AC85DD9A');
  });

  it('omits fields that are undefined rather than logging the word', () => {
    const logger = make();
    logger.info('send', 'Dispatching text', { to: '1555@s.whatsapp.net', replyTo: undefined });

    const contents = read(logger);
    expect(contents).toContain('to=1555@s.whatsapp.net');
    expect(contents).not.toContain('replyTo');
  });

  it('drops lines below the configured level', () => {
    const logger = make('INFO');
    logger.debug('api', 'wacli command completed', { cmd: 'chats list' });

    expect(read(logger)).not.toContain('wacli command completed');
  });

  it('emits debug lines once the level allows them', () => {
    const logger = make('DEBUG');
    logger.debug('api', 'wacli command completed', { cmd: 'chats list', durationMs: 41 });

    expect(read(logger)).toContain('[DEBUG] [api] wacli command completed cmd="chats list" durationMs=41');
  });

  it('records an error with its message and a stack', () => {
    const logger = make();
    logger.error('api', 'Unhandled API error', { err: new TypeError('chat is not iterable') });

    const contents = read(logger);
    expect(contents).toContain('err="TypeError: chat is not iterable"');
    // The frames follow the line, indented, so one event still reads as one entry.
    expect(contents).toMatch(/\n {4}at /);
  });

  it('collapses a repeated line into a count instead of copying it', () => {
    const logger = make();

    // A thread of expired attachments reports the same failure per message.
    for (let i = 0; i < 25; i++) {
      logger.warn('media', 'Media unavailable', { id: `MSG-${i}` });
    }
    logger.info('api', 'Chat list served');

    const contents = read(logger);
    // The line itself, plus one tally naming it — not 25 near-identical rows.
    expect(contents.match(/Media unavailable/g)).toHaveLength(2);
    expect(contents).toContain('[WARN] [media] Media unavailable (repeated 24x more)');
  });

  it('flushes a pending repeat count on close', () => {
    const logger = make();
    logger.warn('ws', 'Failed to send to client');
    logger.warn('ws', 'Failed to send to client');
    logger.close();

    expect(read(logger)).toContain('Failed to send to client (repeated 1x more)');
  });

  it('keeps every copy of a routine line, whose fields are the point', () => {
    const logger = make();

    // Two polls of the same endpoint are distinct events: collapsing them would
    // throw away the status and duration that make the line worth having.
    logger.info('http', 'GET /api/chats', { status: 200, durationMs: 203 });
    logger.info('http', 'GET /api/chats', { status: 304, durationMs: 47 });

    const contents = read(logger);
    expect(contents).toContain('status=200 durationMs=203');
    expect(contents).toContain('status=304 durationMs=47');
    expect(contents).not.toContain('repeated');
  });

  it('puts the elapsed time on the line when work is timed', () => {
    const logger = make();
    const done = logger.time('api', 'Chat preview scan');
    const durationMs = done({ chatsCovered: 100 });

    expect(durationMs).toBeGreaterThanOrEqual(0);
    expect(read(logger)).toMatch(/Chat preview scan chatsCovered=100 durationMs=\d+/);
  });
});

describe('parseLogLevel', () => {
  it('accepts a level in any casing', () => {
    expect(parseLogLevel('debug')).toBe('DEBUG');
    expect(parseLogLevel(' Warn ')).toBe('WARN');
  });

  it('falls back rather than silencing the log on a typo', () => {
    expect(parseLogLevel('verbose')).toBe('INFO');
    expect(parseLogLevel(undefined)).toBe('INFO');
  });
});

describe('isDiskLoggingEnabled', () => {
  it('is off unless LOG is exactly 1', () => {
    expect(isDiskLoggingEnabled(undefined)).toBe(false);
    expect(isDiskLoggingEnabled('0')).toBe(false);
    expect(isDiskLoggingEnabled('true')).toBe(false);
    expect(isDiskLoggingEnabled('1')).toBe(true);
  });
});

describe('messagePreviewText', () => {
  const base = (over: Partial<UnifiedMessage> = {}): UnifiedMessage => ({
    ...normalizeMessage({ ChatJID: '15551234567@s.whatsapp.net', MsgID: 'MSG-1' }),
    ...over,
  });

  it('uses the message body when there is one', () => {
    expect(messagePreviewText(base({ displayText: 'see you at 6' }))).toBe('see you at 6');
  });

  it('describes media, which carries no body text of its own', () => {
    expect(messagePreviewText(base({ mediaType: 'image' }))).toContain('Photo');
    expect(messagePreviewText(base({ mediaType: 'video' }))).toContain('Video');
    expect(messagePreviewText(base({ mediaType: 'audio' }))).toContain('Voice message');
    expect(messagePreviewText(base({ mediaType: 'sticker' }))).toBe('Sticker');
    expect(messagePreviewText(base({ mediaType: 'document', filename: 'invoice.pdf' }))).toContain(
      'invoice.pdf'
    );
  });

  it('prefers a caption over the generic media label', () => {
    expect(messagePreviewText(base({ mediaType: 'image', mediaCaption: 'the new sign' }))).toContain(
      'the new sign'
    );
  });

  it('reports a deleted message rather than showing it blank', () => {
    expect(messagePreviewText(base({ revoked: true, text: 'oops' }))).toBe(
      'This message was deleted.'
    );
  });

  it('returns an empty string when there is genuinely nothing to show', () => {
    expect(messagePreviewText(base())).toBe('');
  });
});
