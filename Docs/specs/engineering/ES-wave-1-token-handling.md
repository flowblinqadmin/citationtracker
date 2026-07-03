# ES-Wave-1 — Token-Handling Fix (G1 + G3)

**Branch:** `fix/wave-1-token-handling` (from `dfbe76a`).
**Source plan:** `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 1.
**Source UAT:** `docs/uat/2026-04-26-issues.md` rows G1 + G3.
**Scope:** spec / design only. ScriptDev implements next.

---

## Overview

Two related access-token bugs make every dashboard-initiated re-audit silently break the open audit-page tab:

- **G3 (BLOCKER):** `app/sites/[id]/SitePageClient.tsx:194` token bootstrap is INVERTED — it reads `sessionStorage.getItem('geo-token-${siteId}')` FIRST and uses the cached value if present, only falling back to the freshly server-rendered `initialSite.token` when nothing is stored. Once a token is cached, every subsequent page load (including hard refresh) keeps using the stale token. After a regenerate from another tab rotates the token server-side (per `buildRegeneratePatch` at `app/api/sites/[id]/regenerate/route.ts:18-25` returning `accessToken: nanoid(32)`), the audit-page tab still ships the OLD token to every action endpoint → 401 cascade.
- **G1 (HIGH):** Dashboard `RowActions.tsx:53-70` `handleRerunAudit` calls regenerate and on 202 only fires `onScanStart?.()` — does NOT call `router.refresh()`. The audit-page tab (`SitePageClient.handleRefreshScore` at lines 313-343) DOES correctly update `sessionStorage` + URL after its own regenerate, but it owns only its own session storage; a regenerate triggered from the dashboard route never touches the audit-page tab. Without `router.refresh()` after the dashboard regenerate, the next-rendered server props on either route do not pick up the rotated token in real time, and a UAT-style flow (Rerun from dashboard → switch to open audit-page tab → click Map Competitors / Add Competitor / Rerun Citations / Download ZIP / Download PDF) returns 401 from every action endpoint.

This ES fixes G3 by inverting the bootstrap (prefer fresh `initialSite.token`; overwrite stored on mismatch) and G1 by adding `router.refresh()` after the regenerate 202 in BOTH the dashboard `RowActions.handleRerunAudit` and the audit-page `SitePageClient.handleRefreshScore`.

---

## Acceptance criteria

| AC | Target | Verify |
|----|--------|--------|
| AC-1 | `app/sites/[id]/SitePageClient.tsx` token-bootstrap `useEffect` (currently lines 193-214): when `initialSite?.token` is present, it is preferred over `sessionStorage`. The `useEffect` writes `initialSite.token` into `sessionStorage` (overwriting any prior value) and calls `setToken(initialSite.token)`. | Vitest UT |
| AC-2 | Same hook: when `initialSite?.token` is **absent** (read-only / share-link view), fall through to existing logic — `sessionStorage` value, `initialToken` prop, then hash `#st=&sid=` — in that order. No regression on the read-only path. | Vitest UT |
| AC-3 | Same hook: when `initialSite?.token` is present **and** equals the value already in `sessionStorage`, the write is a no-op (idempotent — safe to re-run); same `setToken(initialSite.token)` call. | Vitest UT |
| AC-4 | `app/dashboard/RowActions.tsx:53-70` `handleRerunAudit`: on `res.status === 202`, after `onScanStart?.()`, call `router.refresh()`. Triggers a Next.js server-render pass so the dashboard row's next read picks up the rotated `geo_sites.access_token` from the DB. | Vitest UT (mock fetch + spy on `router.refresh`) |
| AC-5 | `app/sites/[id]/SitePageClient.tsx:313-343` `handleRefreshScore`: on `res.status === 202`, AFTER the existing `sessionStorage.setItem` + `setToken(newToken)` + `window.history.replaceState` block, ALSO call `router.refresh()`. The local-state update fixes the current tab; the refresh ensures any open child server components (and the next initial render on hard reload) see the rotated token. | Vitest UT |
| AC-6 | Cross-tab UAT: Rerun Audit from `/dashboard` (RowActions) → token rotates server-side → switch to audit-page tab `/sites/[id]` opened **before** the regenerate → hard-refresh that tab → all five action buttons (Map Competitors, Add Competitor, Rerun Citations, Download ZIP, Download PDF) succeed without 401. | Playwright E2E |
| AC-7 | Read-only view (no `initialSite?.token`): action buttons remain hidden / disabled per existing logic; AC-1's bootstrap change must not surface action buttons in the read-only path. | Existing UT or grep |
| AC-8 | Zero product-code edits outside the 3 file:line targets. AC-25 (zero-fixme) preserved. | Grep + diff-stat at PR review |

