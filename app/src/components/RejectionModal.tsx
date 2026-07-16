import { useState, type FormEvent } from 'react';
import type { FwApplication } from '../lib/types';

interface Props {
  application: FwApplication;
  onCancel: () => void;
  onConfirm: (statedReason: string) => Promise<void>;
}

/**
 * Rejection confirmation. Per spec §7 this is a hard non-negotiable: no whimsy copy here,
 * at any dial setting. Plain, kind, factual only.
 */
export default function RejectionModal({ application, onCancel, onConfirm }: Props) {
  const [statedReason, setStatedReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await onConfirm(statedReason.trim());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-xl border border-border bg-surface p-6">
        <h2 className="text-lg font-medium text-text">
          Log the rejection — {application.company}
        </h2>
        <p className="mt-1 text-sm text-text-dim">
          {application.title ?? 'This role'} moves to Rejected. What did they say the reason
          was?
        </p>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-2 text-sm text-text-dim">
            Stated reason
            <textarea
              required
              value={statedReason}
              onChange={(e) => setStatedReason(e.target.value)}
              rows={3}
              placeholder="e.g. Went with an internal candidate"
              className="rounded-lg border border-border bg-bg px-3 py-2 text-text outline-none focus:border-accent"
            />
          </label>

          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="rounded-lg border border-border px-4 py-2 text-sm text-text-dim transition-colors hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-text transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? 'Logging…' : 'Log rejection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
