# TS-084 — Bulk audit tree extractor races against chunked crawl

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-09
**Priority:** P1 — promoted from P2 per HolePoker HP-177. TS-084 is the timing-race prevention layer for future bulk audits (existing broken customers are rescued separately by TS-086 NEW AC-15).
**Scope:** GEO app — bulk audit pipeline (`app/api/pipeline/stage/route.ts`, `lib/services/tree-extractor.ts` orchestration)
**Related:** TS-083, TS-085, TS-086 (sibling bulk-audit improvements). TS-086 NEW AC-15 supersedes the original TS-084 AC-4 (empty-tree rescue path) by amending the lazy re-extraction trigger to detect empty trees by structure.
**Status:** AMENDED 2026-04-09 (round 3) per HolePoker HP-177/HP-178 + observation O-1 + SpecMaster ES-084 recon (current code already meets AC-1+AC-2); REFRAMED AS REGRESSION GUARD; DISPATCHED TO SCRIPTDEV

---

## 0. Recon update (SpecMaster ES-084, 2026-04-09 round 3)

**SpecMaster's recon during ES-084 writing found that the current code at `app/api/pipeline/stage/route.ts:469-470` already satisfies AC-1 + AC-2.** `handleMergeCrawl` already enqueues `extract-trees` AFTER writing `crawlData` and after merge completion. The extract-trees stage is a separate QStash invocation driven by the merge-crawl stage exit, not an in-line call.

**Implication:** the Manipal customer's empty trees (extractedAt 08:50:49) were NOT caused by a tree-extractor-runs-before-merge-crawl race. They were caused by TS-086's LLM bugs (wrong Anthropic field name + insufficient budget + 35s Promise.race timeout) firing before any LLM call could complete. The extraction ran AT THE RIGHT TIME but FAILED because the LLM call never returned.

**ES-084 reframed by SpecMaster as a regression guard** (Option A, recommended by SpecMaster and confirmed by CoFounder 2026-04-09T20:30Z):
- Keep AC-1 + AC-2 as regression guards — integration tests that prevent accidental future reordering of the pipeline
- Keep AC-3 (`tree_extraction_failed_at` column) as an operator-monitoring timestamp
- Drop the implementation premise that the code currently has a timing race — it doesn't
- Net implementation: ~20 LOC (DDL + wire-up in handleExtractTrees catch path) + 10 tests (5 UT + 5 IT)
- Smallest spec in the sprint

**ScriptDev MUST NOT modify `handleMergeCrawl`.** The IT1 integration test is the regression guard against accidental modification. If ScriptDev finds themselves touching handleMergeCrawl, stop and surface to CoFounder — the recon premise is wrong.

The TS-084 sections below describe the ORIGINAL framing (bug premise) for historical context. Treat ES-084 §a as the authoritative scope for implementation.

## 1. What

In bulk audit mode, the tree extractor (`extractTrees`) runs BEFORE the chunked crawl completes. It sees an incomplete page set, returns empty trees, persists them, and never re-runs. The empty trees then propagate through the rest of the pipeline (research, analyze, prompt generation, citation check) producing degraded dimensional outputs.

This spec ensures the tree extractor either:
1. Waits for all crawl chunks to complete before running (block on chunk completion event), OR
2. Re-runs after crawl completion in a follow-up stage, OR
3. Runs as the LAST stage before research, not in parallel with crawl.

## 2. Why

### 2.1 Concrete evidence (Manipal customer)

Manipal customer site `-GzFX1KcKhmN0W_1t8SmY` was crawled 2026-04-08. The customer's `geo_tree` has:

```json
{
  "root": { "id": "global", "name": "Global", "level": "global", "children": [], "evidence": [], "pageCount": 0 },
  "leafCount": 0,
  "extractedAt": "2026-04-08T08:50:49.273Z"
}
```

The customer's site `updated_at` is `2026-04-08T11:29:42` — **~2.5 hours after** the tree was extracted. The pipeline ran:
1. Discover (08:00)
2. Crawl-fanout / poll-chunk / merge-crawl (08:00 - 11:00, chunked)
3. Tree extraction (08:50:49 — early in the crawl, BEFORE merge-crawl completed)
4. Research, analyze, generate, assemble (11:00 - 11:29)

The tree extractor saw whatever pages had been crawled and merged at 08:50 — likely the first 1-2 chunks (~50-100 pages of the eventual 241). Half of those were probably blog posts. Not enough signal to populate trees. The function ran, returned empty trees, and persisted them. The `extractedAt` timestamp shows when this happened.

### 2.2 Compounding with TS-086 (REFRAMED 2026-04-09 per HolePoker HP-177)

TS-086 fixes the LLM call so that when tree extraction runs against a complete page set, it actually produces populated trees. TS-084 ensures the call happens at the right time — AFTER the chunked crawl merges all pages.

Separation of concerns after the 2026-04-09 amendments:
- **TS-086 NEW AC-15** handles the rescue path for EXISTING affected customers by amending the lazy re-extraction trigger in `app/api/sites/[id]/citation-check/route.ts:107` to detect non-NULL empty trees by structure (via `treeIsEmpty(...)`). On the next citation check, the existing customers' empty trees get re-extracted with the fixed TS-086 code.
- **TS-084** handles the prevention path for FUTURE bulk audits by moving tree extraction from early-in-pipeline (where the crawl is incomplete) to after `merge-crawl` (where all pages are available). Without TS-084, every new bulk audit would reproduce the empty-tree pattern and then rely on TS-086 AC-15 to re-extract during the first citation check — a confusing UX and unnecessary wasted work.

