/**
 * The limits of each resizable side pane, shared by the splitter that drags it
 * and the code that restores a saved width. They used to disagree (a saved
 * 640px chat list was restored, though no drag could reach past 600), so a
 * restored width could sit outside the range the pane could be moved within.
 */
export interface PaneLimits {
  min: number;
  max: number;
  defaultWidth: number;
  storageKey: string;
}

export const CHAT_LIST_PANE: PaneLimits = {
  min: 200,
  max: 600,
  defaultWidth: 320,
  storageKey: 'wacli_chat_list_width',
};

export const STATUS_STRIP_PANE: PaneLimits = {
  min: 180,
  max: 500,
  defaultWidth: 256,
  storageKey: 'wacli_status_strip_width',
};

export function clampPaneWidth(pane: PaneLimits, width: number): number {
  return Math.min(Math.max(width, pane.min), pane.max);
}

/** The saved width, pulled into range, or the default when none can be read. */
export function readSavedPaneWidth(pane: PaneLimits): number {
  try {
    const parsed = parseInt(localStorage.getItem(pane.storageKey) ?? '', 10);
    if (!Number.isNaN(parsed)) return clampPaneWidth(pane, parsed);
  } catch {
    // Storage can be unavailable; the default is a fine answer.
  }
  return pane.defaultWidth;
}

export function savePaneWidth(pane: PaneLimits, width: number): void {
  try {
    localStorage.setItem(pane.storageKey, String(width));
  } catch {
    // ignore
  }
}
