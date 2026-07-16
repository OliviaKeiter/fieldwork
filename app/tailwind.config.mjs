// Tailwind v4 is CSS-first (see src/styles/global.css `@theme` block for the
// canonical token definitions). This file is kept for tooling that expects a
// config file, and to document the dark-mode-first strategy: default (no
// `data-theme` attribute, or `data-theme="dark"`) renders the dark palette;
// `data-theme="light"` overrides it. Loaded into the CSS pipeline via the
// `@config` directive in global.css.

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['selector', '[data-theme="light"]'],
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-2': 'var(--surface-2)',
        text: 'var(--text)',
        'text-dim': 'var(--text-dim)',
        accent: 'var(--accent)',
        'accent-2': 'var(--accent-2)',
        danger: 'var(--danger)',
        success: 'var(--success)',
        border: 'var(--border)',
      },
    },
  },
};
