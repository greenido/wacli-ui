import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Channels come from the active theme in src/index.css.
        mc: {
          bg: 'rgb(var(--mc-bg) / <alpha-value>)',
          surface: 'rgb(var(--mc-surface) / <alpha-value>)',
          surfaceHover: 'rgb(var(--mc-surface-hover) / <alpha-value>)',
          border: 'rgb(var(--mc-border) / <alpha-value>)',
          text: 'rgb(var(--mc-text) / <alpha-value>)',
          textMuted: 'rgb(var(--mc-text-muted) / <alpha-value>)',
          live: 'rgb(var(--mc-live) / <alpha-value>)',
          safe: 'rgb(var(--mc-safe) / <alpha-value>)',
          danger: 'rgb(var(--mc-danger) / <alpha-value>)',
          star: 'rgb(var(--mc-star) / <alpha-value>)',
          onLive: 'rgb(var(--mc-on-live) / <alpha-value>)',
          accent: 'rgb(var(--mc-accent) / <alpha-value>)',
          onAccent: 'rgb(var(--mc-on-accent) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        mc: '5px',
      },
    },
  },
  plugins: [],
} satisfies Config;
