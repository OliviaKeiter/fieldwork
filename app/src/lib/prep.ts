import { supabase } from './supabase';
import { invokeFn } from './functions';
import type { FwPrepDoc } from './types';

export async function generatePrepDoc(applicationId: string, roundType: string): Promise<FwPrepDoc> {
  const res = await invokeFn<{ prep_doc: FwPrepDoc }>('prep', {
    application_id: applicationId,
    round_type: roundType,
  });
  return res.prep_doc;
}

export interface Debrief {
  date: string;
  round_type: string | null;
  notes: string;
}

/** Appends a "here's how it went" entry to a prep doc's debriefs jsonb array (SPEC.md §5).
 * Read-modify-write on the client since this is a plain data append, not an AI call. */
export async function logDebrief(prepDocId: string, debrief: Debrief): Promise<FwPrepDoc> {
  const { data: existing, error: readError } = await supabase
    .from('fw_prep_docs')
    .select('*')
    .eq('id', prepDocId)
    .single();
  if (readError) throw readError;

  const debriefs = Array.isArray((existing as FwPrepDoc).debriefs) ? (existing as FwPrepDoc).debriefs : [];
  const nextDebriefs = [...debriefs, debrief];

  const { data, error } = await supabase
    .from('fw_prep_docs')
    .update({ debriefs: nextDebriefs } as never)
    .eq('id', prepDocId)
    .select()
    .single();
  if (error) throw error;
  return data as FwPrepDoc;
}
