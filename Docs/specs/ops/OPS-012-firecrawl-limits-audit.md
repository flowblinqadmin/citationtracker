# OPS-012: Firecrawl Limits Audit — Validate Capacity for 8000-URL Manipal Crawl

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#90](https://github.com/flowblinqadmin/geo/issues/90)  
> **Delivery Commit:** `53a588a`  

---

**Source:** TS-012-firecrawl-limits-audit.md
**Agent:** 2-SpecMaster
**Date:** 2026-03-01
**Downstream:** OpsMaster (agent 3)
**GitHub Issue:** #90
**Milestone:** Launch: 1st Customer — Manipal Hospitals
**Priority:** P0-critical — must complete before Manipal run
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)

---

## a) Overview

### What This Covers

Research + documentation task to confirm Flowblinq's Firecrawl Standard plan can sustain the full 8000-URL Manipal crawl (16 × 500-URL chunks per OPS-010). Produces a go/no-go recommendation and a pre-run runbook.

**No code changes.** All output is documentation.

### Current State

- **Pipeline:** OPS-010 implemented `chunked-firecrawl.ts` (500 URLs/chunk, 16 chunks for 8000 URLs)
- **Capability findings:** `geo/docs/firecrawl-capability-findings.md` (written by OpsMaster during OPS-010 Task 3) — rate limits, polling model, partial results already documented there
- **Failure recovery:** `geo/docs/pipeline-failure-recovery.md` (OPS-010 Task 5) — resume procedure already documented
- **Plan:** Firecrawl Standard ($83/mo) — assumed active; Task 1 confirms

### Dependency Note

