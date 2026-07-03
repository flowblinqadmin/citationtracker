// CORS helper for Supabase Edge Functions.
//
// Ported from geo/lib/cors.ts with one substitution: drop the NextRequest
// import and narrow the parameter type to the Web platform Request — the
// only header we read is `origin`, which both types expose identically.
//
// Behavior contract (DO NOT change without coordinating with the marketing
// site's credentialed fetch):
//   - Origin in ALLOWED_ORIGINS → echo + Allow-Credentials: true + Vary: Origin.
//     Required for fetch({ credentials: 'include' }) per browser CORS rules.
//   - Anything else → wildcard `*` without credentials. Browser blocks any
//     credentialed call from these origins — the CSRF defense.
//
// Supabase Edge does NOT inject CORS headers automatically. Every handler
// must call this and merge the result into its Response.

/**
 * Origins allowed to send credentialed requests (credentials: 'include').
 * Mirrors geo/lib/cors.ts:ALLOWED_ORIGINS — keep in sync.
 */
const ALLOWED_ORIGINS = new Set([
  "https://www.flowblinq.com",
  "https://flowblinq.com",
  "https://geo.flowblinq.com",
]);

/**
 * Returns CORS headers for the given request.
 */
export function corsHeaders(
  req: Request,
  methods = "GET, POST, OPTIONS",
): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.has(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "*",
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    ...(allowed
      ? { "Access-Control-Allow-Credentials": "true", Vary: "Origin" }
      : {}),
  };
}
