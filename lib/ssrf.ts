/**
 * lib/ssrf.ts — Pure SSRF validation for public URLs.
 *
 * Two variants:
 *   validatePublicUrl(input)           — sync, string-only checks (scheme, hostname blocklist,
 *                                        private ranges). Use at request-validation time.
 *   validatePublicUrlWithDns(input)    — async, adds a DNS lookup pre-flight that resolves the
 *                                        hostname and checks the returned IP(s) against PRIVATE_RANGES.
 *                                        Mitigates DNS rebinding: attacker returns a public IP at
 *                                        validation time then switches to 169.254.169.254 at crawl
 *                                        time. Using the async variant at the point where a fetch
 *                                        actually occurs pins the IP used for validation to the IP
 *                                        that the OS will use seconds later.
 *                                        NOTE: Firecrawl (used for discovery + crawl) is a SaaS
 *                                        service that fetches pages on its own infrastructure. It
 *                                        provides a second-layer of hostname validation but does not
 *                                        publish a formal SSRF guarantee. The async pre-flight below
 *                                        is the defence-in-depth layer for any internal HTTP calls
 *                                        (e.g. sitemaps fetched directly in geo-crawler.ts).
 *
 * Usage:
 *   const result = validatePublicUrl(input);
 *   if (!result.ok) return res.status(400).json({ error: "invalid_url" });
 *   // Use result.url.href downstream — never the raw input string.
 */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

const MAX_URL_LENGTH = 500;

/**
 * Private IPv4 ranges and other reserved hostnames.
 * Tested against the stripped (no trailing dot) hostname.
 */
const PRIVATE_RANGES: RegExp[] = [
  // Loopback
  /^localhost$/i,
  /^127\./,
  // Class A private
  /^10\./,
  // Class B private (172.16.0.0/12)
  /^172\.(1[6-9]|2\d|3[01])\./,
  // Class C private
  /^192\.168\./,
  // Link-local (also covers AWS/GCP/Azure IMDS: 169.254.169.254)
  /^169\.254\./,
  // CGNAT (RFC 6598)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  // This-network (RFC 1122)
  /^0\./,
  // IPv6 loopback — bracketed [::1] (from URL parser) and bare ::1
  /^(\[::1\]|::1)$/i,
  // IPv4-mapped IPv6 — bracketed [::ffff:*] and bare ::ffff:*
  /^(\[::ffff:|::ffff:)/i,
  // IPv6 unique-local [fc00::/7] — bracketed and bare
  /^(\[f[cd]|f[cd])/i,
  // IPv6 link-local [fe80::/10] — bracketed and bare
  /^(\[fe80|fe80)/i,
];

/** Encoded-IP patterns that bypass dotted-quad checks. */
const ENCODED_IP_PATTERNS: RegExp[] = [
  // Decimal integer IPs (e.g. 2130706433 = 127.0.0.1)
  /^[\d.]+$/,
  // Hex-encoded (0x7f000001)
  /^0x/i,
  // Octal / leading-zero octets (0177.0.0.1)
  /^0\d/,
];

/** Cloud-internal / special-purpose FQDNs. */
const CLOUD_FQDN_PATTERNS: RegExp[] = [
  /^metadata\.google\.internal$/i,
  /^instance-data\.ec2\.internal$/i,
  /\.internal$/i,
  /\.local$/i,
  /\.localhost$/i,
  /\.nip\.io$/i,
];

export type ValidatePublicUrlResult =
  | { ok: true; url: URL }
  | { ok: false; error: string };

/**
 * Validate that a URL string:
 *  1. Parses as a valid URL.
 *  2. Uses http: or https: scheme.
 *  3. Contains no userinfo (username/password) component.
 *  4. Is not longer than 500 characters.
 *  5. Has a multi-label hostname (not single-label like "localhost").
 *  6. Does not resolve to a private/loopback/cloud-metadata address.
 *
 * On success, returns `{ ok: true, url }` where `url` is the canonicalized
 * URL object. Callers MUST use `url.href` downstream — never the raw input.
 */
export function validatePublicUrl(input: string): ValidatePublicUrlResult {
  // 1. Length cap
  if (!input || input.length > MAX_URL_LENGTH) {
    return { ok: false, error: "URL too long (max 500 chars)" };
  }

  // 2. Parse
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "Invalid URL" };
  }

  // 3. Scheme
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, error: "Scheme not allowed; use http or https" };
  }

  // 3b. Userinfo (username/password) — reject unconditionally.
  // url.href preserves userinfo in the serialized form, which pollutes Stripe
  // metadata and confuses logs. Not exploitable as SSRF (hostname still wins),
  // but a metadata-hygiene gap that surprises downstream consumers.
  if (url.username || url.password) {
    return { ok: false, error: "userinfo_not_allowed" };
  }

  // 4. Strip trailing dot from hostname for normalization
  const hostname = url.hostname.replace(/\.$/, "");

  // 5. Single-label rejection (must have at least one dot)
  if (!hostname.includes(".")) {
    return { ok: false, error: "Single-label hostname not allowed" };
  }

  // 6. Private IPv4 / IPv6 ranges
  if (PRIVATE_RANGES.some((r) => r.test(hostname))) {
    return { ok: false, error: "Private/reserved IP address not allowed" };
  }

  // 7. Encoded IP patterns
  if (ENCODED_IP_PATTERNS.some((r) => r.test(hostname))) {
    return { ok: false, error: "Encoded IP address not allowed" };
  }

  // 8. Cloud-internal FQDNs
  if (CLOUD_FQDN_PATTERNS.some((r) => r.test(hostname))) {
    return { ok: false, error: "Cloud-internal hostname not allowed" };
  }

  return { ok: true, url };
}

/**
 * Async variant of validatePublicUrl that additionally resolves the hostname
 * via DNS and checks the returned IP(s) against PRIVATE_RANGES.
 *
 * Use at fetch-time (e.g. before directly fetching a sitemap) where DNS
 * rebinding is a realistic threat. Not suitable for hot-path checkout/OTP
 * validation where latency matters.
 *
 * Returns the same { ok, url } / { ok, error } shape as validatePublicUrl.
 */
export async function validatePublicUrlWithDns(input: string): Promise<ValidatePublicUrlResult> {
  // Run sync checks first — avoids a DNS round-trip on obviously invalid inputs
  const syncResult = validatePublicUrl(input);
  if (!syncResult.ok) return syncResult;

  const { url } = syncResult;
  const hostname = url.hostname.replace(/\.$/, "");

  // DNS lookup — skip for literal IP addresses (already checked by PRIVATE_RANGES above)
  // Lookup may throw if hostname is unresolvable; treat as invalid to be safe.
  try {
    const { promises: dnsPromises } = await import("dns");
    const { address } = await dnsPromises.lookup(hostname);
    if (PRIVATE_RANGES.some((r) => r.test(address))) {
      return { ok: false, error: "Resolved IP is private/reserved (DNS rebinding guard)" };
    }
  } catch {
    return { ok: false, error: "Hostname did not resolve to a public address" };
  }

  return { ok: true, url };
}
