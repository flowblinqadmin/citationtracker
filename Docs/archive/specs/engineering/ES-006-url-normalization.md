# ES-006: Smart URL Normalization

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `2bad500`  

---

**Source:** TS-006-url-normalization.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-28
**Priority:** HIGH — production bug causing submission failures
**Branch:** `dev-an-m2-extended`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)
**Lang:** TypeScript / Next.js

---

## a) Overview

### What This Covers

Add a `normalizeUrl()` utility to `geo/lib/utils.ts` and apply it in three call sites:

1. **`geo/app/api/sites/route.ts`** — server-side single-URL flow (replace bare `new URL(url)` call)
2. **`geo/app/api/sites/route.ts`** — server-side bulk-URL SSRF validation loop
3. **`geo/app/page.tsx`** — client-side CSV parser (`handleCsvUpload`)
4. **`geo/app/page.tsx`** — client-side single URL submit (`handleSubmit`)

Additionally, update the URL input placeholder text.

### Reference

Source technical spec: `.agents/specs/technical/TS-006-url-normalization.md`

### Current Implementation State

**`geo/lib/utils.ts` (54 lines — exists):**
Contains `cn()`, `normalizeDomain()`, `slugify()`, and `isValidUrl()`. `normalizeDomain()` already
prepends `https://` before parsing — this precedent confirms the pattern is safe. `normalizeUrl()`
does not exist yet.

**`geo/app/api/sites/route.ts` — single-URL flow (lines 117-125):**
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
`new URL("example.com")` throws — users who omit `https://` get a 400.

**`geo/app/api/sites/route.ts` — bulk-URL SSRF validation loop (lines 41-48):**
```typescript
for (const u of bulkUrls) {
  if (typeof u !== "string") { invalidUrls.push(String(u)); continue; }
  try {
    const parsed = new URL(u);
    if (!["http:", "https:"].includes(parsed.protocol)) { invalidUrls.push(u); continue; }
    if (privateRanges.some((r) => r.test(parsed.hostname))) { invalidUrls.push(u); }
  } catch { invalidUrls.push(u); }
}
```
Same problem — `new URL("example.com")` throws, entire CSV is rejected.

**`geo/app/page.tsx` — CSV parser `handleCsvUpload` (lines 52-57):**
```typescript
try {
  const parsed = new URL(firstCol);
  if (["http:", "https:"].includes(parsed.protocol)) {
    urls.push(firstCol);
  }
} catch { /* skip non-URL lines */ }
```
`example.com` silently dropped — CSV appears to parse but sends 0 valid URLs.

**`geo/app/page.tsx` — single URL submit `handleSubmit` (lines 115-117):**
```typescript
const body = csvUrls.length > 0
  ? { email: email.trim(), bulkUrls: csvUrls }
  : { url: url.trim(), email: email.trim() };
```
`url.trim()` sent raw — no normalization before POST.

**`geo/app/page.tsx` — URL input field (line 180):**
```tsx
placeholder={csvUrls.length > 0 ? "URL disabled — using CSV upload" : "https://yourwebsite.com"}
```
Placeholder is conditional but the active value implies protocol is required.

---

## b) Implementation Requirements

### Change 1: Add `normalizeUrl()` to `geo/lib/utils.ts`

Append to the existing file. Do not create a new module.

#### Function contract

```typescript
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
export function normalizeUrl(input: string): string | null
```

#### Implementation logic

