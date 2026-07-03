# TS-046: Regenerate Endpoint — Rollback on QStash Enqueue Failure

**Status:** Ready for ScriptDev
**Priority:** P0 (causes stuck audits)
**Branch:** `feat/per-page-fixes`
**Scope:** 1 file

---

## Bug

`POST /api/sites/[id]/regenerate` updates the database (`pipelineStatus = "discovery"`, deducts credits) **before** calling `enqueueStage()`. If `enqueueStage()` fails (QStash unreachable, DNS failure, timeout), the site is left in `"discovery"` state permanently with credits already deducted. No pipeline stage is enqueued, so nothing ever progresses. The user sees a stuck "audit in progress" with no recovery path.

**Observed:** User clicked "Refresh My Score" → API returned 500 (QStash DNS failure) → DB already set to `discovery` → UI showed audit running → nothing happened.

## Root Cause

`app/api/sites/[id]/regenerate/route.ts`

**Team path (lines 93-125):**
```
line 93-123:  db.transaction() — sets pipelineStatus="discovery", deducts credits
line 125:     enqueueStage() — can fail after DB is committed
```

**Free path (lines 151-160):**
```
line 151-158:  db.update() — sets pipelineStatus="discovery"
line 160:      enqueueStage() — can fail after DB is committed
```

Both paths: DB committed → enqueue attempted → if enqueue fails, DB is dirty.

## Fix

Wrap `enqueueStage()` in a try/catch. On failure, **roll back** the DB state:

### Team path (lines 93-136)

```typescript
await db.transaction(async (tx) => {
  await tx
    .update(geoSites)
    .set({
      pipelineStatus: "discovery",
      pipelineError: null,
      creditsReserved: creditsToReserve,
      updatedAt: now,
    })
    .where(eq(geoSites.id, id));

  await tx
    .update(teams)
    .set({
      creditBalance: sql`${teams.creditBalance} - ${creditsToReserve}`,
      updatedAt: now,
    })
    .where(eq(teams.id, site.teamId!));

  await tx.insert(creditTransactions).values({
    id: nanoid(),
    teamId: site.teamId!,
    siteId: id,
    type: "crawl_reserve",
    pagesConsumed: maxPages,
    creditsChanged: -creditsToReserve,
    balanceBefore,
    balanceAfter,
    createdAt: now,
  });
});

try {
  await enqueueStage({ siteId: id, domain: site.domain, stage: "discover", maxPages });
} catch (enqueueErr) {
  console.error("enqueueStage failed, rolling back DB state:", enqueueErr);
  // Rollback: restore site status + refund credits
  await db.transaction(async (tx) => {
    await tx
      .update(geoSites)
      .set({
        pipelineStatus: site.pipelineStatus,  // restore original status
        pipelineError: null,
        creditsReserved: 0,
        updatedAt: now,
      })
      .where(eq(geoSites.id, id));

    await tx
      .update(teams)
      .set({
        creditBalance: sql`${teams.creditBalance} + ${creditsToReserve}`,
        updatedAt: now,
      })
      .where(eq(teams.id, site.teamId!));

    // Delete the reserve transaction we just inserted
    // Or insert a reversal — reversal is safer (append-only ledger)
    await tx.insert(creditTransactions).values({
      id: nanoid(),
      teamId: site.teamId!,
      siteId: id,
      type: "crawl_reserve_reversal",
      pagesConsumed: 0,
      creditsChanged: creditsToReserve,  // positive = refund
      balanceBefore: balanceAfter,
      balanceAfter: balanceBefore,
      createdAt: now,
    });
  });

  return NextResponse.json(
    { error: "Failed to start pipeline. Credits have been refunded. Please try again." },
    { status: 503 }
  );
}
```

### Free path (lines 151-168)

```typescript
await db
  .update(geoSites)
  .set({
    pipelineStatus: "discovery",
    pipelineError: null,
    updatedAt: now,
  })
  .where(eq(geoSites.id, id));

try {
  await enqueueStage({ siteId: id, domain: site.domain, stage: "discover", maxPages: FREE_MAX_PAGES });
} catch (enqueueErr) {
  console.error("enqueueStage failed (free path), rolling back:", enqueueErr);
  await db
    .update(geoSites)
    .set({
      pipelineStatus: site.pipelineStatus,  // restore original
      pipelineError: null,
      updatedAt: now,
    })
    .where(eq(geoSites.id, id));

  return NextResponse.json(
    { error: "Failed to start pipeline. Please try again." },
    { status: 503 }
  );
}
```

### creditTransactions schema note

The `type` column may need `"crawl_reserve_reversal"` added as a valid value. Check if it's an enum or free-text string. If enum, add the new variant. If string, no change needed.

---

## Acceptance Criteria

1. If `enqueueStage()` fails, `pipelineStatus` is restored to its previous value (not left as `"discovery"`)
2. If `enqueueStage()` fails on team path, credits are refunded (reversal transaction inserted)
3. User sees "Failed to start pipeline. Please try again." (503), not "Internal server error" (500)
4. If `enqueueStage()` succeeds, behavior is unchanged
5. The reversal transaction maintains append-only ledger integrity (no DELETE)

## Files to modify

| File | Change |
|------|--------|
| `app/api/sites/[id]/regenerate/route.ts` | Wrap `enqueueStage()` in try/catch with DB rollback on both paths |

## Testing

- Mock `enqueueStage` to throw → verify pipelineStatus unchanged, credits refunded, 503 returned
- Normal flow → verify pipelineStatus = "discovery", credits deducted, 202 returned
