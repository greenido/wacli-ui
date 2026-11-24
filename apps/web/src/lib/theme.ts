/**
 * Themes and accent colour.
 *
 * The palettes themselves live in src/index.css, one `[data-theme=…]` block
 * each; this module only decides which one is on and lays a custom accent over
 * it. The choice is per browser (localStorage), like the pane widths.
 * public/theme-init.js repeats loadThemePrefs() + resolveTheme() before first
 * paint, so a change to either belongs in both.
 */

export type ConcreteTheme = 'dark' | 'light' | 'green' | 'solarized' | 'midnight';
export type ThemeChoice = 'system' | ConcreteTheme;

export interface ThemePrefs {
  theme: ThemeChoice;
  /** `#rrggbb`, or null for the theme's own accent. */
  accent: string | null;
}

export interface ThemeOption {
  id: ThemeChoice;
  label: string;
  hint: string;
}

export const THEMES: readonly ThemeOption[] = [
  { id: 'system', label: 'System', hint: 'Dark or Light, following your OS' },
  { id: 'dark', label: 'Dark', hint: 'The original console' },
  { id: 'light', label: 'Light', hint: 'For bright rooms' },
  { id: 'green', label: 'Green chat', hint: 'Deep teal and green' },
  { id: 'solarized', label: 'Solarized', hint: 'Warm, low-glare light' },
  { id: 'midnight', label: 'Midnight', hint: 'True black, for OLED' },
];

/**
 * None of these sit near amber or red, which already mean safe mode and
 * failure. The accent only ever recolours decoration.
 */
export const ACCENT_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: 'Mint', hex: '#4fd1a5' },
  { name: 'Green', hex: '#25d366' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Cyan', hex: '#22d3ee' },
  { name: 'Blue', hex: '#4c9aff' },
  { name: 'Indigo', hex: '#818cf8' },
  { name: 'Violet', hex: '#a78bfa' },
  { name: 'Pink', hex: '#f472b6' },
];

export const THEME_STORAGE_KEY = 'wacli_theme';
export const DEFAULT_THEME_PREFS: ThemePrefs = { theme: 'system', accent: null };

const THEME_IDS = new Set<string>(THEMES.map((t) => t.id));
const HEX = /^#[0-9a-f]{6}$/i;

/** Accent text must clear WCAG AA against the theme's backgrounds. */
const MIN_ACCENT_CONTRAST = 4.5;

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && THEME_IDS.has(value);
}

export function loadThemePrefs(storage: Storage | undefined = globalThis.localStorage): ThemePrefs {
  try {
    const saved: unknown = JSON.parse(storage?.getItem(THEME_STORAGE_KEY) ?? 'null');
    if (!saved || typeof saved !== 'object') return DEFAULT_THEME_PREFS;
    const { theme, accent } = saved as Record<string, unknown>;
    return {
      theme: isThemeChoice(theme) ? theme : DEFAULT_THEME_PREFS.theme,
      accent: typeof accent === 'string' && HEX.test(accent) ? accent.toLowerCase() : null,
    };
  } catch {
    return DEFAULT_THEME_PREFS;
  }
}

export function saveThemePrefs(prefs: ThemePrefs, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Private mode or a full quota: the choice still holds for this session.
  }
}

export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: light)').matches;
}

export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ConcreteTheme {
  if (choice !== 'system') return choice;
  return prefersLight ? 'light' : 'dark';
}

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  if (!HEX.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `"18 21 27"`, the form the CSS variables hold. */
function parseChannels(value: string): Rgb | null {
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? (parts as Rgb) : null;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return a.map((c, i) => Math.round(c + (b[i] - c) * t)) as Rgb;
}

/**
 * The accent as it will be drawn: unchanged when it reads well on every
 * background, otherwise nudged toward the theme's text colour until it does.
 * So a pale yellow picked on Dark stays pale yellow, and turns ochre on Light
 * rather than vanishing into it.
 */
export function readableAccent(accent: Rgb, backgrounds: Rgb[], text: Rgb): Rgb {
  for (let step = 0; step <= 10; step++) {
    const candidate = mix(accent, text, step / 10);
    if (backgrounds.every((bg) => contrastRatio(candidate, bg) >= MIN_ACCENT_CONTRAST)) return candidate;
  }
  return text;
}

/** Label colour for a filled accent button: whichever of the theme's two ends reads better. */
export function onAccent(accent: Rgb, bg: Rgb, text: Rgb): Rgb {
  return contrastRatio(accent, bg) >= contrastRatio(accent, text) ? bg : text;
}

export interface AppliedTheme {
  resolved: ConcreteTheme;
  /** A custom accent had to be shifted to stay readable on this theme. */
  accentAdjusted: boolean;
}

/**
 * Puts the theme on `<html>`. The palette comes from the stylesheet; a custom
 * accent is set inline on top, after reading that palette's backgrounds so it
 * can be kept legible.
 */
export function applyTheme(
  prefs: ThemePrefs,
  prefersLight: boolean,
  root: HTMLElement = document.documentElement
): AppliedTheme {
  const resolved = resolveTheme(prefs.theme, prefersLight);
  root.setAttribute('data-theme', resolved);
  root.style.removeProperty('--mc-accent');
  root.style.removeProperty('--mc-on-accent');

  const accent = prefs.accent ? hexToRgb(prefs.accent) : null;
  if (!accent) return { resolved, accentAdjusted: false };

  const css = getComputedStyle(root);
  const bg = parseChannels(css.getPropertyValue('--mc-bg'));
  const surface = parseChannels(css.getPropertyValue('--mc-surface'));
  const text = parseChannels(css.getPropertyValue('--mc-text'));
  if (!bg || !surface || !text) return { resolved, accentAdjusted: false };

  const drawn = readableAccent(accent, [bg, surface], text);
  root.style.setProperty('--mc-accent', drawn.join(' '));
  root.style.setProperty('--mc-on-accent', onAccent(drawn, bg, text).join(' '));
  return { resolved, accentAdjusted: drawn.some((c, i) => c !== accent[i]) };
}