```typescript
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

#### Key invariants

- Output is always `new URL()`-parseable, or null — callers can safely do `new URL(normalizeUrl(x)!)`
- SSRF checks are applied by the caller after normalization — `normalizeUrl` does not check private ranges
- Does not strip trailing slashes or modify paths — minimal intervention
- Double-normalization is idempotent: `normalizeUrl(normalizeUrl("example.com")!)` → `"https://example.com"`

### Change 2: `geo/app/api/sites/route.ts` — single-URL flow

**Add import at top of file:**
```typescript
import { normalizeDomain, slugify, normalizeUrl } from "@/lib/utils";
```
(Add `normalizeUrl` to the existing import — `normalizeDomain` and `slugify` are already imported.)

**Replace lines 117-125:**

Before:
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

After:
```typescript
const normalizedUrl = normalizeUrl(url);
if (!normalizedUrl) {
  return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
}
const parsedUrl = new URL(normalizedUrl); // safe — normalizeUrl guarantees parseable
```

**Then use `normalizedUrl` (not the raw `url`) for `normalizeDomain()`:**

Line 154 currently reads `const domain = normalizeDomain(url);` — change to:
```typescript
const domain = normalizeDomain(normalizedUrl);
```

### Change 3: `geo/app/api/sites/route.ts` — bulk-URL flow

**Replace the SSRF validation loop and `uniqueUrls` construction.**

The current code has two separate blocks: the validation loop (lines 41-48) that populates
`invalidUrls`, and the `uniqueUrls` dedup (line 56). Replace both with a single normalized-URL
pass that avoids duplicating logic.

**Replace lines 41-56 (validation loop + uniqueUrls construction):**

Before:
```typescript
const invalidUrls: string[] = [];
for (const u of bulkUrls) {
  if (typeof u !== "string") { invalidUrls.push(String(u)); continue; }
  try {
    const parsed = new URL(u);
    if (!["http:", "https:"].includes(parsed.protocol)) { invalidUrls.push(u); continue; }
    if (privateRanges.some((r) => r.test(parsed.hostname))) { invalidUrls.push(u); }
  } catch { invalidUrls.push(u); }
}
if (invalidUrls.length > 0) {
  return NextResponse.json(
    { error: `${invalidUrls.length} invalid URL(s) in CSV. All URLs must be valid HTTP/HTTPS addresses.` },
    { status: 400 }
  );
}

const uniqueUrls = [...new Set(bulkUrls as string[])];
```

After:
```typescript
const invalidUrls: string[] = [];
const validNormalizedUrls: string[] = [];
for (const u of bulkUrls) {
  if (typeof u !== "string") { invalidUrls.push(String(u)); continue; }
  const normalized = normalizeUrl(u);
  if (!normalized) { invalidUrls.push(u); continue; }
  const parsed = new URL(normalized); // safe — normalizeUrl guarantees parseable
  if (privateRanges.some((r) => r.test(parsed.hostname))) {
    invalidUrls.push(u);
    continue;
  }
  validNormalizedUrls.push(normalized);
}
if (invalidUrls.length > 0) {
  return NextResponse.json(
    { error: `${invalidUrls.length} invalid URL(s) in CSV. All URLs must be valid HTTP/HTTPS addresses.` },
    { status: 400 }
  );
}

const uniqueUrls = [...new Set(validNormalizedUrls)];
```

Note: The domain extraction on line 80 (`const firstDomain = new URL(uniqueUrls[0]).hostname...`)
is safe after this change because `validNormalizedUrls` contains only parseable normalized URLs.

### Change 4: `geo/app/page.tsx` — CSV parser

The function currently imports nothing from `@/lib/utils`. Check whether importing `normalizeUrl`
from `@/lib/utils` would pull server-only dependencies into the client bundle.

**Decision rule:**
- If `geo/lib/utils.ts` has no server-only imports (it currently only imports `clsx` and
  `tailwind-merge` — both are safe for client bundles): import `normalizeUrl` from `"@/lib/utils"`.
- If a future server-only dep is added to utils.ts and Next.js errors on client import: inline
  `normalizeUrl` directly in `page.tsx` with comment `// duplicated from lib/utils.ts — keep in sync`.

Current state: `utils.ts` imports only `clsx` and `tailwind-merge`. **Import from `@/lib/utils`.**

**Add to page.tsx imports:**
```typescript
import { normalizeUrl } from "@/lib/utils";
```

**Replace lines 52-57 in `handleCsvUpload`:**

