import { NextRequest } from "next/server";

/**
 * Origins allowed to send credentialed requests (credentials: 'include').
 * Browsers reject `Access-Control-Allow-Origin: *` when credentials are used —
 * these origins get an echoed origin + Allow-Credentials: true instead.
 */
const ALLOWED_ORIGINS = new Set([
  "https://www.flowblinq.com",
  "https://flowblinq.com",
  "https://geo.flowblinq.com",
]);

export interface CorsOptions {
  /**
   * M3 (2026-05-27 audit): default fallback for unknown origins is to omit
   * Access-Control-Allow-Origin entirely. Routes that genuinely need to be
   * world-readable (beacon JS, schema injection, robots) must opt in via
   * `{ allowAll: true }`. This prevents a future route from accidentally
   * publishing sensitive content cross-origin.
   */
  allowAll?: boolean;
}

/**
 * Returns CORS headers for the given request.
 *
 * - Allow-listed origin → echo origin back + Allow-Credentials: true + Vary: Origin
 *   (required for fetch({ credentials: 'include' }) from the marketing site)
 * - Unknown origin + allowAll=true → Access-Control-Allow-Origin: *
 * - Unknown origin + allowAll=false (default) → no Allow-Origin header
 *   (same-origin requests still work; cross-origin requests get blocked
 *   client-side, which is the safe default).
 */
export function corsHeaders(
  req: Request | NextRequest,
  methods = "GET, POST, OPTIONS",
  options: CorsOptions = {},
): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.has(origin);
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed) {
    base["Access-Control-Allow-Origin"] = origin;
    base["Access-Control-Allow-Credentials"] = "true";
    base.Vary = "Origin";
  } else if (options.allowAll) {
    base["Access-Control-Allow-Origin"] = "*";
  }
  // Otherwise: no Allow-Origin header (fail-closed default).
  return base;
}
