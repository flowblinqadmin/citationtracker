# ES-084 — Bulk Audit Tree Extractor Races Against Chunked Crawl

**Author:** SpecMaster (Agent 2)
**Source TS:** geo/docs/specs/technical/TS-084-bulk-audit-tree-extractor-timing-race.md
**Date:** 2026-04-09
**Priority:** P1 (promoted from P2 per HP-177) — timing-race prevention for future bulk audits
**Pipeline pace:** Standard (sprint sibling — ships after ES-086 lands)
**Branch:** `fix/tree-extractor-and-bulk-audit` (sprint branch shared with ES-083 / ES-085 / ES-086)
**Downstream:** ReviewMaster (ES-NNN dev spec)
**HolePoker status:** TS-084 cleared rounds 1+2 (HP-177 / HP-178, both AC-4 and AC-5 removed as SUPERSEDED by ES-086 NEW AC-15 + AC-22)

---

## a) Overview — LOAD-BEARING RECON FINDING

### 🚩 SpecMaster recon find (load-bearing) — READ FIRST

**TS-084 §1 describes a bug that does NOT exist in the current code.** The spec says:

> "In bulk audit mode, the tree extractor (`extractTrees`) runs BEFORE the chunked crawl completes. It sees an incomplete page set, returns empty trees, persists them, and never re-runs."

But I verified against `geo/app/api/pipeline/stage/route.ts` line 442-470: **`extract-trees` is already enqueued from inside `handleMergeCrawl` at line 469**, AFTER the merge completes. Specifically:

```ts
// Line 442-470 of current stage/route.ts
async function handleMergeCrawl(siteId: string, domain: string): Promise<void> {
  // ... merges crawl chunks, scores quality, persists crawlData ...
  console.warn(`[stage:merge-crawl] ${domain}: ${pages.length} pages merged from ${chunkResults.length} chunks`);
  await enqueueStage({ siteId, domain, stage: "extract-trees" });  // ← line 469
}
```

And `handleExtractTrees` at line 474 reads `site.crawlData` which is the merged, final result.

**The Manipal customer's empty trees documented in TS-084 §2.1 were NOT caused by this timing race** — they were caused by TS-086's bugs (wrong Anthropic SDK field name + insufficient token budget + Promise.race timeout firing before LLM could complete). Once ES-086 lands, the Manipal customer's trees will populate correctly via the AC-15 lazy re-extraction trigger.

### What ES-084 actually does

Given the current code already has the correct sequencing, ES-084 becomes a **regression guard** rather than a fix. The work is:

1. **Lock the sequencing** with a regression test that asserts `extract-trees` is ONLY invoked from inside `handleMergeCrawl` (i.e., after `merge-crawl` completes).
2. **Add `tree_extraction_failed_at` timestamp field** (AC-3) as operator-monitoring only (no production consumer per the HP-177 amendment — TS-084 AC-4 and AC-5 were REMOVED, so no code path reads this field).
3. **Integration test** that mocks the chunked crawl progression and asserts `extract-trees` is NOT called until `merge-crawl` is complete.

ES-084 AC-4 and AC-5 are REMOVED per the HP-177 amendment — those were about re-extraction triggering and thundering-herd guards, both now owned by ES-086 (AC-15 + AC-22).

### Source TS reference

`geo/docs/specs/technical/TS-084-bulk-audit-tree-extractor-timing-race.md` — read end-to-end. Critical:
- **§2.2 (REFRAMED per HP-177)** — separation of concerns: ES-086 AC-15 handles rescue of existing customers; ES-084 handles prevention for future bulk audits
- **§3.2 (REMOVED per HP-177)** — the entire AC-4 + AC-5 section is removed; replaced by ES-086 AC-15 + AC-22
- **§3.1 AC-3 field-consumer note (added per O-1)** — `tree_extraction_failed_at` is now operator-monitoring-only (no production consumer); preserved for manual SQL diagnostics

### Current implementation state

| Surface | File | Lines (verified) | State |
|---|---|---|---|
| Pipeline stage orchestration | `geo/app/api/pipeline/stage/route.ts` | 442-470 (`handleMergeCrawl`) | **Already enqueues extract-trees at line 469 after merge completes.** AC-1 already met. |
| Extract-trees stage handler | `geo/app/api/pipeline/stage/route.ts` | 474-506 (`handleExtractTrees`) | Reads `site.crawlData` (the merged final result). Catch block is currently missing — failures fall through to the outer stage retry logic. Needs `tree_extraction_failed_at` timestamp write on failure path (AC-3). |
| Schema | `geo/lib/db/schema.ts` | 77-140+ | **Needs new column `tree_extraction_failed_at timestamp`** for AC-3 operator monitoring. |

