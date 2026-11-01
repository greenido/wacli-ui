import { describe, it, expect, beforeEach } from 'vitest';
import { CHAT_LIST_PANE, STATUS_STRIP_PANE, clampPaneWidth, readSavedPaneWidth } from './paneWidths.ts';

describe('pane widths', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('clamps to the same range the splitter drags within', () => {
    expect(clampPaneWidth(CHAT_LIST_PANE, 50)).toBe(CHAT_LIST_PANE.min);
    expect(clampPaneWidth(CHAT_LIST_PANE, 9999)).toBe(CHAT_LIST_PANE.max);
    expect(clampPaneWidth(STATUS_STRIP_PANE, 300)).toBe(300);
  });

  it('restores a saved width that is in range', () => {
    localStorage.setItem(CHAT_LIST_PANE.storageKey, '410');
    expect(readSavedPaneWidth(CHAT_LIST_PANE)).toBe(410);
  });

  it('pulls a saved width back into the draggable range instead of restoring it as-is', () => {
    // 640 used to be accepted on load, but no drag could ever reach it again,
    // and the first drag snapped the pane to 600.
    localStorage.setItem(CHAT_LIST_PANE.storageKey, '640');
    expect(readSavedPaneWidth(CHAT_LIST_PANE)).toBe(CHAT_LIST_PANE.max);

    localStorage.setItem(STATUS_STRIP_PANE.storageKey, '165');
    expect(readSavedPaneWidth(STATUS_STRIP_PANE)).toBe(STATUS_STRIP_PANE.min);
  });

  it('falls back to the default for a missing or unreadable value', () => {
    expect(readSavedPaneWidth(CHAT_LIST_PANE)).toBe(CHAT_LIST_PANE.defaultWidth);
    localStorage.setItem(STATUS_STRIP_PANE.storageKey, 'wide');
    expect(readSavedPaneWidth(STATUS_STRIP_PANE)).toBe(STATUS_STRIP_PANE.defaultWidth);
  });

  it('keeps every default inside its own range', () => {
    for (const pane of [CHAT_LIST_PANE, STATUS_STRIP_PANE]) {
      expect(pane.defaultWidth).toBeGreaterThanOrEqual(pane.min);
      expect(pane.defaultWidth).toBeLessThanOrEqual(pane.max);
    }
  });
});
