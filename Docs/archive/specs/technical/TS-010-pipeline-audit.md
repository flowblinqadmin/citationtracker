# TS-010: Pipeline Architecture Audit — Firecrawl-Only + Native Retry/Resume

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#88](https://github.com/flowblinqadmin/geo/issues/88) · [#98](https://github.com/flowblinqadmin/geo/issues/98)  
> **Delivery Commit:** `14b06c8`  

---

**Agent:** CoFounder (1)
**Date:** 2026-03-01
**GitHub Issue:** #98
**Milestone:** Launch: 1st Customer — Manipal Hospitals
**Downstream:** OPS-010 → **OpsMaster (agent 3)**
**Priority:** P0-critical (prerequisite to any large Manipal crawl run)

---

## What

An architectural audit of the crawl pipeline to:
1. Confirm (and enforce) Firecrawl-only operation — removing Jina and Apify if still present
2. Map Firecrawl's native capabilities for partial results, job polling, retry, and resumption
3. Implement chunked job submission + Firecrawl job ID persistence for large-scale crawls
4. Document the failure recovery model in the codebase

## Why

The Manipal 8000-page audit is the first customer deliverable. The pipeline was originally designed with Jina (primary) + Apify (fallback) + Firecrawl (map phase only). For 8000 pages:
- Multiple crawlers = unpredictable behavior, split costs, inconsistent output
- Without chunked job submission + persistence, a mid-crawl Firecrawl failure restarts from zero
- Firecrawl Standard ($83/mo) is already paid — no justification for other crawlers

A clean, single-crawler pipeline with native retry/resume is a prerequisite before executing the Manipal run.

---

## Current State (known)

| Crawler | Role in current pipeline | Status |
|---------|------------------------|--------|
| Firecrawl | URL discovery (map phase) + per-page scrape in bulk pipeline (ES-005) | Active |
| Jina | Primary single-page crawler | Possibly still present — audit required |
| Apify | Fallback crawler | Possibly still present — audit required |

**Working assumption:** ES-005 (bulk pipeline) is Firecrawl-only for the bulk path. The single-URL audit path may still reference Jina/Apify. OpsMaster must confirm by reading the source.

---

## Tasks for OpsMaster

### Task 1 — Audit crawler usage across the codebase

Search the codebase for all references to Jina and Apify:
```
grep -r "jina" src/ --include="*.ts" -l
grep -r "apify" src/ --include="*.ts" -l
grep -r "JINA" src/ --include="*.ts" -l
grep -r "APIFY" src/ --include="*.ts" -l
```
Also check `.env.example` and any config files for Jina/Apify API keys.

**Output:** List of files still referencing Jina or Apify.

---

### Task 2 — Remove Jina and Apify from the pipeline

For each file found in Task 1:
- Remove Jina/Apify import, API call, and fallback logic
- Replace with Firecrawl equivalent (or mark URL as `failed` if Firecrawl returns no content)
- Do NOT remove error handling — just remove the Jina/Apify-specific branches

**No feature regression:** Single-URL audit must still complete after removal.

---

### Task 3 — Map Firecrawl API capabilities (research task)

Read Firecrawl API documentation and confirm which of the following are available on the Standard plan:

| Capability | Question | Finding |
|------------|----------|---------|
| Job polling | Can we poll a crawl job ID for status? | TBD |
| Partial results | If a crawl job fails mid-way, are completed pages returned? | TBD |
| Per-URL retry | Can we re-submit specific failed URLs to a new job? | TBD |
| Webhook callbacks | Does Firecrawl push completion/failure, or poll-only? | TBD |
| Native resume | Is there a built-in resume-from-checkpoint API? | TBD |
| Batch size limits | What is the max URLs per crawl job on Standard? | TBD |

**Output:** Fill in the "Finding" column. This drives Task 4 design.

Firecrawl docs: https://docs.firecrawl.dev (reference; OpsMaster should fetch directly)

---

### Task 4 — Implement chunked job submission for large crawls