---

## Implementation contract

### (a) `initialSite.token` present + `sessionStorage` empty
**Behaviour:** write `initialSite.token` to `sessionStorage.setItem('geo-token-${siteId}', initialSite.token)`; `setToken(initialSite.token)`.

### (b) `initialSite.token` present + `sessionStorage` stale-different
**Behaviour:** OVERWRITE `sessionStorage` with `initialSite.token`; `setToken(initialSite.token)`. The cached stale value is silently replaced — this is the rotation-recovery path.

### (c) `initialSite.token` absent (read-only / public-share view)
**Behaviour:** fall through to the existing chain — `sessionStorage` first, then `initialToken` prop, then `window.location.hash` `#st=&sid=`. Identical to current code below the fix point. Read-only views do not have a server-rendered token to prefer.

### (d) Post-regenerate `router.refresh()` call sites
- **`app/dashboard/RowActions.tsx`:** in `handleRerunAudit` after `if (res.status === 202)` and after `onScanStart?.()`, add `router.refresh();`. The `useRouter` hook is already imported (per existing `router.refresh()` at line 96 in `handleRerunCitations`), so no new import needed.
- **`app/sites/[id]/SitePageClient.tsx`:** in `handleRefreshScore` after the existing post-202 block (lines 320-331 — `sessionStorage.setItem`, `setToken`, `window.history.replaceState`, `setSite((prev) => …)`, `await poll(newToken)`), add `router.refresh();`. The `useRouter` hook is already imported (per existing `router.refresh()` at line 234 in `poll`).

The two refreshes are belt-and-braces: in the same-tab case (audit page initiates its own Rerun), the local-state update is enough for the UI; the refresh ensures the next server-render pass and any sibling server components also see the rotated token. In the cross-tab case (dashboard initiates Rerun), the dashboard's refresh re-renders the dashboard with the new token; the audit-page tab still requires a hard-refresh by the user (no cross-tab signal) — that hard-refresh now correctly picks up the new token thanks to AC-1's inverted bootstrap.

---

## Test strategy

### New Vitest unit tests

`__tests__/SitePageClient.token-bootstrap.test.tsx` (NEW) — covers AC-1/AC-2/AC-3:
- Mount the component with `initialSite.token = "fresh"` and `sessionStorage` empty → assert `sessionStorage` now holds `"fresh"`, `setToken("fresh")` called once.
- Mount with `initialSite.token = "fresh"` and `sessionStorage` holds `"stale"` → assert `sessionStorage` now holds `"fresh"` (overwrite), `setToken("fresh")` called.
- Mount with `initialSite.token = "fresh"` and `sessionStorage` holds `"fresh"` (idempotent) → assert no error, `setToken("fresh")` called.
- Mount with `initialSite.token = undefined` and `sessionStorage` holds `"cached"` → assert `setToken("cached")` called (read-only fallback unchanged).
- Mount with `initialSite.token = undefined` and `sessionStorage` empty + `initialToken = "prop"` → assert `setToken("prop")` and `sessionStorage` written.
- Hash fallback: `initialSite = undefined`, no stored, `initialToken = undefined`, `window.location.hash = "#st=hashval&sid=<siteId>"` → assert `setToken("hashval")`.

