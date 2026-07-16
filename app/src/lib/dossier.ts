import { supabase } from './supabase';
import type { FwContact, FwDraft, FwEvent, FwJd, FwPrepDoc } from './types';

export async function listEvents(applicationId: string): Promise<FwEvent[]> {
  const { data, error } = await supabase
    .from('fw_events')
    .select('*')
    .eq('application_id', applicationId)
    .order('occurred_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listJds(applicationId: string): Promise<FwJd[]> {
  const { data, error } = await supabase
    .from('fw_jds')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listContactsForApp(applicationId: string): Promise<FwContact[]> {
  const { data, error } = await supabase
    .from('fw_contacts')
    .select('*')
    .eq('application_id', applicationId);
  if (error) throw error;
  return data ?? [];
}

/** Every saved draft for this application, newest first — feeds the History tab. */
export async function listDraftsForApp(applicationId: string): Promise<FwDraft[]> {
  const { data, error } = await supabase
    .from('fw_drafts')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listPrepDocs(applicationId: string): Promise<FwPrepDoc[]> {
  const { data, error } = await supabase
    .from('fw_prep_docs')
    .select('*')
    .eq('application_id', applicationId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}
