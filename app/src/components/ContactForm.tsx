import { useEffect, useState, type FormEvent } from 'react';
import { listDistinctCompanies, insertContact } from '../lib/contacts';

interface Props {
  onClose: () => void;
  onSaved: () => void;
  /** When set, the saved contact is linked to this application — used by the dossier's
   * Contacts tab, where "add a contact" should mean "add a contact for THIS role". */
  applicationId?: string | null;
  /** Prefills the company field (still editable) when adding from a dossier. */
  defaultCompany?: string;
}

export default function ContactForm({ onClose, onSaved, applicationId, defaultCompany }: Props) {
  const [companies, setCompanies] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [company, setCompany] = useState(defaultCompany ?? '');
  const [roleTitle, setRoleTitle] = useState('');
  const [email, setEmail] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [warmth, setWarmth] = useState('cold');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listDistinctCompanies().then(setCompanies).catch(() => setCompanies([]));
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await insertContact({
        name: name.trim(),
        company: company.trim() || null,
        role_title: roleTitle.trim() || null,
        email: email.trim() || null,
        linkedin: linkedin.trim() || null,
        warmth,
        application_id: applicationId ?? null,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that contact.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">Add a contact</h2>
        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Company
            <input
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              list="contact-company-options"
              placeholder="Start typing…"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
            <datalist id="contact-company-options">
              {companies.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Role / title
            <input
              value={roleTitle}
              onChange={(e) => setRoleTitle(e.target.value)}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            LinkedIn
            <input
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-text-dim">
            Warmth
            <select
              value={warmth}
              onChange={(e) => setWarmth(e.target.value)}
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            >
              <option value="cold">Cold</option>
              <option value="warm">Warm</option>
              <option value="hot">Hot</option>
            </select>
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Add contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
