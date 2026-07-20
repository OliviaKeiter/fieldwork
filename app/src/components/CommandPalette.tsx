import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { STATUS_LABEL } from '../lib/pipeline';
import {
  IconToday,
  IconPipeline,
  IconIntake,
  IconContacts,
  IconInsights,
  IconConstellation,
  IconSettings,
  IconSearch,
  IconMoon,
  IconDossier,
  type IconComponent,
} from './icons';
import type { FwStatus } from '../lib/types';

/* Ctrl/Cmd+K from anywhere (or the sidebar's "Jump anywhere…" button, which
 * dispatches `fieldwork:palette`). Searches pages, every application, and every
 * contact — because the fastest path to "did I ever follow up with them?" is
 * typing the company's name from wherever you already are. */

interface AppRow {
  id: string;
  company: string;
  title: string | null;
  status: FwStatus;
}

interface ContactRow {
  id: string;
  name: string;
  company: string | null;
}

interface Item {
  key: string;
  section: 'Pages' | 'Applications' | 'Contacts' | 'Actions';
  label: string;
  detail?: string;
  Icon: IconComponent;
  run: () => void;
}

const PAGES: { label: string; href: string; Icon: IconComponent }[] = [
  { label: 'Today', href: '/today', Icon: IconToday },
  { label: 'Pipeline', href: '/pipeline', Icon: IconPipeline },
  { label: 'Intake', href: '/intake', Icon: IconIntake },
  { label: 'Contacts', href: '/contacts', Icon: IconContacts },
  { label: 'Insights', href: '/insights', Icon: IconInsights },
  { label: 'Constellation', href: '/constellation', Icon: IconConstellation },
  { label: 'Settings', href: '/settings', Icon: IconSettings },
];

/** Match score: 0 = no match. Prefix beats word-start beats substring beats
 *  in-order subsequence, so "vor" ranks Vortex above "flavor". */
function score(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 1;
  const idx = t.indexOf(q);
  if (idx === 0) return 100;
  if (idx > 0 && (t[idx - 1] === ' ' || t[idx - 1] === '-')) return 80;
  if (idx > 0) return 60;
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return 0;
    ti++;
  }
  return 20;
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  try {
    window.localStorage.setItem('fieldwork-theme', next);
  } catch {
    /* Private mode: still toggles, just won't persist. */
  }
  // Let ThemeToggle's label catch up (it listens for this).
  window.dispatchEvent(new CustomEvent('fieldwork:theme', { detail: next }));
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const fetched = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const openPalette = useCallback(() => {
    setOpen(true);
    setQuery('');
    setSelected(0);
    if (!fetched.current) {
      fetched.current = true;
      // Fire-and-forget: pages and actions work even if the data never lands.
      supabase
        .from('fw_applications')
        .select('id, company, title, status')
        .order('updated_at', { ascending: false })
        .then(({ data }) => setApps((data ?? []) as AppRow[]));
      supabase
        .from('fw_contacts')
        .select('id, name, company')
        .order('updated_at', { ascending: false })
        .then(({ data }) => setContacts((data ?? []) as ContactRow[]));
    }
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => {
          if (!prev) openPalette();
          return !prev;
        });
      }
    }
    const onEvent = () => openPalette();
    window.addEventListener('keydown', onKey);
    window.addEventListener('fieldwork:palette', onEvent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('fieldwork:palette', onEvent);
    };
  }, [openPalette]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const results: (Item & { score: number })[] = [];

    for (const page of PAGES) {
      const s = score(query, page.label);
      if (s > 0) {
        results.push({
          key: `page-${page.href}`,
          section: 'Pages',
          label: page.label,
          Icon: page.Icon,
          run: () => {
            window.location.href = page.href;
          },
          score: s + 5, // pages edge out data rows on ties — they're cheaper to undo
        });
      }
    }

    const themeScore = Math.max(score(query, 'Toggle theme'), score(query, 'dark light'));
    if (themeScore > 0) {
      results.push({
        key: 'action-theme',
        section: 'Actions',
        label: 'Toggle light / dark theme',
        Icon: IconMoon,
        run: () => {
          toggleTheme();
          setOpen(false);
        },
        score: themeScore,
      });
    }

    // With no query, surface the most recently touched roles — "back to what I
    // was doing" is the most common jump.
    const appLimit = query ? 8 : 5;
    let appCount = 0;
    for (const app of apps) {
      if (appCount >= appLimit) break;
      const text = `${app.company} ${app.title ?? ''}`;
      const s = score(query, text);
      if (s > 0) {
        appCount++;
        results.push({
          key: `app-${app.id}`,
          section: 'Applications',
          label: app.company,
          detail: [app.title, STATUS_LABEL[app.status]].filter(Boolean).join(' · '),
          Icon: IconDossier,
          run: () => {
            window.location.href = `/company?id=${app.id}`;
          },
          score: s,
        });
      }
    }

    if (query) {
      let contactCount = 0;
      for (const contact of contacts) {
        if (contactCount >= 6) break;
        const text = `${contact.name} ${contact.company ?? ''}`;
        const s = score(query, text);
        if (s > 0) {
          contactCount++;
          results.push({
            key: `contact-${contact.id}`,
            section: 'Contacts',
            label: contact.name,
            detail: contact.company ?? undefined,
            Icon: IconContacts,
            run: () => {
              window.location.href = '/contacts';
            },
            score: s,
          });
        }
      }
    }

    const sectionOrder = { Pages: 0, Applications: 1, Contacts: 2, Actions: 3 };
    return results
      .sort((a, b) => b.score - a.score || sectionOrder[a.section] - sectionOrder[b.section])
      .slice(0, 14);
  }, [query, apps, contacts]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[selected]?.run();
    }
  }

  let lastSection: string | null = null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Jump anywhere"
    >
      <div className="mx-auto mt-[12vh] w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <IconSearch className="h-5 w-5 shrink-0 text-text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Jump to a company, contact, or page…"
            className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-dim"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[selected]?.key}
          />
          <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-sans text-[0.65rem] text-text-dim">
            esc
          </kbd>
        </div>

        <div ref={listRef} id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-text-dim">
              Nothing matches "{query}".
            </p>
          )}
          {items.map((item, i) => {
            const header =
              item.section !== lastSection ? (
                <p className="px-3 pb-1 pt-2 text-[0.65rem] font-semibold uppercase tracking-widest text-text-dim">
                  {item.section}
                </p>
              ) : null;
            lastSection = item.section;
            return (
              <div key={item.key}>
                {header}
                <button
                  type="button"
                  id={item.key}
                  role="option"
                  aria-selected={i === selected}
                  data-selected={i === selected}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => item.run()}
                  className={[
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    i === selected ? 'bg-surface-2 text-text' : 'text-text-dim',
                  ].join(' ')}
                >
                  <item.Icon
                    className={['h-4 w-4 shrink-0', i === selected ? 'text-accent' : ''].join(' ')}
                  />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.detail && (
                    <span className="max-w-[50%] truncate text-xs text-text-dim">
                      {item.detail}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[0.65rem] text-text-dim">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