**Goal:** For crawls > 500 URLs (Manipal is 8000), submit in chunks so a partial failure doesn't restart from zero.

**Design:**
```
Input: [url_1 ... url_8000]
  ↓
Chunk into batches of N (N = Firecrawl max batch size from Task 3)
  ↓
For each chunk:
  POST /firecrawl/crawl → returns job_id
  Persist job_id + chunk index + URL range to DB
  ↓
Poll each job_id for completion
  ↓
On job failure: re-submit only failed URLs, not entire chunk
  ↓
On all chunks complete: assemble results
```

**DB schema additions (if not already present):**
```sql
-- firecrawl_jobs table
id              uuid primary key
bulk_audit_job_id  uuid references bulk_audit_jobs(id)
firecrawl_job_id   text  -- the ID returned by Firecrawl POST
chunk_index     int
url_count       int
status          text  -- pending | running | partial | completed | failed
urls_submitted  text[] -- URLs in this chunk
urls_completed  text[] -- URLs with results
created_at      timestamptz
updated_at      timestamptz
```

If `firecrawl_jobs` table already exists with a different schema, adapt rather than replace.

---

### Task 5 — Document failure recovery model

Create or update: `docs/pipeline-failure-recovery.md`

Must cover:
1. What triggers a Firecrawl job failure (timeout, rate limit, server error)
2. How the pipeline detects the failure (polling interval, error code)
3. What data is preserved on partial failure (completed page results)
4. How re-submission of failed URLs works (manual trigger vs automatic)
5. What the operator (us) needs to do manually vs what is automatic
6. How a failed Manipal run would be resumed without re-crawling 7500 already-done pages

Keep it short (< 200 lines). This is a reference doc, not a design doc.

---

## Interfaces

### Inputs
- Source code in `dev-an-m2-extended` branch
- Firecrawl API docs (fetch directly; confirm plan tier = Standard)
- Current DB schema (check `lib/db/schema.ts`)

### Outputs
| Artifact | Location |
|----------|----------|
| Jina/Apify removal | Modified source files in `src/` (or wherever crawl logic lives) |
| DB migration | `lib/db/migrations/YYYYMMDD-firecrawl-jobs.sql` |
| Failure recovery doc | `docs/pipeline-failure-recovery.md` |
| Issue #98 comment | Summary of findings posted to GitHub issue |

---

## Acceptance Criteria

- [ ] No references to Jina or Apify in crawl pipeline (grep returns zero results)
- [ ] Single-URL audit still completes after Jina/Apify removal
- [ ] Firecrawl capabilities documented (Task 3 findings added to issue #98 comment or doc)
- [ ] Chunked job submission implemented for batches > 500 URLs
- [ ] `firecrawl_job_id` persisted in DB for each chunk
- [ ] Failed-URL retry submits to Firecrawl (not a custom re-crawl loop)
- [ ] Failure recovery model documented in `docs/pipeline-failure-recovery.md`
- [ ] Pipeline tested against a known partial-failure scenario (mock Firecrawl 500 → verify resume)

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Firecrawl Standard has no native partial-result API | Medium | If true, build minimal checkpoint on our side: persist completed page IDs to DB before job ends |
| Jina/Apify removal breaks single-URL audit path | Medium | Run existing single-URL tests after removal (ES-002/003/004 acceptance criteria) |
| Chunked submission hits Firecrawl rate limits | Low-Medium | Add exponential backoff between chunk submits; log throttling |
| DB migration conflicts with active `dev-an-m2-extended` work | Low | Coordinate with ScriptDev before applying migration |

---

## Notes for OpsMaster

- This is **read + write** work: audit (read source), remove code (write), implement chunking (write), document (write).
- Do NOT run the 8000-URL crawl yet — this spec just makes the pipeline ready for it.
- After completing Task 3 (capability mapping), ping CoFounder with findings before implementing Task 4 — design may need adjustment based on what Firecrawl actually supports.
- Issue #90 (Firecrawl limits audit for 8000-URL run) is a separate task (TS-011, to follow). This spec (TS-010) is the prerequisite.
