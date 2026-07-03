# ES-018 — batchId Column for Bulk Batch Sibling Query

**Source spec:** TS-018-batch-id-column.md  
**GitHub Issue:** #110  
**Date:** 2026-03-01  
**Priority:** P1 — data integrity bug causing credits miscalculation on bulk audits  
**Target branch:** dev-sprint-9  
**Depends on:** none (standalone fix)

---

## a) Overview

Add a `batchId` column to `geo_sites` and use it as the stable FK for bulk batch sibling lookups in `verify/route.ts`, replacing the current fragile query on `verificationCode + ownerEmail + auditMode`.

**Current state (broken):**
- `verify/route.ts` lines 120–126: sibling query uses `eq(geoSites.verificationCode, site.verificationCode!)` 
- `verificationCode` is cleared to `null` on each row after it's processed (line 98-104 in non-bulk path; line 204-212 in the bulk transaction)
- Race condition: two verify requests for the same batch → first clears `verificationCode` → second finds 0 siblings → credits calculated as batch of 1 → other sites never enqueued

**After this fix:**
- Each bulk upload gets a `batchId = nanoid()` generated once before the insert loop
- All rows from that upload share the same `batchId`
- Sibling query uses `eq(geoSites.batchId, site.batchId)` — stable, never nulled
- Single-site rows have `batchId = null` → fallback to `[site]`

**Files to modify (4):**

| File | Change |
|------|--------|
| `geo/lib/db/migrations/20260302-batch-id.sql` | NEW — ALTER TABLE + partial index |
| `geo/lib/db/schema.ts` | Add `batchId` column to `geoSites` |
| `geo/app/api/sites/route.ts` | Generate `batchId = nanoid()` before loop; set on each row |
| `geo/app/api/sites/[id]/verify/route.ts` | Replace sibling query with `batchId`-based lookup |

---

## b) Implementation Requirements

### File 1: `geo/lib/db/migrations/20260302-batch-id.sql` (NEW)

Write verbatim as specified in TS-018:

```sql
-- TS-018: Add batchId to geo_sites for reliable bulk batch sibling lookup (issue #110)

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS batch_id text;

CREATE INDEX IF NOT EXISTS idx_geo_sites_batch_id
  ON geo_sites(batch_id)
  WHERE batch_id IS NOT NULL;
```

The partial index (`WHERE batch_id IS NOT NULL`) avoids indexing the majority of rows (single-audit sites with `batch_id = null`). Run this migration before deploying code changes.

---

### File 2: `geo/lib/db/schema.ts` (ONE EDIT)

Add `batchId` to the `geoSites` table definition. Insert it in the **Bulk CSV audit fields** section, after `reportZipUrl`:

```typescript
// Bulk batch identifier — all domains from the same CSV upload share this ID.
// null for single-audit sites. Never cleared after creation (unlike verificationCode).
batchId: text("batch_id"),
```

Full context (lines ~107–115 after edit):
```typescript
// Bulk CSV audit fields
auditMode:       text("audit_mode").default("single"),
bulkUrls:        jsonb("bulk_urls"),
bulkUrlCount:    integer("bulk_url_count"),
crawlLimit:      integer("crawl_limit"),
creditsReserved: integer("credits_reserved"),
perPageResults:  jsonb("per_page_results"),
reportZipUrl:    text("report_zip_url"),
batchId:         text("batch_id"),            // ← ADD HERE
```

No other schema changes. `GeoSite` and `NewGeoSite` types are derived via `$inferSelect` / `$inferInsert` and will automatically pick up the new column.

---

### File 3: `geo/app/api/sites/route.ts` (ONE EDIT — bulk path only)

**Location:** the bulk audit path, just before the `const rows = domainList.map(...)` call (approximately line 112).

**Add `batchId` generation before the map:**
```typescript
// BEFORE (line ~112):
const primarySiteId = nanoid();
const rows = domainList.map((domain, i) => {
  const siteId = i === 0 ? primarySiteId : nanoid();
  // ...
  return {
    id: siteId,
    domain,
    // ... other fields ...
    // NO batchId
  };
});

// AFTER:
const batchId = nanoid();
const primarySiteId = nanoid();
const rows = domainList.map((domain, i) => {
  const siteId = i === 0 ? primarySiteId : nanoid();
  // ...
  return {
    id: siteId,
    domain,
    // ... all existing fields unchanged ...
    batchId,           // ← ADD THIS LINE inside the returned object
  };
});
```

