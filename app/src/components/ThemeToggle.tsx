import { useEffect, useState } from 'react';
import { IconMoon, IconToday } from './icons';

type Theme = 'dark' | 'light';

const STORAGE_KEY = 'fieldwork-theme';

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/** Sits in the sidebar footer, so it wears the same shape as a nav link and
 *  collapses to a bare icon with the rail. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | null;
    const initial = stored ?? 'dark';
    setTheme(initial);
    applyTheme(initial);
  }, []);

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* Private mode: the toggle still works, it just will not persist. */
    }
  }

  /* The icon shows the theme you are IN, not the one you would switch to. The
     label says the same thing, so the two never contradict each other. */
  const Icon = theme === 'dark' ? IconMoon : IconToday;
  const label = theme === 'dark' ? 'Dark' : 'Light';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Color theme: ${label}. Switch to ${theme === 'dark' ? 'light' : 'dark'}.`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      className="fw-nav-link group relative flex items-center gap-3 rounded-lg px-3 py-2 text-text-dim transition-colors hover:bg-surface-2/60 hover:text-text"
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span className="fw-collapsible truncate text-sm">{label}</span>
      <span
        role="tooltip"
        className="fw-tooltip pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text opacity-0 shadow-lg transition-opacity"
      >
        {label}
      </span>
    </button>
  );
}