Before:
```typescript
try {
  const parsed = new URL(firstCol);
  if (["http:", "https:"].includes(parsed.protocol)) {
    urls.push(firstCol);
  }
} catch { /* skip non-URL lines */ }
```

After:
```typescript
const normalized = normalizeUrl(firstCol);
if (normalized) urls.push(normalized);
```

This correctly handles:
- `# comment lines` → `normalizeUrl` returns null (no dot) → skipped
- `url` (header row) → no dot → null → skipped
- `example.com` → `"https://example.com"` → added
- `www.example.com` → `"https://www.example.com"` → added
- `https://example.com` → unchanged → added
- Empty lines filtered by `.filter(Boolean)` before the loop reaches this code

### Change 5: `geo/app/page.tsx` — single URL submit normalization

In `handleSubmit`, normalize before constructing the request body.

**Replace lines 115-117:**

Before:
```typescript
const body = csvUrls.length > 0
  ? { email: email.trim(), bulkUrls: csvUrls }
  : { url: url.trim(), email: email.trim() };
```

After:
```typescript
let body: { email: string; bulkUrls?: string[]; url?: string };
if (csvUrls.length > 0) {
  body = { email: email.trim(), bulkUrls: csvUrls };
} else {
  const normalizedSingleUrl = normalizeUrl(url.trim());
  if (!normalizedSingleUrl) {
    toast.error("Please enter a valid website URL (e.g. example.com)");
    setLoading(false);
    return;
  }
  body = { url: normalizedSingleUrl, email: email.trim() };
}
```

Note: `setLoading(false)` must be called before the early return since we are inside the
`try` block after `setLoading(true)`.

### Change 6: `geo/app/page.tsx` — URL input placeholder text

**Replace the placeholder in the `<input>` element (line ~180):**

Before:
```tsx
placeholder={csvUrls.length > 0 ? "URL disabled — using CSV upload" : "https://yourwebsite.com"}
```

After:
```tsx
placeholder={csvUrls.length > 0 ? "URL disabled — using CSV upload" : "e.g. example.com or www.example.com"}
```

Also change `type="url"` to `type="text"` on this input. The `type="url"` attribute causes
browsers to validate the field natively and reject bare domains before the form even submits,
undermining the normalization. `type="text"` delegates validation to our `normalizeUrl()`.

---

## c) Unit Test Plan

**Test file:** `geo/lib/utils.test.ts` (NEW, or append to existing if present)
**Framework:** Vitest

### Suite 1: `normalizeUrl()` — valid inputs return normalized URL

| Input | Expected output |
|-------|-----------------|
| `"https://example.com"` | `"https://example.com"` |
| `"http://example.com"` | `"http://example.com"` |
| `"HTTPS://EXAMPLE.COM"` | `"HTTPS://EXAMPLE.COM"` (case-preserved by URL constructor) |
| `"www.example.com"` | `"https://www.example.com"` |
| `"example.com"` | `"https://example.com"` |
| `"example.com/about"` | `"https://example.com/about"` |
| `"example.com/path?q=1"` | `"https://example.com/path?q=1"` |
| `"sub.example.co.uk/page"` | `"https://sub.example.co.uk/page"` |
| `"  example.com  "` (whitespace) | `"https://example.com"` (trimmed) |
| `"https://example.com/path#anchor"` | `"https://example.com/path#anchor"` |
| `"https://user:pass@example.com"` | `"https://user:pass@example.com"` |
| `"example.com:8080"` | `"https://example.com:8080"` |

### Suite 2: `normalizeUrl()` — invalid inputs return null

| Input | Expected | Reason |
|-------|----------|--------|
| `""` | `null` | Empty |
| `"   "` | `null` | Whitespace only |
| `"notaurl"` | `null` | No dot in hostname |
| `"ftp://example.com"` | `null` | Non-HTTP protocol |
| `"file:///etc/passwd"` | `null` | Non-HTTP protocol |
| `"javascript:alert(1)"` | `null` | Non-HTTP protocol |
| `"http://"` | `null` | Empty host (URL() throws) |
| `"https://"` | `null` | Empty host |
| `"//example.com"` | `null` | Protocol-relative — matched by non-HTTP protocol check (`:` absent, but `//` prefix: test what actually happens — `new URL("https:////example.com")` may parse) |

