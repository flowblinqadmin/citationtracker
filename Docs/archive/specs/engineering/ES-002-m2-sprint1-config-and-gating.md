# ES-002: M2 Sprint 1 — Config Constants + Pipeline Gating

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#36](https://github.com/flowblinqadmin/geo/issues/36) · [#37](https://github.com/flowblinqadmin/geo/issues/37) · [#38](https://github.com/flowblinqadmin/geo/issues/38) · [#82](https://github.com/flowblinqadmin/geo/issues/82)  
> **Delivery Commit:** `2bad500`  

---

**Source:** TS-002-m2-sprint1-config-and-gating.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-26
**Branch:** `dev-an` (based on `m3-supabase-implementation`)
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/archive/geo`)
**Issues:** #36, #37, #38
**Blocks:** ES-003 (Sprint 2 — Paywall UX depends on gating being in place)

---

## a) Overview

### What This Covers
Sprint 1 establishes the **free/paid boundary** for the M2 Freemium Launch. Three tasks in strict dependency order:

1. **#36 — `lib/config.ts`**: Extract all hardcoded pricing, tier, and credit constants into a single source-of-truth module.
2. **#37 — Tier-aware crawl depth**: Free users get 20-page crawls; paid users get 100-page crawls.
3. **#38 — API gating**: `GET /api/sites/[id]` strips premium fields for free-tier users. This is the **security boundary** — UI paywall in Sprint 2 is cosmetic; this is enforcement.

```
#36 lib/config.ts  ← root dependency
 ├──→ #37 Tier-aware crawl depth (imports FREE_MAX_PAGES)
 └──→ #38 API gating (imports for tier derivation context)
          └──→ Sprint 2 ResultsDashboard (#42) consumes tier/credits from API
```

### Current Implementation State
- **`lib/config.ts`** does NOT exist. Constants are hardcoded across 5 route files.
- **Crawl depth**: `startCrawl(siteId, domain, maxPages=100)` in `lib/pipeline/runner.ts:68` defaults to 100 for ALL users. The anonymous free path in `regenerate/route.ts:161` calls `startCrawl(id, domain)` without `maxPages`, getting 100 pages (paid-tier value).
- **API gating**: `GET /api/sites/[id]` returns ALL fields unconditionally — no tier awareness.
- **Tier derivation**: No `tier` column in DB. Must derive from `teams.creditBalance`.
- **Public report route**: `app/api/report/[shareToken]/route.ts` already excludes generated files but returns full scorecard/recommendations — needs gating alignment.

### Ambiguities Flagged to CoFounder

1. **GeoScorecard pillar field names**: TS-002 gating code references `p.name` and `p.score`, but the actual `GeoScore` interface in `lib/services/geo-analyzer.ts:70-74` uses `pillar` (ID string like `"author_authority"`), `pillarName` (display name like `"Author Authority (E-E-A-T)"`), and `score`. This spec uses the **actual interface field names**.

2. **`rankedRecommendations` structure**: TS-002 references `recs?.rankedRecommendations` as if it's a nested object, but `rankedRecommendations` is a direct JSONB column on `geoSites`. The gating code should access `site.rankedRecommendations` directly. Each recommendation object has fields: `title`, `pillar`, `priority`, `findings`, `recommendation`, `impactedPages` — matching the `GeoScore` interface shape.

3. **Recrawl route tier awareness**: `app/api/cron/recrawl/route.ts` calls `startCrawl(id, domain)` without `maxPages`. Its query filters by `paymentStatus = "active"` — these are paying users, so it should pass `PAID_MAX_PAGES`. TS-002 mentions checking `teamId` but recrawl already filters for active subscriptions.

4. **`app/api/sites/route.ts` (POST) and initial crawl**: TS-002 says to wire `FREE_MAX_PAGES` into initial site creation. However, `sites/route.ts` POST does NOT call `startCrawl` directly — it sets `pipelineStatus: "pending"` and the cron `process-queue` picks it up. The `maxPages` parameter needs to be stored or resolved at crawl time. **Recommendation**: Store nothing; resolve tier at crawl time by checking if the site has a `teamId` with credits.

---

## b) Implementation Requirements

### Task 1: Create `lib/config.ts` (#36)

**Create file:** `lib/config.ts`

```ts
/** Pricing and tier configuration — single source of truth */

// Crawl limits
export const FREE_MAX_PAGES = 20;
export const PAID_MAX_PAGES = 100;

// Credit system
export const SIGNUP_BONUS_CREDITS = 20;
export const CREDITS_PER_PACK = 100;
export const CREDITS_PRICE_CENTS = 1000;      // $10.00
export const CREDITS_PRICE_USD = 10;
export const PAGES_PER_CREDIT = 5;             // 100 pages / 20 credits
export const PAID_CRAWL_CREDIT_COST = 20;      // ceil(PAID_MAX_PAGES / PAGES_PER_CREDIT)

// Free tier limits
export const FREE_REGENERATIONS = 0;           // free tier: initial run only, no re-runs
```

**Modify file:** `app/api/sites/[id]/regenerate/route.ts`
- **Remove** lines 13-14: `const PAID_CRAWL_CREDIT_COST = 20;` and `const PAID_MAX_PAGES = 100;`
- **Add** import: `import { PAID_CRAWL_CREDIT_COST, PAID_MAX_PAGES, FREE_MAX_PAGES } from "@/lib/config";`
- No logic changes — existing references to `PAID_CRAWL_CREDIT_COST` and `PAID_MAX_PAGES` continue to work via import.

**Modify file:** `app/api/checkout/route.ts`
- **Add** import: `import { CREDITS_PER_PACK, CREDITS_PRICE_CENTS } from "@/lib/config";`
- **Replace** line ~31: `name: "100 GEO Credits"` → `name: \`${CREDITS_PER_PACK} GEO Credits\``
- **Replace** line ~32: `unit_amount: 1000` → `unit_amount: CREDITS_PRICE_CENTS`

**Modify file:** `app/api/webhooks/stripe/route.ts`
- **Add** import: `import { CREDITS_PER_PACK } from "@/lib/config";`
- **Replace** line ~40: `const creditsAdded = 100;` → `const creditsAdded = CREDITS_PER_PACK;`

**Modify file:** `app/auth/callback/route.ts`
- **Add** import: `import { SIGNUP_BONUS_CREDITS } from "@/lib/config";`
- **Replace** line ~123: `creditBalance: 20` → `creditBalance: SIGNUP_BONUS_CREDITS`
- **Replace** the `creditTransactions` insert where `creditsChanged: 20` → `creditsChanged: SIGNUP_BONUS_CREDITS`
- **Replace** `balanceAfter: 20` → `balanceAfter: SIGNUP_BONUS_CREDITS`

**Modify file:** `lib/db/schema.ts`
- **Add** import: `import { SIGNUP_BONUS_CREDITS } from "@/lib/config";`
- **Replace** line ~8: `.default(20)` → `.default(SIGNUP_BONUS_CREDITS)` on `creditBalance` field

**Files changed:** 6 (1 new, 5 modified)

### Task 2: Tier-Aware Crawl Depth (#37)

**Modify file:** `app/api/sites/[id]/regenerate/route.ts`
- Prerequisite: `FREE_MAX_PAGES` already imported from Task 1.
- **Change** line ~161 (anonymous free path):
  ```ts
  // BEFORE
  await startCrawl(id, domain);
  // AFTER
  await startCrawl(id, domain, FREE_MAX_PAGES);
  ```

**Modify file:** `app/api/cron/recrawl/route.ts`
- **Add** import: `import { PAID_MAX_PAGES } from "@/lib/config";`
- **Change** the `startCrawl` call:
  ```ts
  // BEFORE
  await startCrawl(id, domain);
  // AFTER
  await startCrawl(id, domain, PAID_MAX_PAGES);
  ```
- Rationale: Recrawl already filters `paymentStatus = "active"` — these are paid users.

**Verify (no change expected):** `app/api/cron/process-queue/route.ts` (if it exists)
- If this route processes initial crawls for new sites (`pipelineStatus: "pending"`), it must resolve tier at crawl time:
  - Check if the site has a `teamId` → if yes, look up `teams.creditBalance` → if > 0, use `PAID_MAX_PAGES`, else `FREE_MAX_PAGES`
  - If no `teamId` → use `FREE_MAX_PAGES`
- If the process-queue calls `completePipeline()` (phase 2 only, not `startCrawl`), no change needed — `maxPages` was already set in phase 1.

**Files changed:** 1-2 modified

### Task 3: API Gating — Strip Paid Fields (#38)

**Modify file:** `app/api/sites/[id]/route.ts`

**Add imports:**
```ts
import { teams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
```

**Add tier derivation block** (after fetching `site`, before building response):
```ts
let tier: "free" | "paid" = "free";
let credits = 0;

if (site.teamId) {
  const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
  if (team && team.creditBalance > 0) {
    tier = "paid";
    credits = team.creditBalance;
  } else if (team) {
    credits = team.creditBalance;
  }
}
```

**Replace response construction** with conditional gating:

```ts
// --- Always-included fields ---
const response: Record<string, unknown> = {
  id: site.id,
  domain: site.domain,
  slug: site.slug,
  tier,
  credits,
  pipelineStatus: site.pipelineStatus,
  pipelineError: site.pipelineError,
  discoveryData: site.discoveryData,
  platformDetected: site.platformDetected,
  projectedScore: site.projectedScore,
  projectedBoost: site.projectedBoost,
  shareToken: site.shareToken,
  shareUrl: site.shareToken ? `/api/report/${site.shareToken}` : null,
  domainVerified: site.domainVerified,
  verifyToken: site.verifyToken,
  changeLog: site.changeLog,
  manualRunsThisMonth: site.manualRunsThisMonth,
  crawlCount: site.crawlCount,
  lastCrawlAt: site.lastCrawlAt,
  nextCrawlAt: site.nextCrawlAt,
  createdAt: site.createdAt,
};

// --- Diff (always included) ---
if (site.previousRunSnapshot) {
  // ... existing diff construction logic (unchanged)
}

// --- Tier-gated fields ---
if (tier === "paid") {
  response.geoScorecard = site.geoScorecard;
  response.executiveSummary = site.executiveSummary;
  response.rankedRecommendations = site.rankedRecommendations;
  response.generatedLlmsTxt = site.generatedLlmsTxt;
  response.generatedLlmsFullTxt = site.generatedLlmsFullTxt;
  response.generatedBusinessJson = site.generatedBusinessJson;
  response.generatedSchemaBlocks = site.generatedSchemaBlocks;
} else {
  // -- Scorecard: scores visible, findings stripped --
  const scorecard = site.geoScorecard as Record<string, unknown> | null;
  if (scorecard) {
    response.geoScorecard = {
      overallScore: scorecard.overallScore,
      topThreeImprovements: scorecard.topThreeImprovements,
      pillars: (scorecard.pillars as Array<Record<string, unknown>>)?.map(p => ({
        pillar: p.pillar,
        pillarName: p.pillarName,
        score: p.score,
        weight: p.weight,
        priority: p.priority,
        // findings, recommendation, impactedPages STRIPPED
      })),
    };
  }

  // -- Executive summary: first paragraph only --
  const fullSummary = (site.executiveSummary as string) ?? "";
  response.executiveSummary = fullSummary.split("\n\n")[0] ?? fullSummary;

  // -- Recommendations: first 3, titles + pillar + priority only --
  const allRecs = (site.rankedRecommendations as Array<Record<string, unknown>>) ?? [];
  response.rankedRecommendations = allRecs.slice(0, 3).map(r => ({
    title: r.title,
    pillar: r.pillar,
    priority: r.priority,
    // findings, recommendation, impactedPages STRIPPED
  }));

  // -- Generated files: null for free --
  response.generatedLlmsTxt = null;
  response.generatedLlmsFullTxt = null;
  response.generatedBusinessJson = null;
  response.generatedSchemaBlocks = null;
}
```

**Modify file:** `app/api/report/[shareToken]/route.ts`
- Apply the **same free-tier gating** to the public report response.
- The public report is a marketing teaser — it should ALWAYS use free-tier gating regardless of payment status.
- Add the same scorecard stripping, executive summary truncation, and recommendation limiting as above.
- Ensure `generatedLlmsTxt`, `generatedLlmsFullTxt`, `generatedBusinessJson`, `generatedSchemaBlocks` are never returned (already excluded — verify).

**Files changed:** 2 modified

### Data Structures & Types

**GeoScore interface** (existing, `lib/services/geo-analyzer.ts:70-74`):
```ts
export interface GeoScore {
  pillar: string;           // e.g., "author_authority"
  pillarName: string;       // e.g., "Author Authority (E-E-A-T)"
  score: number;            // 0-100
  findings: string;         // 2-3 sentences — GATED
  recommendation: string;   // actionable fix — GATED
  priority: "critical" | "high" | "medium" | "low";
  impactedPages: string[];  // URLs affected — GATED
}
```

**GeoScorecard interface** (existing, `lib/services/geo-analyzer.ts`):
```ts
export interface GeoScorecard {
  overallScore: number;
  pillars: GeoScore[];
  topThreeImprovements: string[];
}
```

**New type (for API response):**
```ts
// No new types needed — the response is Record<string, unknown>
// Type safety is maintained by the GeoScore/GeoScorecard interfaces at analysis time
// The gating layer operates on the serialized JSONB output
```

### Error Handling Requirements

- **Tier derivation failure**: If the `teams` query fails, default to `tier: "free"`, `credits: 0`. Log a warning. Never expose paid data on DB error.
- **Null scorecard/recommendations**: Handle `site.geoScorecard` being `null` (pipeline not complete). Return `null`, not an empty stripped object.
- **Malformed pillar data**: If `scorecard.pillars` is not an array, return `geoScorecard: { overallScore: scorecard.overallScore, pillars: [] }`.

### Performance Requirements

- Tier derivation adds ONE additional DB query (`SELECT * FROM teams WHERE id = ?`). The `teams` table is small (< 1000 rows expected). No index needed beyond the PK.
- No additional latency for paid users beyond the team lookup.
- Free-tier response is smaller (stripped fields) — net positive for response size.

---

## c) Unit Test Plan

**Test file:** `__tests__/config.test.ts` (NEW)

### Test Cases for `lib/config.ts`

| # | Test Case | Input | Expected Output | Edge Case |
|---|-----------|-------|-----------------|-----------|
| 1 | All constants are exported | Import all named exports | All values match spec | — |
| 2 | `PAID_CRAWL_CREDIT_COST` equals `ceil(PAID_MAX_PAGES / PAGES_PER_CREDIT)` | Computed | `ceil(100/5) = 20` | — |
| 3 | `CREDITS_PRICE_CENTS` equals `CREDITS_PRICE_USD * 100` | Computed | `1000` | — |

### Test Cases for API Gating (`app/api/sites/[id]/route.ts`)

**Test file:** `__tests__/api-gating.test.ts` (NEW)

**Mock requirements:**
- Mock `@/lib/db` (db.select, db.from, db.where) — return controlled team data
- Mock Supabase auth (`createServerClient`) — return controlled user session
- Use Vitest `vi.mock()` with hoisted mocks

| # | Test Case | Setup | Expected | Edge Case |
|---|-----------|-------|----------|-----------|
| 1 | Paid tier: full data returned | `teamId` set, `creditBalance: 50` | All fields present: geoScorecard with findings, full executiveSummary, all recommendations, all generated files | — |
| 2 | Free tier (no team): stripped data | `teamId: null` | `tier: "free"`, `credits: 0`, no findings in pillars, truncated summary, max 3 recs (title/pillar/priority only), generated files null | — |
| 3 | Free tier (team, 0 credits): stripped data | `teamId` set, `creditBalance: 0` | Same as case 2 but `credits: 0` | Zero credits = free |
| 4 | Free tier: executive summary truncation | `executiveSummary: "Para 1\n\nPara 2\n\nPara 3"` | Only `"Para 1"` returned | — |
| 5 | Free tier: executive summary single paragraph | `executiveSummary: "Only one paragraph"` | `"Only one paragraph"` returned | No `\n\n` delimiter |
| 6 | Free tier: recommendations capped at 3 | 5 recommendations in DB | Only first 3 returned, each with only `title`, `pillar`, `priority` | — |
| 7 | Free tier: recommendations fewer than 3 | 1 recommendation in DB | 1 recommendation returned | Don't pad to 3 |
| 8 | Free tier: scorecard pillar stripping | Pillar with `findings`, `recommendation`, `impactedPages` | Only `pillar`, `pillarName`, `score`, `weight`, `priority` returned | — |
| 9 | Free tier: null scorecard | `geoScorecard: null` | `geoScorecard: null` (not empty object) | Pipeline incomplete |
| 10 | Free tier: null recommendations | `rankedRecommendations: null` | `rankedRecommendations: []` | — |
| 11 | `tier` and `credits` fields in response | Both tiers | Always present in response | — |
| 12 | Generated files null for free tier | Free tier request | `generatedLlmsTxt: null`, etc. | — |
| 13 | Team lookup failure defaults to free | DB throws on team query | `tier: "free"`, `credits: 0`, paid data stripped | Error resilience |

### Test Cases for Crawl Depth (#37)

**Extend existing test file:** `__tests__/api-routes.test.ts`

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 14 | Anonymous free crawl passes FREE_MAX_PAGES | No team, pipelineStatus != "complete" | `startCrawl(id, domain, 20)` called |
| 15 | Paid crawl passes PAID_MAX_PAGES | Team with credits | `startCrawl(id, domain, 100)` called |
| 16 | Recrawl passes PAID_MAX_PAGES | Cron recrawl trigger | `startCrawl(id, domain, 100)` called |

### Test Cases for Config Import Refactor (#36)

**Extend existing test file:** `__tests__/api-routes.test.ts`

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 17 | Checkout uses CREDITS_PRICE_CENTS | Stripe session creation | `unit_amount` matches `CREDITS_PRICE_CENTS` (1000) |
| 18 | Webhook uses CREDITS_PER_PACK | Payment success | Credits added = `CREDITS_PER_PACK` (100) |
| 19 | Auth callback uses SIGNUP_BONUS_CREDITS | First login | `creditBalance` = `SIGNUP_BONUS_CREDITS` (20) |

**Minimum coverage target:** 90% line coverage for `app/api/sites/[id]/route.ts`, 100% branch coverage on the `tier === "paid"` conditional.

---

## d) Integration Test Plan

**Test file:** `__tests__/integration/gating-flow.test.ts` (NEW)

These tests exercise the full request → tier derivation → response gating flow using the actual route handlers with mocked DB.

### Scenarios

| # | Scenario | Flow | Assertions |
|---|----------|------|------------|
| 1 | Anonymous user creates site, gets free-tier response | POST `/api/sites` → GET `/api/sites/[id]` | Response has `tier: "free"`, stripped fields, no findings |
| 2 | Paid user creates site, gets full response | Setup: team with credits → GET `/api/sites/[id]` | Response has `tier: "paid"`, all fields present |
| 3 | User pays, re-fetches — tier upgrades | GET (free) → simulate payment → GET (paid) | First response stripped, second response full |
| 4 | Credits depleted — tier downgrades | GET (paid) → deplete credits → GET (free) | First response full, second response stripped |
| 5 | Public report always free-gated | Create paid site → GET `/api/report/[shareToken]` | Scorecard stripped, no generated files, max 3 recs |
| 6 | Free crawl depth verified | Anonymous POST → check `startCrawl` args | `maxPages = 20` |
| 7 | Paid crawl depth verified | Team POST → regenerate | `maxPages = 100` |

### End-to-End Data Flow Tests

| # | Flow | Validates |
|---|------|-----------|
| 8 | Config constants propagation | Change `FREE_MAX_PAGES` in config.ts → crawl uses new value |
| 9 | Credit transaction after paid crawl | Regenerate with team → `creditTransactions` row created with `PAID_CRAWL_CREDIT_COST` from config |
| 10 | Gating boundary: network inspection | Free-tier GET → response body does NOT contain `findings` string from any pillar |

### Failure Mode Tests

| # | Scenario | Expected Behavior |
|---|----------|-------------------|
| 11 | Team table unavailable (DB error during tier derivation) | Default to `tier: "free"`, log warning, return stripped data |
| 12 | Malformed geoScorecard JSONB | Return `overallScore` if present, empty `pillars` array |
| 13 | `executiveSummary` is empty string | Return empty string, no crash |

---

## e) Profiling Requirements

### What to Measure

| Metric | Baseline | Target | How to Measure |
|--------|----------|--------|----------------|
| `GET /api/sites/[id]` response time (paid) | ~50ms (current, no team lookup) | < 80ms (with team lookup) | Vitest bench or manual timing |
| `GET /api/sites/[id]` response time (free) | N/A (new path) | < 80ms | Same |
| Team lookup query time | N/A | < 5ms | SQL EXPLAIN on `SELECT * FROM teams WHERE id = ?` |
| Response payload size (free vs paid) | ~15KB (current, all data) | Free: < 5KB, Paid: ~15KB | Measure `Content-Length` |

### Profiling Tool Recommendations

- **Query profiling**: Drizzle query logging (`drizzle-orm` logger) or Supabase dashboard query performance
- **Response timing**: Next.js middleware timing headers or manual `performance.now()` in route handler
- **Payload size**: `JSON.stringify(response).length` logged in development

### When to Profile

- After Task 3 (API gating) is implemented
- Compare before/after for the team lookup overhead
- Profile with realistic scorecard data (16 pillars, 10+ recommendations)

---

## f) Load Test Plan

### Scenarios

| # | Scenario | Concurrent Users | Duration | Description |
|---|----------|------------------|----------|-------------|
| 1 | Free-tier GET spike | 50 | 60s | Simulate 50 concurrent free-tier users fetching site data |
| 2 | Paid-tier GET spike | 20 | 60s | Simulate 20 concurrent paid users fetching full data |
| 3 | Mixed tier traffic | 40 free + 10 paid | 120s | Realistic traffic distribution |
| 4 | Tier derivation under load | 100 | 60s | Stress test the team lookup query |

### Success Criteria

| Metric | Target |
|--------|--------|
| p50 latency | < 100ms |
| p95 latency | < 300ms |
| p99 latency | < 500ms |
| Error rate | < 0.1% |
| Memory per request | No increase > 20% vs baseline |

### Resource Consumption Bounds

- Database connections: Team lookup should not exceed connection pool limits. Verify connection pooling with PgBouncer or Supabase connection pooler.
- No N+1 queries: Tier derivation is 1 query per request (team lookup). Not per-pillar or per-recommendation.

### Tool Recommendation

- **k6** or **autocannon** for HTTP load testing
- Test against local dev server or staging environment
- Load tests are stretch-goal for Sprint 1 — prioritize unit/integration tests

---

## g) Logging & Instrumentation

### Events to Log

| Event | Log Level | Fields | When |
|-------|-----------|--------|------|
| `tier_derived` | `info` | `{ siteId, teamId, tier, credits, durationMs }` | After tier derivation in GET handler |
| `gating_applied` | `debug` | `{ siteId, tier, fieldsStripped: string[] }` | After response gating |
| `tier_derivation_error` | `warn` | `{ siteId, teamId, error: string }` | Team lookup failure (defaults to free) |
| `config_import_used` | — | — | No runtime log; verified by import graph at build time |
| `crawl_depth_set` | `info` | `{ siteId, maxPages, tier }` | When `startCrawl` is called with explicit maxPages |
| `free_crawl_started` | `info` | `{ siteId, domain, maxPages: 20 }` | Anonymous free crawl initiated |

### Metrics to Emit

| Metric | Type | Labels |
|--------|------|--------|
| `api_sites_get_duration_ms` | histogram | `tier: "free" \| "paid"` |
| `api_sites_get_response_bytes` | histogram | `tier: "free" \| "paid"` |
| `tier_derivation_duration_ms` | histogram | — |
| `free_tier_requests_total` | counter | — |
| `paid_tier_requests_total` | counter | — |

### Log Level Guidance

- **Production**: `info` level — `tier_derived` and `crawl_depth_set` events visible
- **Debug/Development**: `debug` level — `gating_applied` shows exactly which fields were stripped
- **Errors**: `warn` for tier derivation failures (never `error` — graceful degradation to free tier)

### Implementation Note

If no structured logging framework is in place, use `console.log` with JSON format:
```ts
console.log(JSON.stringify({ event: "tier_derived", siteId, teamId, tier, credits, durationMs }));
```
This can be upgraded to a proper logger (pino, winston) later without changing the event schema.

---

## h) Acceptance Criteria

### Task 1: `lib/config.ts` (#36)

- [ ] `lib/config.ts` exists with all constants: `FREE_MAX_PAGES`, `PAID_MAX_PAGES`, `SIGNUP_BONUS_CREDITS`, `CREDITS_PER_PACK`, `CREDITS_PRICE_CENTS`, `CREDITS_PRICE_USD`, `PAGES_PER_CREDIT`, `PAID_CRAWL_CREDIT_COST`, `FREE_REGENERATIONS`
- [ ] `app/api/sites/[id]/regenerate/route.ts` imports `PAID_CRAWL_CREDIT_COST` and `PAID_MAX_PAGES` from config — no local constants
- [ ] `app/api/checkout/route.ts` imports `CREDITS_PER_PACK` and `CREDITS_PRICE_CENTS` from config
- [ ] `app/api/webhooks/stripe/route.ts` imports `CREDITS_PER_PACK` from config
- [ ] `app/auth/callback/route.ts` imports `SIGNUP_BONUS_CREDITS` from config
- [ ] `lib/db/schema.ts` imports `SIGNUP_BONUS_CREDITS` from config for default value
- [ ] `grep -rn "= 20\b\|= 100\b\|= 1000\b" app/api/ lib/db/schema.ts` returns zero hits for credit/pricing/page-limit values (exclude unrelated usages)
- [ ] All existing tests pass (`vitest run`) — no behavioral change
- [ ] Build succeeds (`next build` or `tsc --noEmit`)

### Task 2: Tier-Aware Crawl Depth (#37)

- [ ] Anonymous free path in `regenerate/route.ts` calls `startCrawl(id, domain, FREE_MAX_PAGES)` (20 pages)
- [ ] Paid path continues to call `startCrawl(id, domain, PAID_MAX_PAGES)` (100 pages)
- [ ] `cron/recrawl/route.ts` calls `startCrawl(id, domain, PAID_MAX_PAGES)` (100 pages)
- [ ] `discoverSite()` receives correct `maxPages` in both paths
- [ ] New unit tests pass for crawl depth scenarios

### Task 3: API Gating (#38)

- [ ] `tier` and `credits` fields present in ALL `GET /api/sites/[id]` responses
- [ ] **Free tier response**: no `findings`/`recommendation`/`impactedPages` in any pillar, truncated `executiveSummary` (first paragraph), max 3 recommendations (title/pillar/priority only), all generated files `null`
- [ ] **Paid tier response**: full data returned — identical to current behavior plus `tier` and `credits` fields
- [ ] **Security boundary**: Cannot retrieve paid data by inspecting network requests for free-tier user — data is not sent, not just hidden
- [ ] Public report route (`/api/report/[shareToken]`) applies free-tier gating regardless of payment status
- [ ] Null/empty scorecard handled gracefully (no crash)
- [ ] Null/empty recommendations handled gracefully (returns `[]`)
- [ ] Team lookup failure defaults to free tier (no paid data leaked on error)
- [ ] New unit tests pass (13+ test cases)
- [ ] New integration tests pass (13 scenarios)
- [ ] All existing tests continue to pass

### Overall Sprint 1

- [ ] All 3 tasks complete in dependency order: #36 → #37 + #38
- [ ] No regressions in existing functionality
- [ ] Build and type-check pass
- [ ] Test coverage ≥ 90% for modified files

---

## Dependencies & Ordering

```
#36 lib/config.ts          ← MUST ship first (all others import from it)
    ├──→ #37 Crawl depth   ← Can start after #36
    └──→ #38 API gating    ← Can start after #36, parallel with #37
              └──→ Sprint 2 (#42 ResultsDashboard) consumes tier/credits
```

## Files Summary

| Action | File | Task |
|--------|------|------|
| **CREATE** | `lib/config.ts` | #36 |
| **CREATE** | `__tests__/config.test.ts` | #36 |
| **CREATE** | `__tests__/api-gating.test.ts` | #38 |
| **CREATE** | `__tests__/integration/gating-flow.test.ts` | #38 |
| **MODIFY** | `app/api/sites/[id]/regenerate/route.ts` | #36, #37 |
| **MODIFY** | `app/api/checkout/route.ts` | #36 |
| **MODIFY** | `app/api/webhooks/stripe/route.ts` | #36 |
| **MODIFY** | `app/auth/callback/route.ts` | #36 |
| **MODIFY** | `lib/db/schema.ts` | #36 |
| **MODIFY** | `app/api/sites/[id]/route.ts` | #38 |
| **MODIFY** | `app/api/report/[shareToken]/route.ts` | #38 |
| **MODIFY** | `app/api/cron/recrawl/route.ts` | #37 |
| **VERIFY** | `app/api/cron/process-queue/route.ts` | #37 |

**Total:** 4 new files, 8 modified files, 1 verification
