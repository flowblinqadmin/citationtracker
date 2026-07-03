# TS-006: Smart URL Normalization

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `2bad500`  

---

## What

Replace strict `new URL(input)` validation with a `normalizeUrl()` utility that intelligently completes partial URLs (missing protocol, bare domain, `www.` prefix) before validation. Apply to both the single-URL and bulk-URL flows, server-side and client-side.

## Why

Users naturally type `example.com` or `www.example.com` — both are currently rejected because `new URL()` requires a protocol prefix. This is causing real submission failures in production.

---

## 1. New Utility: `normalizeUrl()`

**File:** `geo/lib/utils.ts` (extend existing file — do NOT create a new module)

```typescript
/**
 * Accepts URLs in any common format and normalizes to a full https:// URL.
 * Returns null if the input cannot be made into a valid, public HTTP URL.
 *
 * Handles:
 *   "https://example.com"      → "https://example.com"    (unchanged)
 *   "http://example.com"       → "http://example.com"     (unchanged)
 *   "www.example.com"          → "https://www.example.com"
 *   "example.com"              → "https://example.com"
 *   "example.com/about"        → "https://example.com/about"
 *   "sub.example.co.uk/page"   → "https://sub.example.co.uk/page"
 *   "notaurl"                  → null  (no dot in hostname)
 *   "ftp://example.com"        → null  (non-HTTP protocol)
 *   ""                         → null
 */
export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // If already has a protocol
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      // Reject bare hostnames without a TLD dot (e.g. "https://localhost" caught by SSRF; "https://notaurl" caught here)
      if (!parsed.hostname.includes(".")) return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  // Non-HTTP protocol (ftp://, file://, javascript:, etc.) — reject
  if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(trimmed)) return null;

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
```

**Key invariants:**
- Output is always a valid `new URL()` parseable string, or null
- SSRF checks run AFTER normalization (hostname is validated as public separately)
- The function does not strip trailing slashes or alter paths — minimal intervention

---

## 2. Server-Side: `POST /api/sites`

**File:** `geo/app/api/sites/route.ts`

### 2a. Single-URL flow

Replace:
```typescript
let parsedUrl: URL;
try {
  parsedUrl = new URL(url);
} catch {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
if (!["http:", "https:"].includes(parsedUrl.protocol)) {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
```

With:
```typescript
const normalizedUrl = normalizeUrl(url);
if (!normalizedUrl) {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
const parsedUrl = new URL(normalizedUrl); // safe — normalizeUrl guarantees parseable
```

Then use `normalizedUrl` (not the raw `url`) for all downstream operations including `normalizeDomain()`.

### 2b. Bulk-URL flow

In the SSRF validation loop, replace:
```typescript
try {
  const parsed = new URL(u);
  if (!["http:", "https:"].includes(parsed.protocol)) { invalidUrls.push(u); continue; }
  if (privateRanges.some((r) => r.test(parsed.hostname))) { invalidUrls.push(u); }
} catch { invalidUrls.push(u); }
```

With:
```typescript
const normalized = normalizeUrl(u);
if (!normalized) { invalidUrls.push(u); continue; }
const parsed = new URL(normalized); // safe
if (privateRanges.some((r) => r.test(parsed.hostname))) { invalidUrls.push(u); }
```

Also update the uniqueUrls construction to use normalized values:
```typescript
// After the validation loop, rebuild validUrls from normalized versions
const validNormalizedUrls: string[] = [];
for (const u of bulkUrls as string[]) {
  if (typeof u !== "string") continue;
  const normalized = normalizeUrl(u);
  if (!normalized) continue;
  const parsed = new URL(normalized);
  if (!privateRanges.some((r) => r.test(parsed.hostname))) {
    validNormalizedUrls.push(normalized);
  }
}
const uniqueUrls = [...new Set(validNormalizedUrls)];
```

This is cleaner than the two-pass approach and avoids duplicating logic.

---

## 3. Client-Side: Landing Page CSV Parser

**File:** `geo/app/page.tsx`

Import `normalizeUrl` (or inline an equivalent — but prefer import from shared utils if Next.js client bundle allows it).

If importing from `@/lib/utils` causes bundle size issues (server-only deps in utils.ts), inline the function directly in page.tsx with a `// duplicated from lib/utils.ts — keep in sync` comment.

Replace in `handleCsvUpload`:
```typescript
try {
  const parsed = new URL(firstCol);
  if (["http:", "https:"].includes(parsed.protocol)) {
    urls.push(firstCol);
  }
} catch { /* skip non-URL lines */ }
```

With:
```typescript
const normalized = normalizeUrl(firstCol);
if (normalized) urls.push(normalized);
```

This means:
- `# comment lines` → normalizeUrl returns null → skipped ✓
- `url` (header row) → no dot → null → skipped ✓
- `example.com` → `https://example.com` → added ✓
- `www.example.com` → `https://www.example.com` → added ✓
- `https://example.com` → unchanged → added ✓

The normalized URLs are stored in `csvUrls` state and sent to the API as `bulkUrls`. Since the API also normalizes, this is safe — double normalization of an already-normalized URL is idempotent.

---

## 4. Client-Side: Single URL Input

**File:** `geo/app/page.tsx`

The single-URL submit currently reads `url` state directly. Normalize before submit:
```typescript
// In handleSubmit, before posting:
const normalizedSingleUrl = normalizeUrl(url);
if (!normalizedSingleUrl) {
  toast.error("Please enter a valid website URL (e.g. example.com)");
  return;
}
// use normalizedSingleUrl in the POST body
```

Also update placeholder text on the URL input from whatever it is now to:
```
e.g. example.com or www.example.com
```

---

## Acceptance Criteria

1. `example.com` submitted in the single URL field → pipeline starts for `example.com`
2. `www.example.com` → pipeline starts, domain normalized to `example.com`
3. `https://example.com` → unchanged behavior
4. `ftp://example.com` → rejected with "Invalid URL"
5. `notaurl` (no dot) → rejected with "Invalid URL"
6. CSV with `example.com` (no protocol) → parsed correctly, counted in URL total, sent to API
7. CSV with `# comment` lines → silently skipped
8. CSV with header row `url` → silently skipped
9. SSRF checks still work: `127.0.0.1`, `localhost`, `192.168.1.1` → rejected after normalization

---

## Dependencies

None. Can be implemented independently before or after TS-005.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `normalizeUrl` imported in client bundle pulls in server-only deps | Inline the function in page.tsx with sync comment |
| Double-normalization in API if client already normalized | Idempotent by design — normalizing an already-normalized URL returns same value |
| Edge: user enters `http://` (empty host) | `new URL("http://")` throws → normalizeUrl returns null → rejected ✓ |
| Edge: IDN domains (punycode) | `new URL()` handles these natively — no special case needed |