The original TS-084 framing ("P2 defense-in-depth after TS-086") was wrong in TWO ways per HP-177:
1. TS-086 alone doesn't rescue existing customers (they have non-NULL empty trees; the lazy trigger truthiness check skips them). **Now handled by TS-086 NEW AC-15.**
2. TS-084 is not cosmetic — bulk audits that don't fix the timing race still produce empty trees on first dashboard view, even after TS-086 ships. Customer UX regresses between audit completion and first citation check. TS-084 is the prevention layer.

TS-084 is now P1 and ships CONCURRENTLY with TS-086.

### 2.3 Architecture context

The bulk audit pipeline uses QStash for stage orchestration. Stages:
- `discover` (firecrawl mapUrl + classification)
- `crawl-fanout` (submit batch jobs)
- `poll-chunk` (status checks, fan-in)
- `merge-crawl` (flatten chunks + quality check + write `crawl_data`)
- `research` (Claude API competitive intel)
- `analyze` (8-pillar analysis)
- `generate-fanout` / `generate-chunk` (5 asset types)
- `assemble` (executive summary + bulk reconciliation)

The tree extractor is currently invoked from inside one of these stages (likely `analyze` or `research`). The bug is the timing of that invocation relative to `merge-crawl`.

## 3. Acceptance criteria

### 3.1 Tree extractor sequencing

- [ ] AC-1: Tree extractor (`extractTrees`) is invoked AFTER `merge-crawl` completes — i.e., the call site reads `crawl_data` from a row whose `pipeline_status` is `merged-crawl-done` or later.
- [ ] AC-2: Tree extractor invocation is ATOMIC with respect to crawl chunk writes — it cannot run while a chunk is still being merged.
- [ ] AC-3: If the tree extractor fails (LLM error, parse error), the empty fallback IS persisted (current behavior) AND a `tree_extraction_failed_at` timestamp is set on the geo_sites row.

  **Field consumer note (added 2026-04-09 per HolePoker observation O-1):** with TS-084 AC-4 removed (HP-177 amendment), the `tree_extraction_failed_at` field is **no longer read by any production code path**. The lazy re-extraction trigger (TS-086 AC-15) detects empty trees by structure via `treeIsEmpty(...)`, not by failure timestamp. The field is preserved for **operator monitoring only** — manual SQL queries to find recently-failed sites for diagnostics. If a future spec wants to act on the field, it must explicitly state which code path consumes it.

### 3.2 Re-extraction guard — REMOVED 2026-04-09 (superseded by TS-086 NEW AC-15)

**This section has been removed per HolePoker HP-177.** The original AC-4 required `tree_extraction_failed_at IS NOT NULL` which historical failures don't have, so it never would have rescued existing customers. TS-086 NEW AC-15 handles the rescue path by amending the lazy re-extraction trigger to detect empty trees by structure (via `treeIsEmpty` helper) — no failure timestamp required, works for ALL empty-tree sites including historical ones.

AC-5's 24-hour rate limit is also removed — the thundering herd risk is now handled by TS-086 NEW AC-22 (global semaphore with max 3 concurrent re-extractions).

### 3.3 Test coverage

- [ ] AC-6: Integration test that mocks the chunked crawl progression. Asserts that the tree extractor is NOT called until `merge-crawl` is complete.

## 4. Out of scope

- **TS-086** (tree extractor LLM bug) — must ship before TS-084 has any visible effect.
- **TS-083** (auto-discover brand pages).
- **TS-085** (pageType classifier).
- **Restructuring the entire QStash pipeline** — TS-084 is a targeted timing fix, not a re-architecture.
- **Backfilling existing broken sites** — covered by TS-086's lazy re-extraction code path; TS-084 only changes future audit behavior.

## 5. Risks

### 5.1 Pipeline latency increase

Moving tree extraction to AFTER merge-crawl adds ~30-180s to the bulk audit pipeline (depending on tree complexity). For a 5-10 minute audit this is 5-30% longer.

**Mitigation:** acceptable. The user experience improvement (populated dimensional data on first dashboard view) outweighs the latency cost.

### 5.2 QStash stage dependency

If tree extraction is moved into a new dedicated stage between `merge-crawl` and `research`, it adds a QStash hop. Each hop has a small failure surface (network, retry semantics).

**Mitigation:** the existing stage handlers already use the `enqueueStage` helper. Adding one more stage is mechanical.

### 5.3 Re-extraction loop safety — REMOVED 2026-04-09

Removed per HolePoker HP-178. The re-extraction thundering-herd risk is now owned by TS-086 NEW AC-22 (global semaphore, max 3 concurrent re-extractions). TS-084 no longer addresses this concern since it no longer owns the re-extraction trigger (TS-086 NEW AC-15 does).

## 6. Open questions

- **Q1: Should tree extraction be its own QStash stage or fold into `research`?** Folding into `research` keeps the stage count smaller but couples two LLM-heavy operations. Separating gives cleaner retry semantics. Recommend: separate stage, called `extract-trees`, between `merge-crawl` and `research`.
- **Q2: Re-extraction trigger — citation-check route only, or also a cron?** Currently TS-086's lazy extraction runs only on first citation check after audit. A cron could detect empty-tree-and-failed sites every hour and re-extract them proactively. Recommend: defer cron to follow-up; lazy extraction is sufficient for v1.

## 7. Cross-reference

- TS-086 (must ship first)
- TS-083 (sibling — auto-discover brand pages, complementary)
- TS-085 (sibling — pageType classifier)
- ES-053 (original tree extraction spec)
- ES-035 / ES-039 (event_outbox / chunked crawl orchestration foundation)

---

**End of TS-084.**
