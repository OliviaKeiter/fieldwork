import { useCallback, useEffect, useState } from 'react';
import {
  IconToday,
  IconPipeline,
  IconIntake,
  IconContacts,
  IconInsights,
  IconConstellation,
  IconSearch,
  IconSettings,
  IconPanel,
  type IconComponent,
} from './icons';
import ThemeToggle from './ThemeToggle';

export type NavKey =
  | 'today'
  | 'pipeline'
  | 'intake'
  | 'contacts'
  | 'insights'
  | 'constellation'
  | 'settings'
  | 'company'
  | 'onboarding';

const STORAGE_KEY = 'fieldwork-sidebar';

interface NavItem {
  key: NavKey;
  label: string;
  href: string;
  Icon: IconComponent;
  /** Shown under the label when expanded. Says what the screen is *for*, so the
   *  nav teaches the app instead of just listing it. */
  hint: string;
}

/* Two groups, because the app has two rhythms: things you *do* today, and the
   record you consult. Settings lives apart from both, down by the theme toggle. */
const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Work',
    items: [
      { key: 'today', label: 'Today', href: '/today', Icon: IconToday, hint: 'Due now' },
      { key: 'pipeline', label: 'Pipeline', href: '/pipeline', Icon: IconPipeline, hint: 'Every role' },
      { key: 'intake', label: 'Intake', href: '/intake', Icon: IconIntake, hint: 'Score a JD' },
    ],
  },
  {
    title: 'Record',
    items: [
      { key: 'contacts', label: 'Contacts', href: '/contacts', Icon: IconContacts, hint: 'People' },
      { key: 'insights', label: 'Insights', href: '/insights', Icon: IconInsights, hint: 'What is working' },
      { key: 'constellation', label: 'Constellation', href: '/constellation', Icon: IconConstellation, hint: 'Your search as a sky' },
    ],
  },
];

const FOOTER_ITEM: NavItem = {
  key: 'settings',
  label: 'Settings',
  href: '/settings',
  Icon: IconSettings,
  hint: 'Profile and rules',
};

/** The dossier is reached *through* Pipeline, so it lights Pipeline up rather
 *  than being its own destination. Same for onboarding under Settings. */
const PARENT_OF: Partial<Record<NavKey, NavKey>> = {
  company: 'pipeline',
  onboarding: 'settings',
};

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const { Icon, label, href, hint } = item;
  return (
    <a
      href={href}
      aria-current={active ? 'page' : undefined}
      className={[
        'fw-nav-link group relative flex items-center gap-3 rounded-lg px-3 py-2 transition-colors',
        active
          ? 'bg-surface-2 text-text'
          : 'text-text-dim hover:bg-surface-2/60 hover:text-text',
      ].join(' ')}
    >
      {/* Active rail. Lives inside the link so it tracks the item in both widths. */}
      <span
        aria-hidden="true"
        className={[
          'absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full transition-opacity',
          active ? 'bg-accent opacity-100' : 'opacity-0',
        ].join(' ')}
      />
      <Icon className={['h-5 w-5 shrink-0', active ? 'text-accent' : ''].join(' ')} />
      <span className="fw-collapsible min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{label}</span>
        <span className="block truncate text-xs leading-tight text-text-dim">{hint}</span>
      </span>
      {/* Collapsed-only tooltip: the label has to come back somehow. */}
      <span
        role="tooltip"
        className="fw-tooltip pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text opacity-0 shadow-lg transition-opacity"
      >
        {label}
      </span>
    </a>
  );
}

export default function Sidebar({ active }: { active: NavKey }) {
  const [collapsed, setCollapsed] = useState(false);
  const highlighted = PARENT_OF[active] ?? active;

  /* The inline script in AppShell already set data-sidebar before paint. Read it
     back rather than re-deriving, so React agrees with what is on screen. */
  useEffect(() => {
    setCollapsed(document.documentElement.getAttribute('data-sidebar') === 'collapsed');
  }, []);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      document.documentElement.setAttribute('data-sidebar', next ? 'collapsed' : 'expanded');
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? 'collapsed' : 'expanded');
      } catch {
        /* Private mode: the toggle still works, it just will not persist. */
      }
      return next;
    });
  }, []);

  /* "[" toggles the rail, the way it does in editors. Ignored while typing. */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      toggle();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  return (
    <aside className="fw-sidebar sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex h-14 items-center gap-2.5 px-3">
        <a href="/today" className="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1">
          <FieldworkMark />
          <span className="fw-collapsible min-w-0">
            <span className="block truncate text-sm font-semibold tracking-tight text-text">
              Fieldwork
            </span>
            <span className="block truncate text-xs leading-tight text-text-dim">
              the job-search cockpit
            </span>
          </span>
        </a>
      </div>

      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 py-3">
        {/* Opens the command palette (CommandPalette.tsx, a sibling island in
            AppShell) via a window event — the only channel two islands share. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('fieldwork:palette'))}
          className="fw-nav-link group relative flex items-center gap-3 rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-text-dim transition-colors hover:bg-surface-2 hover:text-text"
        >
          <IconSearch className="h-5 w-5 shrink-0" />
          <span className="fw-collapsible min-w-0 flex-1 truncate text-left text-sm">
            Jump anywhere…
          </span>
          <kbd className="fw-collapsible rounded border border-border bg-bg px-1.5 py-0.5 font-sans text-[0.65rem] text-text-dim">
            Ctrl K
          </kbd>
          <span
            role="tooltip"
            className="fw-tooltip pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text opacity-0 shadow-lg transition-opacity"
          >
            Jump anywhere · Ctrl K
          </span>
        </button>

        {GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            {/* Expanded: a group label. Collapsed: a rule, so the grouping survives. */}
            <p className="fw-collapsible px-3 pb-1 text-[0.65rem] font-semibold uppercase tracking-widest text-text-dim">
              {group.title}
            </p>
            <div className="fw-group-rule mx-3 mb-1 hidden h-px bg-border" aria-hidden="true" />
            {group.items.map((item) => (
              <NavLink key={item.key} item={item} active={highlighted === item.key} />
            ))}
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-border px-3 py-3">
        <NavLink item={FOOTER_ITEM} active={highlighted === 'settings'} />
        <ThemeToggle />
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand sidebar  [' : 'Collapse sidebar  ['}
          className="fw-nav-link group relative flex items-center gap-3 rounded-lg px-3 py-2 text-text-dim transition-colors hover:bg-surface-2/60 hover:text-text"
        >
          <IconPanel className="h-5 w-5 shrink-0" />
          <span className="fw-collapsible truncate text-sm">Collapse</span>
          <span
            role="tooltip"
            className="fw-tooltip pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs font-medium text-text opacity-0 shadow-lg transition-opacity"
          >
            Expand
          </span>
        </button>
      </div>
    </aside>
  );
}

/** The mark: a surveyor's stake in a field. Small enough to read at 28px in the
 *  collapsed rail, which is the only size that really matters. */
function FieldworkMark() {
  return (
    <span
      aria-hidden="true"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
      >
        <path d="M6 21V4" />
        <path d="M6 4.5h10.5L14 8l2.5 3.5H6" />
      </svg>
    </span>
  );
}
