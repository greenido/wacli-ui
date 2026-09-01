import { describe, it, expect } from 'vitest';
import {
  isStoreLockMessage,
  parseLockHolderPid,
  toStoreLockedError,
  STORE_LOCK_CODE,
} from '../wacli/store-lock.js';

describe('store-lock utilities', () => {
  it('detects store lock error messages', () => {
    expect(isStoreLockMessage('store is locked (another wacli is running?)')).toBe(true);
    expect(isStoreLockMessage('store locked: resource temporarily unavailable')).toBe(true);
    expect(isStoreLockMessage('command failed')).toBe(false);
  });

  it('parses lock holder pid from message', () => {
    const msg =
      'store is locked (another wacli is running?): store locked: resource temporarily unavailable (pid=35365 acquired_at=2026-09-01T13:34:14.719739-07:00)';
    expect(parseLockHolderPid(msg)).toBe(35365);
    expect(parseLockHolderPid('no pid here')).toBeNull();
  });

  it('creates StoreLockedError with code and pid', () => {
    const err = toStoreLockedError('store locked (pid=42)', 'wacli chats list');
    expect(err.code).toBe(STORE_LOCK_CODE);
    expect(err.lockHolderPid).toBe(42);
    expect(err.command).toBe('wacli chats list');
  });
});
