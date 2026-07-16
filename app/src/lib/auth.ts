import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

/** Sends a passwordless magic link to the given email. */
export async function signInWithOtp(email: string) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo:
        typeof window !== 'undefined' ? `${window.location.origin}/today` : undefined,
    },
  });
  return { error };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  return { error };
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  return { session: data.session, error };
}

/* On the very first sign-in to a fresh project, ownership is unclaimed and every
 * fw_ table is closed (see schema.sql RLS). fw_claim_owner() claims it for this
 * account; the app must call it before reading data, or the owner sees an empty
 * app on first load. It is idempotent — a no-op once claimed — so calling it once
 * per page-load is cheap, and a non-owner's call simply changes nothing. */
let ownershipEnsured = false;
async function ensureOwnership(session: Session | null): Promise<void> {
  if (!session || ownershipEnsured) return;
  try {
    await supabase.rpc('fw_claim_owner');
    ownershipEnsured = true;
  } catch {
    // Leave the flag down so the next auth event retries; a failed claim must not
    // wedge the app, and for the owner the data reads simply return empty until it
    // succeeds.
  }
}

/** React hook: tracks the current Supabase auth session, live. */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    getSession().then(async ({ session }) => {
      // Claim ownership before reporting "loaded", so the first data fetch on the
      // owner's first login happens after the tables are open to them.
      await ensureOwnership(session);
      if (mounted) {
        setSession(session);
        setLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      await ensureOwnership(newSession);
      setSession(newSession);
      setLoading(false);
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}
