# Cross-Repo Audit — Reusable Code for GEO

> Addresses GitHub issue #32.
> Audited repos: `apiaudit`, `flowblinq_fullrepo`
> Author: CoFounder | Date: 2026-03-02

---

## TL;DR

Both repos contain **production-ready code that directly accelerates TS-015 (AI Citation
Monitoring) and #31 (SoV checker).** Do not rebuild from scratch. Do not use FireGEO as the
primary reference. Use `apiaudit` and `flowblinq_fullrepo` instead — they're on our stack.

**Single most important finding:** `flowblinq_fullrepo/brands-api/src/services/ai-visibility-engine.ts`
is functionally identical to TS-015. It queries 4 LLMs for brand mentions, calculates visibility
scores, and stores structured results. It already exists and works.

---

## Repo 1: apiaudit

**Path:** `/home/aditya/flowblinq_stage/apiaudit/`

### sov-checker.ts ★★★ HIGH PRIORITY for TS-015

**Path:** `lib/services/sov-checker.ts`

Multi-LLM brand mention detection — exactly what TS-015 needs.

| Property | Detail |
|----------|--------|
| **LLM providers** | GPT-4o-mini, Claude Haiku 4.5, Gemini 2.5 Flash Lite, Perplexity Sonar |
| **Model selection** | Cheaper/faster models (haiku, mini, flash) — right choice for 16 calls per check |
| **Query structure** | System: "shopping advisor, name 3-5 brands"; User: the query |
| **Mention detection** | Regex-based, case-insensitive, extracts 50-char context window around mention |
| **Scoring** | SoV% = (brand mentions / total slots) × 100; top competitor extracted |
| **Rate limiting** | 500ms delay between batches |
| **Key exports** | `checkSingleQuery()`, `computeSovSummary()`, `checkShareOfVoice()` |

**How it maps to TS-015:**
- `checkSingleQuery()` → per-(prompt, provider) pair → feeds `partial-result` SSE event
- `computeSovSummary()` → `CitationScores.overallVisibility` calculation
- Model choices are cheaper than FireGEO's (GPT-4o-mini vs GPT-4o; Haiku vs Sonnet) —
  16 calls per check makes cost significant

---

### intelligence-gatherer.ts ★★★ HIGH PRIORITY for TS-015 prompt generation

**Path:** `lib/services/intelligence-gatherer.ts`

Two-phase domain analysis: Perplexity crawls the domain → ChatGPT generates queries.

| Property | Detail |
|----------|--------|
| **Phase 1** | Perplexity sonar crawls the URL, returns: brandName, vertical, targetCustomer, coreCategorySummary, pricePositioning, primaryMarkets, competitors |
| **Phase 2** | GPT-4o-mini generates 8 realistic queries from crawl data (location-aware, avoids brand name) |
| **Region detection** | `detectRegionFromUrl()` maps 32 TLDs to currency/region |
| **Query types** | 3 discovery + 2 product-specific + 2 buying-scenario + 1 category landscape |

**Why this is better than TS-015's current template approach:**
TS-015 uses static `PROMPT_TEMPLATES` with `{serviceType}` substitution. `intelligence-gatherer.ts`
uses Perplexity to *actually crawl the domain* and generate queries grounded in real site content
— competitors, product categories, actual use cases. Produces far more relevant prompts.

---

### competitor-prober.ts — MEDIUM

**Path:** `lib/services/competitor-prober.ts`

Probes competitor domains for ACP endpoints, product feeds, platform detection (Shopify/Magento/etc).

**Reuse for TS-015:** `extractCompetitorsFromSov()` converts SoV mention data into a deduplicated
competitor list — reuse this for `CitationResponse.competitorsMentioned` extraction.

---

### Other useful files

