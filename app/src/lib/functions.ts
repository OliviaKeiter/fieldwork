import { supabase } from './supabase';

/** Pulls the real error message out of a Supabase Functions invoke failure. supabase-js
 * only gives you a generic "non-2xx status" message by default — the actual JSON body our
 * edge functions return (e.g. the missing-secret message) lives on `error.context`. Shared
 * by every edge-function client (intake/scorecard, resume, prep, draft) so the "read the
 * real message" behavior stays consistent everywhere. */
async function readFunctionError(error: unknown): Promise<string | null> {
  const ctx = (error as { context?: Response } | null)?.context;
  if (!ctx || typeof ctx.clone !== 'function') return null;
  try {
    const parsed = await ctx.clone().json();
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      return String((parsed as { error: unknown }).error);
    }
  } catch {
    // Body wasn't JSON — fall through to the generic message.
  }
  return null;
}

export async function invokeFn<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    const detail = await readFunctionError(error);
    throw new Error(detail ?? error.message);
  }
  if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
    const message = (data as { error?: unknown }).error;
    if (message) throw new Error(String(message));
  }
  return data as T;
}
