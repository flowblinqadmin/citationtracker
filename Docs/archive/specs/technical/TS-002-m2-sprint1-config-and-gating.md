# TS-002: M2 Sprint 1 — Config Constants + Pipeline Gating

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#36](https://github.com/flowblinqadmin/geo/issues/36) · [#37](https://github.com/flowblinqadmin/geo/issues/37) · [#38](https://github.com/flowblinqadmin/geo/issues/38) · [#82](https://github.com/flowblinqadmin/geo/issues/82)  
> **Delivery Commit:** `2bad500`  

---

**Agent:** 1-CoFounder
**Date:** 2026-02-26
**Branch:** `dev-an` (based on `m3-supabase-implementation`)
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/archive/geo`)
**Issues:** #36, #37, #38
**Blocks:** TS-003 (Sprint 2 — paywall UX depends on gating being in place)

---

## Overview

Sprint 1 establishes the free/paid boundary. Three tasks, strict dependency chain:

```
#36 lib/config.ts
 ├──→ #37 Tier-aware crawl depth
 └──→ #38 API gating (strip paid fields)
```

#36 is the root dependency — every other M2 issue imports from it.

---

## Task 1: lib/config.ts (#36)

### What
Create `lib/config.ts` as the single source of truth for all pricing, tier, and credit constants.

### Why
Constants are currently hardcoded across multiple files:
- `PAID_CRAWL_CREDIT_COST = 20` in `app/api/sites/[id]/regenerate/route.ts:13`
- `PAID_MAX_PAGES = 100` in `app/api/sites/[id]/regenerate/route.ts:14`
- `unit_amount: 1000` ($10.00) in `app/api/checkout/route.ts:32`
- `creditsAdded = 100` in `app/api/webhooks/stripe/route.ts:35`
- `creditBalance: ... .default(20)` (signup bonus) in `lib/db/schema.ts:6`

These must be centralized so changes propagate everywhere.

### Create `lib/config.ts`

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

### Then update these files to import from config.ts:

**`app/api/sites/[id]/regenerate/route.ts`** — lines 13-14:
- Remove `const PAID_CRAWL_CREDIT_COST = 20;`
- Remove `const PAID_MAX_PAGES = 100;`
- Add `import { PAID_CRAWL_CREDIT_COST, PAID_MAX_PAGES, FREE_MAX_PAGES } from "@/lib/config";`

**`app/api/checkout/route.ts`** — line 32:
- Replace `unit_amount: 1000` with `unit_amount: CREDITS_PRICE_CENTS`
- Replace `name: "100 GEO Credits"` with template using `CREDITS_PER_PACK`
- Add `import { CREDITS_PER_PACK, CREDITS_PRICE_CENTS } from "@/lib/config";`

**`app/api/webhooks/stripe/route.ts`** — line 35:
- Replace `const creditsAdded = 100;` with `import { CREDITS_PER_PACK } from "@/lib/config";`
- Use `CREDITS_PER_PACK` in place of `creditsAdded`

**`app/auth/callback/route.ts`** — signup bonus:
- Replace hardcoded `20` with `import { SIGNUP_BONUS_CREDITS } from "@/lib/config";`

### Acceptance Criteria
- [ ] `lib/config.ts` exists with all constants
- [ ] No hardcoded pricing/credit/page-limit numbers remain in route files
- [ ] `grep -rn "= 20\|= 100\|= 1000" app/api/` returns zero hits for credit/pricing values
- [ ] All existing tests pass (no behavioral change)

### Risks
- LOW. Pure refactor — extract constants, no logic change.

---

## Task 2: Tier-Aware Crawl Depth (#37)

### What
Free users (anonymous, no team) get 20-page crawls. Paid users (team with credits) get 100-page crawls. The `maxPages` parameter already flows through the pipeline — we just need to pass the right value.

### Why
Currently the anonymous free path in `regenerate/route.ts` calls `startCrawl(id, domain)` with no `maxPages` argument, which defaults to 100 in `lib/pipeline/runner.ts:73`. Free users should not get 100-page crawls — that's the paid tier value.

### Current Flow (already wired)

```
regenerate/route.ts → startCrawl(siteId, domain, maxPages)
  → runner.ts:startCrawl() → discoverSite(domain, maxPages)
    → selectTopUrlsWithGemini(urls, domain) returns top `maxPages` URLs
    → jinaPass() crawls those URLs
