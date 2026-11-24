import React from 'react';
import { Check, Palette, Pipette } from 'lucide-react';
import { useTheme } from '../../hooks/useTheme.ts';
import { ACCENT_SWATCHES, THEMES } from '../../lib/theme.ts';
import { ThemePreview } from './ThemePreview.tsx';

const SWATCH =
  'relative w-6 h-6 rounded-full border border-mc-border flex items-center justify-center transition-transform hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-mc-text';

/** The Appearance block of Settings: theme, then accent. Saved in this browser only. */
export const AppearanceSettings: React.FC = () => {
  const { prefs, resolved, accentAdjusted, setTheme, setAccent } = useTheme();
  const isSwatch = ACCENT_SWATCHES.some((s) => s.hex === prefs.accent);
  const isCustom = prefs.accent !== null && !isSwatch;

  return (
    <div className="p-3 bg-mc-bg rounded border border-mc-border space-y-3">
      <span className="font-semibold text-mc-text flex items-center gap-2">
        <Palette size={16} className="text-mc-accent" />
        APPEARANCE
      </span>

      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
        {THEMES.map((t) => {
          const selected = prefs.theme === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setTheme(t.id)}
              className={`p-1.5 rounded border text-left transition-colors font-sans ${
                selected
                  ? 'border-mc-accent ring-1 ring-mc-accent/50 bg-mc-surfaceHover'
                  : 'border-mc-border hover:border-mc-accent/50 hover:bg-mc-surfaceHover'
              }`}
            >
              <ThemePreview theme={t.id} className="h-9" />
              <span className="mt-1.5 flex items-center gap-1 text-[11px] font-semibold text-mc-text">
                {t.label}
                {selected && <Check size={11} className="text-mc-accent" />}
              </span>
              <span className="block text-[10px] leading-tight text-mc-textMuted">{t.hint}</span>
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <span id="accent-label" className="text-[11px] text-mc-textMuted">
          ACCENT
        </span>
        <div role="radiogroup" aria-labelledby="accent-label" className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="radio"
            aria-checked={prefs.accent === null}
            onClick={() => setAccent(null)}
            title="The theme's own accent"
            className={`px-2 h-6 rounded-full border text-[10px] font-sans flex items-center gap-1.5 transition-colors ${
              prefs.accent === null
                ? 'border-mc-text text-mc-text'
                : 'border-mc-border text-mc-textMuted hover:text-mc-text'
            }`}
          >
            <span data-theme={resolved} className="w-3 h-3 rounded-full bg-mc-accent" />
            Theme default
          </button>

          {ACCENT_SWATCHES.map((s) => {
            const selected = prefs.accent === s.hex;
            return (
              <button
                key={s.hex}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={s.name}
                title={s.name}
                onClick={() => setAccent(s.hex)}
                style={{ backgroundColor: s.hex }}
                className={`${SWATCH} ${selected ? 'ring-2 ring-mc-text ring-offset-2 ring-offset-mc-bg' : ''}`}
              >
                {selected && <Check size={12} className="text-black/70" />}
              </button>
            );
          })}

          {/* A native colour input under a swatch-shaped label: the browser's
              own picker, no library, and it works from the keyboard. */}
          <label
            title="Pick any colour"
            style={isCustom && prefs.accent ? { backgroundColor: prefs.accent } : undefined}
            className={`${SWATCH} cursor-pointer focus-within:ring-2 focus-within:ring-mc-text ${
              isCustom ? 'ring-2 ring-mc-text ring-offset-2 ring-offset-mc-bg' : 'bg-mc-surface text-mc-textMuted'
            }`}
          >
            <Pipette size={12} className={isCustom ? 'text-black/70' : ''} />
            <input
              type="color"
              aria-label="Custom accent colour"
              value={prefs.accent ?? '#4fd1a5'}
              onChange={(e) => setAccent(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
        </div>
        <p className="text-[11px] text-mc-textMuted font-sans">
          {accentAdjusted
            ? 'Shaded a little on this theme so text in this colour stays readable.'
            : 'Colours highlights, links, focus and the selected chat. Live, safe-mode and error colours keep their meaning.'}{' '}
          Saved in this browser only.
        </p>
      </div>
    </div>
  );
};
