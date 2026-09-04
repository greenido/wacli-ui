import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Wires up the keyboard contract a dialog owes its user: Escape closes it, Tab
 * stays inside it, a held Enter cannot auto-fire the control it opened onto,
 * and focus lands in it on open and returns where it came from on close. Mark
 * the control that should take focus with `data-autofocus`, otherwise the first
 * focusable one does. Returns the ref to attach to the dialog container.
 */
export function useModalDialog<T extends HTMLElement = HTMLDivElement>(
  isOpen: boolean,
  onClose: () => void
) {
  const containerRef = useRef<T>(null);

  // Held in a ref so an inline arrow function from the caller does not tear
  // down and re-arm the listener on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    // Callers early-return null when closed, so the hook must run every render
    // and arm itself only once the container is actually in the DOM.
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Deliberately not a layout-based visibility test: offsetParent is null for
    // position:fixed subtrees (which every modal here is) and always null under
    // jsdom, so it would silently empty this list.
    const focusable = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => !el.hasAttribute('hidden') && el.closest('[aria-hidden="true"]') === null
      );

    // Respect an explicit autoFocus, otherwise focus the first control.
    if (!container.contains(document.activeElement)) {
      const target = container.querySelector<HTMLElement>('[data-autofocus]') ?? focusable()[0];
      target?.focus();
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // A dialog that opens on Enter (the composer sends on it, and any button
      // is activated by it) is focused on its primary action, so the auto-repeat
      // of a leaned-on Enter would land on that action a frame later. Only the
      // repeats are dropped; a deliberate second press still goes through.
      if (e.key === 'Enter' && e.repeat) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !container.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [isOpen]);

  return containerRef;
}
