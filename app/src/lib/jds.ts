import { supabase } from './supabase';
import type { FwJd } from './types';

export interface JdLibraryRow extends FwJd {
  company: string | null;
  title: string | null;
}

/** All JDs on file, newest first, joined back to their application's company/title so the
 * library reads like a list of roles rather than bare JD rows. */
export async function listAllJds(): Promise<JdLibraryRow[]> {
  const { data, error } = await supabase
    .from('fw_jds')
    .select('*, fw_applications(company, title)')
    .order('created_at', { ascending: false });
  if (error) throw error;

  return (data ?? []).map((row) => {
    const { fw_applications, ...jd } = row as FwJd & {
      fw_applications: { company: string; title: string | null } | null;
    };
    return {
      ...jd,
      company: fw_applications?.company ?? null,
      title: fw_applications?.title ?? null,
    };
  });
}