Note on `"//example.com"`: `new URL("https:////example.com")` may parse with hostname `""` or
throw. Test empirically and document the actual behavior in the test.

### Suite 3: `normalizeUrl()` — idempotency

| Input | Expected |
|-------|----------|
| `normalizeUrl(normalizeUrl("example.com")!)` | `"https://example.com"` |
| `normalizeUrl(normalizeUrl("https://example.com")!)` | `"https://example.com"` |

### Suite 4: `normalizeUrl()` — SSRF-relevant inputs (normalized but not blocked by this function)

These inputs normalize to a value — SSRF blocking is the caller's responsibility:

| Input | Expected output | SSRF check (caller's job) |
|-------|-----------------|---------------------------|
| `"localhost"` | `null` (no dot) | N/A — already null |
| `"127.0.0.1"` | `null` (no dot) | N/A — already null |
| `"https://127.0.0.1"` | `"https://127.0.0.1"` | Caller must block |
| `"https://192.168.1.1"` | `"https://192.168.1.1"` | Caller must block |
| `"192.168.1.1"` | `"https://192.168.1.1"` | Caller must block |
| `"10.0.0.1"` | `null` (no dot — wait, 10.0.0.1 has dots) → `"https://10.0.0.1"` | Caller must block |

Note: `"10.0.0.1"` has dots and will parse — it normalizes to `"https://10.0.0.1"`. The caller's
SSRF regex `^10\.` will block it. This is the correct two-layer design.

### Suite 5: Integration — `normalizeUrl` + SSRF validation (combined)

Replicate the server-side validation logic (including privateRanges) and test the combined flow:

| Input | Expected result |
|-------|-----------------|
| `"example.com"` | valid → `"https://example.com"` |
| `"192.168.1.1"` | normalizes → SSRF blocked → invalid |
| `"10.0.0.1"` | normalizes → SSRF blocked → invalid |
| `"localhost"` | null from normalizeUrl → invalid (no dot) |
| `"ftp://example.com"` | null → invalid |
| `"https://example.com"` | valid → unchanged |

### Coverage target

90% line coverage on `normalizeUrl()` in `geo/lib/utils.ts`.

---

## d) Integration Test Plan

**Test file:** `geo/app/api/sites/normalize-url-integration.test.ts` (NEW, Vitest)

Test the actual `POST /api/sites` route handler end-to-end with a mocked database and email
service, verifying normalization behavior at the API boundary.

### Scenario 1: Single-URL flow — bare domain accepted

1. POST `{ url: "example.com", email: "test@example.com" }` to handler.
2. Assert: response is 201 (not 400).
3. Assert: `db.insert` was called with `domain: "example.com"` (normalizeDomain strips www, etc.).

### Scenario 2: Single-URL flow — www prefix accepted

1. POST `{ url: "www.example.com", email: "test@example.com" }`.
2. Assert: 201. Domain stored as `"example.com"` (www stripped by `normalizeDomain`).

### Scenario 3: Single-URL flow — ftp:// still rejected

1. POST `{ url: "ftp://example.com", email: "test@example.com" }`.
2. Assert: 400, `{ error: "Invalid URL" }`.

### Scenario 4: Single-URL flow — private IP still rejected after normalization

1. POST `{ url: "192.168.1.1", email: "test@example.com" }`.
2. Assert: 400, `{ error: "Invalid URL" }`.

### Scenario 5: Bulk-URL flow — mixed protocol/bare domain CSV

1. POST `{ bulkUrls: ["https://example.com", "example2.com", "www.example3.com"], email: "test@example.com" }`.
2. Assert: 201 (all 3 valid after normalization).
3. Assert: `db.insert` called with `bulkUrls` containing `["https://example.com", "https://example2.com", "https://www.example3.com"]`.

### Scenario 6: Bulk-URL flow — one invalid URL fails the batch

1. POST `{ bulkUrls: ["https://example.com", "ftp://bad.com"], email: "test@example.com" }`.
2. Assert: 400, error mentions `1 invalid URL(s)`.

### Scenario 7: Bulk-URL flow — private IP in CSV is still blocked

1. POST `{ bulkUrls: ["https://example.com", "192.168.1.1"], email: "test@example.com" }`.
2. Assert: 400 (private IP blocked after normalization).

---

## e) Profiling Requirements

`normalizeUrl()` is a synchronous pure function. No async I/O.

### What to Measure

- Execution time for a single `normalizeUrl()` call.
- Memory: no concern (pure string operations, no closures or allocations beyond the return value).

### Baseline Expectations

- Single call: < 0.1ms (synchronous regex + URL constructor).
- Bulk: 500 calls (max CSV) < 10ms total.

### Profiling Approach

Use `performance.now()` in a Vitest benchmark or a simple timing loop:

```typescript
const start = performance.now();
for (let i = 0; i < 500; i++) normalizeUrl("example.com");
console.log(`500 calls: ${performance.now() - start}ms`);
```

No dedicated profiling tooling required — this is a trivial utility.

---

## f) Load Test Plan

`normalizeUrl()` is called synchronously within the existing `POST /api/sites` handler. The load
profile for this route is unchanged — no new endpoints are added.

Existing load test targets (`POST /api/sites`) implicitly cover this change. No new load test
scenarios are required.

If desired, verify that `POST /api/sites` p95 latency does not increase after this change (it
should not — `normalizeUrl` is microseconds).

---

## g) Logging & Instrumentation

No new logging is required for the `normalizeUrl()` utility itself.

The existing structured log in `route.ts` (`event: "bulk_submit"`) already captures `urlCount`.
After this change, `urlCount` reflects normalized, deduplicated URLs — no change to log schema.

**Optional:** If future debugging of malformed URL submissions is needed, log at DEBUG level:

```typescript
console.log(JSON.stringify({
  event: "url_normalization",
  raw: u,
  normalized: normalized ?? "null",
}));
```

Only add this if actively debugging. Do not add it to production code by default.

---

## h) Acceptance Criteria

- [ ] `normalizeUrl("example.com")` returns `"https://example.com"`
- [ ] `normalizeUrl("www.example.com")` returns `"https://www.example.com"`
- [ ] `normalizeUrl("https://example.com")` returns `"https://example.com"` (unchanged)
- [ ] `normalizeUrl("ftp://example.com")` returns `null`
- [ ] `normalizeUrl("notaurl")` returns `null` (no dot)
- [ ] `POST /api/sites { url: "example.com", email: "..." }` returns 201 (not 400)
- [ ] `POST /api/sites { url: "www.example.com", email: "..." }` returns 201
- [ ] `POST /api/sites { url: "ftp://example.com", email: "..." }` returns 400
- [ ] `POST /api/sites { url: "127.0.0.1", email: "..." }` returns 400 (SSRF still blocked)
- [ ] `POST /api/sites { url: "192.168.1.1", email: "..." }` returns 400 (normalizes, then SSRF blocked)
- [ ] Bulk POST with `["example.com", "www.example2.com"]` returns 201 (both normalized)
- [ ] Bulk POST with `["ftp://bad.com"]` returns 400
- [ ] CSV with `example.com` (no protocol) is parsed correctly on landing page: URL count shows 1
- [ ] CSV header row `url` is silently skipped (no dot → null → not counted)
- [ ] CSV comment line `# my sites` is silently skipped
- [ ] Single URL input on landing page: typing `example.com` and submitting starts the pipeline
- [ ] Input field placeholder updated to `e.g. example.com or www.example.com`
- [ ] Input field changed from `type="url"` to `type="text"`
- [ ] Unit tests pass: 90%+ line coverage on `normalizeUrl()`
- [ ] No change to SSRF protection — all private IP ranges still rejected after normalization
