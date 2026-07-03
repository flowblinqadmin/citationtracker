# TS-071 — Dashboard: Download Guards, Failure Fallback, Pipeline Error Visibility

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-30
**Priority:** P1 — live UX bugs (downloads produce JSON files, failures invisible)
**Scope:** `app/dashboard/RowActions.tsx`, `app/dashboard/DomainTableRow.tsx`, `app/dashboard/page.tsx`, `app/api/sites/[id]/download-report/route.ts`, `app/api/sites/[id]/pdf-report/route.ts`

---

## What

Three related issues on the portfolio dashboard (`/dashboard`):

1. **ZIP/PDF buttons lack proper guards** — ZIP download is always active (no status check). PDF button only checks `citationRate !== null` but not pipeline completion. Both use `<a download>` which has no error handling — server JSON error responses get saved as `download-report.json` / `pdf-report.json` ("Site wasn't available").

2. **No fallback to last complete data** — When a re-run fails (`pipelineStatus: "failed"`), the `geo_site_view` still has valid `overallScore`, `perPageResults`, etc. from the previous successful run. But both download API routes hard-reject with 409 if `pipelineStatus !== "complete"`. Downloads should work if the data exists, regardless of current pipeline status.

3. **Pipeline failures invisible** — `pipelineError` is not queried by the dashboard page and not displayed anywhere. When an audit fails, the user sees no indication — the row just sits there with no score or a stale score.

---

## Why

- Users click download buttons and get mysterious `pdf-report.json` / `download-report.json` files
- Failed audits produce no user-visible feedback — the user doesn't know something went wrong
- Re-running a failed audit means the user loses access to downloads from their previous successful run

---

## Root Cause Analysis

### Issue 1: Download button guards

**File:** `app/dashboard/RowActions.tsx`

- Lines 161-174: ZIP `<a download>` — no guard at all, always active
- Lines 177-208: PDF — guards on `hasCitations` only (line 42: `citationRate !== null`)
- Neither checks `pipelineStatus === "complete"` or data availability
- `<a download>` has zero error handling — browser saves any response body as a file

### Issue 2: Hard 409 on non-complete status

**File:** `app/api/sites/[id]/download-report/route.ts` line 33:
```typescript
if (site.pipelineStatus !== "complete") {
  return NextResponse.json({ error: "Audit not yet complete." }, { status: 409 });
}
```

**File:** `app/api/sites/[id]/pdf-report/route.ts` line 32:
Same check. Both reject even when `overallScore` and `perPageResults` exist from a previous run.

### Issue 3: Missing error display

**File:** `app/dashboard/page.tsx` — `geoSiteView.pipelineError` is not in the SELECT query (line 137-153).
**File:** `app/dashboard/DomainTableRow.tsx` — No mention of "failed" or error rendering.

---

## Fix Specification

### Fix 1: Dashboard button guards + fetch error handling

**File:** `app/dashboard/RowActions.tsx`

Add `pipelineStatus` prop to RowActionsProps (already passed as `initialPipelineStatus` but unused for guards).

**ZIP button (lines 161-174):** Replace `<a download>` with a `<button>` that uses `fetch()`:
- Guard: disabled unless `pipelineStatus === "complete"` OR `pipelineStatus === "failed"` (failed can still have data from prior run)
- On click: `fetch()` the ZIP endpoint, check `res.ok`, create blob URL, trigger download
- On error: show tooltip with error message (same pattern as rerun/citation tooltips)

**PDF button (lines 177-208):** Replace `<a download>` with `<button>` + `fetch()`:
- Guard: disabled unless `hasCitations` AND (`pipelineStatus === "complete"` OR `pipelineStatus === "failed"`)
- On click: `fetch()` the PDF endpoint, check `res.ok`, create blob URL, trigger download
- On error: show tooltip with error message

Both buttons should show `opacity: 0.35` and `cursor: "not-allowed"` when disabled, with appropriate title tooltips.

### Fix 2: API fallback — remove hard status check, check data instead

**File:** `app/api/sites/[id]/download-report/route.ts` line 33

Replace:
```typescript
if (site.pipelineStatus !== "complete") {
  return NextResponse.json({ error: "Audit not yet complete." }, { status: 409 });
}
```

With:
```typescript
if (!site.overallScore) {
  return NextResponse.json({ error: "No completed audit data available." }, { status: 404 });
}
```

The subsequent `perPageResults.length === 0` check (line 38) already handles missing page data. Remove the status check entirely — if the data exists, serve it.

**File:** `app/api/sites/[id]/pdf-report/route.ts` line 32

Same change — remove `pipelineStatus !== "complete"` check. Keep `!site.overallScore` check (line 36).

### Fix 3: Pipeline failure visibility on dashboard

**File:** `app/dashboard/page.tsx`

Add `pipelineError` to the dashboard query (line 137-153):
```typescript
pipelineError: geoSiteView.pipelineError,
```

Pass it through to `DomainRow` type and `DomainTableRow` component.

**File:** `app/dashboard/DomainTableRow.tsx`

