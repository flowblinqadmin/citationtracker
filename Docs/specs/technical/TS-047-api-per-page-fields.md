# TS-047: API Response — Include perPageResults, perPageFixes, implementationStatus for All Paid Audits

**Status:** Ready for ScriptDev
**Priority:** P0 (per-page data invisible after re-audit)
**Branch:** `feat/per-page-fixes`
**Scope:** 1 file

---

## Bug

After a re-audit completes, the "Pages" tab shows "Per-page fix data will be available after your next audit run" and Download ZIP stays greyed out — even though the data exists in the database.

The server-side render (`page.tsx:124-127`) correctly includes `perPageFixes`, `implementationStatus`, and `perPageResults` for all paid-tier audits. But the polling API endpoint (`GET /api/sites/[id]/route.ts`) does NOT:

- `perPageResults` — only returned for `auditMode === "bulk"` (line 121-122)
- `perPageFixes` — never returned
- `implementationStatus` — never returned
- `crawlData` extracted fields (`failedUrls`, `creditLimitedUrls`) — only returned for bulk (line 124-126)

After the audit re-runs, the client polls `/api/sites/[id]` which returns a site object missing these fields. The client state overwrites the initial server-rendered data with the incomplete poll response, so per-page data disappears.

## Fix

**`app/api/sites/[id]/route.ts` — lines 120-127:**

Replace the bulk-only block:
```typescript
      // Paid-only bulk fields
      if (site.auditMode === "bulk") {
        response.perPageResults = site.perPageResults ?? null;
        response.reportZipUrl = site.reportZipUrl ?? null;
        const crawlDataRaw = site.crawlData as { failedUrls?: string[]; creditLimitedUrls?: string[] } | null;
        response.failedUrls = crawlDataRaw?.failedUrls ?? [];
        response.creditLimitedUrls = crawlDataRaw?.creditLimitedUrls ?? [];
      }
```

With fields available for ALL paid-tier audits (matching `page.tsx:124-127`):
```typescript
      // Per-page data: available for all paid-tier completed audits (not just bulk)
      response.perPageResults = site.perPageResults ?? null;
      response.perPageFixes = site.perPageFixes ?? null;
      response.implementationStatus = site.implementationStatus ?? null;

      // Bulk-specific fields
      if (site.auditMode === "bulk") {
        response.reportZipUrl = site.reportZipUrl ?? null;
      }

      // crawlData extracted fields: available for all paid audits
      const crawlDataRaw = site.crawlData as { failedUrls?: string[]; creditLimitedUrls?: string[] } | null;
      response.failedUrls = crawlDataRaw?.failedUrls ?? [];
      response.creditLimitedUrls = crawlDataRaw?.creditLimitedUrls ?? [];
```

This ensures the polling API response matches the server-side render, so client state stays consistent after audit completion.

---

## Acceptance Criteria

1. `GET /api/sites/[id]` returns `perPageResults` for all paid-tier audits (single + bulk)
2. `GET /api/sites/[id]` returns `perPageFixes` for all paid-tier audits
3. `GET /api/sites/[id]` returns `implementationStatus` for all paid-tier audits
4. `GET /api/sites/[id]` returns `failedUrls` and `creditLimitedUrls` for all paid-tier audits
5. `reportZipUrl` remains bulk-only
6. Free-tier response unchanged (no per-page data leaked)
7. After re-audit completes, "Pages" tab shows data without requiring a hard refresh

## Bug 2: React key warning in PageByPageSection

`ResultsDashboard.tsx:600` — the `.map()` callback returns a `<>` fragment wrapping two `<tr>` elements (summary row + expanded detail row). The `key` prop is on the inner `<tr>` (line 601) instead of the outermost element. React requires the key on the element returned from `.map()`.

**Fix:** Change `<>` to `<Fragment key={fix.url}>` and remove `key={fix.url}` from the inner `<tr>` on line 601. Add `import { Fragment } from "react"` if not already imported (or use `React.Fragment`).

```typescript
// Line 599-601: change from:
return (
  <>
    <tr key={fix.url} ...>

// To:
return (
  <Fragment key={fix.url}>
    <tr ...>

// And line 612-614 (closing): change </> to </Fragment>
```

Also remove `key={...}` from the expanded `<tr>` on line 614 — it's no longer needed since the Fragment carries the key.

---

## Files to modify

| File | Change |
|------|--------|
| `app/api/sites/[id]/route.ts` | Move perPageResults/perPageFixes/implementationStatus/crawlData fields out of bulk-only block into paid-tier block |
| `app/sites/[id]/ResultsDashboard.tsx` | Line 600: `<>` → `<Fragment key={fix.url}>`, remove key from inner `<tr>` |

## Acceptance Criteria (added)

8. No React "key" warning in console when viewing PageByPageSection

## Testing

- Poll API as paid single audit with perPageResults → fields present in response
- Poll API as paid bulk audit → fields present + reportZipUrl present
- Poll API as free tier → no per-page fields in response
- View Pages tab with per-page data → no React key warnings in console
