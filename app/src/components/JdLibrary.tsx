import { useCallback, useEffect, useState } from 'react';
import { IconArrowRight } from './icons';
import { listAllJds, type JdLibraryRow } from '../lib/jds';
import { formatDate } from '../lib/dateUtils';

type LoadState = 'loading' | 'ready' | 'error';

export default function JdLibrary() {
  const [state, setState] = useState<LoadState>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rows, setRows] = useState<JdLibraryRow[]>([]);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const data = await listAllJds();
      setRows(data);
      setState('ready');
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to load the JD library.');
      setState('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (state === 'loading') {
    return <p className="text-sm text-text-dim">Loading the JD library…</p>;
  }

  if (state === 'error') {
    return (
      <div className="rounded-xl border border-danger/40 bg-surface p-4 text-sm text-danger">
        {errorMessage ?? 'Something went wrong loading the JD library.'}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-text-dim">
        No JDs on file yet — score one above and it'll show up here once filed.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs uppercase tracking-wide text-text-dim">
            <th className="px-4 py-3 font-medium">Company</th>
            <th className="px-4 py-3 font-medium">Title</th>
            <th className="px-4 py-3 font-medium">Live checked</th>
            <th className="px-4 py-3 font-medium">Source</th>
            <th className="px-4 py-3 font-medium"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-border last:border-0">
              <td className="px-4 py-3 text-text">{row.company ?? '—'}</td>
              <td className="px-4 py-3 text-text-dim">{row.title ?? '—'}</td>
              <td className="px-4 py-3 text-text-dim">{formatDate(row.live_checked_at)}</td>
              <td className="px-4 py-3 text-text-dim">{row.source ?? '—'}</td>
              <td className="px-4 py-3">
                {row.application_id && (
                  <a
                    href={`/company?id=${row.application_id}`}
                    className="group inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                  >
                    Open dossier
                    <IconArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </a>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
