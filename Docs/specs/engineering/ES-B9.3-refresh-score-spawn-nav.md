# ES-B9.3 — `handleRefreshScore` spawn-navigation fix + `geoSites.parentSiteId` schema

**Branch:** `fix/b9.3-refresh-score-spawn-nav`
**Base:** `6120c9d`
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate, NO Playwright per-spec.
**Parent:** ES-B9 / ES-B9.1 / ES-B9.2 chain — this is the third UAT-surfaced gap once the regenerate route became bulk-aware.

---

## a) Overview

Aditya UAT 2026-04-27: clicked "Refresh Score" on bulk site report. Server-side spawn completed correctly — `geo_sites 4RATAxNUE31dmcNautaSj` reached `pipeline_status=complete` with 221 pages crawled and a refund event recorded. **But the UI got stuck on a 401 polling loop** — clicking Refresh produced no visible progression.

**Root cause:** the client-side `handleRefreshScore` handler at `app/sites/[id]/SitePageClient.tsx:328-360` ignores the new spawned-site identity returned by the bulk-aware `/regenerate` route (post-B9.2). It type-casts the response as `{ accessToken?: string }` — **dropping the `siteId` field entirely** — then writes the spawned site's accessToken into `sessionStorage` keyed by the **parent's** siteId, then polls the **parent** siteId with the **spawn**'s token. The parent rejects the spawn token → 401 → user sees no progress.

`ResultsDashboardLegacy.tsx:951-966` (`handleRegenerate`) has the same shape — same bug, same trigger — and will fail identically once a user lands on the legacy view of a bulk site.

**Schema gap:** ES-B9 §c.5.1 (Option (i) parent_site_id linkage) has been applied to `creditTransactions.parentSiteId` (`schema.ts:69`, migration `20260427-credit-tx-parent-site-id.sql`) but NOT to `geoSites.parentSiteId`. Aditya: add it now, not deferred. This unlocks (a) audit-trail joins from a spawned site back to its parent without traversing the credit ledger; (b) future "View original audit" affordances; (c) referential integrity for the spawn-navigation client fix below.

---

## b) Root cause

### b.1 Client handler drops `siteId` from spawn response

`app/sites/[id]/SitePageClient.tsx:328-360`:

```ts
async function handleRefreshScore() {
  if (!token || retrying) return;
  setRetrying(true);
  setRefreshError(null);
  try {
    const res = await fetch(`/api/sites/${siteId}/regenerate?token=${token}`, { method: "POST" });
    if (res.status === 202) {
      const data = await res.json().catch(() => ({})) as { accessToken?: string };  // ← drops siteId
      const newToken = data.accessToken;
      if (newToken) {
        sessionStorage.setItem(`geo-token-${siteId}`, newToken);  // ← writes spawn token under PARENT key
        setToken(newToken);
        const url = new URL(window.location.href);
        url.searchParams.set("token", newToken);  // ← parent URL with spawn token
        window.history.replaceState(null, "", url.toString());
      }
      setSite((prev) => prev ? { ...prev, pipelineStatus: "queued" } : prev);
      await poll(newToken);  // ← polls parent siteId with spawn token → 401
      router.refresh();
    } ...
```

