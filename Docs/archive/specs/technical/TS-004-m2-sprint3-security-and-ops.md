# TS-004: M2 Sprint 3 — Security, Scoring & Alpha Operations

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#4](https://github.com/flowblinqadmin/geo/issues/4) · [#5](https://github.com/flowblinqadmin/geo/issues/5) · [#6](https://github.com/flowblinqadmin/geo/issues/6)  
> **Delivery Commit:** `507ab9f`  

---

**Agent:** 1-CoFounder
**Date:** 2026-02-26
**Branch:** `dev-an`
**Repo:** flowblinqadmin/geo
**Issues:** #9, #11, #12, #13
**Depends on:** TS-002 (Sprint 1), TS-003 (Sprint 2) — core monetization must be in place

---

## Overview

Sprint 3 is the polish and hardening pass before alpha launch. These issues are important but not on the critical path for the free/paid boundary — they can ship after Sprints 1+2.

| Issue | Category | Effort |
|-------|----------|--------|
| #11 | Security — customer allowlist | Medium |
| #13 | Security — DMZ formalization | Small |
| #9 | Feature — before/after scoring | Large |
| #12 | Operations — alpha onboarding | Medium |

Recommended build order: #11 → #13 → #9 → #12 (security first, then feature, then ops).

---

## Task 1: Customer Allowlist for /api/serve/* (#11)

### What
Protect the `/api/serve/*` endpoints (which serve GEO files on behalf of customers) from abuse. Implement a layered allowlist: known AI crawlers + verified customer domains + rate limiting for unknowns.

### Why
`/api/serve/*` traffic scales with customer count. Without protection, anyone can scrape all customer files or DDoS the endpoints. As alpha testers connect, this becomes a real attack surface.

### Current State
- Middleware (`middleware.ts`) blocks known malicious UAs (SQLMap, Nikto, etc.) and scanner paths
- No specific protection for `/api/serve/*` beyond the general bot blocking
- `geoCrawlLogs` table already logs every serve request with `botName`, `userAgent`, `ip`, `country`
- Domain verification exists (`domainVerified`, `verifyToken` on `geoSites`)

### Architecture

Three layers, evaluated in order:

```
Request to /api/serve/[slug]/*
    │
    ├─ Layer 1: Known AI Crawler? (UA match)
    │   → GPTBot, ClaudeBot, PerplexityBot, Googlebot, Bingbot, Applebot
    │   → ALLOW (these are the consumers we WANT)
    │
    ├─ Layer 2: Verified Customer Origin? (Referer/Origin header)
    │   → Check if Referer domain matches a verified domain in geo_sites
    │   → ALLOW (customer's own pages requesting their schema.js embed)
    │
    └─ Layer 3: Unknown traffic
        → Rate limit: 10 requests per slug per minute per IP
        → Beyond limit: 429 Too Many Requests
        → Below limit: ALLOW (could be legitimate browser, dev testing, etc.)
```

### Implementation

**Create `lib/crawler-allowlist.ts`:**

```ts
// Known AI crawler User-Agent patterns
export const AI_CRAWLER_UA_PATTERNS = [
  /GPTBot/i,
  /ClaudeBot/i,
  /PerplexityBot/i,
  /Googlebot/i,
  /GoogleExtended/i,
  /Bingbot/i,
  /Applebot/i,
  /cohere-ai/i,
  /meta-externalagent/i,
  /Bytespider/i,
  /CCBot/i,
];

export function isKnownAICrawler(userAgent: string): boolean {
  return AI_CRAWLER_UA_PATTERNS.some(p => p.test(userAgent));
}
```

**Middleware changes (`middleware.ts`):**

Add a specific handler for `/api/serve/*` paths:
1. Check UA against `isKnownAICrawler()` → pass through
2. Check Referer/Origin header against verified domains (query from DB or cache)
3. Apply per-slug per-IP rate limit for unknown traffic

**Note on DB lookups in middleware:** Middleware runs on the edge. DB queries in middleware add latency. Options:
- **Option A:** Cache verified domains in a Map with 5-minute TTL (simple, good enough for alpha)
- **Option B:** Move allowlist check into the serve route handlers themselves (not middleware)