| File | What | Reuse |
|------|------|-------|
| `lib/services/catalog-crawler.ts` | Multi-strategy product discovery (Perplexity → sitemap → Firecrawl) | Medium — URL discovery patterns |
| `lib/services/technical-checker.ts` | 12-point technical audit (robots.txt, schema.org, SSL, TTFB) | High — same pattern for crawler access checks |
| `lib/services/acp-probes.ts` | 5 parallel endpoint probes | High — probe pattern for brand endpoints |
| `app/api/acp-monitor/route.ts` | Time-series JSONB storage (domain, vertical, scores, timestamp) | **Very High** — exact pattern for recurring citation checks (TS-015 future: scheduled checks) |
| `lib/db/schema.ts` | `audit_reports` + `acp_monitoring` tables | High — schema reference |
| `lib/rate-limit.ts` | In-memory sliding-window rate limiter | Low — geo already has this; note same bug (#101) |

---

## Repo 2: flowblinq_fullrepo

**Path:** `/home/aditya/flowblinq_stage/flowblinq_fullrepo/`

### ai-visibility-engine.ts ★★★ CRITICAL — functionally identical to TS-015

**Path:** `brands-api/src/services/ai-visibility-engine.ts`

Complete visibility audit orchestrator — this IS TS-015.

| Property | Detail |
|----------|--------|
| **Flow** | Generate 15+ queries → dispatch to all LLMs in parallel → parse mentions → calculate scores → store → email |
| **LLM providers** | OpenAI, Perplexity, Anthropic, Google Gemini |
| **Progress callbacks** | `onProgress?: (progress: number) => Promise<void>` — maps directly to SSE streaming |
| **DB tables used** | `auditRequests`, `auditLlmResponses`, `auditScores` |

**DB schema that maps to `citation_checks`:**

```
auditLlmResponses:
  auditId, llmProvider, model, query, response (text),
  responseTimeMs, citations (jsonb array)

auditScores:
  auditId, mentionRate, positionScore, consistencyScore,
  citationScore, checkoutScore, totalScore, competitorSummary (jsonb)
```

This is functionally equivalent to our `citation_checks` table. **Consider adopting this schema
split** (separate responses + scores tables) instead of one wide JSONB column.

---

### llm-clients/ ★★★ — drop-in LLM abstraction layer

**Path:** `brands-api/src/services/llm-clients/`

| File | Provider |
|------|----------|
| `openai.ts` | GPT-4o, GPT-4o-mini |
| `anthropic.ts` | Claude models |
| `perplexity.ts` | Perplexity with web search |
| `gemini.ts` | Google Gemini |
| `index.ts` | `queryAllClients(prompt)` — parallel dispatch, fault-tolerant |

`queryAllClients()` returns `LLMResponse[]` — one per provider, with error handling per provider
so a single failure doesn't block others. Exact pattern TS-015 needs.

---

### query-generator.ts — HIGH

**Path:** `brands-api/src/services/query-generator.ts`

Category-specific query templates with persona variation.

Categories: automotive, beauty, electronics, food, fashion, home, health, industrial, sports, toys.

For each category, 6 query templates × multiple personas (budget, premium, eco, health, tech, bulk).
TS-015 should extend this to also include GEO/SEO service category queries.

---

### Credit system — HIGH

**Path:** `brands-api/src/lib/credit-service.ts`

Atomic credit deduction pattern: `UPDATE WHERE balance >= amount`. Same as geo's existing credit
system — confirms our implementation is correct. Check for any edge cases we haven't covered.

---

### Auth + RBAC — MEDIUM (geo already has equivalent)

**Path:** `brands-api/src/lib/auth.ts`, `sales-orders-api/src/lib/auth.ts`

Local JWT verification (no external auth service). Multi-role permission matrix. Brand isolation
at middleware layer. Geo already implements the core of this; reference for edge cases only.

---

### Security middleware — HIGH (for #101 fix)

**Path:** `sales-orders-api/src/middleware/rateLimiter.ts`

**Important for issue #101:** This is a proper token-bucket rate limiter with per-IP windowing.
Same in-memory limitation as geo's current `lib/rate-limit.ts` — confirms both have the same
vulnerability. The fix for #101 (DB-backed counter) is still correct.

---

### Payment / ACP checkout — MEDIUM for geo

**Path:** `brands-api/src/routes/checkout-sessions.ts`, `lib/payment-processor.ts`

Full ACP checkout flow (session → inventory reserve → payment → fulfillment). Not directly needed
for geo's GEO audit product, but essential reference if geo ever handles direct payments (currently
uses Stripe checkout redirect). The multi-PSP abstraction (Stripe + Razorpay) is directly relevant
for India market.

