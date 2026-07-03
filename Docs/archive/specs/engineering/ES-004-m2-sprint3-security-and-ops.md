# ES-004: M2 Sprint 3 — Security, Scoring & Alpha Operations

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#4](https://github.com/flowblinqadmin/geo/issues/4) · [#5](https://github.com/flowblinqadmin/geo/issues/5)  
> **Delivery Commit:** `507ab9f`  

---

**Source:** TS-004-m2-sprint3-security-and-ops.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-26
**Branch:** `dev-an`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/archive/geo`)
**Issues:** #11, #13, #9, #12
**Depends on:** ES-002 (Sprint 1), ES-003 (Sprint 2) — core monetization must be in place

---

## a) Overview

### What This Covers
Sprint 3 is the **hardening and polish pass** before alpha launch. Four tasks:

1. **#11 — Customer Allowlist for /api/serve/***: Layered protection for file-serving endpoints (AI crawler pass-through, verified domain check, rate limiting for unknowns).
2. **#13 — DMZ Architecture Formalization**: Audit and document isolation between payment, auth, pipeline, and serve zones.
3. **#9 — Before/After GEO Scoring**: Capture baseline score on first run, show improvement delta after file deployment.
4. **#12 — Alpha Tester Onboarding**: Admin tooling, weekly recrawl verification, stress testing scripts.

```
#11 Customer allowlist → #13 DMZ formalization (can parallel)
#9 Before/after scoring (depends on pipeline running)
  └──→ #12 Alpha onboarding (depends on #9 for monitoring)
```

### Current Implementation State

**Serve Routes (`/api/serve/*`):**
- 5 routes: `llms.txt`, `llms-full.txt`, `business.json`, `schema.json`, `schema.js`
- All follow identical pattern: lookup site by slug → check generated content exists → log crawl → return file with 1-hour cache headers
- Each route calls `logCrawl(req, siteId, slug, fileType)` asynchronously (fire-and-forget) into `geoCrawlLogs` table
- **No protection** beyond general middleware bot blocking — no AI crawler detection, no rate limiting, no domain verification check

**Middleware (`middleware.ts`, 121 lines):**
- Lines 5-11: 59 blocked UA patterns (scanners/malicious bots)
- Lines 14-44: 43 blocked path patterns (WordPress, PHP, env, etc.)
- Lines 47-73: Allowlist routes — `/api/serve/` is fully public (no auth)
- Lines 85-116: Security headers (X-Frame-Options, HSTS, etc.)
- **No per-route rate limiting** beyond the general bot blocking

**Rate Limiting (`lib/rate-limit.ts`, 64 lines):**
- In-memory Map-based store (not Redis) — suitable for single-instance Vercel
- `checkRateLimit(key, limit, windowMs)` → `{ allowed, remaining, resetAt }`
- Currently used only by `/api/sites` (3/hr per IP, 2/day per email) and OTP verification (5 attempts, 15-min lockout)

**Pipeline Runner (`lib/pipeline/runner.ts`, 487 lines):**
- `startCrawl()` (lines 68-130): Phase 1 — discovery, Jina pass, fire Firecrawl jobs. Creates `previousRunSnapshot` (lines 73-81) on re-runs.
- `completePipeline()` (lines 138-328): Phase 2 — poll FC jobs, analyze, generate, assemble. Atomic DB write at lines 291-307.
- **`baselineScorecard` does NOT exist** — no column in schema, no logic in pipeline.
- `analyzeGeoGaps()` already accepts `previousScorecard` param for trend detection.

**Domain Verification:**
- `domainVerified` (boolean) and `verifyToken` (text) on `geoSites` table (schema.ts lines 80-81)
- Verified via DNS TXT record at `POST /api/sites/[id]/verify-domain`
- `verify-connection` is diagnostic only (tests llms.txt accessibility, no DB update)

**Existing Scripts (`scripts/`):**
- `check-site.mjs`, `list-sites.mjs`, `reset-for-recrawl.mjs`, `trigger-pipeline.mjs`, `link-orphan-sites.mjs`, `create-and-link-users.mjs`, `rerun-summaries.mjs`, `validate-projected-score.mjs`

### Ambiguities Flagged to CoFounder

1. **Rate limiting scope for /api/serve/***: TS-004 says "10 requests per slug per minute per IP" using in-memory Map. On Vercel serverless, each invocation may be a cold start with empty state — rate limiting is per-instance, not global. **Recommendation**: Accept per-instance limitation for alpha. Upgrade to Upstash Redis for GA if needed.

2. **Backfill strategy for baselineScorecard**: Existing sites have no baseline. TS-004 says "treat current geoScorecard as baseline on next run." **Recommendation**: On next `completePipeline()`, if `baselineScorecard` is null AND `previousRunSnapshot` exists, backfill `baselineScorecard` from `previousRunSnapshot.geoScorecard`. If no snapshot exists, use current run as baseline.

3. **DMZ formalization deliverable**: TS-004 says create `.agents/specs/ops/dmz-boundary.md` and route to OpsMaster. Since this is a documentation+audit task, the engineering spec defines what ScriptDev should verify in code and what OpsMaster should document.

4. **Alpha tester domain list**: TS-004 suggests `ALPHA_TESTER_DOMAINS` in `lib/config.ts`. This is a runtime config that changes as testers connect. **Recommendation**: Use config file for now, migrate to DB flag if list exceeds 20.

---

## b) Implementation Requirements

### Task 1: Customer Allowlist for /api/serve/* (#11)

**Create file:** `lib/crawler-allowlist.ts`

```ts
/** Known AI crawler User-Agent patterns — these are the consumers we WANT */
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

