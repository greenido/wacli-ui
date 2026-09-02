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
import { LOG_RETENTION_DAYS, RunLogger } from '../logger.js';
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

  beforeEach(() => {
    tmpLogsDir = path.join(os.tmpdir(), `wacli-test-logs-${Date.now()}`);
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('creates log file and writes structured lines', async () => {
    const logger = new RunLogger(tmpLogsDir);
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

    new RunLogger(tmpLogsDir);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('keeps a log that is exactly at the retention boundary', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    const boundary = seed(runLogName('2026-06-12T12:00:00.000Z')); // exactly 3 days

    new RunLogger(tmpLogsDir);

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

    new RunLogger(tmpLogsDir);

    for (const file of bystanders) {
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  it('never deletes the log the current run is writing to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));
    const first = new RunLogger(tmpLogsDir);

    // A later run, far enough ahead that the earlier log has expired.
    vi.setSystemTime(new Date('2026-06-24T12:00:00.000Z'));
    const second = new RunLogger(tmpLogsDir);
    second.info('process', 'still running');

    expect(fs.existsSync(first.getFilePath())).toBe(false);
    expect(fs.existsSync(second.getFilePath())).toBe(true);
    expect(fs.readFileSync(second.getFilePath(), 'utf8')).toContain('still running');
  });

  it('records the prune in the new run log', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T12:00:00.000Z'));

    seed(runLogName('2026-06-01T09:00:00.000Z'));
    seed(runLogName('2026-06-02T09:00:00.000Z'));

    const logger = new RunLogger(tmpLogsDir);

    expect(fs.readFileSync(logger.getFilePath(), 'utf8')).toContain(
      `Pruned 2 run logs older than ${LOG_RETENTION_DAYS} days`
    );
  });

  it('starts a run normally when the logs directory cannot be read', () => {
    const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    try {
      const logger = new RunLogger(tmpLogsDir);
      logger.info('process', 'started anyway');
      expect(fs.readFileSync(logger.getFilePath(), 'utf8')).toContain('started anyway');
    } finally {
      readdir.mockRestore();
    }
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
