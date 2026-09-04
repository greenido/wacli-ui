import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore.ts';

/** Rail filters in the order the number keys address them. */
const RAIL_FILTERS = ['all', 'unread', 'pinned', 'muted', 'archived'] as const;

/** Whether this key would land in a text field rather than on the app. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface KeyboardShortcutOptions {
  isSearchOpen: boolean;
  onToggleSearch: () => void;
}

/**
 * The console's global keyboard layer, in two tiers.
 *
 * Everything with a modifier works wherever the caret is, including mid-word in
 * the composer. Bare single keys only fire outside a text field, because the
 * composer takes focus the moment a chat opens — Escape steps out of it, and
 * `c` steps back in.
 *
 * Dialogs are left alone: an open modal owns the keyboard, and `useModalDialog`
 * already handles Escape and Tab for it from the capture phase.
 */
export function useKeyboardShortcuts({ isSearchOpen, onToggleSearch }: KeyboardShortcutOptions) {
  // Read through refs so the listener is armed once rather than re-bound on
  // every keystroke that changes the palette's state.
  const isSearchOpenRef = useRef(isSearchOpen);
  const onToggleSearchRef = useRef(onToggleSearch);
  useEffect(() => {
    isSearchOpenRef.current = isSearchOpen;
    onToggleSearchRef.current = onToggleSearch;
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Something nearer the event already claimed this key.
      if (e.defaultPrevented) return;

      const {
        activeModal,
        selectedChat,
        setActiveModal,
        setChatFilter,
        runCommand,
        triggerFocusComposer,
      } = useAppStore.getState();

      const searchOpen = isSearchOpenRef.current;
      const typing = isTypingTarget(e.target);
      const mod = e.metaKey || e.ctrlKey;

      // Escape leaves a text field so the single-key tier below comes alive.
      // A dialog's own handler runs first, in the capture phase, and stops the
      // event before it ever reaches here.
      if (e.key === 'Escape') {
        if (!activeModal && !searchOpen && typing) {
          (e.target as HTMLElement).blur();
        }
        return;
      }

      // A dialog owns the keyboard while it is up.
      if (activeModal) return;

      // The search palette is the one overlay outside `activeModal`; only the
      // key that opened it still means anything while it is on screen.
      if (searchOpen) {
        if (mod && !e.altKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          onToggleSearchRef.current();
        }
        return;
      }

      // ---- Tier one: carries a modifier, so it fires even while typing ----
      if (mod) {
        if (e.altKey) return;
        const key = e.key.toLowerCase();

        if (e.shiftKey) {
          // Unlocking live sends is the one guardrail a stray chord could drop,
          // so the shortcut opens the confirmation rather than flipping it.
          if (key === 'l') {
            e.preventDefault();
            setActiveModal('mode-confirm');
          }
          return;
        }

        switch (key) {
          case 'k':
            e.preventDefault();
            onToggleSearchRef.current();
            return;
          case 'arrowdown':
            e.preventDefault();
            runCommand('chat:next');
            return;
          case 'arrowup':
            e.preventDefault();
            runCommand('chat:prev');
            return;
          case 'u':
            e.preventDefault();
            runCommand('composer:attach');
            return;
          case 'enter':
            e.preventDefault();
            runCommand('composer:send-later');
            return;
          default:
            return;
        }
      }

      if (e.altKey) return;

      // ---- Tier two: bare keys, only outside a text field ----
      if (typing) return;
      // `?` is Shift+/ on most layouts, and is the only shifted key down here.
      if (e.shiftKey && e.key !== '?') return;

      switch (e.key) {
        case '?':
          e.preventDefault();
          setActiveModal('help');
          return;
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          runCommand('chat:next');
          return;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          runCommand('chat:prev');
          return;
        case '/':
          // Ahead of Firefox's quick-find, which would otherwise eat the key.
          e.preventDefault();
          runCommand('chatlist:focus-filter');
          return;
        case 'c':
          e.preventDefault();
          triggerFocusComposer();
          return;
        case 'n':
          e.preventDefault();
          setActiveModal('new-chat');
          return;
        case ',':
          e.preventDefault();
          setActiveModal('settings');
          return;
        case 'i':
          if (!selectedChat) return;
          e.preventDefault();
          setActiveModal('chat-info');
          return;
        case 'e':
          if (!selectedChat) return;
          e.preventDefault();
          runCommand('thread:export');
          return;
        case 'r':
          if (!selectedChat) return;
          e.preventDefault();
          runCommand('thread:reply-latest');
          return;
        case 'o':
          if (!selectedChat) return;
          e.preventDefault();
          runCommand('thread:load-older');
          return;
        case 'g':
          if (!selectedChat) return;
          e.preventDefault();
          runCommand('thread:jump-newest');
          return;
        default:
          break;
      }

      // 1..5 pick a rail filter, in the order the rail shows them.
      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= RAIL_FILTERS.length) {
        e.preventDefault();
        setChatFilter(RAIL_FILTERS[digit - 1]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