```

The `maxPages` parameter propagates correctly. The only change needed is passing `FREE_MAX_PAGES` for the free path.

### Changes

**`app/api/sites/[id]/regenerate/route.ts`**

1. Add to imports: `FREE_MAX_PAGES` from `@/lib/config`

2. In the anonymous free path (~line 112), change:
```ts
// BEFORE
after(async () => {
  try {
    await startCrawl(id, domain);
```
to:
```ts
// AFTER
after(async () => {
  try {
    await startCrawl(id, domain, FREE_MAX_PAGES);
```

3. Also wire `FREE_MAX_PAGES` into the initial site creation crawl. Check `app/api/sites/route.ts` — if it calls `startCrawl` without `maxPages`, pass `FREE_MAX_PAGES` for anonymous creations and `PAID_MAX_PAGES` for team-linked creations.

**`app/api/cron/recrawl/route.ts`** (if exists):
- Weekly recrawl should also respect the tier. Check if the site has a `teamId` — if yes, use `PAID_MAX_PAGES`; if no, use `FREE_MAX_PAGES`.

### Acceptance Criteria
- [ ] Anonymous free crawl uses 20-page limit
- [ ] Team crawl uses 100-page limit
- [ ] `discoverSite()` receives correct `maxPages` in both paths
- [ ] Gemini URL selection respects the limit (already does — `selectTopUrlsWithGemini` slices to `maxPages`)

### Risks
- LOW. The plumbing exists. This is passing one argument.
- MEDIUM: Check that `discoverSite` with `maxPages=20` still produces useful results — 20 pages should be enough for a basic audit but verify Gemini selects the right pages (homepage, about, services, pricing, contact at minimum).

---

## Task 3: API Gating — Strip Paid Fields (#38)

### What
`GET /api/sites/[id]` currently returns all data unconditionally. For free-tier users (no team, or team with 0 credits), strip the premium fields and add `tier`/`credits` to the response.

### Why
This is the security boundary. Without this, free users can inspect network requests and see all paid data. The dashboard paywall (Sprint 2, #42) is just UI — this is the actual enforcement.

### Current State
`app/api/sites/[id]/route.ts` — returns everything including:
- `geoScorecard` (full pillar breakdown)
- `executiveSummary`
- `rankedRecommendations` (actionable fixes)
- `generatedLlmsTxt`, `generatedLlmsFullTxt`
- `generatedBusinessJson`, `generatedSchemaBlocks`

### Tier Derivation Logic

No `tier` column in DB — derive from team credit balance:

```ts
import { teams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// After fetching site, determine tier
let tier: "free" | "paid" = "free";
let credits = 0;

if (site.teamId) {
  const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
  if (team && team.creditBalance > 0) {
    tier = "paid";
    credits = team.creditBalance;
  } else if (team) {
    credits = team.creditBalance; // 0 or negative — still free
  }
}
```

### Gating Rules

| Field | Free Tier | Paid Tier |
|-------|-----------|-----------|
| `geoScorecard.overallScore` | Yes (the number) | Yes |
| `geoScorecard.pillars` (names + scores) | Yes | Yes |
| `geoScorecard.pillars[].findings` | **No** — strip | Yes |
| `executiveSummary` | **First paragraph only** | Yes (full) |
| `rankedRecommendations` | **First 3 only**, details stripped | Yes (all) |
| `projectedScore` / `projectedBoost` | Yes | Yes |
| `generatedLlmsTxt` | **No** — strip | Yes |
| `generatedLlmsFullTxt` | **No** — strip | Yes |
| `generatedBusinessJson` | **No** — strip | Yes |
| `generatedSchemaBlocks` | **No** — strip | Yes |
| `tier` | Added to response | Added to response |
| `credits` | Added to response | Added to response |
| `discoveryData` | Yes | Yes |
| `diff` | Yes | Yes |

### Implementation

In `app/api/sites/[id]/route.ts`, after the tier derivation block, conditionally strip fields:

```ts
// Build response
const response: Record<string, unknown> = {
  id: site.id,
  domain: site.domain,
  slug: site.slug,
  tier,
  credits,
  pipelineStatus: site.pipelineStatus,
  pipelineError: site.pipelineError,
  // ... discoveryData, diff, shareToken, etc. (always included)
};

if (tier === "paid") {
  // Full data
  response.geoScorecard = site.geoScorecard;
  response.executiveSummary = site.executiveSummary;
  response.rankedRecommendations = recs?.rankedRecommendations ?? [];
  response.generatedLlmsTxt = site.generatedLlmsTxt;
  response.generatedLlmsFullTxt = site.generatedLlmsFullTxt;
  response.generatedBusinessJson = site.generatedBusinessJson;
  response.generatedSchemaBlocks = site.generatedSchemaBlocks;
} else {
  // Free tier — scores visible, details gated
  const scorecard = site.geoScorecard as Record<string, unknown> | null;
  if (scorecard) {
    response.geoScorecard = {
      overallScore: scorecard.overallScore,
      pillars: (scorecard.pillars as Array<Record<string, unknown>>)?.map(p => ({
        name: p.name,
        score: p.score,
        weight: p.weight,
        // findings STRIPPED
      })),
    };
  }
  // Executive summary — first paragraph only
  const fullSummary = site.executiveSummary ?? "";
  const firstPara = fullSummary.split("\n\n")[0] ?? fullSummary;
  response.executiveSummary = firstPara;
  // Recommendations — first 3, titles only
  const allRecs = (recs?.rankedRecommendations as Array<Record<string, unknown>>) ?? [];
  response.rankedRecommendations = allRecs.slice(0, 3).map(r => ({
    title: r.title,
    pillar: r.pillar,
    priority: r.priority,
    // details, implementation steps STRIPPED
  }));
  // Generated files — null for free
  response.generatedLlmsTxt = null;
  response.generatedLlmsFullTxt = null;
  response.generatedBusinessJson = null;
  response.generatedSchemaBlocks = null;
}
```

### Shared/Public Report Path

The `/report/[shareToken]` route (if it exists) serves public marketing reports. These should ALWAYS return free-tier data regardless of payment — the share report is a teaser. Verify this route also applies gating.

### Acceptance Criteria
- [ ] `tier` and `credits` fields present in all API responses
- [ ] Free tier: no generated files, no pillar findings, truncated summary, max 3 recommendations (title only)
- [ ] Paid tier: full data returned as before
- [ ] Cannot bypass gating by inspecting network requests (the data is not sent, not just hidden in UI)
- [ ] Share/public report route also applies free-tier gating

### Risks
- **MEDIUM: Scorecard structure.** The `geoScorecard` JSONB column's internal structure must match what we're destructuring. Verify the actual pillar format by checking `lib/services/geo-analyzer.ts` output shape.
- **LOW: Performance.** Adding one team lookup per request. Team table is small — no index needed yet.
- **MEDIUM: Backward compatibility.** The `ResultsDashboard.tsx` component consumes this API. Ensure it handles the new shape gracefully (missing fields should render as locked/blurred in Sprint 2, not crash).

---

## Dependencies

```
lib/config.ts (#36)  ←  MUST ship first
    │
    ├──→ regenerate/route.ts (#37)  ←  import FREE_MAX_PAGES
    │
    └──→ sites/[id]/route.ts (#38)  ←  import for future pricing display
              │
              └──→ ResultsDashboard.tsx (#42, Sprint 2)  ←  consumes tier/credits from API
```

## Effort Estimate

| Task | Effort | Files Changed |
|------|--------|---------------|
| #36 lib/config.ts | Small (1 new file, 4 imports updated) | 5 files |
| #37 Crawl depth | Small (1 argument change + verify) | 1-2 files |
| #38 API gating | Medium (conditional response logic) | 1-2 files |

**Total Sprint 1:** 3-4 hours for ScriptDev, 1 review cycle.

---

## Issues to Close

| Issue | Action | Reason |
|-------|--------|--------|
| #35 | Close as superseded | M3 built `teams.creditBalance` — no `tier`/`credits` columns on `geo_sites` needed |
| #44 | Close as superseded | Login page exists at `app/auth/login/page.tsx` with Supabase OTP flow |
