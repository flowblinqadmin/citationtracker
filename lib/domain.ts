// Canonicalize a user-entered brand/competitor domain to a bare hostname.
// People paste "https://flowblinq.com/about", "www.Flowblinq.com", or leave a
// stray space — all of which the raw [a-z0-9.-] check rejected as "invalid
// domain". Normalize instead of reject: strip scheme, path/query/hash, port,
// leading www., trailing dots, and lowercase. Returns null only when there is
// no plausible hostname left (empty, no TLD dot, illegal chars).
//
// Client-safe (no db imports) — used by the create form, the competitor editor,
// and the zod schema so a direct API call is normalized too.
export function normalizeDomain(input: string): string | null {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // strip scheme (http://, https://, …)
  s = s.split(/[/?#]/)[0];                        // drop path / query / fragment
  s = s.replace(/:\d+$/, "");                     // drop :port
  s = s.replace(/^www\./, "");                    // canonical: drop leading www.
  s = s.replace(/\.+$/, "");                      // drop trailing dot(s)

  if (s.length < 3 || s.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;      // hostname chars only
  if (!s.includes(".")) return null;              // must have a TLD label
  if (/^[.-]|[.-]$/.test(s)) return null;         // no leading/trailing . or -
  if (s.includes("..")) return null;              // no empty labels
  return s;
}
