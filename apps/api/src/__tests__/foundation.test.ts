import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { normalizeChat, normalizeMessage, normalizeDoctor, normalizeWebhookMessage } from '../wacli/normalize.js';
import { ModeManager } from '../wacli/mode.js';
import { RunLogger } from '../logger.js';
import type { RawChat, RawMessage } from '../types.js';

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

  it('defaults to readOnly = false (allow sends) when no settings file exists', () => {
    const mm = new ModeManager(tmpSettingsPath);
    expect(mm.isReadOnly()).toBe(false);
  });

  it('persists and updates readOnly state', () => {
    const mm = new ModeManager(tmpSettingsPath);
    expect(mm.isReadOnly()).toBe(false);

    mm.setReadOnly(true);
    expect(mm.isReadOnly()).toBe(true);

    // Reload from disk
    const mm2 = new ModeManager(tmpSettingsPath);
    expect(mm2.isReadOnly()).toBe(true);
  });
});

describe('RunLogger', () => {
  let tmpLogsDir: string;

  beforeEach(() => {
    tmpLogsDir = path.join(os.tmpdir(), `wacli-test-logs-${Date.now()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpLogsDir)) {
      fs.rmSync(tmpLogsDir, { recursive: true, force: true });
    }
  });

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
});
