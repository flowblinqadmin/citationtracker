# GEO Audit Platform — Business Logic

This document explains how the platform works: what it does, how each flow is implemented, and the rules that govern credits, scoring, and crawling. Read this before touching any billing, pipeline, or audit logic.

---

## Table of Contents

1. [What is GEO?](#1-what-is-geo)
2. [Audit Types: Single vs Bulk](#2-audit-types-single-vs-bulk)
3. [User Flow (End-to-End)](#3-user-flow-end-to-end)
3b. [Authentication & Session Management](#3b-authentication--session-management)
4. [The 7-Stage Pipeline](#4-the-7-stage-pipeline)
5. [Credit System](#5-credit-system)
6. [The 16-Pillar Scoring System](#6-the-16-pillar-scoring-system)
7. [Generated Assets](#7-generated-assets)
8. [Crawling Strategy](#8-crawling-strategy)
9. [Security Rules](#9-security-rules)
10. [Pipeline Status Reference](#10-pipeline-status-reference)
11. [Key Constants Reference](#11-key-constants-reference)

---

## 1. What is GEO?

GEO (Generative Engine Optimization) is an AI discoverability audit platform. It analyzes a website and tells you how well that site can be found, understood, and cited by AI platforms — ChatGPT, Claude, Perplexity, Gemini.

**The core problem:** Search ranking doesn't translate to AI ranking. A site with great SEO can be invisible to AI because it lacks structured data, clear author signals, or machine-readable content. GEO audits find these gaps.

**What the platform produces:**

| Output | Description |
|--------|-------------|
| GEO scorecard | A score out of 100 across 16 pillars, each with detailed findings |
| Ranked recommendations | Ordered list of fixes sorted by impact (critical → high → medium → low) |
| `llms.txt` | A machine-readable file AI crawlers consume to understand the site |
| Schema.org blocks | JSON-LD blocks to copy-paste into the site's `<head>` |
| Business JSON | Structured contact/business info for AI systems |
| Executive summary | 2–3 paragraph human summary of key findings and what to do first |
| Citation check (TS-015) | Whether AI platforms actively cite the brand in relevant queries (web-search grounded) |

---

## 2. Audit Types: Single vs Bulk

### Single Audit

- User submits one URL
- Requires Pro tier (free tier is currently disabled)
- Costs **20 credits** flat
- Crawls up to **100 pages** (PAID_MAX_PAGES)
- Pipeline runs: discover → crawl → poll → research → analyze → generate → assemble
- Results viewable at `/sites/[id]`

### Bulk Audit

- User uploads a CSV of URLs (up to **500 URLs** per batch)
- Requires Pro tier
- Costs **1 credit per 5 pages** crawled
- Pro users get **10 free pages** even with 0 credits (BULK_FREE_PAGES)
- All URLs in a single CSV upload share a **batchId** — they're treated as one campaign
- Each URL in the CSV becomes its own `geoSites` record with its own pipeline run
- Results are viewable per-site and downloadable as a bundle

### When to use which

- Single: deep audit of one domain you own or manage
- Bulk: competitive research on a market (e.g. "audit all 200 hospitals in Ontario")

---

## 3. User Flow (End-to-End)

### Single Audit

```
1. Homepage → user enters URL
2. POST /api/sites
   - Validates URL (SSRF check, must be http/https, no private IPs)
   - Creates geoSites record (status: "pending")
   - Sends OTP email via Resend
3. User enters OTP at /verify/[id]
4. POST /api/sites/[id]/verify
   - Validates code (SHA-256 hash comparison, timing-safe)
   - Checks OTP attempts (max 5, then 15-min lockout)
   - Creates Supabase auth user via admin API (email_confirm: true)
     - If user already exists, looks up their userId from teamMembers table
   - Calls ensureTeamForUser(userId, email, { skipBonus: true })
     - Creates team with 0 credits (free users get FREE_MAX_PAGES, not credits)
   - Generates session token via admin.generateLink({ type: "magiclink" })
     - Returns hashed_token as authOtp in API response (never the raw token)
     - NOTE: "magiclink" is a Supabase API parameter — no magic link email is sent
   - Marks emailVerified = true
   - Enqueues discover stage via QStash (maxPages = FREE_MAX_PAGES)
5. Client at /verify/[id] receives authOtp + email in response
   - Calls supabase.auth.verifyOtp({ token_hash: authOtp, type: "magiclink" })
   - Sets Supabase session cookies — user is now authenticated
   - Redirects to /sites/[id]?token=accessToken
6. Pipeline runs asynchronously (see §4)
7. On completion → email sent to owner with results link
8. User views results at /sites/[id]
   - Supabase session is active: "Upgrade Now" and checkout work without re-login
```

### Bulk Audit

```
1. Homepage → user uploads CSV
2. POST /api/sites
   - Parses CSV, extracts unique domains
   - Validates each URL (SSRF, dedup)
   - Creates ONE geoSites record per domain, all sharing the same batchId
   - Sends ONE OTP email (covers all domains in the batch)
3. User enters OTP once
4. POST /api/sites/[id]/verify (bulk path)
   - Loads all sites with matching batchId
   - Calculates crawl_limit per site (see §5)
   - Reserves credits: inserts credit_transactions rows
   - Enqueues discover stage for EACH domain via QStash
5. Pipelines run in parallel, one per domain
6. In assemble stage: reconciles actual vs reserved credits, issues refunds
7. Results viewable per-site or as bundle download
```

### Regenerate (Re-Run Audit)

```
1. User clicks "Run Audit Again" on a completed site
2. POST /api/sites/[id]/regenerate
   - Saves current scorecard as previousRunSnapshot (for diff view)
   - Saves current scorecard as baselineScorecard if first run
   - Resets crawlData, crawlJobIds
   - Resets pipelineStatus → "pending"
   - Enqueues discover stage
3. Pipeline re-runs with same crawlLimit as original
```

Regenerate is rate-limited: `manualRunsThisMonth` caps re-runs per 30-day window.

---

## 3b. Authentication & Session Management

Every user — free or paid — ends up with a Supabase session. This section documents how that session is established and what it unlocks.

### Two auth paths

| Path | Trigger | Supabase session established by |
|------|---------|----------------------------------|
| OTP verify (free audit) | User enters 6-digit code at `/verify/[id]` | `verifyOtp({ token_hash, type: "magiclink" })` on the client after OTP passes (Supabase API param, not a user-facing magic link) |
| OAuth callback (paid/returning) | Google OAuth | `exchangeCodeForSession(code)` inside `app/auth/callback/route.ts` |

Both paths call `ensureTeamForUser()` after authentication to guarantee the user has a team. The only behavioral difference is the `skipBonus` flag.

### OTP verify path (free audit users)

Handled in `app/api/sites/[id]/verify/route.ts` and `app/verify/[id]/page.tsx`.

**Server side (route handler):**
1. OTP is validated (SHA-256 hash comparison, timing-safe, max 5 attempts).
2. `admin.auth.admin.createUser({ email, email_confirm: true })` creates the Supabase user without a password. If the user already exists, their `userId` is fetched from `teamMembers` by email.
3. `ensureTeamForUser(userId, email, { skipBonus: true })` provisions team (idempotent — no-op if they already have one). `skipBonus: true` means the team starts with 0 credits.
4. `admin.auth.admin.generateLink({ type: "magiclink", email })` generates a one-time session token. The `"magiclink"` is a Supabase API parameter — no magic link email is sent. The route only extracts the `hashed_token` from `linkData.properties.hashed_token`.
5. The route returns `{ authOtp: hashed_token, email }` alongside the normal `accessToken` and `siteId`.

**Client side (verify page):**
1. On successful API response, the client calls `supabase.auth.verifyOtp({ token_hash: data.authOtp, type: "magiclink" })`.
2. Supabase sets session cookies. The user now has a valid Supabase session.
3. The client redirects to `/sites/[id]?token=accessToken`.

If `SUPABASE_SERVICE_ROLE_KEY` is not set (test environments, build time), `getSupabaseAdmin()` returns null and the auth steps are skipped. Users can still view results via `accessToken`, but will lack a Supabase session.

### OAuth callback path (paid/returning users)

Handled in `app/auth/callback/route.ts`.

1. Supabase exchanges the OAuth `code` for a session via `exchangeCodeForSession(code)`.
2. `ensureTeamForUser(userId, email)` is called without `skipBonus` — defaults to `skipBonus: false`, so a new team gets `SIGNUP_BONUS_CREDITS` (20 credits).
3. User is redirected to `/dashboard` (or the `next` param if present and safe).

### Team provisioning: `ensureTeamForUser()`

`lib/services/provision-team.ts` handles three cases idempotently:

| Case | What happens |
|------|-------------|
| User already has a `teamMembers` row | No-op; returns existing `teamId` |
| Email matches a pending invite (userId is null) | Accepts invite by setting `userId` and `inviteAcceptedAt` |
| First login | Creates team + owner membership. Grants `SIGNUP_BONUS_CREDITS` unless `skipBonus: true`. Links any orphan `geoSites` rows with matching `ownerEmail` |

### Credit model by auth path

| User type | Credits on first login | Max pages per audit |
|-----------|----------------------|---------------------|
| Free OTP verify | 0 credits (`skipBonus: true`) | `FREE_MAX_PAGES` (20 pages) |
| OAuth / paid | `SIGNUP_BONUS_CREDITS` (20 credits) | `creditBalance * PAGES_PER_CREDIT`, capped at `ABSOLUTE_MAX_PAGES` |

Free users get a fixed page allotment, not credits. To unlock more pages they must upgrade (purchase credits via Stripe).

### Upgrade flow

Once the user has a Supabase session, the upgrade path works without re-authentication:

```
1. User clicks "Upgrade Now" on /sites/[id]
2. POST /api/checkout → creates Stripe checkout session
   - Requires valid Supabase session (401 if missing)
3. User completes Stripe checkout
4. Stripe webhook → POST /api/webhooks/stripe
   - Adds CREDITS_PER_PACK (100) credits to team.creditBalance
   - Writes creditTransactions row (type: "topup")
5. User returns to dashboard with updated credit balance
```

Before this auth fix, free OTP users had no Supabase session and hit 401 on step 2, being redirected to login instead of checkout. The `verifyOtp` call in the client during OTP verify eliminates that redirect.

### Admin client (`lib/supabase/admin.ts`)

A singleton `SupabaseClient` initialized with `SUPABASE_SERVICE_ROLE_KEY`. Used exclusively for:
- `admin.auth.admin.createUser()` — create user without email confirmation flow
- `admin.auth.admin.generateLink()` — generate session token server-side (Supabase API uses "magiclink" type internally)

Returns `null` when `SUPABASE_SERVICE_ROLE_KEY` is not set. All call sites check for null and treat auth steps as non-fatal (user can still use `accessToken` to view results).

---

## 4. The 7-Stage Pipeline

The pipeline is QStash-orchestrated. Each stage is a POST to `/api/pipeline/stage` with a stage name and payload. QStash handles retries (but we set retries: 0 — we do our own retry logic).

**Golden rule:** Every stage returns HTTP 200, even on failure. QStash must not retry autonomously. Failures are written to the DB (`pipelineError`, `pipelineStatus = "failed"`).

**Timeout budget:** Each stage has a 105-second stage-level timeout (Vercel kills at 120s). The 15-second buffer lets `markFailed()` write to the DB before the process dies.

### Stage 1: Discover

**Purpose:** Build the list of URLs to crawl.

**For single audits:**
- Calls Firecrawl `mapUrl(domain, { limit: maxPages })`
- Returns a flat list of URLs with page-type classifications
- Page types: homepage, about, pricing, services, team, contact, blog, docs, faq, case-studies, legal, other

**For bulk audits:**
- URLs come from the CSV — discovery is skipped
- The `discoveryData` is pre-populated from CSV contents

**Output saved to:** `geoSites.discoveryData`

### Stage 2: Crawl

**Purpose:** Fetch the content of all discovered pages.

**For single audits (≤ 100 URLs):**
1. Jina parallel scrape on all URLs (free, ~15s flat)
2. Pages with < 500 chars or error-page signals are flagged as failed
3. Failed pages → Firecrawl async crawl jobs (handles JS, anti-bot)

**For bulk audits (≤ 500 URLs):**
- Uses Firecrawl batch/scrape (`POST /v1/batch/scrape`) via `submitChunkedBatchScrape()`
- URLs split into 500-URL chunks, submitted sequentially
- Each chunk tracked in `firecrawl_jobs` table

**Output saved to:** `geoSites.crawlData` (partial, completed as chunks finish)

### Stage 3: Poll

**Purpose:** Wait for Firecrawl async jobs to complete.

- Polls every 15 seconds (FIRECRAWL_POLL_INTERVAL_MS)
- Circuit breaker: aborts after 20 minutes if jobs haven't completed
- For bulk audits ≤ 500 URLs: polling is embedded in `submitChunkedBatchScrape()` — this stage is skipped
- Merges new pages into existing `crawlData`

**State checked:** `geoSites.crawlJobIds`

### Stage 4: Research

**Purpose:** Gather competitive intelligence.

- Queries Perplexity (sonar-pro model) with the site's domain and business description
- Extracts top competitors and their GEO status (do they have llms.txt? structured data?)
- Classifies the business into an industry using Schema.org types found in the crawl
- Retryable (up to 2 retries with 30s/60s delays)

**Output saved to:** `geoSites.researchData`

### Stage 5: Analyze

**Purpose:** Score the site across 16 GEO pillars.

- Sends crawl data + competitive intel to Gemini
- Uses Gemini Flash (1M tokens) for shorter prompts, Gemini Pro (2M tokens) for large sites
- Returns a score 0–100 for each pillar plus specific findings and recommendations
- Retryable (up to 2 retries)
- **Grounding check:** After scoring, `groundAndCorrectScorecard()` cross-references pillar scores against crawl evidence (e.g., FAQ count, structured data presence). If a score contradicts the data, it sends a correction call to Gemini, then clamps deterministically if still wrong.

**Output saved to:** `geoSites.geoScorecard`

### Stage 6: Generate

**Purpose:** Create the deployable GEO assets.

- Calls OpenAI with site content, scorecard, and business context
- Produces `llms.txt`, `llms-full.txt`, `businessJson`, and Schema.org blocks
- Output is Zod-validated with a safe JSON fallback
- Retryable (up to 2 retries)

**Output saved to:** `geoSites.generatedLlmsTxt`, `generatedSchemaBlocks`, `generatedBusinessJson`

### Stage 7: Assemble

**Purpose:** Rank recommendations and write the executive summary.

- Sorts all pillar recommendations by impact tier: critical → high → medium → low
- Calculates projected score boost (sum of top 5 improvements)
- Writes a 2–3 paragraph executive summary
- **For bulk audits:** reconciles actual vs reserved credits and issues refunds
- Sends completion email to site owner
- Retryable (up to 2 retries)

**Output saved to:** `geoSites.recommendations`, `geoSites.executiveSummary`

---

## 5. Credit System

### How credits work

1 credit = 5 pages crawled

Credits are consumed when a crawl starts and reconciled when it finishes (refund if fewer pages were actually crawled).

### Sources of credits

| Source | Amount | Trigger |
|--------|--------|---------|
| Signup bonus (OAuth/paid path) | 20 credits | User creates account via OAuth — `skipBonus: false` in `ensureTeamForUser()` |
| Signup bonus (free OTP path) | 0 credits | OTP verify — `skipBonus: true`; free users get `FREE_MAX_PAGES` pages instead |
| Credit purchase | 100 credits per $10 | Stripe checkout |
| Refund | varies | Actual pages < reserved pages |

### Credit consumption

| Audit type | Cost |
|-----------|------|
| Single audit (Pro) | 20 credits flat (= 100 pages max) |
| Bulk audit | `ceil(actualPagesCrawled / 5)` credits |
| Bulk minimum (Pro, 0 credits) | 0 credits deducted; crawls up to 10 pages free |

### Credit reservation for bulk audits

At OTP verification, credits are **reserved** (not finalized) based on `effectiveCrawlLimit()`:

```typescript
effectiveCrawlLimit(csvUrlCount, creditBalance) =
  min(csvUrlCount, max(creditBalance * 5, BULK_FREE_PAGES), ABSOLUTE_MAX_PAGES)

// Example: 200 URLs, 30 credits, BULK_FREE_PAGES = 10, ABSOLUTE_MAX_PAGES = 500
// = min(200, max(150, 10), 500) = 150 pages → 30 credits reserved
```

After the crawl completes:
- If actual pages = 130 (fewer than 150), refund 4 credits `ceil((150 - 130) / 5)`
- A `credit_transactions` row is written for both the debit and the refund

### Credit transaction log

Every credit movement writes a row to `creditTransactions`:

| type | When written |
|------|-------------|
| `signup_bonus` | Account creation |
| `crawl_debit` | OTP verification (single or bulk) |
| `topup` | Stripe payment confirmed |
| `bulk_crawl_refund` | Assembler stage reconciliation |

The balance is `teams.creditBalance` — always the ground truth. Transactions are an audit log.

---

## 6. The 16-Pillar Scoring System

The GEO score (0–100) is a weighted average across 16 pillars. Each pillar has a weight from 2.5 to 4.9. Higher-weight pillars have more impact on the overall score.

| # | Pillar | Weight | What it checks |
|---|--------|--------|---------------|
| 1 | Author Authority (E-E-A-T) | 4.9 | Named authors with credentials, bios, expertise signals |
| 2 | Content Freshness | 4.7 | Publication dates, last-updated timestamps, recency signals |
| 3 | Structured Data (Schema.org) | 4.6 | JSON-LD presence, type accuracy, completeness |
| 4 | FAQ Coverage | 4.5 | Question-answer content that AI models can extract |
| 5 | Contact & Trust Signals | 4.3 | Phone, address, email, business registration signals |
| 6 | Semantic HTML | 4.2 | Proper heading hierarchy, landmark elements, alt text |
| 7 | Content Structure | 4.1 | Clear sections, logical flow, scannable formatting |
| 8 | Evidence & Statistics | 4.0 | Data citations, statistics, third-party references |
| 9 | Internal Linking | 3.8 | Topical coverage, breadcrumb trails, related content |
| 10 | Metadata Freshness | 3.7 | Meta descriptions, Open Graph, title relevance |
| 11 | Entity Definitions | 3.6 | Company name, product names, key people defined clearly |
| 12 | Offering Clarity | 3.5 | What the site sells, who it's for, clear value proposition |
| 13 | Multi-Format Content | 3.2 | Video, images, tables, downloadable assets |
| 14 | CTA Structure | 3.0 | Clear calls to action, conversion paths |
| 15 | Competitive Positioning | 2.8 | Differentiators stated vs. competitors |
| 16 | AI Licensing Signals | 2.5 | `llms.txt` presence, robots.txt AI directives, UCP manifest |

### Overall score calculation

The Gemini model produces a score (0–10) per pillar. The weighted average is:

```
overallScore = sum(pillarScore_i × weight_i) / sum(weight_i) × 10
```

The final score is on a 0–100 scale.

### Recommendation tiers

| Tier | Score gap | Description |
|------|-----------|-------------|
| Critical | 0–3 / 10 | Missing entirely — highest impact fixes |
| High | 4–5 / 10 | Present but severely incomplete |
| Medium | 6–7 / 10 | Partially implemented, needs improvement |
| Low | 8–9 / 10 | Minor polish, minimal impact |

Recommendations are ranked: all criticals first, then highs, then mediums, then lows. Within each tier, higher-weight pillars appear first.

---

## 7. Generated Assets

### `llms.txt`

A plain text file served at `/llms.txt` that tells AI crawlers what the site is, what it sells, who it serves, and what pages to prioritize. Format modeled on the emerging `llms.txt` standard.

- Stored in `geoSites.generatedLlmsTxt`
- Served publicly at `/api/serve/{slug}/llms.txt`
- Automatically updated on re-runs

### `llms-full.txt`

Extended version with more page summaries. Used by AI systems that process larger contexts.

### Schema.org Blocks

An array of JSON-LD blocks that the site owner installs in their HTML `<head>`. Each block targets a different Schema.org type:

- `Organization` — company details
- `LocalBusiness` — physical location if applicable
- `FAQPage` — question/answer content
- `BreadcrumbList` — navigation structure
- `Product` / `Service` — offering definitions

Returned as a JSON array at `/api/serve/{slug}/schema.json`.

### Business JSON

Structured extraction of business identity: name, description, founding date, contact info, social links. Used internally by the analysis pipeline and exposed for downstream integrations.

### Access tokens

Completed audits can be shared publicly without login using a `shareToken` (stored in `geoSites.shareToken`). Reports can also be downloaded as HTML/ZIP bundles from `/api/sites/[id]/download-report`.

---

## 8. Crawling Strategy

See `CRAWLER_ARCHITECTURE.md` for full detail. Summary:

| Tier | Tool | Cost | When used |
|------|------|------|-----------|
| 0 | Firecrawl `mapUrl` | 1 credit/domain | URL discovery (single audit) |
| 1 | Jina | Free | First pass on all URLs (parallel) |
| 2 | Firecrawl async | 1 credit/page | Failed Jina pages (single audit) |
| 3 | Firecrawl batch/scrape | 1 credit/page | Bulk audits (≤ 500 URLs) |

**Quality check:** After crawling, `scoreCrawlQuality()` assesses the crawl:
- `goodPages`: pages with ≥ 500 chars of real content
- `errorPages`: pages with error signals
- `blockedByAntiBot`: Cloudflare/DDoS challenge pages
- `usable`: true if enough good pages exist to run analysis

If the crawl is not usable, the pipeline fails with a descriptive error rather than producing a garbage scorecard.

---

## 9. Security Rules

### SSRF protection

All user-submitted URLs pass through `normalizeUrl()` before any fetch:
- Must be `http://` or `https://`
- Hostname must not resolve to private IP ranges (10.x, 192.168.x, 127.x, ::1, fc00::/7, fe80::/10)
- `localhost` and `0.0.0.0` blocked

### OTP brute-force protection

- Max 5 OTP attempts per site
- After 5 failures: `otpLockedUntil = now + 15 minutes`
- Lock state stored in `geoSites` (DB-backed, survives restarts)
- Code stored as SHA-256 hash; comparison uses `timingSafeEqual` (prevents timing attacks)
- OTP expires after 15 minutes

### Pipeline authentication

- QStash requests validated via signature (Receiver with current + next signing keys)
- Fallback: Bearer token matching `CRON_SECRET` env var
- Unauthorized requests → 403

### Middleware allowlist

Every API sub-route must be in the `ALWAYS_ALLOWED` list in `middleware.ts`. Missing = 403 in production. When adding a new API route, add it to `ALWAYS_ALLOWED` and add a corresponding test in `middleware.test.ts`.

---

## 10. Pipeline Status Reference

| Status | Meaning | Next state |
|--------|---------|-----------|
| `pending` | Created, not started | `discovery` |
| `queued` | Waiting for a crawl slot (concurrency cap) | `discovery` |
| `discovery` | Firecrawl mapUrl running | `crawling` |
| `crawling` | Crawl jobs in progress | `researching` |
| `researching` | Perplexity competitive intel queries | `analyzing` |
| `analyzing` | Gemini scoring 16 pillars | `generating` |
| `generating` | OpenAI producing llms.txt + schema | `assembling` |
| `assembling` | Ranking recommendations + executive summary | `complete` |
| `complete` | Results ready, email sent | — |
| `failed` | Error — see `pipelineError` field | (user can retry) |

---

## 11. Key Constants Reference

All constants live in `lib/config.ts`. Never hardcode these values elsewhere.

| Constant | Value | Meaning |
|----------|-------|---------|
| `FREE_MAX_PAGES` | 20 | Page cap for free tier (currently disabled) |
| `PAID_MAX_PAGES` | 100 | Page cap for Pro single audit |
| `SIGNUP_BONUS_CREDITS` | 20 | Credits given on account creation |
| `CREDITS_PER_PACK` | 100 | Credits per Stripe purchase |
| `CREDITS_PRICE_CENTS` | 1000 | $10.00 per pack |
| `PAGES_PER_CREDIT` | 5 | Conversion rate: 1 credit = 5 pages |
| `PAID_CRAWL_CREDIT_COST` | 20 | Credits for a single Pro audit |
| `BULK_MAX_URLS` | 500 | Max URLs in a bulk CSV upload |
| `BULK_FREE_PAGES` | 10 | Free page floor for Pro users on bulk audits |
| `ABSOLUTE_MAX_PAGES` | 500 | Hard system ceiling — no audit crawls more than this |
| `BULK_CREDIT_PRICE_INR` | 20 | 1 credit = ₹20 (for INR pricing display) |
| `FIRECRAWL_CHUNK_SIZE` | 500 | URLs per Firecrawl batch/scrape job |
| `FIRECRAWL_POLL_INTERVAL_MS` | 15 000 | Poll interval for async jobs |
| `FIRECRAWL_MAX_RETRIES` | 2 | Retries per chunk on failure |
| `BULK_CHUNKING_THRESHOLD` | 500 | URL count above which chunked path is used |

---

## Related Docs

| Document | What it covers |
|----------|---------------|
| `CRAWLER_ARCHITECTURE.md` | Crawl tier details, performance targets, cost model |
| `SECURITY_HARDENING_SPEC.md` | Middleware allowlist, rate limiting, WAF rules, admin client security |
| `docs/pipeline-failure-recovery.md` | Failure detection, partial results, manual recovery |
| `docs/firecrawl-capability-findings.md` | Firecrawl limits and API behaviour findings |
| `docs/specs/engineering/ES-025-auth-session-fix.md` | Auth session fix implementation — OTP verify creates Supabase session |
| `docs/specs/engineering/` | Feature specs (ES-xxx) — implementation plans |
| `docs/specs/technical/` | Technical specs (TS-xxx) — architecture decisions |
| `docs/spec-index.md` | Index of all open specs and blockers |
