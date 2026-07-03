import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function normalizeDomain(url: string): string {
  try {
    // Add protocol if missing so URL constructor works
    const withProtocol = url.startsWith("http://") || url.startsWith("https://")
      ? url
      : `https://${url}`;

    const parsed = new URL(withProtocol);
    // Strip www. prefix, remove trailing slashes
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    // Fallback: strip protocol, www, and trailing slashes manually
    return url
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/.*$/, "")
      .toLowerCase()
      .trim();
  }
}

export function slugify(domain: string): string {
  return domain.replace(/\./g, "-").replace(/[^a-z0-9-]/g, "").toLowerCase();
}

/**
 * Accepts URLs in any common format and normalizes to a full https:// URL.
 * Returns null if the input cannot be made into a valid, public HTTP URL.
 *
 * Handles:
 *   "https://example.com"     → "https://example.com"   (unchanged)
 *   "http://example.com"      → "http://example.com"    (unchanged)
 *   "www.example.com"         → "https://www.example.com"
 *   "example.com"             → "https://example.com"
 *   "example.com/about"       → "https://example.com/about"
 *   "sub.example.co.uk/page"  → "https://sub.example.co.uk/page"
 *   "notaurl"                 → null  (no dot in hostname)
 *   "ftp://example.com"       → null  (non-HTTP protocol)
 *   ""                        → null  (empty)
 *   "http://"                 → null  (empty host)
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Already has http:// or https://
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname.includes(".")) return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  // Non-HTTP protocol (ftp://, file://, javascript:, etc.) — reject.
  // Excludes dots from the scheme pattern so "example.com:8080" is not treated as a scheme.
  if (/^[a-zA-Z][a-zA-Z0-9+\-]*:/.test(trimmed)) return null;

  // No protocol — prepend https://
  try {
    const withHttps = `https://${trimmed}`;
    const parsed = new URL(withHttps);
    if (!parsed.hostname.includes(".")) return null;
    return withHttps;
  } catch {
    return null;
  }
}