**Architecture: Option B (per TS-004 recommendation)** — check in serve route handlers, not middleware. Rationale: serve routes already query DB to find site by slug — adding domain verification check has near-zero marginal cost. Middleware should stay lightweight.

**Create file:** `lib/serve-guard.ts`

This module encapsulates the 3-layer check for all serve routes:

```ts
import { isKnownAICrawler } from "./crawler-allowlist";
import { checkRateLimit } from "./rate-limit";
import { db } from "./db";
import { geoSites } from "./db/schema";
import { eq } from "drizzle-orm";

interface ServeGuardResult {
  allowed: boolean;
  reason: "ai_crawler" | "verified_domain" | "rate_limited" | "unknown_allowed";
  status?: number;    // HTTP status if blocked (429)
  retryAfter?: number; // seconds
}

export async function checkServeAccess(
  req: Request,
  slug: string,
): Promise<ServeGuardResult> {
  const ua = req.headers.get("user-agent") ?? "";
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // Layer 1: Known AI crawler — always allow
  if (isKnownAICrawler(ua)) {
    return { allowed: true, reason: "ai_crawler" };
  }

  // Layer 2: Verified customer domain (Referer/Origin check)
  const referer = req.headers.get("referer") ?? req.headers.get("origin") ?? "";
  if (referer) {
    try {
      const refDomain = new URL(referer).hostname.replace(/^www\./, "");
      // Check if any verified site matches this domain
      const [verifiedSite] = await db
        .select({ id: geoSites.id })
        .from(geoSites)
        .where(eq(geoSites.domainVerified, true))
        .limit(1);
      // More precise: check domain match against site's domain
      // Implementation: query where domain matches refDomain AND domainVerified = true
      if (verifiedSite) {
        return { allowed: true, reason: "verified_domain" };
      }
    } catch { /* invalid URL in referer, fall through */ }
  }

  // Layer 3: Unknown traffic — rate limit
  const rateKey = `serve:${slug}:${ip}`;
  const { allowed, resetAt } = checkRateLimit(rateKey, 10, 60_000); // 10 req/min/slug/IP
  if (!allowed) {
    return {
      allowed: false,
      reason: "rate_limited",
      status: 429,
      retryAfter: Math.ceil((resetAt - Date.now()) / 1000),
    };
  }

  return { allowed: true, reason: "unknown_allowed" };
}
```

**Modify each serve route** (5 files):
- `app/api/serve/[slug]/llms.txt/route.ts`
- `app/api/serve/[slug]/llms-full.txt/route.ts`
- `app/api/serve/[slug]/business.json/route.ts`
- `app/api/serve/[slug]/schema.json/route.ts`
- `app/api/serve/[slug]/schema.js/route.ts`

Add at the top of each GET handler, before the site lookup:

```ts
import { checkServeAccess } from "@/lib/serve-guard";

// Inside GET handler, before site query:
const { slug } = await params;
const guard = await checkServeAccess(req, slug);
if (!guard.allowed) {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(guard.retryAfter ?? 60) },
  });
}
```

**Optimization:** The domain verification query in Layer 2 adds a DB call. To avoid this, use a domain match against the site being served (already queried in the route):

```ts
// After site is fetched from DB (which already happens in the route):
// Check if referer domain matches site domain AND site is verified
if (site.domainVerified && refDomain === site.domain.replace(/^www\./, "")) {
  // Verified customer — allow
}
```

This avoids the extra DB query — the site lookup already happens.

**Layer 2 refined implementation** (integrate into serve route after site lookup):

```ts
// Already in route: const site = await db.select().from(geoSites).where(...)
const guard = await checkServeAccess(req, slug);
if (guard.reason === "rate_limited") {
  return new Response("Too Many Requests", {
    status: 429,
    headers: { "Retry-After": String(guard.retryAfter ?? 60) },
  });
}
// Layer 2 check (post site-lookup):
if (!guard.allowed && !isVerifiedCustomerRequest(req, site)) {
  // This shouldn't happen with current logic, but defensive
}
```

Actually, simpler approach: **Move Layer 2 inside the route handler** since the site is already loaded:

**Final Architecture for each serve route:**

