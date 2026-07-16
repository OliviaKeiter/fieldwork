import { supabase } from './supabase';
import type { FwProfile } from './types';

/** Fetches the single profile row (single-user app; schema is multi-user-ready but there's
 * exactly one row today). Returns null if none exists yet. */
export async function getProfile(): Promise<FwProfile | null> {
  const { data, error } = await supabase.from('fw_profile').select('*').limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateProfile(id: string, patch: Partial<FwProfile>): Promise<void> {
  const { error } = await supabase.from('fw_profile').update(patch as never).eq('id', id);
  if (error) throw error;
}

/** Creates the single profile row for a brand-new user (schema is multi-user-ready but
 * there's exactly one row today). Used by the onboarding wizard the first time it saves —
 * existing users (seeded via import) never hit this path since their row already exists. */
export async function createProfile(patch: Partial<FwProfile>): Promise<FwProfile> {
  const { data, error } = await supabase.from('fw_profile').insert(patch as never).select().single();
  if (error) throw error;
  return data as FwProfile;
}

/** Splits a comma/newline separated textarea value into a trimmed, non-empty string array. */
export function parseListInput(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatListInput(list: string[] | null | undefined): string {
  return (list ?? []).join(', ');
}