The B9.2-amended `/regenerate` route now spawns a fresh `geoSites` row for bulk re-audit (analogous to `/retry-failed`'s spawn pattern) and returns `{siteId: <newSpawn>, accessToken: <newSpawn.accessToken>, ...}`. The client must navigate to the new site's detail page; in-place state mutation is invalid.

### b.2 Legacy handler same shape

`app/sites/[id]/ResultsDashboardLegacy.tsx:951-966` doesn't even read the response body for siteId — just checks `res.ok` and calls `onRegenerate?.()` + `router.refresh()`. Bulk-spawn case will silently abandon the spawned site.

### b.3 `geoSites.parentSiteId` not yet on the schema

`creditTransactions.parentSiteId` exists (schema:69) per ES-B9 §c.5 (γ ledger linkage). `geoSites.parentSiteId` does NOT exist. The B9.2 regenerate spawn and B9 retry-failed spawn currently have no first-class way to express the parent-spawn edge on the geoSites row itself.

---

## c) Acceptance criteria (verbatim from corrected Shastri dispatch corr `ef349ad3`, supersedes corr `8e521365`)

> **Note:** original CoFounder dispatch corr `8e521365` was corrupted by shell-heredoc substitution that stripped key URL/path/template literals. Authoritative source: amended dispatch corr `ef349ad3` (cross-verified against `/tmp/b9.3-dispatch-fixed.json`).

| ID | Criterion |
|---|---|
| **AC-B9.3-1** | `app/sites/[id]/SitePageClient.tsx` `handleRefreshScore` (line 328-360) — when response `data.siteId` is present AND `data.siteId !== current siteId`, navigate via `router.push()` to the spawn detail URL using the explicit concatenation pattern: `'/sites/' + data.siteId + '?token=' + data.accessToken` (template literal). When `data.siteId` is absent OR equals current siteId (single-audit case), preserve existing in-place behaviour: `sessionStorage.setItem(\`geo-token-${siteId}\`, newToken)` + `setToken(newToken)` + `poll(newToken)` + `router.refresh()`. Type cast updated to `{ siteId?: string; accessToken?: string }`. |
| **AC-B9.3-2** | `app/sites/[id]/ResultsDashboardLegacy.tsx` regenerate handler at line ~955 — same fix pattern. **SHARED HELPER path pinned: `app/sites/[id]/_helpers/regenerate-nav.ts`** exporting a function `handleRegenerateResponse(res: Response, currentSiteId: string, deps)` where `deps = { router, setToken, setSite, sessionStorageSetter, pollFn }`. Both call sites (SitePageClient + ResultsDashboardLegacy) MUST use this helper. Avoid duplicate branch logic. |
| **AC-B9.3-3** | Vitest UT for the shared helper, ≥6 cases: (a) `data.siteId === currentSiteId` → in-place path (assert `sessionStorageSetter` called, `setToken` called, `pollFn` called, `router.refresh` called; `router.push` NOT called); (b) `data.siteId !== currentSiteId` → navigation path (assert `router.push` called with `'/sites/' + data.siteId + '?token=' + data.accessToken`; `sessionStorageSetter`/`pollFn`/`setToken` NOT called); (c) response missing `siteId` entirely → defensive in-place path; (d) response missing `accessToken` entirely → defensive: do nothing destructive, surface a `refreshError`. (e/f) Optional 5th/6th cover the call-site integrations in `SitePageClient` and `ResultsDashboardLegacy` against fetch-mock + helper-mock. |
| **AC-B9.3-4** | Schema migration ADD `geoSites.parentSiteId`. (i) `lib/db/schema.ts`: add the line `parentSiteId: text("parent_site_id")` to the `geoSites` table definition (mirror `creditTransactions.parentSiteId` shape at schema:69). (ii) NEW migration file `lib/db/migrations/20260427-geo-sites-parent-site-id.sql` with these two idempotent statements **paste verbatim**: `ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS parent_site_id text;` AND `CREATE INDEX IF NOT EXISTS geo_sites_parent_site_idx ON geo_sites(parent_site_id) WHERE parent_site_id IS NOT NULL;` (iii) Drizzle journal updated. (iv) Apply to LOCAL Supabase via `drizzle-kit push --force`; verify column exists via `SELECT * FROM information_schema.columns WHERE table_name='geo_sites' AND column_name='parent_site_id';`. **DO NOT apply to prod** — Shastri will surface the SQL for Aditya operator approval after dispatch lands. |
| **AC-B9.3-5** | Wire `parentSiteId` into the bulk-spawn paths. (i) `app/api/sites/[id]/regenerate/route.ts` `geoSites` insert at line ~144: add `parentSiteId: id` to the values block (where `id` is the parent siteId variable in scope from the route's `[id]` param destructure). (ii) `app/api/sites/[id]/retry-failed/route.ts` `geoSites` insert (similar location at `route.ts:172`): same — `parentSiteId: id`. Both spawn new sites; both record the parent linkage at the geoSites level (not just the credit ledger). |
| **AC-B9.3-6** | Vitest IT, 2 cases: (a) regenerate-bulk spawns `geoSites` row with `parent_site_id = original siteId` — POST `/api/sites/<bulk-parent>/regenerate` → SELECT new row → assert `parent_site_id` equals parent id; (b) retry-failed bulk spawns `geoSites` row with `parent_site_id = original siteId` — POST `/api/sites/<bulk-parent>/retry-failed` → SELECT new row → assert same. Both ITs use the same test fixture pattern as ES-B9 IT-B9-1/2. |
| **AC-B9.3-7** | `__tests__/schema-drift.test.ts` updated to expect the new `geoSites.parentSiteId` column. (The existing schema-drift test enumerates expected columns per table; add `parent_site_id` to the `geo_sites` expected-set so the drift detector stays aligned.) |

---

## d) Schema migration shape

`lib/db/migrations/20260427-geo-sites-parent-site-id.sql` — paste **verbatim** per AC-B9.3-4:

```sql
ALTER TABLE geo_sites ADD COLUMN IF NOT EXISTS parent_site_id text;
CREATE INDEX IF NOT EXISTS geo_sites_parent_site_idx ON geo_sites(parent_site_id) WHERE parent_site_id IS NOT NULL;
```

Note the **canonical index name**: `geo_sites_parent_site_idx` (NOT `geo_sites_parent_site_id_idx`). Pasted verbatim from corrected dispatch.

**Verification query** (post-`drizzle-kit push --force`, local-Supabase only):

```sql
SELECT * FROM information_schema.columns
WHERE table_name='geo_sites' AND column_name='parent_site_id';
```

**Operator-approval pin:** ScriptDev MUST report this SQL + verification query in their reply payload so CoFounder can relay verbatim to Aditya for prod application. Local-only apply per AC-B9.3-4.

**Drizzle schema snippet** (insert in `geoSites` table definition, mirror `creditTransactions.parentSiteId` shape at schema:69):

```ts
parentSiteId: text("parent_site_id"),
```

**Index rationale:** partial index `WHERE parent_site_id IS NOT NULL` — most rows are NULL (originals, single audits); a full-table index would be wasteful. Lookups only care about non-null rows ("show me all spawns of parent X").

---

## e) Test strategy

### e.1 Vitest UTs — shared helper

`app/sites/[id]/_helpers/__tests__/handle-regenerate-response.test.ts` (NEW). Covers AC-B9.3-3:

| ID | Scenario | Expected behaviour |
|---|---|---|
| U-1 | `data={siteId: 'parent-id', accessToken: 'tok'}` + `currentSiteId='parent-id'` (single-audit in-place) | `router.push` NOT called; sessionStorage write + setToken called; helper returns `{kind:'in-place', token:'tok'}` |
| U-2 | `data={siteId: 'spawn-id', accessToken: 'tok'}` + `currentSiteId='parent-id'` (bulk-spawn navigation) | `router.push('/sites/spawn-id?token=tok')` called; sessionStorage NOT written under parent key; helper returns `{kind:'navigate', siteId:'spawn-id', token:'tok'}` |
| U-3 | `data={accessToken: 'tok'}` (no siteId — legacy 202 shape) | Defensive in-place path; helper returns `{kind:'in-place', token:'tok'}` |
| U-4 | `data={}` (no siteId, no accessToken) | Helper returns `{kind:'noop'}`; caller falls through to setRefreshError defensive branch |
| U-5 | `data={siteId: 'spawn-id'}` (no accessToken — malformed 202) | Helper returns `{kind:'noop'}` (cannot navigate without a token); caller surfaces error |
| U-6 | Both call sites' integration with helper — `SitePageClient.handleRefreshScore` and `ResultsDashboardLegacy.handleRegenerate` both invoke the helper with their own `currentSiteId` and pass through the helper's `kind` to drive their UI updates. (Render test or shallow-mount asserting fetch-mock + helper-mock interactions.) |

### e.2 Vitest ITs — spawn-with-parent (AC-B9.3-6)

`__tests__/integration/regenerate-spawn-parent-site-id.test.ts` (NEW):

| ID | Scenario | Assertion |
|---|---|---|
| IT-1 | Insert bulk parent site `parent-1`, team credits 10. POST `/api/sites/parent-1/regenerate` (B9.2 bulk-aware) → 202 spawning `spawn-1` | `SELECT parent_site_id FROM geo_sites WHERE id='spawn-1'` returns `'parent-1'` |
| IT-2 | Insert bulk parent site `parent-2`, `pipelineStatus='complete'`, `crawlData.failedUrls=['x']`. POST `/api/sites/parent-2/retry-failed` → 201 spawning `spawn-2` | `SELECT parent_site_id FROM geo_sites WHERE id='spawn-2'` returns `'parent-2'` |

### e.3 Schema-drift test update (AC-B9.3-7)

Edit `__tests__/schema-drift.test.ts` — extend the expected-columns set for `geo_sites` to include `parent_site_id`. Test should already enumerate columns per-table; the diff is one line.

### e.4 Verification gate

Per pivot `waves-1to6-cd-pivot-2026-04-26`:
- `vitest run` → ≥6 UTs (e.1) + 2 ITs (e.2) + drift test (e.3) GREEN.
- Docker CI GREEN.
- **NO Playwright** (helper logic + DB-spawn linkage are fully unit/integration testable).

---

## f) Out of scope

- Backfill of `parent_site_id` for historic spawns (existing rows without lineage data): out of scope. New spawns from B9-onward will set it; historic rows stay NULL. If a "View original audit" affordance ships later and demands historical lineage, file a separate backfill TS.
- Foreign-key constraint `parent_site_id REFERENCES geo_sites(id)`: deferred. Adding FK requires deciding ON DELETE behaviour (CASCADE vs SET NULL vs RESTRICT) — non-trivial product decision. Index without FK is sufficient for the spawn-navigation use case in scope.
- UI affordance "View original audit" / breadcrumb on spawned sites: deferred. AC-B9.3-1/2 fixes the navigation bug; the inverse-direction UI surface is a follow-up.
- Migration apply to PROD: explicitly OUT of scope per AC-B9.3-4 wording — local-only.

---

## g) Ambiguity flag for HolePoker round-trip

**None.** All 7 ACs verbatim from corrected Shastri dispatch corr `ef349ad3` (cross-verified against `/tmp/b9.3-dispatch-fixed.json` `.payload.acceptance_criteria`). File:line pins all verified against branch tip `6120c9d`:

- `SitePageClient.tsx:328-360` — `handleRefreshScore` type cast `as { accessToken?: string }` confirmed (drops `siteId`)
- `ResultsDashboardLegacy.tsx:951-966` — `handleRegenerate` same shape confirmed (doesn't read response body for `siteId`)
- `creditTransactions.parentSiteId` at `schema.ts:69` — pattern to mirror confirmed
- Existing migration `20260427-credit-tx-parent-site-id.sql` confirmed in `lib/db/migrations/` — naming + date convention pinned
- `__tests__/schema-drift.test.ts` confirmed exists

**Dispatch correction history:** original CoFounder dispatch corr `8e521365` had AC literals corrupted by shell-heredoc substitution (URL pattern, helper file path, function signature, SQL index name all stripped or renamed). Shastri shipped correction signal `b9.3-correction-2026-04-27` + canonical file at `/tmp/b9.3-dispatch-fixed.json`; CoFounder superseded with corr `f5aa49e7`. Spec authored from corrected literals; the only canonical-name pin worth flagging is the index `geo_sites_parent_site_idx` (NOT `geo_sites_parent_site_id_idx` — the latter would have been my default).
