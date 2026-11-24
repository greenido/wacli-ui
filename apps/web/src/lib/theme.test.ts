import { afterEach, describe, expect, it } from 'vitest';
import {
  applyTheme,
  contrastRatio,
  hexToRgb,
  loadThemePrefs,
  onAccent,
  readableAccent,
  resolveTheme,
  saveThemePrefs,
  THEME_STORAGE_KEY,
} from './theme.ts';

const DARK_BG: [number, number, number] = [18, 21, 27];
const LIGHT_BG: [number, number, number] = [245, 246, 248];
const LIGHT_TEXT: [number, number, number] = [26, 29, 35];

describe('loadThemePrefs', () => {
  afterEach(() => localStorage.clear());

  it('defaults to System with the theme accent', () => {
    expect(loadThemePrefs()).toEqual({ theme: 'system', accent: null });
  });

  it('round-trips what was saved', () => {
    saveThemePrefs({ theme: 'solarized', accent: '#a78bfa' });
    expect(loadThemePrefs()).toEqual({ theme: 'solarized', accent: '#a78bfa' });
  });

  it('drops an unknown theme and a malformed accent rather than trusting them', () => {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ theme: 'neon', accent: 'red' }));
    expect(loadThemePrefs()).toEqual({ theme: 'system', accent: null });
  });

  it('survives storage that is not JSON', () => {
    localStorage.setItem(THEME_STORAGE_KEY, '{not json');
    expect(loadThemePrefs()).toEqual({ theme: 'system', accent: null });
  });
});

describe('resolveTheme', () => {
  it('follows the OS only under System', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('midnight', true)).toBe('midnight');
  });
});

describe('readableAccent', () => {
  it('leaves an accent alone when it already reads well', () => {
    const mint = hexToRgb('#4fd1a5')!;
    expect(readableAccent(mint, [DARK_BG], [231, 233, 238])).toEqual(mint);
  });

  it('darkens a pale accent on a light theme until it clears AA', () => {
    const pale = hexToRgb('#22d3ee')!;
    const drawn = readableAccent(pale, [LIGHT_BG], LIGHT_TEXT);
    expect(drawn).not.toEqual(pale);
    expect(contrastRatio(drawn, LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('onAccent', () => {
  it('labels a bright accent with the dark end and a dark one with the light end', () => {
    expect(onAccent(hexToRgb('#4fd1a5')!, DARK_BG, [231, 233, 238])).toEqual(DARK_BG);
    expect(onAccent(hexToRgb('#0b7a53')!, LIGHT_BG, LIGHT_TEXT)).toEqual(LIGHT_BG);
  });
});

describe('applyTheme', () => {
  it('marks <html> with the resolved theme and clears a stale accent', () => {
    const root = document.createElement('html');
    root.style.setProperty('--mc-accent', '1 2 3');
    const applied = applyTheme({ theme: 'system', accent: null }, true, root);
    expect(applied).toEqual({ resolved: 'light', accentAdjusted: false });
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.getPropertyValue('--mc-accent')).toBe('');
  });

  it('lays a custom accent over the palette, shaded for readability', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    // The stylesheet is not loaded under jsdom; stand in for the light palette.
    root.style.setProperty('--mc-bg', LIGHT_BG.join(' '));
    root.style.setProperty('--mc-surface', '255 255 255');
    root.style.setProperty('--mc-text', LIGHT_TEXT.join(' '));

    const applied = applyTheme({ theme: 'light', accent: '#22d3ee' }, false, root);

    expect(applied.accentAdjusted).toBe(true);
    const channels = root.style.getPropertyValue('--mc-accent').split(' ').map(Number);
    expect(contrastRatio(channels as [number, number, number], LIGHT_BG)).toBeGreaterThanOrEqual(4.5);
    root.remove();
  });
});
