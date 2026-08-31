import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        mc: {
          bg: '#12151B',
          surface: '#1B1F27',
          surfaceHover: '#232834',
          border: '#2A2F3A',
          text: '#E7E9EE',
          textMuted: '#8A93A3',
          live: '#4FD1A5',
          safe: '#E8B96A',
          danger: '#E8637A',
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
