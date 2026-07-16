import { useEffect, useState } from 'react';
import DossierTabs from './DossierTabs';

/** Reads `?id=` from the URL client-side and renders the dossier for it. Kept as a tiny
 * wrapper so the static-output Astro build doesn't need `getStaticPaths` for a route whose
 * ids only exist in Supabase at runtime. */
export default function DossierRouter() {
  const [id, setId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setId(params.get('id'));
  }, []);

  if (id === null) {
    return <p className="text-sm text-text-dim">Loading…</p>;
  }

  if (!id) {
    return (
      <div className="rounded-xl border border-border bg-surface p-6 text-sm text-text-dim">
        No application id given. Open a dossier from Today or Pipeline.
      </div>
    );
  }

  return <DossierTabs applicationId={id} />;
}
