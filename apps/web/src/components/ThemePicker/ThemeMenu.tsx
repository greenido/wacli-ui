import React, { useEffect, useRef, useState } from 'react';
import { Check, Palette, SlidersHorizontal } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme.ts';
import { THEMES } from '../../lib/theme.ts';
import { useAppStore } from '../../store/appStore.ts';
import { ThemePreview } from './ThemePreview.tsx';

/**
 * The quick switch in the status strip's header: a palette button that drops
 * a list of themes. The accent and the rest live in Settings, one click away.
 *
 * Arrow keys walk the list, Enter or a click picks, and Escape or a click
 * elsewhere closes it, handing focus back to the button.
 */
export const ThemeMenu: React.FC = () => {
  const { prefs, setTheme } = useTheme();
  const setActiveModal = useAppStore((s) => s.setActiveModal);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const current = THEMES.findIndex((t) => t.id === prefs.theme);
    itemRefs.current[Math.max(0, current)]?.focus();

    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // Focus the current theme only when the menu opens, not on every pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The menu owns the keyboard while open: without this, the arrows would
    // also walk the chat list through the app's window-level shortcuts.
    e.stopPropagation();
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    }
  };

  return (
    <div ref={wrapRef} className="relative" onKeyDown={open ? onKeyDown : undefined}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Theme"
        className={`p-1 rounded hover:bg-mc-surfaceHover transition-colors ${
          open ? 'bg-mc-surfaceHover text-mc-text' : 'text-mc-textMuted hover:text-mc-text'
        }`}
      >
        <Palette size={15} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Theme"
          className="absolute right-0 top-full mt-1 z-50 w-52 p-1 rounded border border-mc-border bg-mc-surface shadow-2xl font-sans"
        >
          {THEMES.map((t, i) => {
            const selected = prefs.theme === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => setTheme(t.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-mc-text hover:bg-mc-surfaceHover focus:bg-mc-surfaceHover focus:outline-none"
              >
                <ThemePreview theme={t.id} className="w-8 h-5 shrink-0" />
                <span className="flex-1 truncate">{t.label}</span>
                {selected && <Check size={12} className="text-mc-accent shrink-0" />}
              </button>
            );
          })}
          <div className="my-1 border-t border-mc-border" />
          <button
            ref={(el) => {
              itemRefs.current[THEMES.length] = el;
            }}
            type="button"
            role="menuitem"
            onClick={() => {
              close(false);
              setActiveModal('settings');
            }}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[11px] text-mc-textMuted hover:text-mc-text hover:bg-mc-surfaceHover focus:bg-mc-surfaceHover focus:outline-none"
          >
            <SlidersHorizontal size={12} className="shrink-0" />
            Accent colour &amp; more…
          </button>
        </div>
      )}
    </div>
  );
};
