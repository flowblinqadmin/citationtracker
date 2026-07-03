// HMAC-SHA256 IP pseudonymization for the beacon Edge Functions.
//
// Closes ES-090 §b.1 COMP-2: the `ipHash` column on geo_page_views and
// geo_crawl_logs exists in the production schema but has never been
// populated. Every beacon insert now writes a stable HMAC of the client IP
// keyed by IP_HASH_SECRET. Raw `ip` is retained alongside until the
// backfill + 1w safety window per the compliance plan.
//
// Rotation: changing IP_HASH_SECRET breaks correlation across the
// rotation boundary, by design. Document the rotation procedure and store
// a backup of the prior secret in 1Password / Bitwarden.

const encoder = new TextEncoder();

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Raw HMAC-SHA256 hex helper. Returns 64 lowercase hex chars.
 *
 * Exposed for direct use by tests and for callers that want a different
 * keying strategy than IP_HASH_SECRET (none today, but keeps the helper
 * composable).
 */
export async function hmacSha256Hex(
  secret: string,
  data: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return bytesToHex(sig);
}

/**
 * Hash an IP address using IP_HASH_SECRET. Returns null when:
 *   - `ip` is null or empty (typical for direct internal traffic)
 *   - `IP_HASH_SECRET` is not configured — never fail the beacon over a
 *     missing secret; emit a warning so operators notice the misconfig.
 */
export async function hashIp(ip: string | null): Promise<string | null> {
  if (!ip) return null;
  const secret = Deno.env.get("IP_HASH_SECRET");
  if (!secret) {
    console.warn(
      "[ip-hash] IP_HASH_SECRET is not set — ip_hash will be NULL. Set the secret to satisfy ES-090 §b.1 COMP-2.",
    );
    return null;
  }
  return await hmacSha256Hex(secret, ip);
}
