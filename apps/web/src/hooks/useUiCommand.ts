import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore.ts';
import type { UiCommand } from '../lib/shortcuts.ts';

/**
 * Runs `handler` whenever the keyboard layer fires `name`.
 *
 * Shortcuts are read at the app root, but most of what they do needs state that
 * only one pane holds — the rail's filtered chat order, the thread's loaded
 * messages, the composer's file input. Rather than lift all of that into the
 * store, the root publishes a command and the owning pane subscribes here.
 *
 * The handler is kept in a ref so an inline arrow from the caller does not
 * re-run the effect on every render, and the last-seen sequence number is what
 * gates the call, so the same command fired twice is two separate events.
 */
export function useUiCommand(name: UiCommand, handler: () => void) {
  const command = useAppStore((s) => s.uiCommand);

  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  });

  // Commands raised before this pane mounted are already stale; start from
  // whatever the counter is at so mounting mid-session never replays one.
  const lastSeq = useRef(command?.seq ?? 0);

  useEffect(() => {
    if (!command || command.seq === lastSeq.current) return;
    lastSeq.current = command.seq;
    if (command.name !== name) return;
    handlerRef.current();
  }, [command, name]);
}
