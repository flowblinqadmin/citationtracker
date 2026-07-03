# TS-045: Validation Bugfixes — Download ZIP Guard + AuthNavButton Hydration

**Status:** Ready for ScriptDev
**Priority:** P0 (blocks release validation)
**Branch:** `feat/per-page-fixes`
**Scope:** 2 files, 2 bugs

---

## Bug 1: Download ZIP navigates to JSON error page

### What
Clicking "Download ZIP" when `perPageResults` is empty navigates the browser to `/api/sites/{id}/download-report?token=...` which returns raw JSON `{"error":"No per-page results available."}` on a blank page. User must use browser back button to return.

### Why it happens
- `ResultsDashboard.tsx:1275` only checks `site.tier === "paid" && site.pipelineStatus === "complete"` before rendering the button
- `ResultsDashboard.tsx:1566` renders the bulk-section ZIP button with no guard at all
- The button's `onClick` does `window.location.href = ...` (full page navigation, not fetch)
- `download-report/route.ts:37-39` returns 404 JSON when `perPageResults.length === 0`

### Fix

**`ResultsDashboard.tsx` — both ZIP button instances (lines 1275-1281 and 1566-1570):**

Add `perPageResults` availability check. When `perPageResults` is empty/null/missing:
- Render the button as **disabled** (greyed out, `cursor: not-allowed`, reduced opacity)
- Wrap in a container with `title` attribute: `"Rerun audit to generate per-page results"`
- Do NOT hide the button — user should see it exists but understand why it's unavailable

Derive availability from the `site` object. The `site` prop already has `perPageResults` (used elsewhere in the component — it renders per-page tables from it).

```typescript
// Guard condition (use for both instances):
const hasPerPageResults = Array.isArray(site.perPageResults) && (site.perPageResults as unknown[]).length > 0;
```

**Header button (line 1275-1281) — change to:**
```typescript
{site.tier === "paid" && site.pipelineStatus === "complete" && (
  <button
    onClick={hasPerPageResults ? () => { window.location.href = `/api/sites/${site.id}/download-report?token=${site.token}`; } : undefined}
    disabled={!hasPerPageResults}
    title={!hasPerPageResults ? "Rerun audit to generate per-page results" : "Download full audit report as ZIP"}
    style={{ padding: "6px 14px", background: hasPerPageResults ? "#14532d" : "#a1a1aa", color: hasPerPageResults ? "#86efac" : "#e4e4e7", border: hasPerPageResults ? "1px solid #166534" : "1px solid #d4d4d8", borderRadius: "8px", cursor: hasPerPageResults ? "pointer" : "not-allowed", fontWeight: 600, fontSize: "12px", whiteSpace: "nowrap" as const, opacity: hasPerPageResults ? 1 : 0.6 }}>
    Download ZIP
  </button>
)}
```

**Bulk section button (line 1566-1570) — same pattern:**
```typescript
<button
  onClick={hasPerPageResults ? () => { window.location.href = `/api/sites/${site.id}/download-report?token=${site.token}`; } : undefined}
  disabled={!hasPerPageResults}
  title={!hasPerPageResults ? "Rerun audit to generate per-page results" : "Download full audit report as ZIP"}
  style={{ padding: "8px 14px", background: hasPerPageResults ? GREEN : "#a1a1aa", color: hasPerPageResults ? "#fff" : "#e4e4e7", border: "none", borderRadius: "8px", cursor: hasPerPageResults ? "pointer" : "not-allowed", fontWeight: 600, fontSize: "12px", opacity: hasPerPageResults ? 1 : 0.6 }}>
  Download ZIP
</button>
```

**No changes to `download-report/route.ts`** — the server-side guard stays as defense-in-depth.

---

## Bug 2: AuthNavButton hydration mismatch

### What
Navigating back to the report page (via browser back button) shows a React hydration error. The server renders `<a href="/auth/login">Sign in</a>` but the client renders `<button>Sign out</button>`.