**Single-audit paths (the two `db.insert(geoSites).values(...)` calls for single audits) do NOT get `batchId`** — the column is nullable and will default to `null`. Do not touch the single-audit insert paths.

---

### File 4: `geo/app/api/sites/[id]/verify/route.ts` (ONE EDIT)

**Location:** lines 120–126 — the `batchSites` query inside the bulk audit branch.

**Replace the fragile three-condition query:**
```typescript
// BEFORE (lines 120–126):
const batchSites = await db.select().from(geoSites).where(
  and(
    eq(geoSites.verificationCode, site.verificationCode!),
    eq(geoSites.ownerEmail, site.ownerEmail),
    eq(geoSites.auditMode, "bulk"),
  )
);

// AFTER:
const batchSites = site.batchId
  ? await db.select().from(geoSites).where(eq(geoSites.batchId, site.batchId))
  : [site];
```

**No other changes to this file.** The `and`, `eq` imports remain (used elsewhere). Remove `and` from this specific query but do not remove the import if it's used elsewhere in the file.

**Important:** The `eq` import from `drizzle-orm` is already present in this file. The `geoSites` import is already present. No new imports needed.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/batch-id.test.ts`

**Mocks required:**
- `@/lib/db` — mock `db.insert().values()` and `db.select().from().where()` chains
- `nanoid` — mock to return predictable values for assertion

### sites/route.ts — bulk insert path

| ID | Description | Setup | Expected |
|----|-------------|-------|----------|
| U-1 | Single-domain bulk: batchId set | bulkUrls=[1 domain], mock db | Single inserted row has `batchId` set |
| U-2 | Multi-domain bulk: same batchId on all rows | bulkUrls=[3 domains] | All 3 inserted rows share the same `batchId` |
| U-3 | batchId is a nanoid (21 chars) | Mock nanoid returns fixed string | `batchId` on rows matches generated value |
| U-4 | Single-audit insert: no batchId field | POST with single url | `batchId` is not set / is `undefined` (nullable) |
| U-5 | Email rate limit path not affected | POST with single url | existing behavior unchanged |

### verify/route.ts — sibling query

| ID | Description | Setup | Expected |
|----|-------------|-------|----------|
| U-6 | site.batchId set → queries by batchId | Mock select returns [s1, s2] | `batchSites = [s1, s2]` |
| U-7 | site.batchId null → fallback to self | site.batchId=null | `batchSites = [site]`; no DB query |
| U-8 | Old bulk site (batchId=null, auditMode=bulk) | site.batchId=null, auditMode=bulk | fallback `[site]`; credits for batch of 1 |
| U-9 | batchId query returns all siblings including self | 3 sites same batchId | all 3 in batchSites; all get enqueued |

**Coverage target:** both branches of `site.batchId ? ... : [site]`.

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/batch-id-integration.test.ts`

### Scenario 1 — Happy path: 3-domain CSV, one verify

1. POST `/api/sites` with `bulkUrls = [a.com, b.com, c.com]`
2. Assert DB: all 3 `geoSites` rows have same non-null `batchId`
3. POST `/api/sites/{primaryId}/verify` with correct code
4. Assert: `batchSites` contains 3 rows; credits deducted for all 3; all 3 enqueued

### Scenario 2 — Race: two verify requests for same batch

1. Seed DB: 3 sites, same `batchId`, all `emailVerified=false`, `verificationCode=hash`
2. Send two simultaneous POST `/api/sites/{id}/verify` with correct code
3. Assert: both complete 200 (idempotent — site already verified on second attempt)
4. Assert: `batchSites` lookup returned 3 sites in both requests (batchId stable)
5. Assert: credits deducted once (transaction on teams.creditBalance)

### Scenario 3 — Old bulk site fallback (batchId=null)

1. Seed DB: geoSite with `auditMode=bulk`, `batchId=null`, valid `verificationCode`
2. POST `/api/sites/{id}/verify` correct code
3. Assert: `batchSites = [site]`; single-site credit calculation; site enqueued

### Scenario 4 — Single-audit site: batchId remains null

1. POST `/api/sites` with single URL (non-bulk)
2. Assert DB: inserted row has `batch_id IS NULL`
3. POST verify: `batchSites = [site]` via null fallback

