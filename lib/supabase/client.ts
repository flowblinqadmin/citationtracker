import { createBrowserClient } from "@supabase/ssr";

/**
 * Supabase browser client — used ONLY for sign-out from the global header.
 *
 * Same Supabase project + same session cookie as geo (see CLAUDE.md "Auth"):
 * calling supabase.auth.signOut() here clears the shared cookie so the user is
 * signed out of geo and citations alike.
 *
 * createBrowserClient is a singleton internally; call createClient() at the
 * point of use rather than caching a module-level instance (SSR hydration).
 * navigator.locks is disabled to avoid multi-tab token-refresh deadlocks
 * (mirrors geo's client).
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY)!;
  return createBrowserClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      lock: <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> => fn(),
    },
  });
}
