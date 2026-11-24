import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useThemeStore, useThemeSync } from '../../hooks/useTheme.ts';
import { THEME_STORAGE_KEY } from '../../lib/theme.ts';
import { useAppStore } from '../../store/appStore.ts';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import { ThemeMenu } from './ThemeMenu.tsx';

const Synced: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useThemeSync();
  return <>{children}</>;
};

const saved = () => JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) ?? 'null');

beforeEach(() => {
  useThemeStore.setState({ prefs: { theme: 'dark', accent: null }, prefersLight: false, accentAdjusted: false });
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  useAppStore.setState({ activeModal: null });
});

describe('AppearanceSettings', () => {
  it('switches the page theme and remembers it', () => {
    render(
      <Synced>
        <AppearanceSettings />
      </Synced>
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('radio', { name: /Midnight/ }));

    expect(screen.getByRole('radio', { name: /Midnight/ })).toHaveAttribute('aria-checked', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(saved()).toEqual({ theme: 'midnight', accent: null });
  });

  it('resolves System against the OS setting', () => {
    useThemeStore.setState({ prefersLight: true });
    render(
      <Synced>
        <AppearanceSettings />
      </Synced>
    );
    fireEvent.click(screen.getByRole('radio', { name: /^System/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('picks a swatch accent, a custom one, and goes back to the default', () => {
    render(<AppearanceSettings />);

    fireEvent.click(screen.getByRole('radio', { name: 'Violet' }));
    expect(saved().accent).toBe('#a78bfa');
    expect(screen.getByRole('radio', { name: 'Violet' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(screen.getByLabelText('Custom accent colour'), { target: { value: '#ff8800' } });
    expect(saved().accent).toBe('#ff8800');
    expect(screen.getByRole('radio', { name: 'Violet' })).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(screen.getByRole('radio', { name: /Theme default/ }));
    expect(saved().accent).toBeNull();
  });
});

describe('ThemeMenu', () => {
  it('opens a list of themes and applies a pick', () => {
    render(
      <Synced>
        <ThemeMenu />
      </Synced>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    expect(screen.getByRole('menuitemradio', { name: /Dark/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Solarized/ }));

    expect(document.documentElement.getAttribute('data-theme')).toBe('solarized');
    expect(screen.getByRole('menuitemradio', { name: /Solarized/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('closes on Escape without the key reaching the app shortcuts', () => {
    let leaked = false;
    const onKey = () => {
      leaked = true;
    };
    window.addEventListener('keydown', onKey);
    render(<ThemeMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(leaked).toBe(false);
    window.removeEventListener('keydown', onKey);
  });

  it('hands off to Settings for the accent', () => {
    render(<ThemeMenu />);
    fireEvent.click(screen.getByRole('button', { name: 'Theme' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Accent colour/ }));
    expect(useAppStore.getState().activeModal).toBe('settings');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