---

### Dashboard components — HIGH for #21 (Brand Monitor Dashboard)

**Path:** `frontend/app/brand-portal/[brandSlug]/acp/`

Pages: dashboard, orders, analytics, products, credits, settings, security, enrichment.
Components: KPI cards, system health, activity feed, revenue chart, analytics.

These are **exactly** what GitHub issue #21 (Brand Monitor Dashboard) needs. Copy the layout
patterns and component structure for the `AI Visibility` tab (TS-015 UI) and the larger brand
monitor M5 dashboard.

---

## Issue-to-Code Mapping

| GitHub Issue | Existing Code to Reuse |
|-------------|------------------------|
| **#104 / TS-015** (AI Citation Monitoring) | `ai-visibility-engine.ts` (primary), `sov-checker.ts`, `llm-clients/index.ts`, `intelligence-gatherer.ts` |
| **#31** (SoV checker port) | `sov-checker.ts` (direct port) — absorbed into TS-015 |
| **#21** (Brand Monitor Dashboard) | `frontend/app/brand-portal/` components |
| **#20** (Weekly snapshot cron) | `acp-monitor/route.ts` time-series pattern |
| **#19** (Response enrichment) | `sov-checker.ts` competitor extraction + `query-generator.ts` |
| **#17** (Prompt library generator) | `query-generator.ts` (direct port) |
| **#16** (Brand monitor DB schema) | `auditRequests` + `auditLlmResponses` + `auditScores` tables |
| **#101** (OTP rate-limiter fix) | Reference `rateLimiter.ts` pattern — implement DB-backed version |
| **#89** (AI crawler hit tracking) | `technical-checker.ts` robots.txt + UA parsing patterns |

---

## Recommendations for TS-015 / ES-015

1. **Replace FireGEO as primary reference** with `apiaudit/sov-checker.ts` + `flowblinq_fullrepo/ai-visibility-engine.ts`. These are on our exact stack (Next.js + Drizzle + Supabase).

2. **Use cheaper models** (haiku, mini, flash-lite, sonar) not premium ones. 16 LLM calls per check at premium model prices is ~$0.10–0.30 per check; at haiku/mini it's ~$0.01–0.03.

3. **Replace static prompt templates** with `intelligence-gatherer.ts` pattern: use Perplexity to crawl the domain first, generate grounded queries from real site content. Costs 1 extra Perplexity call per check but produces far more relevant prompts.

4. **Consider splitting `citation_checks` into two tables** matching the `auditLlmResponses` + `auditScores` schema in flowblinq_fullrepo — easier to query per-provider breakdowns.

5. **Issue #31 is absorbed into TS-015** — do not build separately.

---

## Files to Clone/Reference

```
# Primary references for TS-015 implementation
/home/aditya/flowblinq_stage/apiaudit/lib/services/sov-checker.ts
/home/aditya/flowblinq_stage/apiaudit/lib/services/intelligence-gatherer.ts
/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/ai-visibility-engine.ts
/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/llm-clients/index.ts
/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/services/query-generator.ts

# Schema reference
/home/aditya/flowblinq_stage/flowblinq_fullrepo/brands-api/src/db/schema.ts
/home/aditya/flowblinq_stage/apiaudit/lib/db/schema.ts

# Dashboard UI reference (for Brand Monitor M5)
/home/aditya/flowblinq_stage/flowblinq_fullrepo/frontend/app/brand-portal/
```

---

_Author: CoFounder (Agent 1) | Closes #32 | 2026-03-02_