DB migration (#100) is a parallel dependency owned by Adithya Rao — **not OpsMaster's responsibility.** Do not block on it.

---

## b) Implementation Requirements

### Task 1 — Audit current Firecrawl account state

Check the Firecrawl dashboard (`https://firecrawl.dev`, account section) and/or Firecrawl API:

| Item | What to find |
|------|-------------|
| Plan | Confirm Standard plan is active and not in trial/expired state |
| Credits remaining | Current credit balance this billing cycle |
| Credits per URL | Cost per URL for batch/scrape (per URL? per job submission?) |
| Billing reset date | When the cycle resets — affects timing of the Manipal run |
| Overage policy | Hard stop when credits exhausted, or charged overage? |

**Output:** Fill in the findings table in `geo/docs/manipal-crawl-runbook.md` (Task 4).

---

### Task 2 — Model the 8000-URL crawl cost

Using Task 1 findings, calculate:

```
creditsPerUrl     = (from Task 1)
totalCreditsNeeded = 8000 × creditsPerUrl
creditsRemaining  = (from Task 1)
creditSurplus     = creditsRemaining - totalCreditsNeeded
                    (positive = sufficient; negative = top-up required)

topUpNeeded (if deficit):
  deficit      = abs(creditSurplus)
  topUpAmount  = ceil(deficit / creditsPerTopUpUnit) × topUpUnitCost  (in USD)
```

Also estimate wall-clock time:
```
chunkDurationEstimate = (from firecrawl-capability-findings.md or observed timing in OPS-010 tests)
pollingOverhead       = (FIRECRAWL_POLL_INTERVAL_MS × polls_per_chunk)
totalEstimatedTime    = 16 × (chunkDurationEstimate + pollingOverhead)
```

**Output:** Numbers go into `geo/docs/manipal-crawl-runbook.md`.

---

### Task 3 — Confirm rate limits won't block the run

Cross-reference `geo/docs/firecrawl-capability-findings.md` against the sequential chunk submission pattern:

| Check | Question | Answer (OpsMaster fills) |
|-------|----------|--------------------------|
| Concurrent job limit | Standard plan: is simultaneous chunk submission blocked, or is one-at-a-time safe? | TBD |
| Batch/scrape rate limits | Are batch/scrape endpoints subject to separate rate limits from crawl endpoints? | TBD |
| Polling rate limit | Polling 16 chunks at 15s intervals = ~4 API calls/minute. Does this stay within limits? | TBD |
| Per-hour cap | Any undocumented hourly cap that 16 sequential chunks might hit? | TBD |

**If any check reveals a limit that blocks the run:** document the constraint and the mitigation (e.g., increase polling interval, submit chunks with a deliberate delay, upgrade plan).

---

### Task 4 — Write `geo/docs/manipal-crawl-runbook.md`

**New file.** Maximum 150 lines. Structure:

```markdown
# Manipal Crawl Runbook — 8000-URL Audit

## 1. Go / No-Go
[One of: GO | NO-GO — TOP-UP REQUIRED | NO-GO — PLAN UPGRADE REQUIRED]
[One paragraph justification with numbers]

## 2. Account State
| Field | Value |
Credits remaining: X
Credits needed: Y
Surplus / deficit: Z
Billing reset: YYYY-MM-DD
Overage policy: [hard stop | charged]

## 3. Cost Model
Credits per URL: N
Total credits for 8000 URLs: N
Top-up required: [None | $X for Y credits]

## 4. Timing Estimate
Chunk duration estimate: Xm
Polling overhead per chunk: Ys
Total estimated run time: ~Zh Zm

## 5. Pre-Run Checklist
- [ ] Firecrawl credits confirmed sufficient (or top-up purchased)
- [ ] DB migration #100 applied (coordinate with Adithya Rao)
- [ ] firecrawl_jobs table confirmed in production DB
- [ ] Test Supabase project isolated from production
- [ ] Test user with active Pro account and sufficient Flowblinq credits ready
- [ ] .env.production has FIRECRAWL_API_KEY set
- [ ] Staging run (100 URLs) completed without errors (ES-009 Tier 2 passed)
- [ ] pipeline-failure-recovery.md read by operator

## 6. Monitoring During the Run
- Firecrawl dashboard: watch active jobs and credit balance
- Supabase: SELECT * FROM firecrawl_jobs ORDER BY created_at — watch status transitions
- Vercel logs: filter for [chunked-crawl] prefix — chunk completions, failures, retries
- Expected: one [chunked-crawl] "Chunk N completed" log every ~Xm

## 7. If Run Fails Mid-Way
[Reference pipeline-failure-recovery.md — summarize resume procedure in 3 steps]
```

---

## c) Unit Test Plan

Not applicable — research and documentation task only.

---

## d) Integration Test Plan

Not applicable. The 100-URL staging run (ES-009 Tier 2) serves as the integration validation. OpsMaster should confirm Tier 2 passed before declaring go.

---

## e) Profiling Requirements

Not applicable directly. However, the chunk duration estimate in Task 2 should be derived from:
1. Firecrawl documentation (documented average batch/scrape time per URL)
2. Observed timing from ES-009 Tier 2 load test (100 URLs actual duration), if available

If Tier 2 timing is available: `chunkDurationEstimate = (100-URL observed duration / 100) × 500`.

---

## f) Load Test Plan

Not applicable. This spec is the prerequisite research before the Manipal run, not the run itself.

---

## g) Logging & Instrumentation

No code changes — no logging requirements. The runbook's "Monitoring" section (Task 4 §6) covers what to watch during the actual run.

---

## h) Acceptance Criteria

- [ ] Task 1: Current Firecrawl credit balance documented with source (dashboard screenshot or API response)
- [ ] Task 2: Credit cost for 8000-URL run calculated; surplus or deficit stated explicitly
- [ ] Task 2: Top-up amount and cost stated if deficit exists
- [ ] Task 2: Estimated wall-clock time for full run stated
- [ ] Task 3: Rate limit checks completed — all four rows in findings table filled
- [ ] Task 3: Any blocking limit documented with mitigation
- [ ] Task 4: `geo/docs/manipal-crawl-runbook.md` written, ≤ 150 lines, all 7 sections present
- [ ] Task 4: Go/no-go stated explicitly as first line of §1
- [ ] GitHub issue #90: comment posted with summary (go/no-go, credit numbers, estimated time)
- [ ] No code files modified

---

## Notes for OpsMaster

- **Read `geo/docs/firecrawl-capability-findings.md` first** (written during OPS-010 Task 3) — most rate limit data is already there. Task 3 of this spec is a cross-check, not a fresh research pass.
- **Firecrawl dashboard login:** `https://firecrawl.dev` — credentials in 1Password or `.env.local` (`FIRECRAWL_API_KEY` owner's account).
- **If capability findings doc does not exist yet** (OPS-010 Task 3 not complete): complete that task first, then return to this spec. OPS-012 depends on OPS-010 Task 3.
- **Go/no-go is the primary output.** The runbook is the artifact. Everything else feeds into that decision.
- **Post to GitHub issue #90** after the runbook is written — this closes the issue if go, or flags the blocker if no-go.
