/**
 * Private/internal IP ranges for SSRF protection.
 * Rejects hostnames that resolve to private networks, loopback, link-local,
 * CGNAT, and IPv6 equivalents.
 *
 * Used at URL submission time (sites, bulk audit, v1 API) and inside
 * proxyFetch/crawlers as defense-in-depth.
 */
export const PRIVATE_RANGES = [
  /^localhost$/i,
  /^127\./,                              // loopback
  /^10\./,                               // RFC-1918
  /^192\.168\./,                         // RFC-1918
  /^172\.(1[6-9]|2\d|3[01])\./,         // RFC-1918
  /^169\.254\./,                         // link-local / cloud metadata (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^0\./,                                // 0.0.0.0/8
  /^\[::1\]$/,                           // IPv6 loopback (URL() wraps in brackets)
  /^\[::ffff:/i,                         // IPv4-mapped IPv6
  /^\[f[cd]/i,                           // IPv6 ULA fc00::/7
  /^\[fe80/i,                            // IPv6 link-local
];

/** Returns true if the hostname matches a private/internal IP range. */
export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_RANGES.some((r) => r.test(hostname));
}