Recommend **Option B** — keep middleware lightweight, add the allowlist check at the top of each serve route handler (`app/api/serve/[slug]/[file]/route.ts` or similar). The serve routes already query the DB to find the site by slug.

**Rate limiting:**
- Use a simple in-memory Map: `Map<string, { count: number, resetAt: number }>` keyed by `${slug}:${ip}`
- 10 requests per minute per slug per IP
- This is per-instance (Vercel serverless), so not globally consistent — but good enough for alpha. Upgrade to Redis/Upstash later if needed.

### Auto-Populate from Signup

When a customer verifies their domain (existing `domainVerified` flow), their domain is automatically "allowlisted" — Layer 2 checks `domainVerified === true` for the site matching the Referer domain. No separate allowlist table needed.

### Acceptance Criteria
- [ ] Known AI crawlers always pass through (test with GPTBot, ClaudeBot UAs)
- [ ] Verified customer domains pass through via Referer check
- [ ] Unknown traffic rate-limited at 10/min/slug/IP
- [ ] Rate-limited requests get 429 with `Retry-After` header
- [ ] No performance regression on serve endpoints (< 50ms added latency)
- [ ] `lib/crawler-allowlist.ts` is the single source for UA patterns

### Risks
- **LOW:** UA spoofing — attackers can fake GPTBot UA. Acceptable for alpha; add IP range verification later (Google publishes GPTBot IP ranges).
- **MEDIUM:** Referer can be spoofed. Again, acceptable for alpha — the rate limit catches bulk abuse regardless.

---

## Task 2: DMZ Architecture Formalization (#13)

### What
Audit and document the isolation between payment processing routes and the audit pipeline. Ensure no shared state or PII leakage.

### Why
Payment data (Stripe tokens, customer emails in payment context) must never mix with the audit pipeline (crawl data, analysis). This is both a security requirement and a compliance prerequisite.

### Current State (Partially Done)
- Stripe routes are already isolated: `/api/checkout/route.ts` and `/api/webhooks/stripe/route.ts`
- These routes only interact with `teams` and `creditTransactions` tables
- Pipeline routes (`/api/pipeline/run`, `/api/cron/recrawl`) only interact with `geoSites` and crawl data
- No direct import between payment and pipeline code

### What's Needed
1. **Audit:** Verify no pipeline code imports from payment routes or vice versa
2. **Document:** Create a DMZ boundary document listing which routes belong to which zone
3. **Enforce:** Add a lint rule or boundary comment convention

### Boundary Definition

| Zone | Routes | DB Tables | Notes |
|------|--------|-----------|-------|
| **Payment Zone** | `/api/checkout`, `/api/webhooks/stripe` | `teams` (credit fields only), `creditTransactions` | Stripe SDK imported here only |
| **Auth Zone** | `/auth/login`, `/auth/callback`, `/api/teams/*` | `teams`, `teamMembers`, `teamDomains` | Supabase auth SDK here |
| **Pipeline Zone** | `/api/pipeline/run`, `/api/cron/recrawl`, `/api/sites/[id]/regenerate` | `geoSites`, `teams` (credit check only) | Crawl + AI services |
| **Serve Zone** | `/api/serve/*` | `geoSites` (read-only) | Public-facing, high traffic |

### Deliverable
Create `.agents/specs/ops/dmz-boundary.md` documenting the zones. This is an OpsMaster deliverable — include it in the message to OpsMaster.

