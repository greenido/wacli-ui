import React from 'react';
import type { ConcreteTheme, ThemeChoice } from '../../lib/theme.ts';

/**
 * A thumbnail of a theme. It sets `data-theme` on itself, so the stylesheet's
 * palette applies inside it whatever theme the page is in: nothing here
 * repeats a colour from src/index.css.
 */
const Mini: React.FC<{ theme: ConcreteTheme; className?: string }> = ({ theme, className = '' }) => (
  <div data-theme={theme} className={`bg-mc-bg flex gap-1 p-1 ${className}`}>
    <div className="w-1/3 rounded-sm bg-mc-surface" />
    <div className="flex-1 flex flex-col justify-center gap-1">
      <div className="h-1 w-3/4 rounded-full bg-mc-text/80" />
      <div className="h-1 w-1/2 rounded-full bg-mc-textMuted/70" />
      <div className="h-1.5 w-2/3 rounded-full bg-mc-accent" />
    </div>
  </div>
);

export const ThemePreview: React.FC<{ theme: ThemeChoice; className?: string }> = ({ theme, className = '' }) => (
  <div aria-hidden="true" className={`flex overflow-hidden rounded-sm border border-mc-border ${className}`}>
    {theme === 'system' ? (
      <>
        <Mini theme="dark" className="flex-1" />
        <Mini theme="light" className="flex-1" />
      </>
    ) : (
      <Mini theme={theme} className="flex-1" />
    )}
  </div>
);
