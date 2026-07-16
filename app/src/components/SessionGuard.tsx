import { useEffect } from 'react';
import { useSession } from '../lib/auth';

/**
 * Client-side auth gate. Mount inside any protected page; redirects to
 * /login if there's no active Supabase session once the initial session
 * check resolves. Renders nothing itself — the Astro-rendered page content
 * is what the user sees, this just watches and redirects.
 */
export default function SessionGuard() {
  const { session, loading } = useSession();

  useEffect(() => {
    if (!loading && !session) {
      window.location.href = '/login';
    }
  }, [loading, session]);

  return null;
}