### Scenario 5 — Index used for batchId query

1. `EXPLAIN` the batchSites query on a table with 1000 sites
2. Assert: query plan uses `idx_geo_sites_batch_id` index

---

## e) Profiling Requirements

| Metric | Tool | Target |
|--------|------|--------|
| batchId sibling query (10 sites, index) | DB `EXPLAIN ANALYZE` | < 5ms (index scan) |
| vs. old verificationCode query (no dedicated index) | `EXPLAIN ANALYZE` | Should be slower — demonstrates regression fixed |
| Bulk insert with batchId field | `console.time` | < 5ms overhead vs current (one extra `nanoid()` call) |

---

## f) Load Test Plan

**Target:** POST `/api/sites/{id}/verify` with bulk mode sites, concurrent verify requests.

### Scenario 1 — Concurrent verifies for same batch
- 10 simultaneous POST verify for same `batchId` (simulating retry storm)
- **Pass criteria:** All complete 200; DB row shows `emailVerified=true`; no 5xx; credits deducted once

### Scenario 2 — High-volume bulk submits
- 100 POST `/api/sites` (bulk, 5 domains each) over 30s
- **Pass criteria:** All 100×5=500 site rows have non-null `batchId`; each batch shares one unique `batchId`

**Tool:** `k6`.

---

## g) Logging & Instrumentation

### sites/route.ts

Add `batchId` to the existing structured log at the end of the bulk submit path:

```typescript
// BEFORE:
console.log(JSON.stringify({
  event: isMultiDomain ? "multi_domain_bulk_submit" : "bulk_submit",
  primarySiteId,
  domains: domainList,
  totalUrlCount: uniqueUrls.length,
  teamId: member.teamId,
}));

// AFTER (add batchId field):
console.log(JSON.stringify({
  event: isMultiDomain ? "multi_domain_bulk_submit" : "bulk_submit",
  primarySiteId,
  batchId,                   // ← ADD
  domains: domainList,
  totalUrlCount: uniqueUrls.length,
  teamId: member.teamId,
}));
```

### verify/route.ts

Add `batchId` to the existing `bulk_credit_reserved` log:

```typescript
// AFTER (add batchId field):
console.log(JSON.stringify({
  event: "bulk_credit_reserved",
  primarySiteId: id,
  batchId: site.batchId,    // ← ADD
  teamId: site.teamId,
  totalCreditsDeducted: totalCreditsToDeduct,
  sitesInBatch: siteUpdates.length,
  domains: siteUpdates.map((u) => u.domain),
}));
```

**Log level guidance:**
- `log` (structured JSON) — normal batch operations; include `batchId` for traceability
- `warn` — fallback path taken (batchId=null on bulk site): `console.warn(\`[verify] batchId null for bulk site siteId=${id} — falling back to self\`)`

---

## h) Acceptance Criteria

| # | Criterion | Implementation reference |
|---|-----------|--------------------------|
| BI-1 | Bulk upload sets same batchId on all N rows | `batchId = nanoid()` before loop; same var set on every row |
| BI-2 | Single-audit sites have `batchId = null` | No `batchId` field in single-audit insert blocks |
| BI-3 | Verify uses batchId query, not verificationCode | Sibling query is `eq(geoSites.batchId, site.batchId)` |
| BI-4 | Race: verify called twice for same batch | batchId stable → both requests find all siblings |
| BI-5 | Old sites (batchId=null) verify as batch of 1 | `site.batchId ? ... : [site]` fallback |
| BI-6 | Existing 815 tests still pass | `vitest run` → 0 failures |

**Definition of Done:**
- [ ] Migration file written and matches TS-018 exactly (partial index included)
- [ ] `geoSites` schema has `batchId: text("batch_id")`
- [ ] `sites/route.ts` bulk path: `batchId = nanoid()` before loop; all rows include `batchId`
- [ ] `verify/route.ts` sibling query is replaced with `batchId`-based lookup + null fallback
- [ ] Old three-condition query (`verificationCode + ownerEmail + auditMode`) is removed
- [ ] `batchId` field added to both structured log statements
- [ ] TypeScript compiles without errors (`tsc --noEmit`)
- [ ] `vitest run` → 0 failures
- [ ] Target branch: dev-sprint-9