### Out of scope (verbatim from TS-084 §4)

- TS-086 (tree extractor LLM bug) — must ship first
- TS-083 (auto-discover brand pages)
- TS-085 (pageType classifier)
- Restructuring the entire QStash pipeline
- Backfilling existing broken sites — covered by ES-086 AC-15

---

## b) Implementation Requirements

### b.1 Regression test (AC-6) — the load-bearing deliverable

File to create: `geo/__tests__/integration/pipeline/extract-trees-sequencing.integration.test.ts`

The test mocks the stage handlers and asserts:

```ts
it("extract-trees is enqueued only from handleMergeCrawl", async () => {
  // Snapshot: scan stage/route.ts for all `enqueueStage({ stage: "extract-trees" })` call sites
  // Assert: exactly ONE call site, inside handleMergeCrawl
});

it("handleMergeCrawl enqueues extract-trees after persisting crawlData", async () => {
  // Mock db.update and enqueueStage
  // Simulate handleMergeCrawl with valid chunk results
  // Assert: db.update(crawlData) called BEFORE enqueueStage(extract-trees)
});

it("handleExtractTrees reads the merged crawlData, not intermediate chunks", async () => {
  // Insert test row with crawlData = merged final result
  // Run handleExtractTrees
  // Assert: extractTrees is called with site.crawlData (not chunk-level data)
});
```

### b.2 `tree_extraction_failed_at` column (AC-3)

**Schema migration** — `geo/lib/db/migrations/000X_es084_tree_extraction_failed_at.sql`:

```sql
ALTER TABLE geo_sites
  ADD COLUMN tree_extraction_failed_at TIMESTAMP NULL;
```

**Schema TS update** — `geo/lib/db/schema.ts`, add field to `geoSites`:

```ts
// ES-084 AC-3: operator-monitoring only — no production consumer reads this field
// per HP-177 amendment. Set by handleExtractTrees catch block on failure.
treeExtractionFailedAt: timestamp("tree_extraction_failed_at"),
```

Insert near the other `geo_tree` / `category_tree` columns around line 106-108.

**Wire into `handleExtractTrees` catch path** — `geo/app/api/pipeline/stage/route.ts:474-506`. Currently the function does NOT have a try/catch around the extract call (it uses `Promise.race` and any failure would propagate up to the outer stage retry). Add explicit try/catch:

```ts
async function handleExtractTrees(siteId: string, domain: string): Promise<void> {
  const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
  if (!site) throw new Error("Site not found");

  if (!site.crawlData) {
    console.error(`[extract-trees] ${domain}: no crawlData, skipping`);
    await enqueueStage({ siteId, domain, stage: "research" });
    return;
  }

  await updateStatus(siteId, "extracting");

  try {
    const result = await Promise.race([
      extractTrees(
        site.crawlData as CrawlData,
        site.discoveryData as DiscoveryData,
        domain,
        site.siteType ?? undefined
      ),
      stageTimeout("extract-trees"),
    ]);

    await db.update(geoSites).set({
      geoTree: result.geoTree,
      categoryTree: result.categoryTree,
      geoCategoryMapping: result.mapping,
      pipelineStatus: "researching",
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));

    console.info(`[extract-trees] ${domain}: geoLeafCount=${result.geoTree.leafCount}, catLeafCount=${result.categoryTree.leafCount}, mappingEntries=${result.mapping.totalEntries}`);
  } catch (err) {
    // ES-084 AC-3: set tree_extraction_failed_at timestamp for operator monitoring
    console.warn(`[extract-trees] ${domain}: failed — ${(err as Error).message}`);
    await db.update(geoSites).set({
      treeExtractionFailedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(geoSites.id, siteId));
    // Re-throw so the outer stage retry / markFailed logic fires
    throw err;
  }

  await enqueueStage({ siteId, domain, stage: "research" });
}
```

**Field consumer note (AC-3 per HP-177 amendment):** with TS-084 AC-4 REMOVED, the `treeExtractionFailedAt` field is **no longer read by any production code path**. The ES-086 AC-15 lazy re-extraction trigger detects empty trees by STRUCTURE via the `treeIsEmpty` helper, not by failure timestamp. This field is preserved for **operator monitoring only** — manual SQL queries to find recently-failed sites for diagnostics. If a future spec wants to act on the field, it must explicitly state which code path consumes it.

### b.3 Files summary

