# ES-071 — Dashboard: Download Guards, Failure Fallback, Pipeline Error Visibility

**Source:** TS-071-dashboard-download-guards-failure-visibility.md
**Priority:** P1 — live UX bugs (JSON file downloads, invisible failures)
**Scope:** 5 files modified, ~50 lines of implementation code

---

## a) Overview

Three related P1 issues on the portfolio dashboard (`/dashboard`):

1. **ZIP/PDF download buttons lack guards** — ZIP `<a download>` is always active (no status/data check). PDF only checks `citationRate !== null`. Both use `<a download>` which has zero error handling — server JSON error responses get saved as files (`download-report.json`, `pdf-report.json`).

2. **No fallback to last complete data** — Both download API routes hard-reject with 409 when `pipelineStatus !== "complete"`, even when the `geo_site_view` still has valid `overallScore` / `perPageResults` from a previous successful run. Re-running a failed audit blocks downloads.

3. **Pipeline failures invisible** — `pipelineError` is not in the dashboard query (page.tsx lines 137-150) and not displayed in `DomainTableRow.tsx`. Users have no indication when an audit fails.

### Current Implementation State

- **`app/dashboard/RowActions.tsx`** — Lines 161-174: ZIP is `<a download>`, no guard. Lines 177-208: PDF uses `hasCitations` toggle between `<a download>` and disabled button. `initialPipelineStatus` is a prop but aliased to `_initialPipelineStatus` (unused for guards). Tooltip + fetch patterns already exist for rerun/citation actions.

- **`app/dashboard/DomainTableRow.tsx`** — `liveStatus === "failed"` falls through to normal row (not scanning row). No error indicator, no "stale" badge. `row` interface has no `pipelineError` field.

- **`app/dashboard/page.tsx`** — Query (lines 137-150) selects from `geoSiteView` but does not include `pipelineError`. `DomainRow` type does not include it. Domain mapping (lines 167-185) does not pass it.

- **`app/api/sites/[id]/download-report/route.ts`** — Line 33: hard 409 if `pipelineStatus !== "complete"`. Then lines 38-40: `perPageResults.length === 0` → 404. Then lines 42-44: `!site.overallScore` → 404.

- **`app/api/sites/[id]/pdf-report/route.ts`** — Line 32: hard 409 if `pipelineStatus !== "complete"`. Then line 36: `!site.overallScore` → 404.

---

## b) Implementation Requirements

### Fix 1: Dashboard button guards + fetch error handling

**File:** `app/dashboard/RowActions.tsx`

#### 1a. Remove `_` prefix from `initialPipelineStatus`

Line 41: change `_initialPipelineStatus` to `initialPipelineStatus` (un-ignore it).

#### 1b. Add download state and helper

Add state:
```typescript
const [downloadTooltip, setDownloadTooltip] = useState<string | null>(null);
```

Add a `canDownload` derived boolean:
```typescript
const canDownload = initialPipelineStatus === "complete" || initialPipelineStatus === "failed";
```

#### 1c. Replace ZIP `<a download>` (lines 161-174) with `<button>` + fetch

```typescript
<div style={{ position: "relative" }}>
  <button
    onClick={canDownload ? handleDownloadZip : undefined}
    disabled={!canDownload}
    title={canDownload ? "Download ZIP" : "Audit in progress"}
    style={{
      ...btnStyle("zip"),
      opacity: canDownload ? 1 : 0.35,
      cursor: canDownload ? "pointer" : "not-allowed",
    }}
    onMouseEnter={() => setHovered("zip")}
    onMouseLeave={() => setHovered(null)}
  >
    {/* existing SVG */}
  </button>
  {downloadTooltip && tooltip(downloadTooltip)}
</div>
```

Add `handleDownloadZip`:
```typescript
async function handleDownloadZip() {
  try {
    const res = await fetch(`/api/sites/${siteId}/download-report?token=${accessToken ?? ""}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Download failed" }));
      setDownloadTooltip(data.error ?? "Download failed");
      setTimeout(() => setDownloadTooltip(null), 3000);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${siteId}-report.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    setDownloadTooltip("Download failed");
    setTimeout(() => setDownloadTooltip(null), 3000);
  }
}
```

#### 1d. Replace PDF `<a download>` (lines 177-208) with `<button>` + fetch

Guard condition: `hasCitations && canDownload`.

```typescript
<div style={{ position: "relative" }}>
  <button
    onClick={hasCitations && canDownload ? handleDownloadPdf : undefined}
    disabled={!hasCitations || !canDownload}
    title={!hasCitations ? "Run citation check first" : !canDownload ? "Audit in progress" : "Download PDF Report"}
    style={{
      ...btnStyle("report"),
      opacity: hasCitations && canDownload ? 1 : 0.35,
      cursor: hasCitations && canDownload ? "pointer" : "not-allowed",
    }}
    onMouseEnter={() => setHovered("report")}
    onMouseLeave={() => setHovered(null)}
  >
    {/* existing PDF SVG */}
  </button>
  {downloadTooltip && tooltip(downloadTooltip)}
