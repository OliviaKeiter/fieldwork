import { supabase } from './supabase';
import type { FwContact } from './types';

export async function listContacts(): Promise<FwContact[]> {
  const { data, error } = await supabase
    .from('fw_contacts')
    .select('*')
    .order('last_touch', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return data ?? [];
}

export async function listDistinctCompanies(): Promise<string[]> {
  const { data, error } = await supabase.from('fw_applications').select('company');
  if (error) throw error;
  const set = new Set<string>();
  for (const row of (data ?? []) as { company: string }[]) {
    if (row.company) set.add(row.company);
  }
  return Array.from(set).sort();
}

export interface NewContactInput {
  name: string;
  company: string | null;
  role_title: string | null;
  email: string | null;
  linkedin: string | null;
  warmth: string;
  application_id: string | null;
}

export async function insertContact(input: NewContactInput): Promise<void> {
  const { error } = await supabase.from('fw_contacts').insert(input as never);
  if (error) throw error;
}
