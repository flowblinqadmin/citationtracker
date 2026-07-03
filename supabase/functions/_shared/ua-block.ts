// Malicious user-agent blocklist for Supabase Edge Functions.
//
// Middleware does NOT run for Supabase Edge endpoints — the geo/middleware.ts
// UA block list won't apply to traffic that hits *.supabase.co directly.
// Each Edge handler must call isBlockedUA() at entry and return 403 on match.
//
// Pattern list extracted verbatim from geo/middleware.ts:BLOCKED_UA_PATTERNS
// (commit dbe92c2). Keep in sync — if the Next.js list adds an entry, mirror
// it here.

const BLOCKED_UA_PATTERNS = [
  "nikto",
  "sqlmap",
  "nmap",
  "masscan",
  "zgrab",
  "nuclei",
  "acunetix",
  "nessus",
  "openvas",
  "burpsuite",
  "metasploit",
  "w3af",
  "havij",
  "wpscan",
  "wpbot",
  "cms-checker",
  "joomscan",
  "ahrefsbot",
  "semrushbot",
  "mj12bot",
  "dotbot",
  "blexbot",
  "dataforseobot",
  "faviconhash",
  "shodan",
];

/**
 * Returns true if the UA string contains any blocked-tool substring.
 * Match is case-insensitive. Null/empty returns false — the handler
 * decides how to treat missing UAs (track-collect allows empty per
 * current Next.js behavior; track-slug should reject).
 */
export function isBlockedUA(userAgent: string | null): boolean {
  if (!userAgent) return false;
  const lower = userAgent.toLowerCase();
  return BLOCKED_UA_PATTERNS.some((p) => lower.includes(p));
}