```ts
import { isKnownAICrawler } from "@/lib/crawler-allowlist";
import { checkRateLimit } from "@/lib/rate-limit";

export async function GET(req: Request, { params }: { params: { slug: string } }) {
  const { slug } = await params;
  const ua = req.headers.get("user-agent") ?? "";
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  // Layer 1: AI crawlers pass through
  const isAICrawler = isKnownAICrawler(ua);

  if (!isAICrawler) {
    // Layer 3: Rate limit unknown traffic (Layer 2 checked after site lookup)
    const { allowed, resetAt } = checkRateLimit(`serve:${slug}:${ip}`, 10, 60_000);
    if (!allowed) {
      return new Response("Too Many Requests", {
        status: 429,
        headers: { "Retry-After": String(Math.ceil((resetAt - Date.now()) / 1000)) },
      });
    }
  }

  // Existing site lookup...
  const [site] = await db.select().from(geoSites).where(eq(geoSites.slug, slug));
  if (!site) return new Response("Not found", { status: 404 });

  // Layer 2: Verified customer domain (referer matches site domain + verified)
  // Not blocking — just for logging/analytics differentiation

  // Existing: log crawl, return file...
}
```

**Simplification rationale:** Layer 2 doesn't block anyone — it's for analytics only (distinguishing customer traffic from unknown). Layer 1 (AI crawlers) and Layer 3 (rate limit) are the actual enforcement. This keeps the code simple.

**Files changed:** 1 new (`lib/crawler-allowlist.ts`), 5 modified (serve routes)

---

### Task 2: DMZ Architecture Formalization (#13)

This is primarily an **audit and documentation** task. Engineering spec defines what ScriptDev verifies in code.

#### Code Audit Checklist

ScriptDev must run these checks and document results:

```bash
# 1. Stripe SDK import isolation
grep -rn "stripe" app/api/ lib/ --include="*.ts" --include="*.tsx" | grep -v node_modules

# Expected: only in app/api/checkout/ and app/api/webhooks/stripe/

# 2. No PII in pipeline data
grep -rn "email\|creditCard\|payment" lib/pipeline/ lib/services/ --include="*.ts"

# Expected: zero hits (or only in type definitions, not data flow)

# 3. Cross-zone import check
grep -rn "from.*checkout\|from.*webhook.*stripe" lib/pipeline/ lib/services/ app/api/cron/ --include="*.ts"

# Expected: zero hits
```

#### Boundary Definition

| Zone | Routes | DB Tables (Write) | External Services | Imports |
|------|--------|-------------------|-------------------|---------|
| **Payment** | `/api/checkout`, `/api/webhooks/stripe` | `teams` (credits), `creditTransactions` | Stripe SDK | stripe, drizzle |
| **Auth** | `/auth/*`, `/api/teams/*` | `teams`, `teamMembers` | Supabase Auth | @supabase/ssr |
| **Pipeline** | `/api/sites/[id]/regenerate`, `/api/cron/*` | `geoSites` (all fields), `teams` (credit check READ only) | Gemini, Jina, Firecrawl, ScraperAPI, Apify | AI SDKs, crawler libs |
| **Serve** | `/api/serve/*` | `geoCrawlLogs` (INSERT only), `geoSites` (READ only) | None | drizzle (read) |
| **Report** | `/api/report/*` | `geoSites` (READ only) | None | drizzle (read) |

#### Shared Table Access Points

`creditTransactions` is the only table touched by both Payment and Pipeline zones:
- **Payment zone**: INSERT on `checkout.session.completed` webhook (topup)
- **Pipeline zone**: INSERT on regenerate (crawl_debit) — this is the credit deduction in `regenerate/route.ts`

This is acceptable — the `creditTransactions` table is an audit log, not shared mutable state.

#### Deliverable

ScriptDev creates: `.agents/specs/ops/dmz-boundary.md` with:
1. Zone diagram (ASCII)
2. Table access matrix
3. Import audit results
4. Recommendations for enforcement (boundary comments, optional ESLint rule)

#### Optional: Boundary Comments

Add to each zone's entry file:

```ts
// @zone: payment — do not import pipeline or serve modules
// @zone: pipeline — do not import payment or stripe modules
// @zone: serve — read-only DB access, no mutations except crawl logs
```

**Files changed:** 0 code files modified, 1 documentation file created

---

### Task 3: Before/After GEO Scoring (#9)

#### Step 1: Database Migration

**Modify file:** `lib/db/schema.ts`

Add column to `geoSites` table (after line 73, near `previousRunSnapshot`):

```ts
baselineScorecard: jsonb("baseline_scorecard"),  // Score0: first pipeline run scorecard
```

**Migration command:**
```sql
ALTER TABLE geo_sites ADD COLUMN baseline_scorecard JSONB;
```

Or via Drizzle: `npx drizzle-kit generate` → `npx drizzle-kit push`

#### Step 2: Pipeline — Capture Baseline on First Run

**Modify file:** `lib/pipeline/runner.ts`

Insert between line 239 (after `analyzeGeoGaps()` returns `geoScorecard`) and line 291 (atomic DB write):

```ts
// After line 239: const geoScorecard = await analyzeGeoGaps(...)

// Capture baseline on first successful run
let baselineScorecard = site.baselineScorecard;
if (!baselineScorecard && geoScorecard) {
  baselineScorecard = geoScorecard;
}
```

