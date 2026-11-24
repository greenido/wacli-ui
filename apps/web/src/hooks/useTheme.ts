import { useEffect, useLayoutEffect } from 'react';
import { create } from 'zustand';
import {
  applyTheme,
  loadThemePrefs,
  resolveTheme,
  saveThemePrefs,
  systemPrefersLight,
  THEME_STORAGE_KEY,
  type ConcreteTheme,
  type ThemeChoice,
  type ThemePrefs,
} from '../lib/theme.ts';

interface ThemeState {
  prefs: ThemePrefs;
  prefersLight: boolean;
  accentAdjusted: boolean;
  setTheme: (theme: ThemeChoice) => void;
  setAccent: (accent: string | null) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const update = (patch: Partial<ThemePrefs>) => {
    const prefs = { ...get().prefs, ...patch };
    saveThemePrefs(prefs);
    set({ prefs });
  };
  return {
    prefs: loadThemePrefs(),
    prefersLight: systemPrefersLight(),
    accentAdjusted: false,
    setTheme: (theme) => update({ theme }),
    setAccent: (accent) => update({ accent: accent?.toLowerCase() ?? null }),
  };
});

export function useTheme(): ThemeState & { resolved: ConcreteTheme } {
  const state = useThemeStore();
  return { ...state, resolved: resolveTheme(state.prefs.theme, state.prefersLight) };
}

/**
 * Keeps `<html>` on the chosen theme. Mounted once, at the app root.
 *
 * Applied in a layout effect so a custom accent lands before the first paint,
 * and re-applied when the OS flips light/dark (for System) or another tab of
 * the console saves a different choice.
 */
export function useThemeSync(): void {
  const prefs = useThemeStore((s) => s.prefs);
  const prefersLight = useThemeStore((s) => s.prefersLight);

  useLayoutEffect(() => {
    const { accentAdjusted } = applyTheme(prefs, prefersLight);
    if (useThemeStore.getState().accentAdjusted !== accentAdjusted) {
      useThemeStore.setState({ accentAdjusted });
    }
  }, [prefs, prefersLight]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    const onMedia = (e: MediaQueryListEvent) => useThemeStore.setState({ prefersLight: e.matches });
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) useThemeStore.setState({ prefs: loadThemePrefs() });
    };
    media?.addEventListener?.('change', onMedia);
    window.addEventListener('storage', onStorage);
    return () => {
      media?.removeEventListener?.('change', onMedia);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
}