| Action | Path | LOC est. |
|---|---|---|
| **CREATE** | `geo/lib/db/migrations/000X_es084_tree_extraction_failed_at.sql` | ~3 |
| **MODIFY** | `geo/lib/db/schema.ts` | +3 (column definition + comment) |
| **MODIFY** | `geo/app/api/pipeline/stage/route.ts` | +15 (try/catch around extract call in handleExtractTrees) |

**No new files besides the migration.** No new dependencies.

**Total impl LOC: ~20.** ES-084 is the smallest spec in the sprint because the primary fix (sequencing) is already in the code.

---

## c) Unit Test Plan

### c.1 New test file — `geo/__tests__/pipeline/handle-extract-trees.test.ts`

| # | Test | Setup | Assertion |
|---|---|---|---|
| U1 | Success path: handleExtractTrees updates crawlData-derived trees | Mock extractTrees to return populated trees. Mock db.select / db.update. | db.update called with the populated trees. `tree_extraction_failed_at` NOT set. `pipelineStatus === "researching"`. |
| U2 | Failure path: handleExtractTrees sets tree_extraction_failed_at | Mock extractTrees to throw | db.update called with `tree_extraction_failed_at: <current timestamp>`. The throw is re-thrown. |
| U3 | Timeout path: handleExtractTrees sets tree_extraction_failed_at on stageTimeout | Mock extractTrees to never resolve; let the Promise.race timeout | Same as U2 |
| U4 | No crawlData: skips extraction and enqueues research stage | Mock site row with `crawlData: null` | extractTrees NOT called. `enqueueStage({ stage: "research" })` called. |
| U5 | Success path does NOT set tree_extraction_failed_at | Mock success | `treeExtractionFailedAt` NOT written (or explicitly left null) |

### c.2 Coverage target

5 unit tests for the new try/catch wrapping behavior.

---

## d) Integration Test Plan

### d.1 New test file — `geo/__tests__/integration/pipeline/extract-trees-sequencing.integration.test.ts`

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT1 | Extract-trees NOT called until merge-crawl is complete (AC-1 + AC-6) | Mock the chunked crawl progression. Fire `poll-chunk` events until all chunks done. Track the order of `enqueueStage` calls. | `extract-trees` enqueueStage call happens AFTER the merge-crawl enqueueStage call. Never before. |
| IT2 | Sequence: merge-crawl completes → crawlData persisted → extract-trees enqueued | Run handleMergeCrawl with valid chunk results | Order: (1) db.update(crawlData), (2) enqueueStage(extract-trees). Assert via call-order spy. |
| IT3 | handleExtractTrees reads merged crawlData (not intermediate chunks) | Insert row with `crawlData` populated, `crawlChunkResults: null` | extractTrees invoked with `site.crawlData` (not an intermediate chunk slice) |
| IT4 | Regression: `enqueueStage({ stage: "extract-trees" })` call sites scan | Grep stage/route.ts for all call sites | Exactly ONE occurrence, inside `handleMergeCrawl` |
| IT5 | Failure propagation: extract-trees throws → tree_extraction_failed_at persisted | Insert row + mock extractTrees to throw | After call: DB row has `treeExtractionFailedAt !== null` |

### d.2 Total integration tests: 5 (IT1–IT5)

---

## e) Profiling Requirements

**Not applicable.** ES-084 doesn't add new latency surfaces. The existing `handleExtractTrees` timing is governed by ES-086's `EXTRACTION_TIMEOUT_MS` bump.

---

## f) Load Test Plan

**Not applicable.** No concurrency surface.

---

## g) Logging & Instrumentation

| Event | Level | Source | Payload |
|---|---|---|---|
| `[extract-trees] ${domain}: failed — ${err.message}` | warn | `handleExtractTrees` catch block | Existing free-form log; acceptable |

No new structured events required. The `tree_extraction_failed_at` column itself is the operator-visible signal.

---

## h) Acceptance Criteria

### h.1 Tree extractor sequencing (TS-084 §3.1)

- [ ] **AC-1:** Tree extractor (`extractTrees`) is invoked AFTER `merge-crawl` completes — i.e., the call site reads `crawl_data` from a row whose `pipelineStatus` has advanced past `merged-crawl-done`. **Status: already met by current code at `stage/route.ts:469`.** **Verified by:** IT1, IT2, IT3, IT4 (regression guard).
- [ ] **AC-2:** Tree extractor invocation is ATOMIC with respect to crawl chunk writes — cannot run while a chunk is still being merged. **Status: already met** — `handleMergeCrawl` is a QStash stage handler; it reads all chunks, merges, persists, then enqueues extract-trees as the LAST action. There's no concurrent path that could inject between the persist and the enqueue. **Verified by:** IT2 (call-order assertion).
- [ ] **AC-3:** If the tree extractor fails, the empty fallback IS persisted (current behavior — `extractTrees` returns `emptyGeoTree()` on last-resort path) AND `tree_extraction_failed_at` timestamp is set. **New column + catch-block wiring required.** **Verified by:** U2, U3, IT5.