</div>
```

Add `handleDownloadPdf`:
```typescript
async function handleDownloadPdf() {
  try {
    const res = await fetch(`/api/sites/${siteId}/pdf-report?token=${accessToken ?? ""}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Download failed" }));
      setDownloadTooltip(data.error ?? "Download failed");
      setTimeout(() => setDownloadTooltip(null), 3000);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${siteId}-report.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    setDownloadTooltip("Download failed");
    setTimeout(() => setDownloadTooltip(null), 3000);
  }
}
```

**Note:** The existing conditional render (`hasCitations ? <a> : <button disabled>`) is replaced with a single `<button>` that handles both guards (citations + pipeline status). This eliminates the code branch.

### Fix 2: API fallback — remove hard status check, check data instead

**File:** `app/api/sites/[id]/download-report/route.ts`

**Lines 33-35 — remove:**
```typescript
if (site.pipelineStatus !== "complete") {
  return NextResponse.json({ error: "Audit not yet complete." }, { status: 409 });
}
```

The existing checks below it (`perPageResults.length === 0` at line 38, `!site.overallScore` at line 42) already guard for missing data. If data exists from a prior successful run, serve it.

**File:** `app/api/sites/[id]/pdf-report/route.ts`

**Lines 32-34 — remove:**
```typescript
if (site.pipelineStatus !== "complete") {
  return NextResponse.json({ error: "Audit not yet complete." }, { status: 409 });
}
```

The existing `!site.overallScore` check (line 36) already guards for missing data.

### Fix 3: Pipeline failure visibility on dashboard

**File:** `app/dashboard/page.tsx`

**3a. Add `pipelineError` to query** (line 137-150):

Add after `citationRate: geoSiteView.citationRate,` (line 149):
```typescript
pipelineError: geoSiteView.pipelineError,
```

**3b. Add `pipelineError` to domain mapping** (line 170-184):

Add after `lastCrawlAt: r.lastCrawlAt?.toISOString() ?? null,`:
```typescript
pipelineError: r.pipelineError ?? null,
```

**3c. Update `DomainRow` type** to include `pipelineError: string | null`.

**File:** `app/dashboard/DomainTableRow.tsx`

**3d. Add `pipelineError` to the row interface** (line 41-54):

Add after `lastCrawlAt: string | null;`:
```typescript
pipelineError: string | null;
```

**3e. Render failed state in the normal row** (inside the non-scanning `<tr>`):

When `liveStatus === "failed"`:

- **Domain cell (line 213-232):** Below the page count subtitle, add a failure indicator:
  ```typescript
  {liveStatus === "failed" && (
    <div style={{ fontSize: 11, color: RED, fontWeight: 500 }} title={row.pipelineError ?? "Audit failed"}>
      Audit failed{row.pipelineError ? `: ${row.pipelineError.slice(0, 60)}` : ""}
    </div>
  )}
  ```

- **Score cell (line 236-248):** When `liveStatus === "failed"` AND `liveScore !== null` (data from prior run), show the score with a stale badge:
  ```typescript
  {liveStatus === "failed" && liveScore !== null && (
    <span style={{ fontSize: 9, color: T2, fontWeight: 500, marginLeft: 4 }} title="Score from last successful run">
      stale
    </span>
  )}
  ```

### Interfaces

No new types or API contracts. Only additions are:
- `pipelineError: string | null` added to the `DomainRow` type (page.tsx) and `DomainTableRowProps.row` interface (DomainTableRow.tsx).
- `downloadTooltip` state + `canDownload` derived bool in RowActions.

### Error Handling

- Download fetch errors → tooltip feedback, 3-second dismiss (same pattern as rerun/citation tooltips).
- API JSON parse fallback: `res.json().catch(() => ({ error: "Download failed" }))`.
- No new error states in the API routes — existing 404 checks are preserved.

### Performance

- Replacing `<a download>` with `fetch()` + blob URL: negligible overhead. Blob URL creation is instant.
- Adding `pipelineError` to the dashboard query: one more column from the existing `geoSiteView` — no cost.

---

## c) Unit Test Plan

**File:** `__tests__/dashboard-download-guards.test.tsx`

**Framework:** Vitest + React Testing Library

**Mock requirements:**
- Mock `fetch` for download endpoints + site API
- Mock `useRouter` from `next/navigation`
- Mock `URL.createObjectURL` / `URL.revokeObjectURL`
- Mock `document.createElement("a")` click behavior

### Test Cases

**T-071-1: ZIP button disabled when pipelineStatus is active**
- Render RowActions with `initialPipelineStatus: "crawling"`.
- Assert: ZIP button has `disabled` attribute, `opacity: 0.35`, `cursor: "not-allowed"`.
- Assert: `title` is "Audit in progress".

**T-071-2: ZIP button enabled when pipelineStatus is "complete"**
- Render RowActions with `initialPipelineStatus: "complete"`.
- Assert: ZIP button is not disabled, `opacity: 1`.
- Click button → assert `fetch` called with `/api/sites/:id/download-report?token=...`.

**T-071-3: ZIP button enabled when pipelineStatus is "failed" (prior run data)**
- Render RowActions with `initialPipelineStatus: "failed"`.
- Assert: ZIP button is not disabled.
- Click → fetch called.

**T-071-4: ZIP button disabled when pipelineStatus is "failed" and no overallScore**
- This is handled server-side (API returns 404). Client-side button is enabled for "failed" status.
- Click → mock fetch returns 404 with `{ error: "Scorecard not yet available." }`.
- Assert: tooltip shows "Scorecard not yet available."

**T-071-5: PDF button disabled when citationRate is null**
- Render RowActions with `citationRate: null`, `initialPipelineStatus: "complete"`.
- Assert: PDF button disabled, `title` is "Run citation check first".

**T-071-6: PDF button disabled when pipelineStatus is active even with citationRate**
- Render RowActions with `citationRate: 45`, `initialPipelineStatus: "analyzing"`.
- Assert: PDF button disabled, `title` is "Audit in progress".

**T-071-7: PDF button enabled when complete + citationRate**
- Render RowActions with `citationRate: 45`, `initialPipelineStatus: "complete"`.
- Assert: PDF button enabled. Click → fetch called with pdf-report URL.

**T-071-8: PDF button enabled when failed + citationRate**
- Render RowActions with `citationRate: 45`, `initialPipelineStatus: "failed"`.
- Assert: PDF button enabled.

**T-071-9: Successful ZIP fetch creates blob URL and triggers download**
- Click active ZIP button. Mock fetch returns `ok: true` with blob.
- Assert: `URL.createObjectURL` called. `<a>` element created with `.download` = `{siteId}-report.zip`. `a.click()` called. `URL.revokeObjectURL` called.

**T-071-10: Failed fetch shows tooltip error, no file download**
- Click active ZIP button. Mock fetch returns `{ ok: false, status: 404, json: { error: "No per-page results available." } }`.
- Assert: tooltip with "No per-page results available." appears.
- Assert: `URL.createObjectURL` NOT called.

**T-071-11: Failed pipeline row shows error indicator**
- Render DomainTableRow with `row.pipelineStatus: "failed"`, `row.pipelineError: "Firecrawl timeout after 300s"`.
- Assert: "Audit failed: Firecrawl timeout after 300s" visible in the DOM.
- Assert: Text color is RED (`#ff3b30`).

**T-071-12: Failed pipeline row with score shows stale badge**
- Render DomainTableRow with `row.pipelineStatus: "failed"`, `row.overallScore: 72`.
- Assert: Score "72" renders normally.
- Assert: "stale" badge visible next to score.

**Minimum coverage:** 100% of new/modified code.

---

## d) Integration Test Plan

**File:** `__tests__/dashboard-download-guards.integration.test.ts`

### Scenarios

**IT-071-1: download-report returns ZIP when status=failed but data exists**
- Setup: site with `pipelineStatus: "failed"`, `overallScore: 65`, `perPageResults: [...]`.
- `GET /api/sites/:id/download-report?token=TOKEN`.
- Assert: response `status: 200`, `Content-Type: application/zip`.

**IT-071-2: download-report returns 404 when status=failed and no data**
- Setup: site with `pipelineStatus: "failed"`, `overallScore: null`, `perPageResults: []`.
- `GET /api/sites/:id/download-report?token=TOKEN`.
- Assert: response `status: 404`, body contains `"No per-page results available."` or `"Scorecard not yet available."`.

**IT-071-3: pdf-report returns PDF when status=failed but score+citation exist**
- Setup: site with `pipelineStatus: "failed"`, `overallScore: 65`, citation scores in DB.
- `GET /api/sites/:id/pdf-report?token=TOKEN`.
- Assert: response `status: 200`, `Content-Type: application/pdf`.

**IT-071-4: pdf-report returns 404 when no score exists**
- Setup: site with `pipelineStatus: "failed"`, `overallScore: null`.
- `GET /api/sites/:id/pdf-report?token=TOKEN`.
- Assert: response `status: 404`, body contains `"Scorecard not yet available."`.

---

## e) Profiling Requirements

Not applicable — no new computation paths. Downloads already exist; this only changes guards and error handling.

---

## f) Load Test Plan

Not applicable — no new endpoints or processing. Download frequency is low (user-initiated, one at a time).

---

## g) Logging & Instrumentation

No new logging required. Existing API route error responses (401, 402, 404) already return structured JSON. The client-side tooltip displays the error message from the JSON body.

---

## h) Acceptance Criteria

| # | Criterion | Section |
|---|-----------|---------|
| AC-1 | ZIP button disabled (greyed out, `cursor: not-allowed`) when pipelineStatus is active (queued/discovery/crawling/etc.) with tooltip "Audit in progress" | §b Fix 1c |
| AC-2 | ZIP button enabled when pipelineStatus is "complete" — click downloads ZIP | §b Fix 1c |
| AC-3 | ZIP button enabled when pipelineStatus is "failed" and data exists — click downloads from last complete data | §b Fix 1c + Fix 2 |
| AC-4 | PDF button disabled when citationRate is null with tooltip "Run citation check first" | §b Fix 1d |
| AC-5 | PDF button disabled when pipelineStatus is active even with citationRate, tooltip "Audit in progress" | §b Fix 1d |
| AC-6 | PDF button enabled when complete + citationRate — click downloads PDF | §b Fix 1d |
| AC-7 | PDF button enabled when failed + citationRate + overallScore — click downloads PDF | §b Fix 1d + Fix 2 |
| AC-8 | Clicking disabled buttons does nothing (no download attempt, no file) | §b Fix 1c/1d |
| AC-9 | Failed download shows tooltip error (3s dismiss), no JSON file downloaded | §b Fix 1c/1d |
| AC-10 | `GET /api/sites/:id/download-report` returns ZIP when `overallScore` + `perPageResults` exist, even if `pipelineStatus === "failed"` | §b Fix 2 |
| AC-11 | `GET /api/sites/:id/download-report` returns 404 when no data (not 409) | §b Fix 2 |
| AC-12 | `GET /api/sites/:id/pdf-report` returns PDF when `overallScore` exists, even if `pipelineStatus === "failed"` | §b Fix 2 |
| AC-13 | Dashboard row shows red "Audit failed" text when `pipelineStatus === "failed"` with truncated error (60 chars) | §b Fix 3e |
| AC-14 | Dashboard row shows "stale" badge next to score when `pipelineStatus === "failed"` and score exists | §b Fix 3e |
| AC-15 | T-071-1 through T-071-12 unit tests pass | §c |
| AC-16 | IT-071-1 through IT-071-4 integration tests pass | §d |
| AC-17 | `docker build -f Dockerfile.test -t geo-test . && docker run --rm geo-test` passes with all existing + new tests | §c |
| AC-18 | No new packages or schema changes introduced | TS-071 §Dependencies |

---

## ScriptDev Notes

1. **RowActions.tsx** — The existing `rerunTooltip` / `citationTooltip` pattern is the model for `downloadTooltip`. Both download handlers share the same tooltip state (only one download happens at a time). Remove the entire conditional render block for PDF (lines 177-208) and replace with a single unified `<button>`. The ZIP SVG and PDF SVG remain unchanged.
2. **DomainTableRow.tsx** — The failure indicator goes in the domain cell of the normal row (not the scanning row). When `liveStatus === "failed"`, the scanning row won't render (it requires `isActiveStatus()`), so the normal row handles it. The `liveStatus` state already tracks pipeline status via polling.
3. **API routes** — Literally remove lines 33-35 from both routes. Three lines deleted total. The existing data checks below are sufficient.
4. **page.tsx** — One line added to query SELECT, one line added to domain mapping, one field added to DomainRow type. Check if `geoSiteView.pipelineError` exists in the Drizzle schema — it should be in the view definition.
5. **`useRouter`** — Still needed in RowActions for `router.refresh()` in citation handler. Do not remove.
