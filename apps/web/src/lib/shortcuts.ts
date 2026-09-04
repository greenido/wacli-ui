/**
 * One catalogue for every shortcut. The key handler dispatches from these names
 * and the help modal renders from these rows, so a binding that changes here
 * cannot drift away from the table that documents it.
 */

/**
 * A command a shortcut fires at whichever pane owns the behaviour. The key
 * handler sits at the app root, but the rail is the only thing that knows the
 * filtered chat order and the thread is the only thing that knows its loaded
 * messages, so those act on a signal rather than being lifted into the store.
 */
export type UiCommand =
  | 'chat:next'
  | 'chat:prev'
  | 'chatlist:focus-filter'
  | 'thread:reply-latest'
  | 'thread:load-older'
  | 'thread:jump-newest'
  | 'thread:export'
  | 'composer:attach'
  | 'composer:send-later';

/** Stands in for the platform's primary modifier until the help table renders. */
export const MOD = '$mod';

export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export function modLabel(): string {
  return isApplePlatform() ? 'Cmd' : 'Ctrl';
}

/** Swaps the `$mod` placeholder for the label this operator actually presses. */
export function resolveChord(chord: string[]): string[] {
  const label = modLabel();
  return chord.map((key) => (key === MOD ? label : key));
}

export interface ShortcutRow {
  /** Interchangeable chords for one action; each chord is a list of keys. */
  chords: string[][];
  action: string;
}

export interface ShortcutSection {
  title: string;
  blurb: string;
  rows: ShortcutRow[];
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'Works anywhere',
    blurb: 'These carry a modifier, so they fire even mid-sentence in the composer.',
    rows: [
      { chords: [[MOD, 'K']], action: 'Open or close global message search' },
      { chords: [[MOD, '↓'], [MOD, '↑']], action: 'Next / previous chat in the rail' },
      { chords: [[MOD, 'U']], action: 'Attach a file to this message' },
      { chords: [['Enter']], action: 'Send — opens the confirmation step' },
      { chords: [['Shift', 'Enter']], action: 'New line in the composer' },
      { chords: [[MOD, 'Enter']], action: 'Send later — schedule this message' },
      {
        chords: [[MOD, 'Shift', 'L']],
        action: 'Switch between SAFE (read-only) and LIVE sending — asks first',
      },
      {
        chords: [['Esc']],
        action: 'Close a dialog, clear the reply pill, or step out of the composer',
      },
    ],
  },
  {
    title: 'Navigating — when you are not typing',
    blurb:
      'The composer takes focus whenever you open a chat. Press Esc to step out of it and these single keys go live; press C to drop back in.',
    rows: [
      { chords: [['?']], action: 'Open this help' },
      { chords: [['J'], ['↓']], action: 'Next chat' },
      { chords: [['K'], ['↑']], action: 'Previous chat' },
      {
        chords: [['1'], ['2'], ['3'], ['4'], ['5']],
        action: 'Rail filter: All · Unread · Pinned · Muted · Archived',
      },
      { chords: [['/']], action: 'Jump to the chat filter box' },
      { chords: [['C']], action: 'Back into the composer' },
      { chords: [['N']], action: 'Start a new chat' },
      { chords: [[',']], action: 'Settings & diagnostics' },
    ],
  },
  {
    title: 'This conversation — when you are not typing',
    blurb: 'Act on the thread on screen without reaching for the mouse.',
    rows: [
      { chords: [['R']], action: 'Reply to the newest incoming message' },
      { chords: [['I']], action: 'Chat info — contact, alias, and tags' },
      { chords: [['E']], action: 'Export this conversation' },
      { chords: [['O']], action: 'Load older messages' },
      { chords: [['G']], action: 'Jump to the newest message' },
    ],
  },
];
