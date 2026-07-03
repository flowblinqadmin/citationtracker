# TS-018 — Add batchId Column for Bulk Batch Sibling Query

**GitHub Issue:** #110
**Date:** 2026-03-02
**Priority:** P1 — data integrity bug blocking reliable bulk audit launches
**Depends on:** none (standalone fix)

---

## What

Add a `batchId` column to `geo_sites` and use it as the FK for bulk batch
sibling lookups in `verify/route.ts`, replacing the current implicit FK on
`verificationCode + ownerEmail`.

---

## Why

### Current behavior (broken)

When a user uploads a bulk CSV with N domains, `sites/route.ts` creates N
`geoSites` rows — all with the same `verificationCode` hash and `ownerEmail`.

`verify/route.ts` then finds all sibling sites by querying:

```typescript
const batchSites = await db.select().from(geoSites).where(
  and(
    eq(geoSites.verificationCode, site.verificationCode!),
    eq(geoSites.ownerEmail, site.ownerEmail),
    eq(geoSites.auditMode, "bulk"),
  )
);
```

**The race condition:** The verify handler sets `verificationCode = null` on each
site after it processes it. If two verify requests arrive close together (e.g.,
two browser tabs, a retry), whichever runs first may clear `verificationCode`
before the second query can find siblings → the second request sees an empty
batch → credits calculated incorrectly → some sites never get enqueued.

### Root cause

`verificationCode` is a **security credential** (hashed OTP), not a FK.
Reusing it as a batch identifier couples two unrelated concerns and creates
a time-of-check/time-of-use (TOCTOU) window.

---

## Fix

### 1. New column: `batchId` on `geoSites`

```sql
ALTER TABLE geo_sites ADD COLUMN batch_id text;
CREATE INDEX idx_geo_sites_batch_id ON geo_sites(batch_id);
```

- Single-audit sites: `batch_id = null` (not a batch)
- Bulk-audit sites: all rows from the same CSV upload share the same `batch_id`

### 2. Set `batchId` at creation in `app/api/sites/route.ts`

In the bulk upload path (where N site rows are inserted), generate one
`batchId = nanoid()` before the loop and set it on every row:

```typescript
const batchId = nanoid();
// ... for each URL:
await db.insert(geoSites).values({
  ...siteData,
  batchId,  // same value for every row in this upload
});
```

### 3. Use `batchId` in `app/api/sites/[id]/verify/route.ts`

Replace the fragile three-condition query with:

```typescript
const batchSites = site.batchId
  ? await db.select().from(geoSites).where(eq(geoSites.batchId, site.batchId))
  : [site];
```

This query is safe regardless of when `verificationCode` is cleared — `batchId`
is never set to null after creation.

---

## New Artifacts

| File | Change |
|------|--------|
| `lib/db/migrations/20260302-batch-id.sql` | New — ALTER TABLE + CREATE INDEX |
| `lib/db/schema.ts` | Add `batchId: text("batch_id")` to `geoSites` table definition |
| `app/api/sites/route.ts` | Generate `batchId = nanoid()` per upload; set on each inserted row |
| `app/api/sites/[id]/verify/route.ts` | Replace sibling query with `eq(geoSites.batchId, site.batchId)` |

---

## Migration File

`lib/db/migrations/20260302-batch-id.sql`:

```sql
-- TS-018: Add batchId to geo_sites for reliable bulk batch sibling lookup (issue #110)

ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS batch_id text;

CREATE INDEX IF NOT EXISTS idx_geo_sites_batch_id
  ON geo_sites(batch_id)
  WHERE batch_id IS NOT NULL;
```

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Single-audit site verifies | `site.batchId = null` → `batchSites = [site]` (fallback to self) |
| Old bulk sites (pre-migration, `batchId = null`) | Same fallback → `batchSites = [site]`; each site acts as a batch of one. Acceptable degradation for pre-existing rows. |
| Two verify requests for same batch race | Both query by `batchId` — stable, not null → both find full sibling list. Credit logic de-dupes by `siteId`. |
| Single URL bulk CSV (batch of 1) | `batchId` set, `batchSites` has 1 row → correct |

---

## Acceptance Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| BI-1 | Bulk upload sets same `batchId` on all N site rows | Insert 3-URL CSV; check DB — all 3 rows share `batch_id` |
| BI-2 | Single-audit sites have `batch_id = null` | Single URL submit; check DB row |
| BI-3 | Verify uses `batchId` query, not `verificationCode` | Read verify/route.ts — no `verificationCode` in sibling query |
| BI-4 | Race: verify called twice for same batch | Both complete successfully; credits deducted once (idempotent transaction) |
| BI-5 | Old sites with `batchId = null` verify correctly | Manual test on pre-migration row; acts as batch of one |
| BI-6 | Existing 815 tests still pass | `vitest run` → 0 failing |

---

## Risks

| Risk | Mitigation |
|------|------------|
| Old bulk rows (no `batchId`) may not find siblings | Fallback to `[site]` (self-only batch) is safe — credits already calculated at creation time for old rows |
| `nanoid()` collision across batches | Probability negligible (21 chars, URL-safe alphabet) |
| Index on nullable column wastes space | Partial index `WHERE batch_id IS NOT NULL` avoids indexing null rows |