When `liveStatus === "failed"`:
- Show a **blinking red dot** (10px, same size as the green active dot, `animation: pulse 1.5s ease-in-out infinite` using RED `#ff3b30`)
- Tooltip on hover: `"Audit failed: {first 60 chars of pipelineError}. Credits have been refunded."`
- **On click**: trigger re-run audit (same as the existing re-run button in RowActions — call `handleRerunAudit()`)
- The red dot acts as a CTA to restart the audit

When `liveStatus === "failed"` AND `overallScore` exists (previous run data):
- Show the score normally (it's from the last successful run)
- Add a small text label below or beside the score: "Last successful run" in T3 color, font-size 10px
- Downloads (ZIP/PDF) serve data from this last successful run

---

## Files Changed

| File | Change |
|------|--------|
| `app/dashboard/RowActions.tsx` | Replace `<a download>` with `<button>` + fetch, add guards |
| `app/dashboard/DomainTableRow.tsx` | Add failed state rendering, error display |
| `app/dashboard/page.tsx` | Add `pipelineError` to query + DomainRow type |
| `app/api/sites/[id]/download-report/route.ts` | Remove status check, keep data check |
| `app/api/sites/[id]/pdf-report/route.ts` | Remove status check, keep data check |

---

## Dependencies

- None. All changes are to existing files. No new packages or schema changes.

---

## Acceptance Criteria

### AC-1: ZIP button disabled for in-progress audits
- When `pipelineStatus` is active (queued/discovery/crawling/etc.), ZIP button is greyed out with tooltip "Audit in progress"

### AC-2: ZIP button enabled for complete and failed-with-data audits
- When `pipelineStatus === "complete"`, ZIP button is active and downloads the ZIP
- When `pipelineStatus === "failed"` but `overallScore` exists, ZIP button is active and downloads from last complete data

### AC-3: PDF button disabled without citation check
- When `citationRate` is null, PDF button is greyed out with tooltip "Run citation check first"

### AC-4: PDF button disabled for in-progress audits even with citation rate
- When re-running an audit (status active) but old citation rate exists, PDF button is greyed out with tooltip "Audit in progress"

### AC-5: PDF button enabled for failed-with-data audits that had citation check
- When `pipelineStatus === "failed"` but `citationRate` is set and `overallScore` exists, PDF button works

### AC-6: No JSON file downloads
- Clicking disabled buttons does nothing (no download attempt)
- Clicking active buttons that fail shows a tooltip error, not a file download

### AC-7: Download API serves last complete data regardless of status
- `GET /api/sites/:id/download-report` returns ZIP if `overallScore` and `perPageResults` exist, even when `pipelineStatus === "failed"`
- `GET /api/sites/:id/pdf-report` returns PDF if `overallScore` exists, even when `pipelineStatus === "failed"`

### AC-8: Failed pipeline shows blinking red dot with restart CTA
- Dashboard row shows blinking red dot (pulse animation) when `pipelineStatus === "failed"`
- Hover tooltip: `"Audit failed: {error}. Credits have been refunded."`
- Clicking the red dot triggers audit re-run (same as re-run button)
- If score exists from prior run, score still displays with "Last successful run" label (T3 color, 10px)

### AC-9: Docker CI passes
- All existing + new tests pass in `docker build -f Dockerfile.test && docker run --rm geo-test`

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Stale data misleads user after failed re-run | Low | "Stale" badge makes it clear data is from previous run |
| fetch() for downloads slower than `<a download>` | Low | Negligible — blob URL creation is instant |
| Failed audits showing old score could confuse | Low | Red warning + "Last successful run" label disambiguates |

---

## Test Plan

### Unit Tests

**T-071-1:** ZIP button disabled when pipelineStatus is active
**T-071-2:** ZIP button enabled when pipelineStatus is "complete"
**T-071-3:** ZIP button enabled when pipelineStatus is "failed" with overallScore
**T-071-4:** ZIP button disabled when pipelineStatus is "failed" without overallScore
**T-071-5:** PDF button disabled when citationRate is null
**T-071-6:** PDF button disabled when pipelineStatus is active even with citationRate
**T-071-7:** PDF button enabled when complete + citationRate
**T-071-8:** PDF button enabled when failed + citationRate + overallScore
**T-071-9:** Click on active ZIP button triggers fetch, not `<a download>`
**T-071-10:** Failed fetch shows tooltip error, no file download
**T-071-11:** Failed pipeline row shows error indicator
**T-071-12:** Failed pipeline row with score shows stale badge

### Integration Tests

**IT-071-1:** download-report returns ZIP when status=failed but data exists
**IT-071-2:** download-report returns 404 when status=failed and no data
**IT-071-3:** pdf-report returns PDF when status=failed but score+citation exist
**IT-071-4:** pdf-report returns 404 when no score exists

---

## Implementation Notes for ScriptDev

1. **RowActions.tsx** — The existing `rerunTooltip` / `citationTooltip` pattern provides the tooltip infrastructure. Add `downloadTooltip` state for download error feedback.
2. **DomainTableRow.tsx** — Needs `pipelineError` prop added. Use a red dot (similar to the green active dot) + title tooltip for the error text.
3. **API routes** — Remove lines 33-35 from both download-report and pdf-report. The existing data checks (`!site.overallScore`, `perPageResults.length === 0`) are sufficient guards.
4. **page.tsx** — One-line addition to the SELECT query + DomainRow type.
