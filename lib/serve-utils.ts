/**
 * Utility functions for serve route path matching.
 * Used by /api/serve/[slug]/head to filter schema blocks by page target.
 */

/**
 * Normalize a request path for comparison:
 * - Lowercase
 * - Strip query string and fragment
 * - Strip trailing slash (except root "/")
 */
export function normalizePath(path: string): string {
  // Strip query string and fragment
  let normalized = path.split("?")[0].split("#")[0];
  normalized = normalized.toLowerCase();
  // Strip trailing slash unless it's just "/"
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || "/";
}

/**
 * Extract the path portion from a pageTarget that may be a full URL or a path.
 */
function extractPath(pageTarget: string): string {
  try {
    const url = new URL(pageTarget);
    return normalizePath(url.pathname);
  } catch {
    // Not a valid URL — treat as a path
    return normalizePath(pageTarget);
  }
}

/**
 * Check if a schema block's pageTarget matches the requested path.
 *
 * Match rules:
 * - "all pages" → always matches
 * - "homepage" → matches only "/"
 * - Full URL (e.g. "https://example.com/about") → extract path, compare
 * - Path (e.g. "/about") → direct path comparison
 */
export function matchesPageTarget(
  pageTarget: string,
  requestPath: string
): boolean {
  const target = pageTarget.trim().toLowerCase();

  if (target === "all pages") return true;
  if (target === "homepage") return normalizePath(requestPath) === "/";

  const targetPath = extractPath(pageTarget);
  const normalizedRequest = normalizePath(requestPath);

  return targetPath === normalizedRequest;
}
