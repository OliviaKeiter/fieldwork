import { useCallback, useEffect, useState } from 'react';
import { listContacts } from '../lib/contacts';
import { agingLabel, formatDate } from '../lib/dateUtils';
import ContactForm from './ContactForm';
import DraftPanel from './DraftPanel';
import EmptyState from './EmptyState';
import { IconContacts } from './icons';
import type { FwContact, FwDraftType } from '../lib/types';

const CONTACT_DRAFT_TYPES: { value: FwDraftType; label: string }[] = [
  { value: 'hello', label: 'Hello' },
  { value: 'stay_in_touch', label: 'Stay in touch' },
  { value: 'thank_you', label: 'Thank-you' },
];

type LoadState = 'loading' | 'ready' | 'error';

const WARMTH_CLASSES: Record<string, string> = {
  cold: 'bg-danger/15 text-danger border-danger/30',
  warm: 'bg-accent/15 text-accent border-accent/30',
  hot: 'bg-success/15 text-success border-success/30',
};

export default function ContactsTable() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [contacts, setContacts] = useState<FwContact[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [draftType, setDraftType] = useState<Record<string, FwDraftType>>({});
  const [draftFor, setDraftFor] = useState<FwContact | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await listContacts();
      setContacts(data);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load contacts.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90"
        >
          + Contact
        </button>
      </div>

      {state === 'loading' && <p className="text-sm text-text-dim">Loading contacts…</p>}

      {state === 'error' && (
        <div className="rounded-xl border border-danger/40 bg-surface p-6 text-sm text-danger">
          {errorMessage ?? 'Something went wrong loading contacts.'}
        </div>
      )}

      {state === 'ready' && contacts.length === 0 && (
        <EmptyState
          Icon={IconContacts}
          title="No contacts yet"
          body="Add the first person you're staying in touch with. Recruiters, hiring managers, and anyone who gave you a warm intro."
        />
      )}

      {state === 'ready' && contacts.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-text-dim">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Company</th>
                <th className="px-4 py-3 font-medium">Warmth</th>
                <th className="px-4 py-3 font-medium">Last touch</th>
                <th className="px-4 py-3 font-medium">Quiet for</th>
                <th className="px-4 py-3 font-medium">Next action</th>
                <th className="px-4 py-3 font-medium">Draft</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-text">{c.name}</td>
                  <td className="px-4 py-3 text-text-dim">{c.company ?? '—'}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs capitalize ${
                        WARMTH_CLASSES[c.warmth] ?? WARMTH_CLASSES.cold
                      }`}
                    >
                      {c.warmth}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-dim">{formatDate(c.last_touch)}</td>
                  <td className="px-4 py-3 text-text-dim">{agingLabel(c.last_touch)}</td>
                  <td className="px-4 py-3 text-text-dim">{c.next_action ?? '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <select
                        value={draftType[c.id] ?? 'hello'}
                        onChange={(e) =>
                          setDraftType((d) => ({ ...d, [c.id]: e.target.value as FwDraftType }))
                        }
                        className="rounded-lg border border-border bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
                      >
                        {CONTACT_DRAFT_TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setDraftFor(c)}
                        className="rounded-lg bg-accent px-3 py-1 text-xs font-medium text-bg transition-opacity hover:opacity-90"
                      >
                        Draft
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <ContactForm
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {draftFor && (
        <DraftPanel
          type={draftType[draftFor.id] ?? 'hello'}
          context={{ contact_id: draftFor.id }}
          subjectLabel={draftFor.name}
          onClose={() => setDraftFor(null)}
          onSent={load}
        />
      )}
    </div>
  );
}