### Acceptance Criteria
- [ ] No `stripe` import exists outside Payment Zone routes
- [ ] No PII (email, payment details) flows into pipeline data
- [ ] DMZ boundary documented in ops specs
- [ ] `creditTransactions` is the only table both Payment and Pipeline zones touch (via regenerate's credit deduction)

### Risks
- LOW. Mostly audit and documentation. The code is already well-separated.

---

## Task 3: Before/After GEO Scoring (#9)

### What
Two-phase scoring: capture a baseline score (Score0) before GEO files are deployed, then re-score after deployment (Score1) and show the improvement delta.

### Why
This is the core value demonstration. "Your GEO score improved from 23 to 67 (+44 points)" is the money shot for converting free users to paid.

### Current State
- Pipeline runs once: discovery → crawl → research → analyze → generate → assemble
- `geoScorecard` stores the latest score
- `previousRunSnapshot` stores the prior run (for re-run diffs)
- No concept of "baseline before files deployed"
- `changeLog` tracks score history across runs

### Architecture

**Phase A: Score0 (Baseline)**
This is the FIRST pipeline run. The site has no GEO files deployed yet. The scorecard from this run IS the baseline.

Key insight: **Score0 already happens naturally on the first run.** The pipeline crawls the site, finds no llms.txt / schema.json / business.json, and scores accordingly. We just need to save it as the baseline.

**Phase B: Score1 (Post-Deployment)**
After the user deploys generated files and clicks "Verify Connection":
1. System confirms files are live (existing verify-connection flow)
2. Trigger a re-crawl + re-analysis
3. New scorecard becomes Score1
4. Show delta: Score1 - Score0

### DB Changes

Add one column to `geoSites`:

```ts
// In lib/db/schema.ts, inside geoSites table:
baselineScorecard: jsonb("baseline_scorecard"),  // Score0: captured on first pipeline run
```

### Pipeline Changes

**In `lib/pipeline/runner.ts`** — at the end of `startCrawl()` or the completion handler:

After the pipeline completes and `geoScorecard` is populated:

```ts
// If this is the first run (no baseline exists), save current score as baseline
if (!existingSite.baselineScorecard && scorecard) {
  await db.update(geoSites).set({
    baselineScorecard: scorecard,
  }).where(eq(geoSites.id, siteId));
}
```

This means:
- First run → `baselineScorecard` = Score0, `geoScorecard` = Score0 (same)
- After deployment + re-run → `baselineScorecard` = Score0 (unchanged), `geoScorecard` = Score1

### API Changes

**In `app/api/sites/[id]/route.ts`** — add to response:

```ts
baselineScore: (site.baselineScorecard as { overallScore?: number } | null)?.overallScore ?? null,
improvementDelta: site.baselineScorecard && site.geoScorecard
  ? ((site.geoScorecard as { overallScore: number }).overallScore -
     (site.baselineScorecard as { overallScore: number }).overallScore)
  : null,
```

Note: `baselineScorecard` full data should follow the same gating rules as `geoScorecard` (Sprint 1, #38) — free tier sees the score number only, paid tier sees full pillar breakdown.

### Dashboard Changes

In `ResultsDashboard.tsx`, add a comparison view when `baselineScore` exists and differs from current score:

```
┌────────────────────────────────────────┐
│  Your GEO Score Improved!              │
│                                        │
│  Before: 23  →  After: 67  (+44)       │
│  ████████░░░░░░░░░░  →  ██████████████ │
│                                        │
│  Pillar improvements:                  │
│  • Structured Data: 15 → 82 (+67)      │
│  • LLM Readability: 31 → 75 (+44)      │
│  • ...                                 │
└────────────────────────────────────────┘
```

### Edge Cases
- **User re-runs before deploying files:** Score0 stays the same (baseline is only captured once, on first run)
- **User deploys partial files:** Score1 will show partial improvement — this is correct
- **Anonymous free user:** Baseline captured on first run. They see the Score0. To see Score1, they need to pay for a re-run after deploying files.

### Acceptance Criteria
- [ ] `baselineScorecard` column exists in `geoSites`
- [ ] First pipeline run saves scorecard as baseline
- [ ] Subsequent runs do NOT overwrite baseline
- [ ] API returns `baselineScore` and `improvementDelta`
- [ ] Dashboard shows before/after comparison when both scores exist
- [ ] Per-pillar delta visible (paid tier only)

### Risks
- **MEDIUM: Migration.** Existing sites have no `baselineScorecard`. For existing sites, treat current `geoScorecard` as the baseline on next run. Or backfill from `previousRunSnapshot` if available.
- **LOW: Score comparability.** If the scoring algorithm changes between Score0 and Score1, the delta may be misleading. Acceptable risk — we're not changing the algorithm between sprints.

---

## Task 4: Alpha Tester Onboarding (#12)

### What
Operational setup for 10 alpha test sites: admin tooling to manage them, weekly recrawl schedule, and stress testing infrastructure.

### Why
Alpha testers validate the full pipeline under real conditions. Need tooling to monitor their sites and catch issues before broader launch.

### Current State
- `app/api/cron/recrawl/route.ts` exists — triggers recrawl for sites where `nextCrawlAt < now`
- No admin UI for managing alpha sites
- Scripts exist in `scripts/` for manual operations (list-sites, trigger-pipeline, reset-run-counter, etc.)

### What's Needed

**1. Alpha site list**

Create a config or DB-based list of alpha sites. Simplest approach: tag alpha sites in a config file or use a naming convention.

Option: Add `isAlphaTester: boolean` column to `geoSites`, or just maintain a list in `lib/config.ts`:

```ts
// In lib/config.ts
export const ALPHA_TESTER_DOMAINS = [
  // Populated as testers connect
];
```

**2. Weekly recrawl cron**

The recrawl cron already exists. Ensure alpha sites have `nextCrawlAt` set to 7 days after each crawl. Verify in `lib/pipeline/runner.ts` that `nextCrawlAt` is updated at pipeline completion.

**3. Admin status script**

Create `scripts/alpha-status.mjs`:
- List all alpha domains
- Show last crawl date, next crawl date, pipeline status, overall score
- Flag any sites with errors or stale crawls (> 7 days since last crawl)

**4. Stress testing**

Create `scripts/stress-test-serve.mjs`:
- Hit `/api/serve/[slug]/llms.txt` for all alpha sites in parallel
- Measure response times
- Verify content is served correctly
- Run this before and after adding new alpha sites

### Known Alpha Testers (from issue)
- Competition (friend) — domain TBD
- happypathfire.com — will connect
- 1 person with 3 domains — will connect 1
- Others TBD

### Acceptance Criteria
- [ ] Alpha tester list maintained in config or DB
- [ ] Weekly recrawl running for all alpha sites
- [ ] Admin status script shows health of all alpha sites
- [ ] Stress test script validates serve endpoints under load
- [ ] Onboarding documented: steps for connecting a new alpha site

### Risks
- **LOW:** Operational task. No complex code.
- **MEDIUM:** Firecrawl API rate limits. 10 sites × 100 pages/week = 1000 pages/week. Monitor Firecrawl usage.

---

## Sprint 3 Summary

| # | Task | Effort | Assigned To |
|---|------|--------|-------------|
| #11 | Customer allowlist | Medium | ScriptDev |
| #13 | DMZ formalization | Small | OpsMaster (audit) + ScriptDev (lint rule) |
| #9 | Before/after scoring | Large | ScriptDev |
| #12 | Alpha onboarding | Medium | OpsMaster (cron/scripts) + ScriptDev (admin script) |

**Total Sprint 3:** 10-14 hours ScriptDev, 2-3 hours OpsMaster, 2 review cycles.

---

## M2 Complete Dependency Map (All Sprints)

```
Sprint 1 (Config + Gating)
  #36 lib/config.ts
   ├──→ #37 Crawl depth limits
   ├──→ #38 API gating
   │
Sprint 2 (Paywall UX)
   ├──→ #42 Dashboard paywall UI
   │     └──→ #43 Post-payment toast
   └──→ #45 Pricing page

Sprint 3 (Security + Ops)  [independent of Sprints 1-2]
  #11 Customer allowlist
  #13 DMZ audit
  #9 Before/after scoring  [depends on pipeline running]
  #12 Alpha onboarding     [depends on #9 for monitoring]
```

Sprint 3 items #11 and #13 can start in parallel with Sprint 2.
#9 and #12 should wait until Sprints 1+2 are stable.