Add `baselineScorecard` to the atomic DB write block (line 291-307):

```ts
await db.update(geoSites)
  .set({
    // ... existing fields ...
    baselineScorecard,  // ADD THIS — only writes non-null on first run
  })
  .where(eq(geoSites.id, siteId));
```

**Backfill logic** (for existing sites with no baseline): On next `completePipeline()` run, if `baselineScorecard` is null:
- If `previousRunSnapshot?.geoScorecard` exists → use that as baseline (it's the score before the current run)
- If no snapshot → current run's scorecard becomes the baseline

This happens naturally: the `if (!baselineScorecard && geoScorecard)` check on the next run will set the baseline to whatever the current score is. For sites with history, the `previousRunSnapshot` provides a better baseline. Add:

```ts
// Improved backfill: prefer previousRunSnapshot for existing sites
let baselineScorecard = site.baselineScorecard;
if (!baselineScorecard) {
  const snapshot = site.previousRunSnapshot as { geoScorecard?: unknown } | null;
  if (snapshot?.geoScorecard) {
    baselineScorecard = snapshot.geoScorecard;
  } else if (geoScorecard) {
    baselineScorecard = geoScorecard;
  }
}
```

#### Step 3: API Response — Add Baseline Fields

**Modify file:** `app/api/sites/[id]/route.ts`

Add to the always-included response fields:

```ts
// Baseline score (available to all tiers — it's just a number)
const baseline = site.baselineScorecard as { overallScore?: number } | null;
const current = site.geoScorecard as { overallScore?: number } | null;

response.baselineScore = baseline?.overallScore ?? null;
response.improvementDelta = (baseline && current && baseline.overallScore !== undefined && current.overallScore !== undefined)
  ? current.overallScore - baseline.overallScore
  : null;
```

For the **paid tier**, add per-pillar baseline comparison:

```ts
if (tier === "paid" && baseline) {
  response.baselineScorecard = baseline;
  // Per-pillar delta
  const baselinePillars = (baseline as { pillars?: Array<{ pillar: string; score: number }> }).pillars ?? [];
  const currentPillars = (current as { pillars?: Array<{ pillar: string; score: number }> }).pillars ?? [];
  response.pillarDeltas = currentPillars.map(cp => {
    const bp = baselinePillars.find(b => b.pillar === cp.pillar);
    return {
      pillar: cp.pillar,
      before: bp?.score ?? null,
      after: cp.score,
      delta: bp ? cp.score - bp.score : null,
    };
  });
}
```

For the **free tier**: `baselineScore` and `improvementDelta` are numbers (always visible). `baselineScorecard` full data and `pillarDeltas` are paid-only.

#### Step 4: Dashboard — Before/After Comparison View

**Modify file:** `app/sites/[id]/ResultsDashboard.tsx`

**Update SiteData interface:**

```ts
interface SiteData {
  // ... existing fields ...
  baselineScore: number | null;      // NEW
  improvementDelta: number | null;   // NEW
  baselineScorecard?: unknown;       // NEW (paid only)
  pillarDeltas?: Array<{             // NEW (paid only)
    pillar: string;
    before: number | null;
    after: number;
    delta: number | null;
  }>;
}
```

**Add improvement banner** (insert after header section, before/instead of free tier banner when delta exists):

When `improvementDelta !== null` and `improvementDelta > 0`:

```tsx
{site.improvementDelta != null && site.improvementDelta > 0 && (
  <div style={{
    background: "linear-gradient(135deg, #052e16, #14532d)",
    border: "1px solid #22c55e",
    borderRadius: 12,
    padding: "20px 24px",
    marginBottom: 24,
  }}>
    <div style={{ color: "#22c55e", fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
      Your GEO Score Improved!
    </div>
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <span style={{ color: "#888", fontSize: 28 }}>{site.baselineScore}</span>
      <span style={{ color: "#666", fontSize: 20 }}>→</span>
      <span style={{ color: "#fff", fontSize: 28, fontWeight: 700 }}>
        {(site.geoScorecard as { overallScore: number })?.overallScore}
      </span>
      <span style={{
        color: "#22c55e",
        fontSize: 16,
        fontWeight: 600,
        background: "rgba(34,197,94,0.15)",
        padding: "4px 12px",
        borderRadius: 20,
      }}>
        +{site.improvementDelta}
      </span>
    </div>
    {/* Per-pillar deltas (paid tier only) */}
    {site.tier === "paid" && site.pillarDeltas && (
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {site.pillarDeltas
          .filter(d => d.delta != null && d.delta > 0)
          .sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0))
          .slice(0, 6)
          .map(d => (
            <div key={d.pillar} style={{ color: "#888", fontSize: 13 }}>
              {d.pillar}: {d.before} → {d.after}{" "}
              <span style={{ color: "#22c55e" }}>+{d.delta}</span>
            </div>
          ))}
      </div>
    )}
  </div>
)}
```

**Edge case:** When `improvementDelta === 0` or negative, don't show the celebration banner. Optionally show "Score unchanged" or "Score decreased — check recent changes" in neutral styling.

**Files changed:** 3 modified (`schema.ts`, `runner.ts`, `sites/[id]/route.ts`, `ResultsDashboard.tsx`)

---

### Task 4: Alpha Tester Onboarding (#12)

#### Step 1: Alpha Tester Config

**Modify file:** `lib/config.ts`

Add to existing config:

```ts
// Alpha tester domains — populated as testers connect
export const ALPHA_TESTER_DOMAINS: string[] = [
  // "example.com",
  // "happypathfire.com",
];
```

#### Step 2: Admin Status Script

**Create file:** `scripts/alpha-status.mjs`

```js
#!/usr/bin/env node
/**
 * Alpha Site Status — shows health of all alpha tester domains
 * Usage: node scripts/alpha-status.mjs
 */

// Query geoSites for alpha domains
// For each: show domain, pipelineStatus, overallScore, lastCrawlAt, nextCrawlAt, crawlCount
// Flag: stale (lastCrawlAt > 7 days), errored (pipelineStatus = "failed"), never-run
// Output: formatted table to stdout
```

**Implementation details:**
- Import `ALPHA_TESTER_DOMAINS` from config (or accept `--all` flag to show all sites)
- Connect to DB via Drizzle (use same connection pattern as other scripts)
- Query `geoSites` where `domain IN (ALPHA_TESTER_DOMAINS)`
- Output columns: domain, status, score, lastCrawl, nextCrawl, crawlCount, issues
- Issues flagging: `lastCrawlAt > 7 days ago` → "STALE", `pipelineStatus = "failed"` → "ERROR", `crawlCount = 0` → "NEVER_RUN"

#### Step 3: Stress Test Script

**Create file:** `scripts/stress-test-serve.mjs`

```js
#!/usr/bin/env node
/**
 * Stress test /api/serve endpoints for alpha sites
 * Usage: node scripts/stress-test-serve.mjs [--concurrent=10] [--duration=30]
 */

// For each alpha domain: resolve slug, hit each of the 5 serve endpoints
// Measure: response time, status code, content size
// Report: p50, p95, p99 latency, error rate, total requests
```

**Implementation details:**
- Accept `--concurrent` (default 10) and `--duration` (default 30s) flags
- For each alpha domain, lookup slug from DB
- Hit all 5 endpoints: llms.txt, llms-full.txt, business.json, schema.json, schema.js
- Use native `fetch()` (Node 18+) for requests
- Collect metrics: { url, status, latencyMs, bodyLength }
- Report summary table with p50/p95/p99 stats

#### Step 4: Verify Weekly Recrawl

**Verification (no code change expected):**
- Confirm `runner.ts:303` sets `nextCrawlAt` to 7 days after completion
- Confirm `recrawl/route.ts` queries where `nextCrawlAt < now`
- Confirm `recrawl/route.ts` calls `startCrawl(id, domain, PAID_MAX_PAGES)` (from ES-002)
- Verify the cron schedule is configured in Vercel (or `vercel.json`): `/api/cron/recrawl` should run every hour or every 15 minutes

#### Step 5: Onboarding Checklist Document

**Create file:** `scripts/ALPHA_ONBOARDING.md`

Document for each new alpha tester:
1. User creates account via login page
2. Team created automatically with 20 bonus credits
3. User runs audit on their domain
4. User deploys generated files (llms.txt, schema.json)
5. User verifies domain (DNS TXT record)
6. User verifies connection (llms.txt accessible)
7. Admin adds domain to `ALPHA_TESTER_DOMAINS` in config
8. Weekly recrawl activates automatically (nextCrawlAt set on completion)
9. Monitor via `node scripts/alpha-status.mjs`

**Files changed:** 1 modified (`lib/config.ts`), 2 new scripts, 1 documentation file

---

### Error Handling Requirements

**Task 1 (Allowlist):**
- Rate limit `checkRateLimit` is in-memory — cold starts have empty state. This is acceptable for alpha: worst case, a rate-limited user gets 10 extra requests on cold start.
- Invalid Referer URL: catch and ignore, fall through to rate limiting.
- Missing UA header: treat as unknown traffic (Layer 3).

**Task 3 (Scoring):**
- `baselineScorecard` is null for all existing sites until next pipeline run — API handles null gracefully.
- If `geoScorecard` is null (pipeline incomplete), don't attempt delta calculation.
- If `baselineScorecard.overallScore` equals `geoScorecard.overallScore`, `improvementDelta = 0` — no celebration banner.

**Task 4 (Ops):**
- Scripts should exit with non-zero code on failure.
- Scripts should handle empty `ALPHA_TESTER_DOMAINS` gracefully (print "No alpha domains configured").

### Performance Requirements

**Task 1:** Rate limit check is O(1) Map lookup — negligible overhead. Domain verification check reuses the already-loaded site object — zero extra queries.

**Task 3:** One additional JSONB column (`baselineScorecard`) adds ~2KB per site to the DB response. No additional queries — it's fetched in the existing site SELECT.

---

## c) Unit Test Plan

### Test Cases for Crawler Allowlist (#11)

**Test file:** `__tests__/crawler-allowlist.test.ts` (NEW)

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| 1 | GPTBot recognized | `"Mozilla/5.0 (compatible; GPTBot/1.0)"` | `isKnownAICrawler` = true |
| 2 | ClaudeBot recognized | `"ClaudeBot/1.0"` | true |
| 3 | PerplexityBot recognized | `"PerplexityBot/1.0"` | true |
| 4 | Googlebot recognized | `"Googlebot/2.1"` | true |
| 5 | Regular browser not recognized | `"Mozilla/5.0 (Windows NT 10.0; Win64; x64)"` | false |
| 6 | Empty UA string | `""` | false |
| 7 | Case insensitive matching | `"gptbot"` | true |
| 8 | Partial match in longer UA | `"Mozilla/5.0 (compatible; GPTBot/1.0; +http://...)"` | true |

### Test Cases for Rate Limiting on Serve Routes (#11)

**Test file:** `__tests__/serve-guard.test.ts` (NEW)

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 9 | AI crawler bypasses rate limit | UA = GPTBot, 100 requests | All pass, no 429 |
| 10 | Unknown UA rate limited at 10/min | UA = browser, 11 requests same IP+slug | First 10 pass, 11th → 429 |
| 11 | Different IPs not rate limited together | 2 IPs, 10 requests each | All 20 pass |
| 12 | Different slugs not rate limited together | Same IP, 10 req to slug-A + 10 to slug-B | All 20 pass |
| 13 | 429 response includes Retry-After header | Rate limited request | `Retry-After` header present, numeric value |
| 14 | Rate limit resets after window | 10 requests → wait 60s → 11th request | 11th passes |

### Test Cases for Baseline Scoring (#9)

**Test file:** `__tests__/baseline-scoring.test.ts` (NEW)

| # | Test Case | Setup | Expected | Edge |
|---|-----------|-------|----------|------|
| 15 | First run: baseline captured | `baselineScorecard: null`, `geoScorecard` produced | `baselineScorecard = geoScorecard` | — |
| 16 | Second run: baseline unchanged | `baselineScorecard` exists, new `geoScorecard` | `baselineScorecard` unchanged | — |
| 17 | Backfill from previousRunSnapshot | `baselineScorecard: null`, `previousRunSnapshot.geoScorecard` exists | `baselineScorecard = previousRunSnapshot.geoScorecard` | — |
| 18 | No snapshot, no baseline: use current | `baselineScorecard: null`, `previousRunSnapshot: null` | `baselineScorecard = current geoScorecard` | — |
| 19 | API: improvementDelta calculated | baseline=23, current=67 | `improvementDelta: 44` | — |
| 20 | API: improvementDelta null when no baseline | `baselineScorecard: null` | `improvementDelta: null` | — |
| 21 | API: improvementDelta zero | baseline=50, current=50 | `improvementDelta: 0` | Same score |
| 22 | API: negative delta | baseline=70, current=60 | `improvementDelta: -10` | Score decreased |
| 23 | Paid tier: pillarDeltas included | `tier: "paid"`, baseline + current with pillars | `pillarDeltas` array present with per-pillar before/after | — |
| 24 | Free tier: pillarDeltas excluded | `tier: "free"` | `pillarDeltas` not in response, `baselineScorecard` not in response | — |
| 25 | Free tier: baselineScore number visible | `tier: "free"`, baseline exists | `baselineScore` and `improvementDelta` present | Numbers are free |

### Test Cases for Dashboard Improvement Banner (#9)

**Extend:** `__tests__/paywall-ui.test.tsx`

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 26 | Improvement banner shown | `improvementDelta: 44`, `baselineScore: 23` | "Your GEO Score Improved!" + "23 → 67 +44" visible |
| 27 | No banner when delta is null | `improvementDelta: null` | Banner not rendered |
| 28 | No banner when delta is 0 | `improvementDelta: 0` | Banner not rendered |
| 29 | No banner when delta is negative | `improvementDelta: -5` | Banner not rendered (or shows neutral message) |
| 30 | Per-pillar deltas shown for paid | `tier: "paid"`, `pillarDeltas` with 3 improved pillars | Pillar improvements listed |
| 31 | Per-pillar deltas hidden for free | `tier: "free"` | Pillar details not rendered |

**Minimum coverage target:** 90% line coverage for `lib/crawler-allowlist.ts` and `lib/serve-guard.ts`, 85% for baseline scoring logic in `runner.ts`.

---

## d) Integration Test Plan

**Test file:** `__tests__/integration/sprint3-flow.test.ts` (NEW)

### Serve Route Protection Scenarios (#11)

| # | Scenario | Flow | Assertions |
|---|----------|------|------------|
| 1 | AI crawler fetches llms.txt | Request with GPTBot UA → GET /api/serve/[slug]/llms.txt | 200 OK, content returned |
| 2 | Rate limited unknown UA | 11 rapid requests with browser UA → same slug, same IP | First 10 → 200, 11th → 429 with Retry-After |
| 3 | Multiple file types served | GPTBot requests all 5 file types for one slug | All 200, correct content-types |
| 4 | Non-existent slug | GET /api/serve/bad-slug/llms.txt | 404 Not Found |

### Baseline Scoring Scenarios (#9)

| # | Scenario | Flow | Assertions |
|---|----------|------|------------|
| 5 | First pipeline run captures baseline | Create site → run pipeline → check DB | `baselineScorecard` populated, equals `geoScorecard` |
| 6 | Re-run preserves baseline | Run pipeline twice | `baselineScorecard` from run 1, `geoScorecard` from run 2 |
| 7 | API returns improvement delta | Complete two runs → GET /api/sites/[id] | `baselineScore`, `improvementDelta`, `pillarDeltas` present |
| 8 | Dashboard renders improvement | API with delta → render ResultsDashboard | Improvement banner visible |

### DMZ Boundary Scenarios (#13)

| # | Scenario | Verification | Expected |
|---|----------|-------------|----------|
| 9 | No stripe import in pipeline zone | grep code audit | Zero hits |
| 10 | No PII in pipeline data flow | grep code audit | Zero hits |
| 11 | Serve zone is read-only | Code review of serve routes | Only SELECT queries + INSERT to crawlLogs |

### Failure Mode Tests

| # | Scenario | Expected |
|---|----------|----------|
| 12 | Rate limit on cold start (empty Map) | First 10 requests always pass |
| 13 | Serve route with null generated content | 404 (existing behavior preserved) |
| 14 | Baseline scoring with malformed scorecard | `baselineScorecard` set to null, no crash |

---

## e) Profiling Requirements

### What to Measure

| Metric | Baseline | Target | How |
|--------|----------|--------|-----|
| `/api/serve/*` response time (AI crawler) | ~30ms | < 35ms (negligible overhead from UA check) | Manual timing |
| `/api/serve/*` response time (unknown UA, rate limit check) | ~30ms | < 40ms | Manual timing |
| `/api/serve/*` response time (rate limited, 429) | N/A | < 5ms (no DB query) | Manual timing |
| `completePipeline` duration with baseline save | ~45s | < 46s (one extra JSONB write) | Pipeline logs |
| `GET /api/sites/[id]` with baselineScore | ~80ms | < 85ms (no extra query) | Manual timing |

### When to Profile

- After Task 1: Compare serve endpoint latency before/after allowlist check
- After Task 3: Measure pipeline completion time with baselineScorecard write
- Run stress test script (Task 4) to validate serve performance under load

---

## f) Load Test Plan

### Scenarios

| # | Scenario | Concurrent | Duration | Description |
|---|----------|------------|----------|-------------|
| 1 | AI crawler burst on serve | 50 GPTBot UAs | 60s | Simulate crawl spike from AI indexers |
| 2 | Rate limit enforcement | 20 browser UAs × 1 slug | 60s | Verify 429s kick in at 10/min |
| 3 | Mixed serve traffic | 30 AI + 20 unknown | 120s | Realistic traffic mix |
| 4 | Alpha site recrawl batch | 10 sites | 1 run | All alpha sites recrawled in one cron pass |

### Success Criteria

| Metric | Target |
|--------|--------|
| Serve p50 (AI crawler) | < 50ms |
| Serve p95 (AI crawler) | < 150ms |
| 429 response p50 | < 10ms |
| Recrawl 10 sites | Complete within cron maxDuration (60s) |

### Tool

Use `scripts/stress-test-serve.mjs` (Task 4 deliverable) for serve endpoint testing.

---

## g) Logging & Instrumentation

### Events to Log

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `serve_access_allowed` | `debug` | `{ slug, reason: "ai_crawler"\|"verified_domain"\|"unknown_allowed", ua, ip }` | Request passes allowlist |
| `serve_rate_limited` | `warn` | `{ slug, ip, retryAfter }` | Request rate limited |
| `baseline_captured` | `info` | `{ siteId, overallScore }` | First pipeline run saves baseline |
| `baseline_backfilled` | `info` | `{ siteId, source: "previousRunSnapshot"\|"currentRun", overallScore }` | Existing site gets baseline |
| `improvement_calculated` | `info` | `{ siteId, baselineScore, currentScore, delta }` | API returns improvement delta |
| `dmz_audit_pass` | `info` | `{ zone, violations: 0 }` | DMZ audit finds no violations |
| `dmz_audit_violation` | `error` | `{ zone, file, violation }` | DMZ audit finds cross-zone import |
| `alpha_status_check` | `info` | `{ totalSites, healthy, stale, errored }` | Admin script run |

### Metrics to Emit

| Metric | Type | Labels |
|--------|------|--------|
| `serve_requests_total` | counter | `reason: "ai_crawler"\|"verified_domain"\|"unknown"\|"rate_limited"` |
| `serve_rate_limited_total` | counter | `slug` |
| `baseline_captures_total` | counter | — |
| `improvement_delta_distribution` | histogram | — |

---

## h) Acceptance Criteria

### Task 1: Customer Allowlist (#11)

- [ ] `lib/crawler-allowlist.ts` exists with `AI_CRAWLER_UA_PATTERNS` and `isKnownAICrawler()` function
- [ ] Known AI crawlers (GPTBot, ClaudeBot, Googlebot, etc.) always pass through — never rate limited
- [ ] Unknown traffic rate limited at 10 req/min/slug/IP
- [ ] Rate-limited requests return 429 with `Retry-After` header
- [ ] No performance regression on serve endpoints (< 10ms added latency)
- [ ] All 5 serve routes updated with allowlist check
- [ ] All new unit tests pass (14 test cases)

### Task 2: DMZ Formalization (#13)

- [ ] No `stripe` import exists outside Payment Zone routes
- [ ] No PII (email, payment details) flows into pipeline data
- [ ] DMZ boundary documented in `.agents/specs/ops/dmz-boundary.md`
- [ ] `creditTransactions` is the only table both Payment and Pipeline zones touch
- [ ] Boundary comments added to zone entry files (optional)

### Task 3: Before/After Scoring (#9)

- [ ] `baselineScorecard` JSONB column exists in `geoSites` table (migration applied)
- [ ] First pipeline run saves `geoScorecard` as `baselineScorecard`
- [ ] Subsequent pipeline runs do NOT overwrite `baselineScorecard`
- [ ] Backfill works: existing sites get baseline from `previousRunSnapshot` on next run
- [ ] API returns `baselineScore` (number) and `improvementDelta` (number) for all tiers
- [ ] API returns `baselineScorecard` (full) and `pillarDeltas` (array) for paid tier only
- [ ] Dashboard shows "Your GEO Score Improved!" banner when `improvementDelta > 0`
- [ ] Per-pillar deltas visible for paid users in improvement banner
- [ ] No banner when delta is null, zero, or negative
- [ ] All new unit tests pass (17 test cases)

### Task 4: Alpha Onboarding (#12)

- [ ] `ALPHA_TESTER_DOMAINS` array in `lib/config.ts`
- [ ] `scripts/alpha-status.mjs` shows health of all alpha sites
- [ ] `scripts/stress-test-serve.mjs` validates serve performance
- [ ] Weekly recrawl verified: `nextCrawlAt` set correctly, cron picks up due sites
- [ ] `scripts/ALPHA_ONBOARDING.md` documents full onboarding process
- [ ] Cron schedule configured in Vercel for `/api/cron/recrawl`

### Overall Sprint 3

- [ ] Sprints 1+2 are merged and stable
- [ ] All 4 tasks complete in recommended order: #11 → #13 → #9 → #12
- [ ] No regressions in existing serve endpoints, pipeline, or API
- [ ] Build and type-check pass
- [ ] DB migration applied successfully
- [ ] Test coverage ≥ 85% for new/modified files

---

## Dependencies & Ordering

```
Sprint 1+2 stable
    │
    ├──→ #11 Customer allowlist (independent)
    ├──→ #13 DMZ formalization (independent, can parallel with #11)
    │
    └──→ #9 Before/after scoring (depends on pipeline running)
          └──→ #12 Alpha onboarding (depends on #9 for monitoring + serve endpoints from #11)
```

#11 and #13 can start immediately (in parallel with Sprint 2 if desired).
#9 and #12 should wait until Sprints 1+2 are stable.

## Files Summary

| Action | File | Task |
|--------|------|------|
| **CREATE** | `lib/crawler-allowlist.ts` | #11 |
| **MODIFY** | `app/api/serve/[slug]/llms.txt/route.ts` | #11 |
| **MODIFY** | `app/api/serve/[slug]/llms-full.txt/route.ts` | #11 |
| **MODIFY** | `app/api/serve/[slug]/business.json/route.ts` | #11 |
| **MODIFY** | `app/api/serve/[slug]/schema.json/route.ts` | #11 |
| **MODIFY** | `app/api/serve/[slug]/schema.js/route.ts` | #11 |
| **MODIFY** | `lib/db/schema.ts` | #9 (migration) |
| **MODIFY** | `lib/pipeline/runner.ts` | #9 (baseline capture) |
| **MODIFY** | `app/api/sites/[id]/route.ts` | #9 (API response) |
| **MODIFY** | `app/sites/[id]/ResultsDashboard.tsx` | #9 (improvement banner) |
| **MODIFY** | `lib/config.ts` | #12 (alpha domains) |
| **CREATE** | `scripts/alpha-status.mjs` | #12 |
| **CREATE** | `scripts/stress-test-serve.mjs` | #12 |
| **CREATE** | `scripts/ALPHA_ONBOARDING.md` | #12 |
| **CREATE** | `.agents/specs/ops/dmz-boundary.md` | #13 |
| **CREATE** | `__tests__/crawler-allowlist.test.ts` | #11 |
| **CREATE** | `__tests__/serve-guard.test.ts` | #11 |
| **CREATE** | `__tests__/baseline-scoring.test.ts` | #9 |
| **CREATE** | `__tests__/integration/sprint3-flow.test.ts` | #11, #9 |

**Total:** 9 new files, 10 modified files
