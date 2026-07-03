import { createBrowserClient } from "@supabase/ssr";

/**
 * Returns a custom fetch that intercepts Supabase auth API calls and reroutes
 * them through the Vercel proxy at /api/auth/proxy.
 *
 * This prevents ISP-level blocks on supabase.co from breaking auth for Indian users.
 * Only /auth/v1/* calls are intercepted. Database, storage, and realtime calls are
 * unaffected.
 */
function createProxyFetch(supabaseUrl: string): typeof fetch {
  const authPrefix = `${supabaseUrl}/auth/v1`;
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr =
      typeof input === "string"
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;
    if (urlStr.startsWith(authPrefix)) {
      const proxyUrl = urlStr.replace(authPrefix, "/api/auth/proxy");
      return fetch(proxyUrl, init);
    }
    return fetch(input, init);
  };
}

/**
 * Creates a Supabase browser client.
 *
 * createBrowserClient has built-in singleton behavior.
 * Call createClient() everywhere — do NOT create module-level singletons.
 * Module-level singletons cause SSR hydration issues.
 *
 * CRITICAL: Must disable navigator.locks to prevent multi-tab deadlocks.
 * Without lock: false, multiple tabs compete for locks during token refresh,
 * causing DB queries to hang indefinitely on direct URL navigation.
 *
 * Auth calls are routed through /api/auth/proxy to bypass ISP-level blocks
 * on *.supabase.co that affect Indian users (Airtel, Jio, BSNL).
 */
export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  return createBrowserClient(
    supabaseUrl,
    (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY)!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Disable navigator.locks to prevent multi-tab deadlocks during token refresh.
        // LockFunc is generic — the pass-through must preserve the return type.
        lock: <R>(_name: string, _acquireTimeout: number, fn: () => Promise<R>): Promise<R> => fn(),
      },
      global: {
        fetch: createProxyFetch(supabaseUrl),
      },
    }
  );
}

export { createProxyFetch };