### Why it happens
`ResultsDashboard.tsx:122-124`:
```typescript
const [authed, setAuthed] = useState(() =>
  typeof window !== "undefined" && sessionStorage.getItem("geo-authed") === "1"
);
```
- Server: `typeof window === "undefined"` → `authed = false` → renders `<a>Sign in</a>`
- Client (hydration): `typeof window !== "undefined"` + `sessionStorage` has `"geo-authed": "1"` → `authed = true` → renders `<button>Sign out</button>`
- Different initial render = hydration mismatch

### Fix

**`ResultsDashboard.tsx` lines 121-149 — rewrite `AuthNavButton`:**

Always initialize `authed` as `false` to match SSR. Let `useEffect` handle the client-side session check after hydration.

```typescript
function AuthNavButton() {
  const [authed, setAuthed] = useState(false);
  useEffect(() => {
    // Check sessionStorage first for instant UI (avoids flash)
    if (sessionStorage.getItem("geo-authed") === "1") {
      setAuthed(true);
    }
    // Then verify with Supabase (authoritative)
    import("@/lib/supabase/client").then(({ createClient }) => {
      createClient().auth.getSession().then(({ data }) => {
        const ok = !!data.session?.user;
        ok ? sessionStorage.setItem("geo-authed", "1") : sessionStorage.removeItem("geo-authed");
        setAuthed(ok);
      }).catch(() => {});
    });
  }, []);
  if (!authed) return (
    <a href="/auth/login" style={{ fontSize: "13px", fontWeight: 600, color: "#fff", background: "#b45309", borderRadius: "8px", padding: "6px 14px", textDecoration: "none" }}>Sign in</a>
  );
  return (
    <button onClick={async () => {
      const { createClient } = await import("@/lib/supabase/client");
      await createClient().auth.signOut();
      sessionStorage.removeItem("geo-authed");
      Object.keys(localStorage).filter(k => k.startsWith("sb-")).forEach(k => localStorage.removeItem(k));
      setAuthed(false);
      window.location.href = "/auth/login";
    }} style={{ fontSize: "13px", fontWeight: 600, color: "#78716c", background: "none", border: "1px solid rgba(0,0,0,0.07)", borderRadius: "8px", padding: "6px 14px", cursor: "pointer", fontFamily: "inherit" }}>
      Sign out
    </button>
  );
}
```

The only change: `useState(false)` instead of `useState(() => typeof window !== "undefined" && ...)`. The `sessionStorage` check moves into the `useEffect` body (before the async Supabase call) so authenticated users see "Sign out" almost instantly after hydration, with no SSR mismatch.

---

## Acceptance Criteria

1. **ZIP button disabled:** When `perPageResults` is empty/null, the Download ZIP button appears greyed out with `cursor: not-allowed` and opacity 0.6
2. **ZIP button tooltip:** Hovering the disabled button shows "Rerun audit to generate per-page results"
3. **ZIP button functional:** When `perPageResults` exists and is non-empty, button works as before (navigates to download)
4. **No hydration error:** Navigating to a report page (direct or via back button) produces no React hydration mismatch warning
5. **Auth state correct:** Authenticated users see "Sign out" after hydration; unauthenticated users see "Sign in"
6. **Both ZIP instances:** Both the header button (line 1275) and bulk section button (line 1566) have the guard

## Files to modify

| File | Lines | Change |
|------|-------|--------|
| `app/sites/[id]/ResultsDashboard.tsx` | 122-124 | `useState(false)` + move sessionStorage check to useEffect |
| `app/sites/[id]/ResultsDashboard.tsx` | 1275-1281 | Add `hasPerPageResults` guard, disabled state, tooltip |
| `app/sites/[id]/ResultsDashboard.tsx` | 1566-1570 | Same guard as header button |

## Testing

- Visit a report with no `perPageResults` → ZIP button greyed out, tooltip on hover
- Visit a report with `perPageResults` → ZIP button green, downloads correctly
- Hard refresh a report page when authenticated → no hydration error in console
- Navigate away and back → no hydration error
- Unauthenticated visit → "Sign in" link, no hydration error