### h.2 Re-extraction guard (REMOVED per HP-177)

- [ ] **AC-4:** ~~REMOVED~~ — superseded by ES-086 AC-15 (lazy re-extraction trigger uses `treeIsEmpty` structure detection).
- [ ] **AC-5:** ~~REMOVED~~ — superseded by ES-086 AC-22 (global semaphore).

### h.3 Test coverage (TS-084 §3.3)

- [ ] **AC-6:** Integration test mocks chunked crawl progression. Asserts extract-trees is NOT called until merge-crawl is complete. **Verified by:** IT1.

### h.4 Cross-cutting

- [ ] **AC-7:** No new external dependencies. DDL migration is the only schema change.
- [ ] **AC-8:** Sprint sequencing: ES-084 ships with ES-086 + ES-083 + ES-085 in the same branch / same merge.
- [ ] **AC-9:** The regression guard test at IT4 asserts there is EXACTLY ONE `enqueueStage({ stage: "extract-trees" })` call site in `stage/route.ts`, inside `handleMergeCrawl`. If a future contributor adds another call site (e.g., from `handleDiscover` or `handleCrawlFanout`), this test fails.

---

## Notes for downstream agents

### For ReviewMaster (Phase A)

1. **READ THE RECON FINDING IN §a FIRST.** ES-084 is largely a regression guard, not a fix. The primary timing race described in TS-084 §1 does not exist in the current code. AC-1 and AC-2 are already met.
2. **5 unit tests + 5 integration tests = 10 tests total across 2 new test files.** Much smaller than ES-086 / ES-085 / ES-083.
3. **IT1 is the load-bearing regression guard** — if a future refactor moves the `extract-trees` enqueueStage call out of `handleMergeCrawl`, this test fails and catches the regression.
4. **IT4 is the scan-based regression guard** — asserts exactly ONE call site. Use a simple grep via Node's `fs.readFileSync` or a static scan, not a runtime instrumentation.
5. **AC-3 failure timestamp is operator-monitoring only** — no production consumer reads this field. RM should verify the catch-block wiring writes it, but there's no downstream test to verify consumption (because there's nothing consuming it).
6. **Use DIFFERENT fixture identifiers than ScriptDev source.** Convention: `sequencing-fixture-rm-084`.

### For CostMaster

1. **Files (CREATE):** 1 (DDL migration)
2. **Files (MODIFY):** 2 (`schema.ts`, `stage/route.ts`)
3. **Test files (CREATE):** 2 (1 unit, 1 integration)
4. **DDL migration:** yes (1 nullable timestamp column `tree_extraction_failed_at`)
5. **Total LOC est.:** ~20 (impl) + ~150 (tests) = ~170. **Smallest spec in the sprint.**
6. **Branch:** `fix/tree-extractor-and-bulk-audit` (sprint shared)
7. **Lang:** `typescript`
8. **Sequencing:** ES-084 ships with the sprint. Can land in any order relative to ES-083 / ES-085 (all 3 are no-ops without ES-086).

### For CoFounder

1. **READ THE RECON FINDING.** TS-084 §1 describes a bug that the current code has already fixed. ES-084 becomes a regression guard rather than an active fix. The Manipal customer's empty trees were caused by TS-086 (LLM bugs), not by this timing race.
2. **Options for you:**
   - **A (recommended):** Ship ES-084 as specified — regression guard + operator-monitoring timestamp. Locks the sequencing so it can't regress.
   - **B:** Downgrade ES-084 to informational (close with "already met by current code") and skip it entirely. Saves ~20 LOC + 10 tests but loses the regression guard.
   - **C:** Investigate whether the Manipal crawl (08:50:49 timestamp in TS-084 §2.1) was from an OLDER version of the code where extract-trees DID run before merge-crawl. Could confirm via git blame on `handleMergeCrawl`. Not blocking for the sprint.
3. **My recommendation:** ship Option A. The regression guard is cheap and the operator-monitoring timestamp is mildly useful. It's the smallest spec in the sprint so it's low-cost.

---

**End of ES-084**
