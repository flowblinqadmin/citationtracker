# TS-050: Citation Monitor Missing on First Audit Load

**Status:** Ready for ScriptDev
**Priority:** P1 (feature invisible on first run)
**Branch:** `feat/per-page-fixes`
**Scope:** 1 file

---

## Bug

When an audit completes for the first time, the AI Citation section (Discover Competitors + Run AI Visibility) is missing. It only appears after a manual page refresh.

## Root Cause

`CitationMonitor` is rendered by the **server component** `page.tsx:160-174`, gated by:
```typescript
const showCitationMonitor = site.pipelineStatus === "complete" && tier === "paid" && token && site.accessToken === token;
```

When the user first navigates to the report page while the audit is running:
1. Server renders `page.tsx` with `pipelineStatus !== "complete"` → `showCitationMonitor = false` → no CitationMonitor in HTML
2. `SitePageClient` polls `/api/sites/{id}` every 3 seconds
3. Polling detects `pipelineStatus === "complete"` → updates client state → ResultsDashboard renders the completed report
4. But the **server component** is never re-rendered — `CitationMonitor` stays absent

`SitePageClient.tsx` has no `router.refresh()` call when the pipeline transitions to "complete". Only the client-side `setSite()` updates, which doesn't affect the server component tree.

## Fix

**`app/sites/[id]/SitePageClient.tsx`** — add a `router.refresh()` when the pipeline status transitions to "complete".

In the poll callback (around line 146-155), detect the transition:

```typescript
const poll = useCallback(async () => {
  if (!token || isComplete || isFailed || isIdle) return;
  try {
    const res = await fetch(`/api/sites/${siteId}?token=${token}`);
    if (res.ok) {
      const data = await res.json() as SiteData;
      setSite({ ...data, token });
      // When pipeline completes, refresh server components so CitationMonitor renders
      if (data.pipelineStatus === "complete") {
        router.refresh();
      }
    }
  } catch { /* ignore */ }
}, [siteId, token, isComplete, isFailed, isIdle, router]);
```

Make sure `router` is available — it should already be imported from `useRouter()` in this component.

### Why `router.refresh()` is safe here

- It triggers a server re-render of `page.tsx` without full navigation
- `page.tsx` re-queries the DB, sees `pipelineStatus === "complete"`, renders `CitationMonitor`
- This only fires once (polling stops after `isComplete` becomes true)
- The client state is already updated via `setSite()`, so there's no flash

---

## Acceptance Criteria

1. Audit runs to completion → CitationMonitor section appears without manual page refresh
2. "Discover your competitors" and "Run AI visibility check" buttons visible immediately after audit completes
3. No double-render or flash when transitioning to complete
4. Polling still stops after completion (existing behavior preserved)

## Files to modify

| File | Change |
|------|--------|
| `app/sites/[id]/SitePageClient.tsx` | Add `router.refresh()` in poll callback when `data.pipelineStatus === "complete"` |
