# TS-012: Firecrawl Limits Audit — Validate Capacity for 8000-URL Manipal Crawl

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#90](https://github.com/flowblinqadmin/geo/issues/90)  
> **Delivery Commit:** `53a588a`  

---

**Agent:** CoFounder (1)
**Date:** 2026-03-01
**GitHub Issue:** #90
**Milestone:** Launch: 1st Customer — Manipal Hospitals
**Downstream:** OPS-012 → OpsMaster (agent 3)
**Priority:** P0-critical — must complete before Manipal run

---

## What

Audit Flowblinq's current Firecrawl Standard plan limits and confirm we have sufficient capacity to complete Manipal's 8000-URL crawl without hitting rate limits, credit caps, or concurrent job limits. Produce a go/no-go recommendation with supporting numbers.

## Why

OPS-010 implemented chunked batch/scrape (500 URLs/chunk, 16 chunks for 8000 URLs). But we haven't confirmed whether the Standard plan ($83/mo) can sustain 16 sequential batch jobs without exhausting credits, triggering rate limits, or hitting undocumented concurrent job caps. Running into a hard limit mid-crawl wastes time and risks the customer engagement.

---

## Tasks for OpsMaster

### Task 1 — Audit current Firecrawl account state
Check the Firecrawl dashboard or API:
- Current plan: Standard ($83/mo) — confirm active
- Credits remaining this billing cycle
- Credits consumed per batch/scrape request (per URL? per job?)
- Reset date for the current billing cycle
- Any overage policy (hard stop vs. charged overage)

### Task 2 — Model the 8000-URL crawl cost
Using findings from Task 1:
- Credits required for 8000 URLs at current consumption rate
- Whether remaining credits are sufficient, or if a top-up is needed before the run
- Estimated wall-clock time for 16 × 500-URL chunks (chunk duration × 16, accounting for polling intervals)

### Task 3 — Confirm rate limits won't block the run
From the capability findings doc (`geo/docs/firecrawl-capability-findings.md`):
- Standard plan: 50 concurrent browsers, 50 crawl req/min
- For batch/scrape (not crawl): confirm if separate rate limits apply
- Confirm sequential chunk submission (one at a time) stays within limits
- Identify any per-minute or per-hour API call limits that polling at 15s intervals might hit

### Task 4 — Go/no-go recommendation + runbook
Produce a short doc: `geo/docs/manipal-crawl-runbook.md`

Must cover:
1. **Go/no-go:** Can we run 8000 URLs on current plan without interruption?
2. **If no-go:** What's needed (top-up amount, plan upgrade, timing)?
3. **Timing:** Estimated total duration for the 8000-URL run
4. **Pre-run checklist:** Steps before starting (credit check, migration confirmed, test user ready)
5. **Monitoring:** What to watch during the run (Firecrawl dashboard, Supabase job rows, Vercel logs)
6. **If it fails mid-run:** How to resume from the last completed chunk (per pipeline-failure-recovery.md)

---

## Acceptance Criteria

- [ ] Current Firecrawl credit balance documented
- [ ] Credit cost per 8000-URL run calculated
- [ ] Sufficient credits confirmed (or top-up flagged with amount)
- [ ] Rate limits verified — sequential 500-URL chunks won't be throttled
- [ ] `geo/docs/manipal-crawl-runbook.md` written (< 150 lines)
- [ ] Go/no-go recommendation stated explicitly
- [ ] Comment posted on GitHub issue #90 with summary

---

## Notes for OpsMaster

- Firecrawl dashboard: https://firecrawl.dev (check account section)
- Capability findings already documented: `geo/docs/firecrawl-capability-findings.md`
- Failure recovery already documented: `geo/docs/pipeline-failure-recovery.md`
- DB migration (#100) is a parallel dependency — coordinate with Adithya Rao (flowblinqadmin), not your responsibility
- This is research + documentation only — no code changes