`__tests__/RowActions.handleRerunAudit.test.tsx` (NEW) — covers AC-4:
- Mock `fetch` to return `{ status: 202 }`, mock `useRouter` with a `refresh` spy → call `handleRerunAudit` → assert `router.refresh` called exactly once after `onScanStart`.
- Negative case: 409 / 402 → `router.refresh` NOT called.

`__tests__/SitePageClient.handleRefreshScore.test.tsx` (NEW) — covers AC-5:
- Mock `fetch` to return `{ status: 202, json: () => ({ accessToken: "newtok" }) }`, mock `useRouter` → call `handleRefreshScore` → assert order: `sessionStorage.setItem` → `setToken("newtok")` → `window.history.replaceState` → `setSite` → `poll("newtok")` → `router.refresh`.

### New Playwright E2E spec

`e2e/tests/02-portfolio/067-cross-tab-rerun-token-rotation.spec.ts` (NEW) — covers AC-6:
- Pre: seeded paid site with completed audit (uses existing seed fixture from §b.4 / DRY-02-style helper).
- Open dashboard tab; open audit-page tab in a second context (Playwright `browser.newContext()`) with the original token.
- Trigger Rerun Audit from the dashboard tab via `RowActions` → wait for 202.
- In the audit-page tab: hard-refresh (`page.reload()`).
- Assert `sessionStorage.getItem('geo-token-${siteId}')` matches the rotated token (read via `page.evaluate`).
- Click each action button in turn: Map Competitors, Add Competitor, Rerun Citations, Download ZIP, Download PDF. Assert each request returns NOT 401 (use `page.waitForResponse` to capture status of the corresponding API call).
- Tags: `live-services` (per AC-30), `chromium` project (authed via storageState).

### Existing tests — regression check

Run the existing Phase A + Phase B retired/live wave; assertion: zero new failures introduced. Specifically:
- DRY-02 single-URL audit (uses its own access-token path) — should pass unchanged.
- DRY-05 bulk audit + retired per-page-fixes specs — unaffected (no touch).

---

## Out of scope

- **G2** (route-level fixes for completion-email links) — Wave 4.
- **B1, B2, B3** (pipeline-status persistence / OTP error-handling / Pro re-audit gate) — Wave 2.
- **C1+** (UI polish, copy fixes, accessibility) — Wave 5.
- Token-rotation **grace window** (server-side accepts both old + new for a short period) — explicitly NOT taken; out-of-scope per Wave 1's "well-defined fix shape" framing in the bugfix plan. If grace-window semantics are wanted later, that's a separate ES.
- Cross-tab token-sync via `BroadcastChannel` or `storage` events — also out-of-scope; the user's hard-refresh on the audit-page tab is the documented UAT recovery, and AC-1's inverted bootstrap makes that recovery work.
- Switching to Supabase JWT for action authorization (G1 fix-option (c) in the issues doc) — larger refactor, separate TS if pursued.

---

## Verification gate (UAT shape per plan)

1. Pre: paid Pro user; audit page (`/sites/<id>`) open in tab A from before the test; dashboard open in tab B.
2. From tab B (dashboard): click Rerun Audit on the same site row → expect 202 → `router.refresh()` (AC-4) → token rotates server-side via `buildRegeneratePatch`.
3. Switch to tab A (audit page): hard-refresh (Cmd-R / F5).
4. After hard-refresh, `SitePageClient` mounts with the freshly server-rendered `initialSite.token` (the rotated one); AC-1's bootstrap writes it into `sessionStorage` (overwriting the stale value).
5. Click each action button in turn — Map Competitors, Add Competitor, Rerun Citations, Download ZIP, Download PDF.
6. **PASS:** every request returns 200/202; zero 401s.
7. **FAIL:** any 401 → AC-1 or AC-5 implementation bug; surface to CoFounder before retry.

A non-hard-refresh recovery (cross-tab token-sync) is intentionally out-of-scope; the gate accepts the documented hard-refresh step.
