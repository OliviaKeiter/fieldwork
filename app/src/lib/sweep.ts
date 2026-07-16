import { invokeFn } from './functions';

export interface SweepMailItem {
  from: string;
  subject: string;
  snippet: string;
  received_at?: string | null;
}

export interface SweepResult {
  item: SweepMailItem;
  application_id: string | null;
  classification: 'rejection' | 'interview_invite' | 'other';
  stated_reason: string | null;
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  action: string;
  error?: string;
}

/** Calls the `sweep` edge function with already-fetched email summaries. Fieldwork has no
 * mail-provider OAuth of its own (see supabase/functions/sweep/index.ts header) — this is
 * for pasting in a handful of subject/snippet lines gathered elsewhere, or for a future job
 * to POST to directly. */
export async function runSweep(items: SweepMailItem[]): Promise<SweepResult[]> {
  const res = await invokeFn<{ results: SweepResult[] }>('sweep', { items });
  return res.results;
}
