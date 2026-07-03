# ES-e2e-fixtures — Deterministic seeded fixtures for local-Supabase E2E

**Branch:** `e2e-comprehensive-suite` (tip `a36606e` at spec time).
**Source TS:** none — Shastri pivot dispatch 2026-04-20, Aditya approved.
**Driver:** PR-1 Stage 7 browser gate hitting successive pre-condition failures (Chromium missing → macOS-hardcoded webServer → missing `geo_site_view` → `token_expires_at NOT NULL` violation at retry #2). Ad-hoc per-spec `createSiteWithKnownOtp` drift has exceeded useful life. Real fix: a single, deterministic seed script that plants a known world-state in local Supabase before any spec runs.

**Scope:** design + contract only. This ES produces no code. ScriptDev implements under a separate PR against `e2e-comprehensive-suite`.

---

## a) Overview

Produce two scripts and their Playwright wiring:

1. `scripts/e2e/seed.ts` — creates one test team, one test user, 5 seeded `geo_sites` at known pipeline stages, matching `geo_site_view` rows, credits state, consent state, and dependent rows. Re-runnable. Refuses to run against production.
2. `scripts/e2e/teardown.ts` — enumerates and purges every row tagged with the seed identifier, plus `rate_limits` rows keyed to the test user so OTP-lockout specs stay idempotent.
3. `e2e/fixtures/ids.ts` — module that exports hard-coded UUIDs + slugs for specs to `import`.
4. `package.json` — `db:seed:e2e` and `db:teardown:e2e` scripts.
5. `e2e/global-setup.ts` — extended to invoke `db:seed:e2e` after the existing Supabase + Mailpit reachability checks.

**Design pivot (CoFounder's call, SpecMaster ratifies):** DELETE-then-INSERT over upsert. Justification in §b.6.

**Time-determinism pivot (HP-260, Aditya-ratified 2026-04-20):** the seed uses an absolute `SEED_EPOCH = "2026-04-01T00:00:00.000Z"` constant for EVERY timestamp column (`createdAt`, `updatedAt`, `acceptedAt`, `viewedAt`, `tokenExpiresAt`, `tokenRotatedAt`, `lastCrawlAt`, `nextCrawlAt`, `lastSignificantChange`, `manualRunsResetAt`, `codeExpiresAt`, `crawlStartedAt`, `requestedAt`, `expiresAt`, `redeemedAt`, etc.). All row-specific timestamps are computed as `SEED_EPOCH + <fixed-offset>` (e.g. `SEED_EPOCH - 10m`, `SEED_EPOCH + 90d`). **No `NOW()`, `new Date()`, or `CURRENT_TIMESTAMP` anywhere in seed.ts or fixture payloads.** Choice of `2026-04-01T00:00:00Z` — first day of April 2026, 20 days after the ES-086/082 sprint landed (so it falls within the "current operational era" on the branch) yet stable across any replay of the test suite. Side benefit: specs asserting "audit N days ago" compute deterministic, byte-equal display strings on any host, any timezone (the seed stamps UTC; specs must render UTC or timezone-normalize).

---

## b) Implementation Requirements

### b.1 Test team identity + deterministic UUID — auth.users provisioning included (AC-1, AC-24)

All fixtures are anchored to **one** test team and **one** test user:

| Key | Value | Column |
|-----|-------|--------|
| `TEST_TEAM_ID` | `00000000-e2e-0000-0000-000000000001` | `teams.id` (text, UUID-shaped) |
| `TEST_USER_ID` | `00000000-0000-4000-8000-0000000000a1` | `teams.owner_user_id` (text), `team_members.user_id`, `consent_records.user_id` |
| `TEST_USER_EMAIL` | `adityanittoor+geotests@gmail.com` | `team_members.email`, `consent_records.email`, `geo_sites.owner_email` |
| `TEST_TEAM_NAME` | `E2E Test Team` | `teams.name` |
| `SEED_TAG` | `e2e-seed` | tag value stored in `teams.name` suffix, `team_members.invite_token` = `e2e-seed:<sub>`, `credit_transactions.type` prefix, `consent_records.user_agent`, etc. (see §b.9 for the full tag column table) |

Rationale:
- `teams.id` is `text("id").primaryKey()` (schema.ts:12). It accepts any string; we use a literal UUID for operator readability.
- `owner_user_id` is `text` (schema.ts:14) but semantically a Supabase `auth.users` UUID. **The seed MUST provision a `auth.users` row keyed to `TEST_USER_ID`** — see the design note immediately below and AC-24.
- Email matches `otp-helper.ts:14` (`TO_FILTER = "adityanittoor+geotests@gmail.com"`) so OTP IMAP polling continues to work.

**Design note (Fix 4, supersedes prior version): seed provisions a Supabase `auth.users` row.**

The earlier version of this section claimed "the seed does NOT create a Supabase auth row — OTP tests exercise the real auth path." That was a wrong assumption and Phase E (109-spec run @ commit `ac10c4a`) blew it up. The actual product call chain at branch tip `97703b4`:

1. `app/auth/login/page.tsx:79–107` — after `supabase.auth.verifyOtp({ email, token, type: "email" })` succeeds, the page calls `await fetch("/api/consent")` and gates the `/dashboard` redirect on `{ hasConsent: true }`.
2. `app/api/consent/route.ts:15` — `const user = await getAuthenticatedUser();` returns the **Supabase `auth.users` row** for the verifying session. Line 19 then queries `consent_records` keyed by `user.id` (i.e. the auth.users UUID).
3. `supabase.auth.signInWithOtp({ email })` against an unprovisioned email creates a brand-new `auth.users` row with a **random UUIDv4** — never `TEST_USER_ID`.

So the chain is: Supabase generates a random `auth.users.id` per run → `/api/consent` looks up `consent_records WHERE user_id = <random-uuid>` → no match → `hasConsent: false` → page sets `requiresConsent` → URL stays on `/auth/login`. FI-001 happy path and FI-004 returning-user-skips-consent (AC-23) both break for the same reason.

**Fix:** the seed provisions an `auth.users` row with `id = TEST_USER_ID`, `email = TEST_USER_EMAIL`, `email_confirm = true`, so that every Supabase OTP verify against `TEST_USER_EMAIL` resolves to the **same deterministic** `auth.users.id` that all seeded `public.*` rows already key off. Returning-user lookups then hit the seeded `consent_records` row (AC-4) and the redirect to `/dashboard` succeeds.

Mechanics, idempotency, and env-loader contract are codified in **AC-24**.

**Export shape — `e2e/fixtures/ids.ts`:**
```ts
export const TEST_TEAM_ID = "00000000-e2e-0000-0000-000000000001";
export const TEST_USER_ID = "00000000-0000-4000-8000-0000000000a1";
export const TEST_USER_EMAIL = "adityanittoor+geotests@gmail.com";
export const SEED_TAG = "e2e-seed";
export const SITE_IDS = {
  freshFreeAudit:   "00000000-e2e-site-0000-0000000000f1",
  paidFullAudit:    "00000000-e2e-site-0000-0000000000f2",
  midPipelineAudit: "00000000-e2e-site-0000-0000000000f3",
  historicalAudit:  "00000000-e2e-site-0000-0000000000f4",
  portfolioSiteB:   "00000000-e2e-site-0000-0000000000f5",
} as const;
export const SITE_SLUGS = {
  freshFreeAudit:   "e2e-fresh-free",
  paidFullAudit:    "e2e-paid-full",
  midPipelineAudit: "e2e-mid-pipeline",
  historicalAudit:  "e2e-historical",
  portfolioSiteB:   "e2e-portfolio-b",
} as const;
export const SITE_DOMAINS = {
  freshFreeAudit:   "fresh-free.e2e.flowblinq.test",
  paidFullAudit:    "paid-full.e2e.flowblinq.test",
  midPipelineAudit: "mid-pipeline.e2e.flowblinq.test",
  historicalAudit:  "historical.e2e.flowblinq.test",
  portfolioSiteB:   "portfolio-b.e2e.flowblinq.test",
} as const;
```

All UUIDs are zero-padded, embed `e2e` as a recognizable token, and stay distinct so a `grep` of the DB can trivially identify fixture rows. The `.e2e.flowblinq.test` domain suffix is reserved (no DNS, no crawl risk) and serves as a second-level tag (§b.9).

### b.2 Seeded sites (AC-2)

Five rows into `geo_sites` (all columns that are NOT NULL in schema.ts MUST be populated). The pipeline states below are what the UI / API observes.

| Fixture | site_id | slug | domain | pipelineStatus | paymentStatus | auditMode | perPageResults | bulkUrlCount | createdAt | notes |
|---------|---------|------|--------|----------------|---------------|-----------|----------------|--------------|-----------|-------|
| freshFreeAudit | `SITE_IDS.freshFreeAudit` | `e2e-fresh-free` | `fresh-free.e2e.flowblinq.test` | `complete` | `pending` | `single` | `null` | `SEED_EPOCH - 10m` | Free baseline audit. Minimum viable `geoScorecard = {"overallScore":42,"pillars":[]}`. No per-page fixes. Tier=free (implicit via `teams.subscriptionTier='free'`). |
| paidFullAudit | `SITE_IDS.paidFullAudit` | `e2e-paid-full` | `paid-full.e2e.flowblinq.test` | `complete` | `paid` | `single` | 12-element array, see §b.3 | `null` | `SEED_EPOCH - 1d` | Full report. `perPageFixes` populated. Powers per-page-fixes.spec.ts golden path. |
| midPipelineAudit | `SITE_IDS.midPipelineAudit` | `e2e-mid-pipeline` | `mid-pipeline.e2e.flowblinq.test` | `crawling` | `paid` | `single` | `null` | `SEED_EPOCH - 2m` | `crawlJobIds=["e2e-stub-job-1"]`, `crawlChunksTotal=3`, `crawlChunksDone=1`. **Seed writes a matching `firecrawl_jobs` stub row** (see §b.8, HP-259) so the FK resolves and the "scan in progress" UI has backing data. Exercises "scan in progress" UI. |
| historicalAudit | `SITE_IDS.historicalAudit` | `e2e-historical` | `historical.e2e.flowblinq.test` | `complete` | `paid` | `single` | 5-element array | `SEED_EPOCH - 30d` | `previousRunSnapshot` populated with a `SEED_EPOCH - 37d` `geoScorecard` of `overallScore=31`; current `overallScore=58`. `crawlJobIds=null` — no in-flight firecrawl_jobs stub needed (pipeline complete). Powers re-audit delta view. `baselineScorecard` = the 31-snapshot. |
| portfolioSiteB | `SITE_IDS.portfolioSiteB` | `e2e-portfolio-b` | `portfolio-b.e2e.flowblinq.test` | `complete` | `paid` | `single` | 3-element array | `SEED_EPOCH - 2d` | `crawlJobIds=null` — no stub. Second site on the same team. Powers multi-domain portfolio dashboard specs. |

**NOT NULL columns on `geo_sites` that MUST be set** (verified against schema.ts:77–228):
`id`, `domain`, `slug` (UNIQUE), `ownerEmail`, `tokenExpiresAt` (see §b.5), `crawlFrequency` (default `"manual"`), `otpAttempts` (default 0). `createdAt`/`updatedAt` get `SEED_EPOCH + <offset>` (HP-260 — no `NOW()`). `teamId` populated with `TEST_TEAM_ID` for all 5 sites. `pipelineStatus` defaults to `"pending"` — we override to the per-fixture value.

**Crawl-fanout FK completeness (HP-259):** only `midPipelineAudit` has `crawlJobIds` non-null (it models an in-flight crawl). Its single stub element `"e2e-stub-job-1"` becomes the `firecrawl_jobs.id` of one stub row (see §b.8). `paidFullAudit`, `historicalAudit`, and `portfolioSiteB` all set `crawlJobIds = null` — they model completed pipelines where Firecrawl async jobs have already resolved and the polling array was cleared. No stub rows for them. `freshFreeAudit` uses the synchronous crawl path (no async jobs), `crawlJobIds = null`.

**`geo_site_view` mirror:** the pipeline normally writes this at stage end (schema.ts:234–290). The seed MUST insert a parallel `geo_site_view` row for each fixture because the UI / API read-path uses this table exclusively (schema.ts:234 comment). Columns to mirror (non-exhaustive, all by name from schema.ts):
`siteId`, `domain`, `slug`, `teamId`, `accessToken`, `tokenExpiresAt`, `pipelineStatus`, `pipelineError`, `overallScore`, `previousScore`, `pillars`, `pageCount`, `citationRate`, `crawlCount`, `executiveSummary`, `perPageResults`, `perPageFixes`, `generatedLlmsTxt`, `discoveryData`, `platformDetected`, `shareToken`, `domainVerified`, `createdAt`, `updatedAt`. Fixture `freshFreeAudit` and `midPipelineAudit` may omit rendering-only fields (overallScore, perPageResults) — but MUST populate the row so index lookups don't miss.

### b.3 `perPageResults` + `perPageFixes` shape

Fixture payloads live in `scripts/e2e/fixtures/per-page-samples.ts` as typed constants. The seed script imports them and JSON-stringifies into the `jsonb` column. `PerPageResult` / `PerPageFix` shapes are defined by existing runtime types under `@/lib/types/...` — the seed MUST `satisfies` those types to catch drift at build time, not at runtime against the running Playwright browser.

### b.4 Credits state (AC-3 + AC-32)

- `teams.creditBalance` = `10` (column: schema.ts:15, `integer`, NOT NULL, default `SIGNUP_BONUS_CREDITS` from `@/lib/config`). Seed sets it explicitly to `10` regardless of the default value, so a future bump of `SIGNUP_BONUS_CREDITS` doesn't flip fixture assertions.
- **`teams.monthly_page_allowance` = `0`** (AC-32 / Aditya corr `d8a5afd6`). Default free-tier allowance is `20`/month (per `lib/config.ts:FREE_MAX_PAGES` and schema.ts:22 default). Seed OVERRIDES to `0` to simulate the **free-tier exhausted state**, in which audit launch debits **1 credit per 10 pages** (per the free-exhausted row of §b.16.8). This makes DRY-02 (single-URL audit) produce a deterministic `credit_balance` delta of `-1`, matching AC-31's exact-delta rule against the §b.16.8 cost table. Without this override, the default `allowance=20` + `used=0` state would absorb the audit for 0 credits, and DRY-02's exact-delta target would be `0` (which also satisfies AC-31 but loses the ability to exercise the credit-debit path end-to-end). Alternative coverage via a pro-tier seeded user is DEFERRED to Phase B per AC-32.
- `credit_transactions` rows (schema.ts:62–72):

| id | type | pagesConsumed | creditsChanged | balanceBefore | balanceAfter | siteId |
|----|------|---------------|----------------|---------------|--------------|--------|
| `e2e-tx-signup` | `signup_bonus` | 0 | +5 | 0 | 5 | `null` |
| `e2e-tx-topup` | `topup` | 0 | +10 | 5 | 15 | `null` |
| `e2e-tx-audit` | `crawl_debit` | 5 | -5 | 15 | 10 | `SITE_IDS.paidFullAudit` |

Final sum (5 + 10 - 5 = 10) matches `teams.creditBalance`. FI-041 (balance display) and history pane have real data.

### b.5 `tokenExpiresAt` (AC-5, the actual blocker)

Current failure at retry #2: test harness inserted `geo_sites` rows without `token_expires_at`. Schema (line 97) is `timestamp notNull() $defaultFn(...)` — the default fires at drizzle-insert time. The failing harness used a raw SQL `INSERT` (see `e2e/helpers/db.ts:43` for the existing pattern) which bypasses the drizzle default.

**Rule (HP-260, updated):** every `geo_sites` insert in the seed script MUST set `token_expires_at` explicitly to `SEED_EPOCH + 90d` (i.e. `2026-06-30T00:00:00.000Z`) — NOT `NOW() + INTERVAL '90 days'`, NOT `new Date(Date.now() + …)`, NOT the drizzle `$defaultFn`. The `$defaultFn` fallback is forbidden because it would re-introduce `Date.now()` non-determinism on re-seed. Seed writes the literal computed ISO string via parameterized SQL. `geoSiteView.tokenExpiresAt` (nullable, schema.ts:244) receives the same literal value. `tokenRotatedAt` is set to `null` for all fixtures except as noted per-row.

### b.6 Consent state (AC-4)

One row in `consent_records` (schema.ts:421–433) per `TEST_USER_ID`:

| id | userId | email | tosVersion | eulaVersion | acceptedAt | userAgent |
|----|--------|-------|------------|-------------|------------|-----------|
| `e2e-consent-01` | `TEST_USER_ID` | `TEST_USER_EMAIL` | `"1.0"` | `"1.0"` | `SEED_EPOCH - 1d` | `"e2e-seed"` (tag — see §b.9) |

**Note — spec drift correction:** the task payload named `consent_acceptances`; the actual table on branch tip is `consent_records` (schema.ts:421). Spec-rigour rule (HP-169/184) — I use the real name.

`consent-flow.spec.ts:154` (returning-user path) passes because the row exists. A spec that wants to test the first-acceptance flow MUST `DELETE FROM consent_records WHERE user_id = TEST_USER_ID` in its own `beforeEach` and let the `afterEach` restore via a re-seed — but the shared teardown handles this only if the spec leaks the row.

### b.7 Idempotency strategy — DELETE-then-INSERT (AC-6)

**Decision:** DELETE-then-INSERT, gated on `SEED_TAG`. Justification:

- **Determinism is non-negotiable.** Upserts leave stale columns (e.g. `updated_at`, `previousRunSnapshot`) from prior runs, producing flaky "date looks newer than expected" assertions.
- **DELETE-then-INSERT is safer than it sounds** because every seeded row is tagged (§b.9). The DELETE traverses only rows with the tag; rows a human operator added by hand are untouched.
- **Rollback speed.** A failing seed mid-way leaves a consistent "empty" world-state, not a half-populated one. The next retry re-runs the same script and completes.
- **Upsert alternative rejected** because `geo_sites.perPageResults` and `geo_site_view.pillars` are `jsonb` and upserts cannot cheaply ensure exact byte-equality — jsonb comparison is semantic, not textual.

**Execution order (single transaction) — FK-complete per HP-252:**
```
BEGIN;
  -- Delete in FK-reverse order
  -- (api_clients and firecrawl_jobs added per HP-252 — both had references(() => teams.id)
  --  / references(() => geoSites.id) without ON DELETE CASCADE, so an un-cleaned row blocks teams/geoSites delete)
  DELETE FROM api_clients         WHERE team_id = $TEST_TEAM_ID;                   -- HP-252 (schema.ts:443)
  DELETE FROM firecrawl_jobs      WHERE site_id = ANY($SITE_IDS[]);                -- HP-252 (schema.ts:325)
  DELETE FROM credit_transactions WHERE team_id = $TEST_TEAM_ID;
  DELETE FROM geo_page_views      WHERE site_id = ANY($SITE_IDS[]);
  DELETE FROM citation_check_responses WHERE site_id = ANY($SITE_IDS[]);           -- CASCADE from geoSites but explicit for clarity + test-speed
  DELETE FROM citation_check_scores    WHERE site_id = ANY($SITE_IDS[]);           -- CASCADE from geoSites but explicit
  DELETE FROM exchange_codes      WHERE email = $TEST_USER_EMAIL;                  -- FK to geo_sites ON DELETE CASCADE but email-indexed path is direct
  DELETE FROM geo_site_view       WHERE team_id = $TEST_TEAM_ID;
  DELETE FROM team_domains        WHERE team_id = $TEST_TEAM_ID;
  DELETE FROM geo_sites           WHERE team_id = $TEST_TEAM_ID;
  DELETE FROM team_members        WHERE team_id = $TEST_TEAM_ID;
  DELETE FROM teams               WHERE id      = $TEST_TEAM_ID;
  DELETE FROM consent_records     WHERE user_id = $TEST_USER_ID;
  DELETE FROM rate_limits         WHERE <broadened pattern — see §b.12 for the canonical set>;
  -- Insert in FK order: teams → team_members → geo_sites → geo_site_view → team_domains → credit_transactions → consent_records → dependent rows
  INSERT INTO teams ...;
  INSERT INTO team_members ...;
  INSERT INTO geo_sites ...;             -- 5 rows, all with token_expires_at = SEED_EPOCH + 90d (HP-260)
  INSERT INTO geo_site_view ...;         -- 5 mirror rows
  INSERT INTO team_domains ...;          -- 5 rows
  INSERT INTO firecrawl_jobs ...;        -- 1 stub row for midPipelineAudit (HP-259; §b.8)
  INSERT INTO credit_transactions ...;   -- 3 rows
  INSERT INTO consent_records ...;       -- 1 row
  INSERT INTO citation_check_scores ...; -- see §b.8
  INSERT INTO citation_check_responses ...; -- see §b.8
  INSERT INTO geo_page_views ...;        -- see §b.8
  -- api_clients intentionally NOT seeded (no spec in scope exercises OAuth clients against a seeded team
  --  — schema.ts:441-452). But DELETE remains on every seed run so a human-added stray row is purged.
COMMIT;
```

A single transaction ensures a failure partway through leaves the DB as the teardown would have left it.

**Regrep verdict (HP-252 spec-rigour pass):** I regrepped `references(() => teams.id)` and `references(() => geoSites.id)` on branch tip `1cae951` at `lib/db/schema.ts` — results: lines 36, 51, 52, 64, 83, 325, 345, 369, 443, 595. Lines 345/369/595 all have `{ onDelete: "cascade" }` so they're covered implicitly (still listed explicitly above for speed + clarity). Line 83 (`geoSites.teamId` nullable self-FK) — already covered by the `geo_sites` row delete. That leaves **api_clients (443)** and **firecrawl_jobs (325)** as the only previously-missed children. No third FK-child found.

### b.8 Dependent rows (AC-5)

For `paidFullAudit`:
- 1 row in `citation_check_scores` (schema.ts:367–406) with `siteId=paidFullAudit`, `teamId=TEST_TEAM_ID`, `overallVisibility=62`, `sentimentScore=78`, `promptsUsed=["e2e prompt 1","e2e prompt 2"]`, `providerResults=[{provider:"openai",...}]`. `check_id` = `"e2e-check-paid-01"`.
- 4 rows in `citation_check_responses` for that `check_id`, one per provider.
- 6 rows in `geo_page_views` (schema.ts:511–532) — `slug = "e2e-paid-full"`, `page_url = "https://paid-full.e2e.flowblinq.test/"` (×3) plus 3 other URL paths, `botName` varies (`visitor`, `GPTBot`, `ClaudeBot`), `viewedAt` spread over last 24 h.

For `historicalAudit`:
- 1 row in `citation_check_scores` with `createdAt = SEED_EPOCH - 30d` so history views have a prior data-point.

For `midPipelineAudit` (HP-259 — stub so `crawlJobIds=["e2e-stub-job-1"]` resolves):
- 1 row in `firecrawl_jobs` (schema.ts:323–334). All columns — all are NOT NULL on that table except `urlsCompleted` which defaults to `[]`:

| Column | Value |
|--------|-------|
| `id` | `"e2e-stub-job-1"` (matches `geo_sites.crawl_job_ids[0]`) |
| `site_id` | `SITE_IDS.midPipelineAudit` (FK → geoSites.id, NOT NULL, schema.ts:325) |
| `firecrawl_job_id` | `"fc-e2e-stub-0001"` (opaque; Firecrawl-side id would be assigned by the real API) |
| `chunk_index` | `0` |
| `url_count` | `1` |
| `status` | `"scraping"` (matches midPipelineAudit's "in-flight" semantics; enum values per schema.ts:329 `"pending" \| "scraping" \| "completed" \| "failed"`) |
| `urls_submitted` | `["https://mid-pipeline.e2e.flowblinq.test/"]` (jsonb array, NOT NULL) |
| `urls_completed` | `[]` (jsonb array, default `[]`) |
| `created_at` | `SEED_EPOCH - 2m` (mirrors geo_sites.createdAt for this fixture) |
| `updated_at` | `SEED_EPOCH - 1m` (one minute after creation — models "already polled once") |

`paidFullAudit`, `historicalAudit`, and `portfolioSiteB` do NOT seed `firecrawl_jobs` rows because their `crawlJobIds` is null (pipeline complete, async jobs already drained — see §b.2 note). `freshFreeAudit` does not use the async path.

The rest of the fixtures do NOT seed citation or pageview rows — they exist to prove the empty-state UI path works.

### b.9 Isolation tagging (AC-12)

Every seeded row carries a machine-discoverable tag so teardown enumerates without relying on FK traversal:

| Table | Tag column | Tag value |
|-------|------------|-----------|
| `teams` | `name` | suffix `" (e2e-seed)"` |
| `team_members` | `invite_token` | `"e2e-seed:<random>"` (use `e2e-seed:` prefix) |
| `team_domains` | `added_by_user_id` | `TEST_USER_ID` (equal to tag) |
| `geo_sites` | `owner_email` | `TEST_USER_EMAIL` — unique to the test user |
| `geo_sites` | `domain` | ends with `.e2e.flowblinq.test` — second-level tag |
| `geo_site_view` | `domain` | same suffix rule |
| `credit_transactions` | `team_id` | `TEST_TEAM_ID` |
| `consent_records` | `user_agent` | `"e2e-seed"` (exact match) |
| `citation_check_scores` | `team_id` + `check_id` prefix `"e2e-check-"` | both |
| `citation_check_responses` | `check_id` prefix `"e2e-check-"` | |
| `geo_page_views` | `slug` prefix `"e2e-"` | |
| `rate_limits` | `key` | real-prefix set per §b.12 (HP-261 — supersedes HP-254) |
| `exchange_codes` | `email` | `TEST_USER_EMAIL` |
| `api_clients` (HP-252) | `team_id` | `TEST_TEAM_ID` — table is never seeded in this ES, but DELETE runs on every seed cycle to purge human-added strays blocking the `teams` delete |
| `firecrawl_jobs` (HP-252, HP-259) | `site_id` | `SITE_IDS.midPipelineAudit` — one stub row seeded per §b.8; DELETE block covers `site_id = ANY(all SITE_IDS[])` so a future stub for any fixture is auto-covered without tag-table churn |

Teardown enumerates by tag. No FK traversal, no orphans. Any fixture table not listed here is outside the fixture surface and MUST NOT be touched by seed or teardown.

### b.10 Production-DB safety gate (AC-7)

**First line of `seed.ts` and `teardown.ts` main bodies** (before any `BEGIN`). Both guards live in `scripts/e2e/lib/safety.ts` as `assertLocalDb()` and are invoked by both entry-points:

```ts
// scripts/e2e/lib/safety.ts
export function assertLocalDb(): void {
  // HP-253: production-environment guard — fires FIRST so an SSH-tunnel-to-prod
  // scenario (where DATABASE_URL looks like localhost:54322 but NODE_ENV=production
  // signals the operator is in a prod context) is rejected before any SQL opens.
  if (process.env.NODE_ENV === "production") {
    console.error("[e2e/seed] REFUSING: NODE_ENV=production. Seed/teardown never run in production context.");
    process.exit(2);
  }
  const url = process.env.DATABASE_URL ?? "";
  const LOCAL_PATTERN = /^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):54322\//;
  if (!LOCAL_PATTERN.test(url)) {
    console.error("[e2e/seed] REFUSING: DATABASE_URL is not a local Supabase URL.");
    console.error("[e2e/seed] Expected: postgresql://…@127.0.0.1:54322/…");
    console.error("[e2e/seed] Got:      " + url.replace(/:[^:@]*@/, ":***@"));
    process.exit(2);
  }
}
```

Regex verified against `playwright.config.ts:DATABASE_URL` and `supabase/config.toml:port = 54322`. Exit code `2` distinguishes this from generic failures (exit `1`). The check is first, not last — NO SQL opens the connection before the guard passes. Teardown runs the identical check.

**HP-253 rationale:** the `NODE_ENV !== "production"` guard fires BEFORE the URL regex. Covers the SSH-tunnel-to-prod attack — where an operator forwards `prod-db.supabase.co:5432 → localhost:54322` in an SSH tunnel, making the URL appear local even though the actual target is production. Any CI or deploy context where `NODE_ENV=production` is set by framework/container (Next.js, Vercel, GitHub Actions prod workflows) will abort here before the URL check even runs. Both guards must pass; either failure is a hard exit.

### b.11 Global-setup wiring (AC-8)

Extend `e2e/global-setup.ts` (currently 40 lines; see §reference). Insert after the Mailpit check, before return:

```ts
const { execFileSync } = await import("node:child_process");
try {
  execFileSync("npm", ["run", "db:seed:e2e"], { stdio: "inherit", timeout: 60_000 });
} catch (err) {
  throw new Error(`E2E seed failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

- `stdio: "inherit"` — seed output surfaces to the Playwright report; no silent-swallow (AC-8).
- `timeout: 60_000` — seed should take <5 s; 60 s is a generous bound with margin for slow CI.
- `execFileSync` throws on non-zero exit, which Playwright treats as a global-setup failure → suite aborts before a single spec runs.

`package.json` additions:

```json
"db:seed:e2e":     "tsx scripts/e2e/seed.ts",
"db:teardown:e2e": "tsx scripts/e2e/teardown.ts"
```

Rationale for `tsx`: keeps the script in typed TS, imports `@/lib/db/schema` directly, catches column-name typos at compile time (HP-163 pattern). `tsx` is already in `devDependencies` (confirmed by existing `scripts/test-chatbot-queries.ts`).

### b.12 Teardown (AC-9, AC-11) — broadened rate_limits per HP-254 + rotation-safe deletes (Phase E retry)

Teardown reuses the DELETE block from §b.7 verbatim, wrapped in the §b.10 safety gate. It does NOT re-seed. `db:teardown:e2e` is optional in local dev (Playwright runs seed before each suite; leaked rows carry forward until next seed), **required in CI** via `afterAll` hook or a dedicated CI `teardown` step.

#### b.12.0 Rotation-safe DELETE pattern — `user_id OR PK` (Phase E retry)

**Phase E retry finding:** Teardown was scoped purely by `user_id = ${TEST_USER_ID}` on tables like `consent_records`. When `TEST_USER_ID` rotated between runs — e.g. Option A swap from `00000000-e2e-0000-0000-0000000000a1` to `00000000-0000-4000-8000-0000000000a1` — the prior run's rows (keyed by the OLD `user_id`) were NOT matched by the new teardown filter. They survived into the next seed cycle. The next seed's INSERT then collided on the **deterministic primary key** (e.g. `consent_records.id = 'e2e-consent-01'`, §b.6), raising a unique-constraint violation and aborting the seed transaction. The consent_records row is the motivating example but the pattern generalises to any seeded table with a deterministic PK.

**Rule (binding):** every DELETE on a seeded table with BOTH a deterministic PK AND a user_id / team_id / site_id scope MUST filter on the **union** of both criteria. Form:

```sql
DELETE FROM <table>
WHERE user_id = ${TEST_USER_ID}      -- catches all rows owned by the current identity
   OR id      = ${DETERMINISTIC_PK}; -- catches orphans from a rotated identity
```

Substitute `user_id`/`team_id`/`site_id` for whatever scope column the table uses, and substitute the fixture's deterministic PK constant. Both clauses are necessary:
- **`user_id = $TEST_USER_ID`** — covers rows created by this run (and any prior run using the SAME id).
- **`id = $DETERMINISTIC_PK`** — covers rows orphaned by a prior run whose `user_id` has since rotated.

The OR-combined filter is idempotent: matches zero rows when neither applies, matches one row in the steady state, matches two rows during a rotation-transition cycle (prior orphan + current row — both purged cleanly). No race, no partial state.

**Tables currently requiring the pattern** (deterministic PK + scoped FK):
- `consent_records` — `id = 'e2e-consent-01'` OR `user_id = $TEST_USER_ID` (§b.6)
- `credit_transactions` — rows keyed by `id IN ('e2e-tx-signup','e2e-tx-topup','e2e-tx-audit')` OR `team_id = $TEST_TEAM_ID` (§b.4)
- `citation_check_scores` — `check_id IN ('e2e-check-paid-01', 'e2e-check-historical-01', …)` OR `site_id = ANY($SITE_IDS[])` (§b.8)
- `firecrawl_jobs` — `id = 'e2e-stub-job-1'` OR `site_id = ANY($SITE_IDS[])` (§b.8)

Tables scoped ONLY by a team/site FK (no fixed PK literals — e.g. `team_domains`, `geo_page_views`) are naturally rotation-safe: they don't use deterministic PKs for their own rows, so the scope-column DELETE catches everything.

**Why NOT simply purge by PK alone?** Because fixtures that SEED only by PK (like the 5 `geo_sites` rows with deterministic `SITE_IDS`) still need to catch rows a rotated prior-run might have inserted under a NEW user_id with the SAME site_id — which can't happen in practice for `geo_sites` (SITE_IDS are constants that never rotate), but the belt-and-braces OR-union pattern is the safe default whenever BOTH axes are deterministic. Keep the rule uniform across all such tables.

**Spec-rigour note on `geo_sites` specifically:** `SITE_IDS` are constants defined in `e2e/fixtures/ids.ts`; they do NOT rotate. The DELETE `WHERE team_id = $TEST_TEAM_ID` (§b.7) is sufficient for `geo_sites` alone. BUT if a future change ever scopes `geo_sites.team_id` to a rotated value without also rotating `SITE_IDS`, the rotation-safe pattern becomes necessary there too. Preemptively, seed SHOULD use the OR-union form on `geo_sites` too (`WHERE team_id = $TEST_TEAM_ID OR id = ANY($SITE_IDS[])`) — cheap insurance.

**HP-261 correction (supersedes the earlier HP-254 "broadened invented prefixes" block).** Prior revision named fabricated prefixes (`otp:<email>`, `otp-email:<email>`, `otp:<user_id>`, `user:<user_id>`, `ip:127.0.0.1`, `ip:::1`, `ip:e2e`, `signup:<email>`) — none of which exist in the codebase. The real key formats, grep-verified against `app/api/**` on branch tip `ad7280c`, are:

| # | Prefix | Key format | Source |
|---|--------|------------|--------|
| 1 | `otp_send:` | `otp_send:${email}` | `app/api/auth/otp/send/route.ts:25` |
| 2 | `otp_verify:` | `otp_verify:${email}` | `app/api/auth/otp/verify/route.ts:42` |
| 3 | `invite:` | `invite:${user.id}` | `app/api/teams/invite/route.ts:15` |
| 4 | `sites_create:` | `sites_create:${ip}` | `app/api/sites/route.ts:302` |
| 5 | `csp_report:` | `csp_report:${ip}` | `app/api/csp-report/route.ts:59` |
| 6 | `auth_proxy:` | `auth_proxy:${ip}` | `app/api/auth/proxy/[...path]/route.ts:67` |
| 7 | `audit-ip:` | `audit-ip:${ip}` | `app/api/audit/route.ts:50` |
| 8 | `oauth:` | `oauth:${client_id}` | `app/api/oauth/token/route.ts:47` |
| 9 | `chatbot:` | `chatbot:${siteId}` | `app/api/chatbot/route.ts:51` |
| 10 | `citation_check:` | `citation_check:${siteId}` | `app/api/sites/[id]/citation-check/route.ts:104` |

Teardown SQL:

```sql
DELETE FROM rate_limits
WHERE
     -- (1) (2) OTP send/verify email-keyed counters
     key LIKE 'otp_send:'       || $TEST_USER_EMAIL || '%'
  OR key LIKE 'otp_verify:'     || $TEST_USER_EMAIL || '%'
     -- (3) invite throttle by user_id
  OR key LIKE 'invite:'         || $TEST_USER_ID    || '%'
     -- (4) (5) (6) (7) ip-keyed loopback counters (Playwright / local docker / CI runner)
  OR key LIKE 'sites_create:127.0.0.1%'    OR key LIKE 'sites_create:::1%'
  OR key LIKE 'csp_report:127.0.0.1%'      OR key LIKE 'csp_report:::1%'
  OR key LIKE 'auth_proxy:127.0.0.1%'      OR key LIKE 'auth_proxy:::1%'
  OR key LIKE 'audit-ip:127.0.0.1%'        OR key LIKE 'audit-ip:::1%'
     -- (8) oauth by client_id — purge any e2e-scoped client; api_clients is not seeded so this matches only hand-created rows during tests
  OR key LIKE 'oauth:e2e%'
     -- (9) (10) chatbot + citation_check by site_id — scoped to the fixture siteIds
  OR key LIKE 'chatbot:'        || $SITE_IDS.freshFreeAudit   || '%'
  OR key LIKE 'chatbot:'        || $SITE_IDS.paidFullAudit    || '%'
  OR key LIKE 'chatbot:'        || $SITE_IDS.midPipelineAudit || '%'
  OR key LIKE 'chatbot:'        || $SITE_IDS.historicalAudit  || '%'
  OR key LIKE 'chatbot:'        || $SITE_IDS.portfolioSiteB   || '%'
  OR key LIKE 'citation_check:' || $SITE_IDS.freshFreeAudit   || '%'
  OR key LIKE 'citation_check:' || $SITE_IDS.paidFullAudit    || '%'
  OR key LIKE 'citation_check:' || $SITE_IDS.midPipelineAudit || '%'
  OR key LIKE 'citation_check:' || $SITE_IDS.historicalAudit  || '%'
  OR key LIKE 'citation_check:' || $SITE_IDS.portfolioSiteB   || '%';
```

Each pattern is prefix-anchored and parameter-bound. The purge cannot cascade damage because `rate_limits` has no inbound FKs (schema.ts:414–418: just `key`, `count`, `reset_at`).

**Rationale (HP-261, supersedes HP-254 on this point):**

1. **OTP-lockout repeatability is NOT served by rate_limits teardown.** The OTP lockout lives on `geoSites.otpAttempts` (schema.ts:195, `integer notNull default 0`) and `geoSites.otpLockedUntil` (schema.ts:196, nullable `timestamp`) — NOT in the `rate_limits` table. The atomic incrementor at `lib/rate-limit.ts:79–100` (`incrementOtpAttempt`) does a `db.update(geoSites).set({ otpAttempts: sql\`… + 1\`, otpLockedUntil: sql\`CASE WHEN … >= 5 THEN \${lockUntil} ELSE … END\` })` against `geo_sites`, not an increment against `rate_limits`. The DELETE-then-INSERT cycle on `geo_sites` (§b.7) therefore automatically resets `otpAttempts → 0` and `otpLockedUntil → NULL` for every fixture siteId on every seed. OTP-lockout repeatability is a side-effect of the existing fixture reseed, not of any rate_limits work.
2. **rate_limits teardown covers non-OTP burst limits.** The 10 real prefixes are burst limiters against per-email, per-user, per-ip, per-site, and per-client actions OTHER than OTP lockout (signups, invites, CSP reports, auth proxy, audits, OAuth token exchange, chatbot queries, citation checks). A test run that exercises any of these paths leaves counter rows that — within the 15-60 minute TTL — would throttle the NEXT run's equivalent action. Purging them keeps consecutive runs deterministic.
3. **Implementation reference:** `lib/rate-limit.ts:79–100` (`incrementOtpAttempt`) is authoritative for OTP lockout; deviate only via a schema change to `geoSites.otpAttempts` / `otpLockedUntil`, which is out-of-scope for this ES.

This ES pins the contract: **rate_limits teardown covers the 10 non-OTP burst prefixes scoped to the test user / fixture siteIds / loopback IPs. OTP-lockout repeatability comes from the `geo_sites` reseed, not from rate_limits.**

### b.14 OTP routing contract — two flows, two helpers (Phase 0 Track A, 2026-04-20)

**Section placement justification:** added as §b.14 (after FIXME block §b.13, before §c file inventory) rather than §c.5 because OTP routing is an implementation requirement that specs must honour; §c is a flat file-inventory section without subsection numbering. Keeping routing rules next to other §b implementation rules preserves the "read §b top-to-bottom to understand the contract" property. Numbering goes §b.1..§b.12, §b.13 (FIXME), §b.14 (this) — §b.13 is left in place so existing AC references to "the `FIXME-DEFERRED` block from §b.13" continue to resolve.

**Phase 0 Task A finding (SD reply corr `6752a1bb`, 2026-04-20):** the app has two distinct OTP flows with two distinct inboxes. Specs that mix them hit flaky "code never arrives" timeouts — half the OTPs were being looked for in the wrong inbox.

| Flow | Trigger | Emitter | Inbox (local dev) | Helper |
|------|---------|---------|-------------------|--------|
| **login** | `/auth/login` page OR `/api/auth/otp/send` server proxy | Supabase Auth built-in mailer via `signInWithOtp` | Mailpit at `http://127.0.0.1:54324` | `e2e/helpers/mailpit.ts` → `getOtpForEmail(email, timeoutMs?)` |
| **verify** | `/api/sites` (site-verification), pipeline completion emails, team invites — any path through `lib/email.ts` | Resend (`noreply@send.flowblinq.com`) | Real Gmail inbox `adityanittoor@gmail.com` (plus-address filter `adityanittoor+geotests@gmail.com`) | `e2e/fixtures/otp-helper.ts` → `getLatestOtp(toAddress?, opts?)` |

**Call-chain references (verified on branch tip `4b0e53d` at `e2e-comprehensive-suite`):**
- `app/auth/login/page.tsx:53` — `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: … } })` → Supabase Auth → Mailpit.
- `app/api/auth/otp/send/route.ts:43` — server-side proxy calling `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })` → same Supabase path.
- `app/api/sites/route.ts:254` — `await sendVerificationEmail(emailLower, code, domainList[0])` → `lib/email.ts`.
- `lib/email.ts:61` — `async function sendWithResend(payload: EmailPayload)` → Resend API → Gmail inbox.
- `lib/email.ts:113` — `export async function sendVerificationEmail(…)` — the canonical Resend entry-point.
- `supabase/config.toml` — `[inbucket] enabled=true port=54324` (Supabase Local uses Inbucket/Mailpit on 54324 for dev emails).
- Phase 0 Task B — throwaway smoke script at `/tmp/imapflow-smoke.mjs` proved Gmail IMAP app-password auth is healthy end-to-end.

#### b.14.1 Routing selection — **unified facade (approach (c))**

SpecMaster picks **(c) unified facade** over (b) Playwright fixture. Justification:

1. **No per-test state to manage.** Both underlying helpers are request/response — Mailpit polls an HTTP API, IMAP opens-reads-closes per call. Neither benefits from Playwright fixture lifecycle (no `beforeAll` connect, no `afterAll` cleanup). A Playwright fixture would add ceremony without payoff.
2. **Single call site beats spec authors forgetting to take the fixture.** With approach (b), a spec author writing a new test must remember to destructure `otp` from the Playwright `test` signature; forgetting it silently falls back to a nonexistent helper. With approach (c), every spec imports `{ getOtp }` the same way.
3. **Type-narrowed flow enum.** The facade's signature `getOtp(flow: "login" | "verify", email: string, opts?)` turns crossed-wire bugs into compile errors, not runtime hangs.
4. **Migration is a one-line change.** Existing specs that import `getOtpForEmail` or `getLatestOtp` directly can either keep their imports (both helpers remain exported) or switch to `getOtp("login", …)` / `getOtp("verify", …)`. No Playwright config surgery.
5. **Future flows are a single-site addition.** If a third flow appears (e.g. 2FA TOTP), we add one branch in `otp.ts`; no spec-by-spec update.

Approach (a) — spec-file-based — was rejected because it hard-codes the crossed-wire risk into every spec author's muscle memory. Approach (b) was the close second; (c) wins on simplicity.

#### b.14.2 Facade contract — `e2e/helpers/otp.ts` (NEW FILE)

```ts
// e2e/helpers/otp.ts — unified OTP facade (ES-e2e-fixtures §b.14)
import { getOtpForEmail } from "./mailpit";
import { getLatestOtp, OtpTimeoutError } from "../fixtures/otp-helper";

export type OtpFlow = "login" | "verify";

export interface GetOtpOptions {
  /** Max wait in ms. Default 20_000 (per §b.14.3). Bounded and explicit-fail. */
  timeoutMs?: number;
}

export async function getOtp(
  flow: OtpFlow,
  email: string,
  opts: GetOtpOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  switch (flow) {
    case "login":
      return getOtpForEmail(email, timeoutMs);
    case "verify":
      return getLatestOtp(email, { maxWaitMs: timeoutMs });
    default: {
      const never: never = flow;
      throw new Error(
        `getOtp: unknown flow "${String(never)}". Expected "login" (Supabase→Mailpit) ` +
          `or "verify" (lib/email.ts→Resend→Gmail). See ES-e2e-fixtures §b.14.`,
      );
    }
  }
}

export { OtpTimeoutError } from "../fixtures/otp-helper";
```

Re-exports `OtpTimeoutError` so specs can catch the Gmail-path timeout class without reaching through to the underlying module.

#### b.14.3 Bounded timeout + explicit-error contract

Both helpers MUST honour a `timeoutMs` option and raise a **named error** when the timeout fires — NOT hang, NOT return `undefined`, NOT silently retry forever.

- **Mailpit (`getOtpForEmail`)** — already throws `new Error("No OTP email received for ${email} within ${timeoutMs}ms")` on timeout (verified at `e2e/helpers/mailpit.ts`, branch tip `4b0e53d`). Default `timeoutMs = 10_000`; facade caps at `20_000`.
- **Gmail IMAP (`getLatestOtp`)** — already throws `OtpTimeoutError` (verified at `e2e/fixtures/otp-helper.ts:26–31`). Default `maxWaitMs = 20_000`; facade passes through.

**Contract ceiling:** facade default `timeoutMs = 20_000` (20 s). Specs may lower but NOT raise the bound. Rationale: the whole Playwright suite has a ~30 s per-spec budget; an unbounded OTP wait would mask genuine app breakage behind test-timeout failures.

#### b.14.4 Failure modes — explicit error, not hang

If a spec invokes `getOtp("login", email)` but the email was actually sent via `lib/email.ts` (or vice-versa), the helper times out because the target inbox never sees the message. The error message names the expected inbox (the existing Mailpit error already does; the IMAP error names `toAddress` and `maxWaitMs`), so the debugging path is:

```
Error: No OTP email received for ci-login-test@test.local within 20000ms
       ↑
       if you see this for a /api/sites spec, you used flow="login" on a "verify" flow — switch to getOtp("verify", …)
```

Specs MAY catch the timeout and rethrow with the spec name + chosen flow for crisper CI diagnosis:

```ts
const code = await getOtp("login", email).catch((e) => {
  throw new Error(`[${test.info().title}] getOtp("login") timed out: ${e.message}`);
});
```

This is a convention, not enforced by the facade.

#### b.14.5 Mailpit connectivity assumptions

- Port `54324` (verified `supabase/config.toml:[inbucket] enabled=true port=54324`).
- HTTP API endpoint used by `getOtpForEmail`: `GET /api/v1/search?query=to:<url-encoded-email>` returning `{ total, messages: MailpitMessage[] }` where `MailpitMessage = { ID, From: {Name, Address}, To: [{Name, Address}], Subject, Created, Snippet }` (verified at `e2e/helpers/mailpit.ts:10–22`).
- OTP extraction: regex `/\b(\d{6})\b/` against `Snippet` (verified in `e2e/helpers/mailpit.ts` body).
- **Reachability** is verified by existing `e2e/global-setup.ts` Mailpit check on the same port. Seed wiring (§b.11) runs AFTER that check, so by the time any spec invokes `getOtp("login", …)` the Mailpit endpoint is already proven reachable.
- **Local-only.** Prod tests that would require a live Resend/Gmail + real Mailpit are out of scope for this ES.

#### b.14.6 Helper file inventory (expands §c)

| File | Action | Purpose |
|------|--------|---------|
| `e2e/helpers/mailpit.ts` | **EXISTS** (confirmed on branch tip `4b0e53d` — `getOtpForEmail` + `clearMailpit` exports; imported by `e2e/login-page.spec.ts:2`) | Mailpit polling for login-flow OTPs. No change required by this ES. |
| `e2e/fixtures/otp-helper.ts` | EXISTS (canonical Gmail IMAP path, line-refs throughout this ES) | verify-flow OTPs. No change required by this ES. |
| `e2e/helpers/otp.ts` | **CREATE (ScriptDev)** | Unified facade per §b.14.2. |

### b.15 Selector hardening — Phase 0 Track B (2026-04-20)

**Source manifest:** `/tmp/flowblinq/phase0-trackB-selector-manifest.md` (RM, 180 lines, branch `e2e-comprehensive-suite@4b0e53d`). Inlined below so the ES is self-contained and survives `/tmp/` cleanup; the external path is preserved as a reference for the full original with additional commentary. Continues the §b.14 OTP-routing theme — numbered §b.15 rather than a new §c subsection so "read §b top-to-bottom" property holds.

#### b.15.1 Root cause (one-line)

`/auth/login` has NO `<label>`, NO `aria-label`, NO `data-testid` on the email and OTP inputs. Every `page.getByLabel(/email/i)` is unbindable — 6 of 7 failing specs chain from this single assertion failure. Swap to `getByPlaceholder(/you@yourcompany\.com/i)` + `getByPlaceholder(/6-digit code/i)` unblocks 6 of 7; the 7th (FI-056 invalid-token) is a separate 404-vs-401 UI surface issue resolved by pinning to `page.title()` + `h1.next-error-h1`.

#### b.15.2 Canonical resolution patterns (enumerated — specs MUST follow)

| # | Old (placeholder / broken) | New (concrete) | Notes |
|---|----------------------------|----------------|-------|
| 1 | `page.getByLabel(/email/i)` | `page.getByPlaceholder(/you@yourcompany\.com/i)` (or `page.locator('input[type="email"]')` as fallback) | No label, no aria-label, no data-testid exist on the input. Placeholder is the stable anchor. |
| 2 | `page.getByLabel(/otp\|verify\|verification code/i)` | `page.getByPlaceholder(/6-digit code/i)` (or `page.locator('input[inputmode="numeric"][maxlength="6"]')`) | Same missing-label issue on OTP input. |
| 3 | `page.getByRole("button", { name: /send code\|verify/i }).click()` | **KEEP** the role-selector; it binds to rendered button text ("Send Code", "Verify Code"). But **add** `await expect(btn).toBeEnabled();` BEFORE `.click()`. Both buttons start `disabled=true` and only enable when the adjacent input validates. | Required to avoid flake from fill→click race. |
| 4 | `expect(page.getByText(/invalid\|expired\|too many.../i)).toBeVisible()` | `expect(page.locator('[role="alert"]')).toContainText(/invalid\|expired\|too many.../i)` | The login page has a single `<div role="alert">` container; this is the dedicated error surface. `getByText` races dev-server hydration. |
| 5 | `expect(page.getByText(/unauthorized\|invalid\|not found/i).first()).toBeVisible({ timeout: 10_000 })` (FI-056 deep-link invalid-token) | `await page.waitForLoadState('networkidle'); await expect(page).toHaveTitle(/404/); await expect(page.locator('h1.next-error-h1, h1:has-text("404")')).toBeVisible({ timeout: 15_000 });` | Route returns Next.js default 404 (title `"404: This page could not be found."`, `<h1 class="next-error-h1">404</h1>`). Title is set synchronously; h1 is deterministic. |
| 6 | Optional UX polish (NON-gating — see §b.15.6 secondary findings) | Add `data-testid="email-input"`, `data-testid="otp-input"`, `data-testid="send-code-btn"`, `data-testid="verify-btn"`, `data-testid="auth-error"` to `/auth/login` form | One-line product touch-up that would bulletproof the whole 66-spec suite. **Not required by this ES.** |

#### b.15.3 Per-spec resolution table (inlined from manifest §3)

**FI-001 — `e2e/tests/01-auth/001-otp-signin.spec.ts`** (6 placeholders, 5 resolved, 1 escalated to UX ruling §b.15.4)

| # | Line | Placeholder | Concrete locator |
|---|------|-------------|------------------|
| 1.1 | 10 | `page.getByLabel(/email/i)` (visibility assert) | `page.getByPlaceholder(/you@yourcompany\.com/i)` |
| 1.2 | 11 | `page.getByLabel(/email/i).fill(email)` | same as 1.1 |
| 1.3 | 12 | `page.getByRole("button", { name: /send code/i }).click()` | KEEP + `await expect(btn).toBeEnabled()` gate |
| 1.4 | 14 | `page.getByLabel(/verification code\|verify\|otp/i).fill(code)` | `page.getByPlaceholder(/6-digit code/i)` |
| 1.5 | 15 | `page.getByRole("button", { name: /verify/i }).click()` | KEEP + `await expect(btn).toBeEnabled()` |
| 1.6 | 21–25 | invalid-email error-text assert | **ESCALATED — see §b.15.4 FI-001 ruling** |

**FI-002 — `e2e/tests/01-auth/002-otp-expiry.spec.ts`** (5 placeholders, all resolved)

| # | Line | Placeholder | Concrete locator |
|---|------|-------------|------------------|
| 2.1 | 11 | `page.getByLabel(/email/i).fill(email)` | `page.getByPlaceholder(/you@yourcompany\.com/i).fill(email)` |
| 2.2 | 12 | `page.getByRole("button", { name: /send code/i }).click()` | KEEP |
| 2.3 | 17 | `page.getByLabel(/verification code\|otp/i).fill(code)` | `page.getByPlaceholder(/6-digit code/i).fill(code)` |
| 2.4 | 18 | `page.getByRole("button", { name: /verify/i }).click()` | KEEP |
| 2.5 | 19 | `expect(page.getByText(/invalid or expired/i)).toBeVisible()` | `expect(page.locator('[role="alert"]')).toContainText(/invalid or expired/i)` |

**FI-003 — `e2e/tests/01-auth/003-otp-lockout.spec.ts`** (7 placeholders, all resolved)

| # | Line | Placeholder | Concrete locator |
|---|------|-------------|------------------|
| 3.1 | 10 | email getByLabel | `page.getByPlaceholder(/you@yourcompany\.com/i).fill(email)` |
| 3.2 | 11 | send-code button | KEEP |
| 3.3 | 13 | OTP getByLabel (×5 wrong-code loop, fills `"000000"`) | `page.getByPlaceholder(/6-digit code/i).fill("000000")` |
| 3.4 | 14 | verify button | KEEP + `toBeEnabled()` |
| 3.5 | 19 | OTP getByLabel, fills `"111111"` | same as 3.3 |
| 3.6 | 20 | verify button | KEEP |
| 3.7 | 21 | `getByText(/invalid or expired\|too many\|try again later/i)` | `expect(page.locator('[role="alert"]')).toContainText(/invalid or expired\|too many\|try again later/i)` |

**FI-004 — `e2e/tests/01-auth/004-consent-gate.spec.ts`** (5 placeholders, 4 resolved, 1 rewritten per UX ruling §b.15.5)

| # | Line | Placeholder | Concrete locator |
|---|------|-------------|------------------|
| 4.1 | 10 | email getByLabel | `page.getByPlaceholder(/you@yourcompany\.com/i).fill(email)` |
| 4.2 | 11 | send-code button | KEEP |
| 4.3 | 13 | OTP getByLabel | `page.getByPlaceholder(/6-digit code/i).fill(code)` |
| 4.4 | 14 | verify button | KEEP |
| 4.5 | 17 | `page.getByRole("button", { name: /accept\|agree/i })` on `/consent` | **REWRITTEN — see §b.15.5 FI-004 ruling**: no `/consent` DOM inspection; assert the route-transition invariant instead. |

**FI-009 — `e2e/tests/01-auth/009-protected-redirect.spec.ts`** (1 placeholder, resolved)

| # | Line | Placeholder | Concrete locator |
|---|------|-------------|------------------|
| 9.1 | 14 | open-redirect test — `expect(page.getByLabel(/email/i)).toBeVisible()` | `expect(page.getByPlaceholder(/you@yourcompany\.com/i)).toBeVisible()`. ALSO: `expect(page.url()).not.toContain('https://evil.com')` — query-param presence is fine (not followed), but an explicit not-followed assertion documents intent. |

**FI-056 — `e2e/tests/06-nav/056-deep-link.spec.ts`** (1 placeholder, resolved)

| # | Line | Placeholder | Concrete locator |
|---|------|-------------|------------------|
| 56.1 | 11 | `expect(page.getByText(/unauthorized\|invalid\|not found/i).first()).toBeVisible({ timeout: 10_000 })` | `await page.waitForLoadState('networkidle'); await expect(page).toHaveTitle(/404/); await expect(page.locator('h1.next-error-h1, h1:has-text("404")')).toBeVisible({ timeout: 15_000 })` |

Total manifest counts (from source §6/§7): **23 resolved, 2 escalated to UX ruling, 5 pages inspected, 6 specs covered**.

#### b.15.4 FI-001 invalid-email UX — CoFounder ruling: native HTML5 validation (HP-263 rewrite)

**Supersedes:** the prior-version §b.15.4 "disabled-button-as-validation-signal" ruling, which was based on the initial RM manifest observation. HP-263 re-grep of `app/auth/login/page.tsx` at branch tip `88c26df` shows that claim was factually wrong — the button does NOT disable on invalid format. Ruling re-issued below.

**Product JSX (verified, branch tip `88c26df`):**
- `app/auth/login/page.tsx:198` — `<input`
- `app/auth/login/page.tsx:199` — `  type="email"`
- `app/auth/login/page.tsx:200` — `  placeholder="you@yourcompany.com"`
- `app/auth/login/page.tsx:204` — `  required`
- `app/auth/login/page.tsx:222` — `disabled={loading || !email.trim()}`

The submit button disables on TWO conditions only: `loading === true` OR `email.trim() === ""`. Invalid format (e.g. `"not-an-email"`) leaves `email.trim()` non-empty, so the button stays **enabled** — it is the browser's native `type="email" required` constraint validation that blocks form submission, surfacing the browser's own validation bubble. No application-level error reaches the `role="alert"` container because no API call is made.

**Ruling (CoFounder, Aditya-ratified):** native HTML5 constraint validation is the authoritative gate. Specs assert against `input.validity.valid`, NOT against button-disabled state, NOT against `role="alert"` text.

**Canonical FI-001 invalid-email assertion pattern — primary:**
```ts
const emailInput = page.getByPlaceholder(/you@yourcompany\.com/i);
await emailInput.fill("not-an-email");
// Native HTML5 type="email" required is the authoritative gate; browser blocks submit.
// Button stays enabled because email.trim() is non-empty (see app/auth/login/page.tsx:222).
await expect(emailInput).toHaveJSProperty("validity.valid", false);
```

**Alternative patterns (if `toHaveJSProperty` is unavailable or flakes in a given spec context):**
```ts
// (a) Evaluate checkValidity() directly
const valid = await emailInput.evaluate((el: HTMLInputElement) => el.checkValidity());
expect(valid).toBe(false);

// (b) Poll for aria-invalid attribute (ONLY if present — the input has no aria-invalid today; this path is forward-compatible)
await expect(emailInput).toHaveAttribute("aria-invalid", "true");
```

**Rationale (why native HTML5 is the right design):** browser-consistent (every major browser implements RFC-5322 email validation), free i18n (browser surfaces the validation bubble in the user's language), accessible (assistive tech already handles `:invalid` pseudo-class + native validation messages). Layering a custom toast or inline error would be duplicative.

**Secondary note (non-gating, corrected per HP-263):** both `Send Code` and `Verify Code` buttons start `disabled=true` and enable when the adjacent input is **non-empty** (not necessarily valid) — `!email.trim()` at `app/auth/login/page.tsx:222` for Send Code; OTP button gate is at line 163 (`disabled={loading || otp.trim().length < 6}` — same shape, different length threshold). Specs relying on the §b.15.2 pattern #3 `toBeEnabled()` gate still work because `fill(email)` makes the input non-empty regardless of format. Format validation is a separate, later gate enforced at submit by the browser.

#### b.15.5 FI-004 consent gate — CoFounder ruling: data-flow, not DOM

**Finding (manifest §4 item 1):** `/consent` DOM cannot be inspected without completing a real OTP login via Gmail, which requires `GMAIL_APP_PASSWORD` and a specific DB state. RM correctly flagged `needs-auth-flow`.

**Ruling (CoFounder, Aditya-ratified):** FI-004 is **rewritten from a DOM-selector assertion to a DATA-FLOW assertion**. A returning user (seeded `consent_records` row per AC-4) completes OTP and reaches `/dashboard` WITHOUT visiting `/consent`.

**Canonical FI-004 returning-user assertion pattern:**
```ts
// Seed already placed a consent_records row for TEST_USER_ID (ES §b.6, AC-4).
await page.goto("/auth/login");
await page.getByPlaceholder(/you@yourcompany\.com/i).fill(TEST_USER_EMAIL);
await expect(page.getByRole("button", { name: /send code/i })).toBeEnabled();
await page.getByRole("button", { name: /send code/i }).click();
const code = await getOtp("login", TEST_USER_EMAIL);
await page.getByPlaceholder(/6-digit code/i).fill(code);
await expect(page.getByRole("button", { name: /verify/i })).toBeEnabled();

// Track URL transitions — assert /consent is NEVER visited
const visited: string[] = [];
page.on("framenavigated", (f) => { if (f === page.mainFrame()) visited.push(f.url()); });
await page.getByRole("button", { name: /verify/i }).click();
await expect(page).toHaveURL(/\/dashboard/);
expect(visited.some((u) => /\/consent(\b|$|\/)/.test(u))).toBe(false);
```

**Rationale:** the tested behaviour is "returning-user-skips-consent" — a route-transition invariant, not a `/consent` DOM inspection. RM inspected `/consent` from a no-seed state and correctly reported `needs-auth-flow`. Rewriting to data-flow turns this into a deterministic pass/fail per seed-state.

**New-user variant (OUT OF SCOPE for this ES — flagged as follow-up FI-004b):** a separate spec for the new-user path (must ACCEPT consent) would clear `consent_records` for the test user, run OTP, assert `/consent` IS visited AND contains an accept-consent interactive element. RM does the DOM inspection for that variant only after `teardown+seed` clears the consent row. **Not in this ES.** If needed, CoFounder dispatches a separate TS for FI-004b.

#### b.15.6 Secondary findings — non-gating observations (from manifest §5)

These are informational only — do not block any AC in this ES.

1. **No `data-testid` attributes on `/auth/login` inputs.** Biggest structural test-brittleness risk across the 66-spec suite. A 5-minute product touch-up (pattern #6 above) would bulletproof the whole tree. **Disposition: listed-as-secondary-finding** (no FIXME-defer entry in seed.ts; no dedicated TS; the resolution patterns in §b.15.2 work without it). If Aditya wants to track as a product task, CoFounder can open a separate item; not in this ES.
2. **No `<label>` elements on login form inputs.** Accessibility finding beyond test scope — `getByLabel` is a Playwright-recommended pattern for reliability *and* screen-reader usability. Both benefits lost today. Same disposition as #1.
3. **Buttons start `disabled=true`.** Documented in §b.15.2 pattern #3 and §b.15.4 note. Specs MUST `await expect(btn).toBeEnabled()` before `.click()`.
4. **FI-056 conflates 404-vs-401.** The app returns 404 for unknown site id, not 401. There is no "unauthorized token" UI state because the DB lookup fails first. If FI-056's intent is "401 on valid-site-but-invalid-token," the test needs a *seeded* valid site id with a garbage token, not a fake id. Current test conflates failure modes; pattern #5 preserves the "any 4xx surface" intent by matching the 404 page title, but a stricter follow-up would seed a valid site + invalid token. **Disposition: documented here; no change to this ES scope.**
5. **Email input has no `name` or `id` attribute.** `page.fill()` works; form-library internals (react-hook-form etc.) manage state off-DOM. Not a blocker; informational for anyone writing FormData-level assertions.

#### b.15.7 Helper file inventory impact

No new files from Track B. Selector-hardening is a per-spec edit to `e2e/tests/01-auth/*.spec.ts` and `e2e/tests/06-nav/056-deep-link.spec.ts`. Optional `data-testid` product change (§b.15.2 pattern #6) would touch `app/auth/login/page.tsx` — explicitly NOT in this ES; flagged as secondary finding #1.

### b.16 Phase A dry-run scope — DRY-01..05 + cross-cutting contracts (Aditya D1/D2 ratify)

**Background:** Aditya ratified (corr `354442c8`) a 5-spec dry-run as the gate before Phase B heavy-wave. Three cross-cutting contracts (zero-`fixme`, Supabase-assert-per-spec, product-gap surface protocol) are introduced HERE in Phase A and INHERITED by Phase B unchanged. Phase A also pins a one-shot 200-credit grant to `TEST_USER_ID` so dry-run audits can run without zero-balance gating.

**Out of scope:** DRY-06 (Stripe-mock checkout) is DROPPED per Aditya D2. Stripe-adjacent specs that surface during heavy-wave authoring use the new product-gap class `product-gap-stripe-deferred` (AC-27) — they do NOT carry `test.fixme()`. Live-key risk surfacing (D3) is deferred to Phase B revisit.

**Cross-reference:** the Phase B heavy-wave pre-queue draft at `/tmp/flowblinq/phaseB-es-draft.md` will be revised AFTER this commit lands (its AC-25/26/27 are now Phase A's; Phase B inherits them and adds AC-29 for 8-category coverage).

#### b.16.1 Numbering and section placement

Numbered §b.16 (next contiguous slot after §b.15). The three cross-cutting ACs (AC-25 zero-`fixme`, AC-26 Supabase-assert, AC-27 product-gap) are introduced as Phase A artefacts because they apply UNIVERSALLY across Phase A, Phase B, and any future phase. AC-28 documents the Phase-A-specific credit-grant contract.

#### b.16.2 The five dry-run specs (DRY-01..05)

| ID | Flow | Required UI assertions | Required Supabase asserts (AC-26) | Expected credit impact |
|----|------|------------------------|------------------------------------|------------------------|
| **DRY-01** | Login → logout. Returning user via `getOtp("login", TEST_USER_EMAIL)` per §b.14; reach `/dashboard`; click logout; verify redirect back to `/auth/login`. | `page.url()` reaches `/dashboard` post-verify; `page.url()` is `/auth/login` post-logout. `role="alert"` empty on success path. | `assertAuthSessionExists(TEST_USER_ID, 1)` post-login → ≥1 `auth.sessions` row; `assertAuthSessionExists(TEST_USER_ID, 0)` post-logout → 0 rows (if product clears on logout) OR `assertNoMutation` on logout boundary if session lifetime is server-managed differently. | 0 credits |
| **DRY-02** | Single-domain audit launch. From `/dashboard`, enter a domain (use a fixture from `SITE_DOMAINS` or a fresh `dry02.e2e.flowblinq.test`), click audit, wait for `pipeline_status` to flip to a non-pending state, verify report tab loads. | Audit-running indicator visible; report URL `/sites/[id]` loads; at least one pillar card renders. | `assertRowExists("geo_sites", { domain: "<dry02 domain>", team_id: TEST_TEAM_ID })`; `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", -<expected page count>)`; `assertRowExists("credit_transactions", { team_id: TEST_TEAM_ID, type: "crawl_debit", site_id: <new siteId> })`. | −5 credits typical (or per the actual page count) |
| **DRY-03** | Citation check on the DRY-02 site. Navigate to the citation tab, trigger a citation check, wait for completion. | Citation results table renders with non-zero entries (or empty-state copy if local mocks return zero — surface via `expect(...).toContainText` either way). | `assertRowExists("citation_check_scores", { site_id: <DRY-02 siteId> })`; `assertRowCount("citation_check_responses", { check_id: <new checkId> }, n)` where `n ≥ 1`; `assertColumnDelta("teams", …, "credit_balance", -<citation cost>)`. | −1 to −5 credits per product cost |
| **DRY-04** | Map competitors on the DRY-02 site. Open competitor settings, add a user-defined competitor, save. | Competitor pill appears in UI; toast/feedback on save. | `assertColumnDelta("geo_sites", { id: <DRY-02 siteId> }, "user_competitors", <new array length>)` (assert JSONB array length increased by 1); OR `assertRowExists("geo_sites", { id: …, user_competitors: <jsonb-contains-name> })` if helper supports JSONB containment. | 0 credits typical |
| **DRY-05** | Bulk CSV (5 URLs minimum). From `/dashboard`, upload a 5-row CSV, verify bulk-mode classification, wait for `firecrawl_jobs` rows to materialise, optionally wait for completion. | Bulk-upload modal accepts the CSV; bulk job appears in dashboard with "in progress" state. | `assertRowExists("geo_sites", { team_id: TEST_TEAM_ID, audit_mode: "bulk" })` returns the new bulk-site row; `assertColumnDelta(..., "bulk_url_count", +5)` OR `assertRowExists("geo_sites", { …, bulk_url_count: 5 })`; `assertRowCount("firecrawl_jobs", { site_id: <bulk siteId> }, ≥1)`; `assertColumnDelta("teams", …, "credit_balance", -5)` (one credit per URL minimum). | −5 credits minimum (1 per URL) |

**Total dry-run credit budget: ~16-20 credits** (conservative). The 200-credit grant per AC-28 leaves ample headroom for retries.

**Strict scope: DRY-06 is NOT in this ES.** No spec, no AC, no FIXME, no class tag. The Stripe-mock checkout flow waits for a separate Phase B revisit (Aditya D3 live-key finding).

#### b.16.3 Supabase-assert helper contract — `e2e/helpers/supabase-assert.ts` (CREATE per AC-26)

```ts
// e2e/helpers/supabase-assert.ts — Phase A AC-26 helper contract.
// Service-role-scoped DB asserts. Loads SUPABASE_SERVICE_ROLE_KEY from process.env
// per AC-24 pattern; fail-fast if absent. Local-only (AC-7(b) + AC-7(c) gates apply).
import postgres from "postgres";

let _sql: ReturnType<typeof postgres> | null = null;
function getDb(): ReturnType<typeof postgres> { /* singleton, uses DATABASE_URL */ }

/** Assert at least one row matches the WHERE predicate. Returns the first matched row for chained inspection. */
export async function assertRowExists<T = unknown>(
  table: string,
  where: Record<string, unknown>,
): Promise<T>;

/** Assert the row count for a WHERE predicate equals expected (or is in a tolerance band). */
export async function assertRowCount(
  table: string,
  where: Record<string, unknown>,
  expected: number | { min?: number; max?: number },
): Promise<void>;

/** Assert the row count CHANGED by exactly `delta` between a baseline snapshot (taken at spec-arrange time) and now. */
export async function assertRowCountDelta(
  table: string,
  where: Record<string, unknown>,
  baseline: number,
  delta: number,
): Promise<void>;

/** Assert a single column on a single row changed by `delta` since a baseline read. */
export async function assertColumnDelta<T extends number>(
  table: string,
  where: Record<string, unknown>,
  column: string,
  delta: T,
): Promise<void>;

/** Read-only specs use this to PROVE no mutation happened (snapshot row counts before, assert equal after). */
export async function assertNoMutation(
  tables: string[],
  // optional scoped predicates — defaults to TEST_TEAM_ID-scoped where applicable
  scope?: { teamId?: string; userId?: string; siteIds?: string[] },
): Promise<void>;

/** Auth-schema helpers (Category 6 / DRY-01 logout edge). Admin connection required. */
export async function assertAuthSessionExists(userId: string, expectedCount?: number): Promise<void>;
export async function assertRefreshTokenValid(userId: string): Promise<void>;
```

**Contract details:**
- `SUPABASE_SERVICE_ROLE_KEY` read from `process.env` per AC-24 bullet 4. **Fail-fast** at module load if absent — throws before any test runs.
- Same `DATABASE_URL` as seed/teardown (local-only per AC-7).
- `assertNoMutation` is for read-only specs (e.g. "navigation works" specs that don't change state). Calling it pins the no-mutation guarantee at AC-26-compliance level — UI-only assertion is INSUFFICIENT.
- `assertColumnDelta` and `assertRowCountDelta` need a baseline read at spec-arrange time. Spec authors take a snapshot in the `test.beforeEach` or the `// arrange` block, then call the delta assert in `// assert`.
- All helpers throw on connection failure — silent passes are impossible.
- Tested via mock-postgres backend in UT-19; live exercise via DRY-01..05 ITs.

#### b.16.4 Product-gap surface protocol — class tags (AC-27)

When a spec author hits a product gap (feature not built, route returns 500, UI state missing), they have THREE legitimate paths — `test.fixme()` is BANNED:

1. **Fix the product** — dispatch a ScriptDev fix in the same PR; spec asserts the fixed behaviour.
2. **Fail the spec with a tracked TS reference** — example:
   ```ts
   test("dry-04 competitor mapping persists across reload", async ({ page }) => {
     // FIXME-GAP: TS-NNN — competitor JSONB persists in DB but UI doesn't re-render on reload
     // The DB assertion below WILL pass; the UI assertion CURRENTLY FAILS.
     // When TS-NNN lands, the UI re-renders and this spec goes green.
     await ...;
     await assertRowExists("geo_sites", { id: …, user_competitors: contains("Acme") });
     await expect(page.locator('[data-testid="competitor-pill"]')).toContainText("Acme"); // currently red
   });
   ```
3. **Tag with a product-gap class and remove from active wave** — example: `test.skip("DRY-06 Stripe checkout — product-gap-stripe-deferred TS-NNN", …)` MUST carry the class tag in the test name AND a `// product-gap-stripe-deferred` adjacent comment.

**Class tag conventions (extensible):**
- `product-gap-stripe-deferred` — Stripe checkout / billing surface not yet wired (Aditya D3 deferred)
- `product-gap-ui-missing` — backend surface works, no UI yet
- `product-gap-api-not-built` — UI exists, backend route returns 4xx/5xx
- `product-gap-design-pending` — feature scope not yet decided

Class-tagged specs are **visibly tracked** (a CI report enumerates them per class) and do NOT count against AC-25 zero-`fixme` because they are NOT `fixme()`-tagged. They are honest declarations of product state, not hidden skips.

**Why this matters:** the entire heavy-wave premise is "specs surface reality." A silent `test.fixme()` defeats this. A class-tagged `test.skip("… — product-gap-X-deferred TS-NNN", …)` makes the gap visible in CI, traceable to a TS, and removable when the product catches up.

#### b.16.5 File inventory impact (append to §c)

| File | Action | Purpose |
|------|--------|---------|
| `e2e/helpers/supabase-assert.ts` | **CREATE (ScriptDev)** | Phase A AC-26 DB-assertion helper per §b.16.3 |
| `scripts/e2e/grant-credits.ts` | **CREATE (ScriptDev)** | Phase A AC-28 one-shot 200-credit grant invoked at dry-run setup |
| `e2e/tests/dry-run/DRY-01-login-logout.spec.ts` | CREATE | DRY-01 per §b.16.2 |
| `e2e/tests/dry-run/DRY-02-single-audit.spec.ts` | CREATE | DRY-02 |
| `e2e/tests/dry-run/DRY-03-citation-check.spec.ts` | CREATE | DRY-03 |
| `e2e/tests/dry-run/DRY-04-map-competitors.spec.ts` | CREATE | DRY-04 |
| `e2e/tests/dry-run/DRY-05-bulk-csv.spec.ts` | CREATE | DRY-05 |

`scripts/e2e/seed.ts` extension: AC-28 credit-grant step runs AFTER the existing seed completes (or as part of it — ScriptDev's call). Either way, the granted balance is observable post-seed.

#### b.16.6 Operational — Playwright outputDir relocation

Playwright artifacts (`test-results/`, `playwright-report/`) are written to `/home/aditya/data/flowblinq-artifacts/` on a separate disk (88 G free vs root 25 G free). This applies to both Phase A dry-run and Phase B heavy-wave runs. Configured at `geo/playwright.config.ts` — `outputDir` for raw test artifacts and the HTML reporter's `outputFolder` for the rendered report. Symlinks from `geo/test-results` and `geo/playwright-report` to the new location are preserved for backward-compat (existing tooling and the existing CI scripts that reference the in-tree paths continue to work transparently). Rationale: prevent root-disk pressure during 109-spec headful runs, which produce video / trace / screenshot artifacts per Playwright's `retain-on-failure` policy and can each consume tens of MB. Operational concern only — no AC, no UT/IT, no behavioural contract change.

**Always-on capture (Shastri directive 2026-04-21):** the Playwright `use` block sets `video`, `screenshot`, and `trace` all to `'on'` for every spec — every spec is replayable on demand, not only on failure. Artifacts land under `/home/aditya/data/flowblinq-artifacts/test-results/` alongside the relocated `outputDir`. Disk impact: ~5–20 MB per spec for video+trace combined; ~350 MB–1.4 GB across the 71-spec final batch. Operational concern only — no AC.

#### b.16.7 Operational — QStash callback pathways (E2E inline bypass vs non-E2E tunnel)

QStash callback base supports two pathways depending on context:

(i) **E2E (Playwright-driven specs):** when `NODE_ENV=test` OR `QSTASH_LOCAL_BYPASS=1`, `lib/qstash.ts` triggers the **OPT-A inline bypass** (landed commit `c660f6d`). `enqueueStage` inline-fetches `/api/pipeline/stage` directly instead of going through QStash's publish-then-callback round-trip. Removes external-network dependency from the E2E suite — specs run deterministically against the local Next dev server with no QStash account, no callback URL, no tunnel.

(ii) **Non-E2E local manual dev:** for hands-on local development that wants to exercise the real QStash publish/retry/dedupe path, `QSTASH_CALLBACK_BASE` env var (set in `.env.local`) points QStash's `publishJSON` callback at an ephemeral cloudflared tunnel reaching `localhost:3000`. Tunnel URLs are session-specific — the operator re-sets `QSTASH_CALLBACK_BASE` each time `cloudflared` restarts. **Not used by Playwright-driven tests.** The tunnel URL is intentionally NOT quoted in this spec because it changes per session.

Operational concern only — no AC, no UT/IT, no behavioural contract change.

#### b.16.8 Credit cost per tier per action — source-of-truth table (AC-31, AC-33)

**Status:** POPULATED from ScriptDev credit-tier audit reply (corr `59008009`); REVISED per RM RC1 finding (corr `853b80e0`, Aditya ratified) to two-phase reserve-then-debit semantics. Line numbers pinned at branch tip `2e8f988` (SD audit tip) — may drift with future refactors; HolePoker re-greps at ratify and this ES gets a micro-amendment if any `file:line` changes.

**Two-phase semantics (RC1, see AC-33 for assertion contract):** for crawl-debiting actions (single-URL audit, bulk audit), the product writes credit_transactions in TWO phases against `credit_balance`:

1. **Discovery phase** (at `/api/sites` POST acceptance) — `crawl_reserve` row with `credits_changed = -ceil(page_estimate / PAGES_PER_CREDIT)`. `page_estimate` is Firecrawl's discovery-stage URL count for single-URL audits, or the operator-provided URL count for bulk. `PAGES_PER_CREDIT = 10` per `lib/config.ts:12` (`export const PAGES_PER_CREDIT = 10`).
2. **Debit phase** (at `pipeline_status = "complete"`) — `crawl_debit` row with `credits_changed = -ceil(actual_pages / PAGES_PER_CREDIT)`. `actual_pages` is the real crawl count after Firecrawl returns. The debit row reconciles against the reserve row such that the **NET `credit_balance` change from the action's start to pipeline-complete equals the cost in the table below** — the reserve is effectively superseded by the debit (whether the product writes an explicit refund row, or the debit row's `credits_changed` is the net adjustment, is an SD impl detail; the ES contract is the post-complete net delta).

Citation-check, competitor-discovery, and manual-competitor-add are **single-phase** (no reserve, single debit at action time) because they are flat-cost and have no estimate-vs-actual divergence.

| Tier state | Action | Cost (credits) — net post-complete | Phases | Source |
|------------|--------|------------------------------------|--------|--------|
| Free + allowance remaining (`used < monthly_page_allowance`) | Single-URL audit | **0** | Two-phase: reserve & debit both present, both `credits_changed = 0` (subscription absorbs); net = 0 | `lib/config.ts` (`FREE_MAX_PAGES = 20`, `PAGES_PER_CREDIT = 10`) + `app/api/sites/route.ts` tier-branch |
| **Free + exhausted** (`monthly_page_allowance = 0` OR `used ≥ monthly_page_allowance`) | Single-URL audit | **`-ceil(actual_pages / 10)`** post-complete; for `actual_pages = 5` (DRY-02 mock): **`-1`** net (`ceil(5/10) = 1`) | Two-phase: reserve = `-ceil(page_estimate / 10)` at discovery; debit reconciles to `-ceil(actual / 10)` at complete; reserve effectively superseded | `app/api/sites/route.ts` debit branch (RC1: two-phase, not single) |
| Free + exhausted | Bulk `N` URLs | **`-ceil(N_actual / 10)`** post-complete; for `N = 5` (DRY-05): **`-1`** net (`ceil(5/10) = 1`) | Two-phase per bulk job: reserve at submit on `N_estimate`; debit at complete on `N_actual` | `lib/config.ts:35` `bulkCreditsRequired(N) = ceil(N / PAGES_PER_CREDIT)` — linear per `PAGES_PER_CREDIT`-URL block |
| Pro active + allowance remaining | Single-URL audit | **0** | Two-phase, both rows credits_changed = 0 | `app/api/sites/route.ts:484` fast-path |
| ANY tier (flat) | Citation check | **`-5`** | Single-phase: one debit row | `app/api/sites/[id]/citation-check/route.ts:28` `ACTION_CREDITS.shareOfVoice` |
| ANY tier (flat) | Competitor discovery | **`-5`** | Single-phase: one debit row | `app/api/sites/[id]/competitor-discovery/route.ts:14` `ACTION_CREDITS.competitorMapping` |
| ANY tier (flat) | Manual competitor add | **0** | No row written (free-by-design) | no debit path |

**Footnote:** line numbers pinned at tip `2e8f988` (SD audit snapshot). May drift with future refactors — HolePoker re-greps at ratify; any drift triggers a micro-amendment to refresh the `Source` column. The cost integers (0, 1, 5) are stable — they're pinned against SD's audit and the `ACTION_CREDITS` constants, not against line numbers. **`PAGES_PER_CREDIT = 10` constant** is pinned against `lib/config.ts:12` (verbatim: `export const PAGES_PER_CREDIT = 10;            // 1 credit = 10 pages (10cr per 100 pages)`) and is the divisor used by both reserve and debit phases. (HP-271 corrected the prior `5` cite to the actual `10` value.)

**Rule (per AC-31 + AC-33):** every `assertColumnDelta(..., "credit_balance", <value>)` in Phase B specs MUST (a) use an integer literal matching the **net post-complete cost** in this table, AND (b) be issued AFTER `pipeline_status = "complete"` is observed (no mid-flight assertions — see AC-33). Spec authors seed the test user to the matching tier state via §b.4 (seed sets `monthly_page_allowance = 0` per AC-32, placing the user in "Free + exhausted" by default). Specs that need the "Free + allowance remaining" row MUST override the allowance mid-test. Pro-tier coverage deferred to Phase B per AC-32.

**Worked deltas for dry-run specs** (given seed default `monthly_page_allowance = 0`, `PAGES_PER_CREDIT = 10`, mock Firecrawl returns 5 URLs/domain per AC-30):
- **DRY-02** (single-URL audit) — launch: `crawl_reserve` row `credits_changed = -ceil(page_estimate/10)` (sign negative; exact integer depends on Firecrawl discovery — non-deterministic under live services per AC-34); complete: `crawl_refund` row `credits_changed = +(reserve_amount - ceil(actual_pages/10))` reconciling the over-estimate (zero or positive). Net `credit_balance` delta from action-start to post-complete = `-ceil(actual_pages/10)`; for a minimal-page public site per §b.16.9.5 (actual_pages typically 1–5), **net = `-1`**. Assertion (post-complete only): `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", -1)` — EXACT integer literal per AC-31 on the net — AND `assertRowExists("credit_transactions", { type: "crawl_reserve", site_id: <DRY-02 siteId> })` AND `assertRowExists("credit_transactions", { type: "crawl_refund", site_id: <DRY-02 siteId> })` — row existence exact per AC-34 but row-level `credits_changed` NOT asserted (vendor-content dependent).
- **DRY-02 with observed milestone values** (from corr `19d64ff5`) — `crawl_reserve.credits_changed = -2` (Firecrawl returned page_estimate ≈ 11–20 for this run); `crawl_refund.credits_changed = +1` (reconciliation: actual_pages ≈ 1–10 → ceil(actual/10) = 1 → refund = `-(-2) - 1 = +1`). Net = `-2 + 1 = -1`. Individual row values vary per run; only the net is pinned.
- **DRY-02 with `actual_pages = 10`, `page_estimate = 20`** (illustrative — larger over-estimate) — reserve `-ceil(20/10) = -2` at launch; refund `+(2 - ceil(10/10)) = +1` at complete; net = `-2 + 1 = -1`.
- **DRY-02 with `actual_pages = 20`** (illustrative — pushes into 2-credit territory) — reserve proportional; refund reconciles; net = `-ceil(20/10) = -2`.
- **DRY-03** (citation check) — single-phase: one debit-style row `credits_changed = -5` with a type reflecting the citation-check path (flat-cost action per `ACTION_CREDITS.shareOfVoice`). Net delta = `-5`. No reserve row. Assertion: `assertColumnDelta(..., "credit_balance", -5)`.
- **DRY-04** (add competitor) — no row written; net delta = `0`. Assertion: `assertColumnDelta(..., "credit_balance", 0)`.
- **DRY-05** (bulk 5 URLs) — launch: `crawl_reserve` bulk aggregate at `app/api/sites/route.ts:170` with `credits_changed = -bulkCreditsRequired(5) = -1` (unconditional when `creditsToDeduct > 0`). Complete-reconciliation refund (`bulk_crawl_refund` at `stage/route.ts:1076` or `crawl_refund` at `stage/route.ts:1114`): CONDITIONAL on `actualCredits < reservedCredits` per site; for minimal-page fixture (§b.16.9.5) with 4 non-primary sites at `reservedCredits=0` and 1 primary at `reserved=1, actual=1` → **0 refund rows emitted**. Net `credit_balance` delta = `-1` (single Rule-1 integer-literal invariant; captured by `assertColumnDelta("teams", …, "credit_balance", -1)` regardless of whether any refund row is written). **Spec assertion surface:** `assertRowExists(crawl_reserve)` with `createdAfter: uploadStartIso` cutoff (unconditional emission, reliable) AND `assertColumnDelta` on the net (per AC-31); refund-row existence NOT asserted (would be brittle to the conditional emission — see AC-33 taxonomy "Spec-assertion implication" bullet). `firecrawl_jobs` row count per `computeChunks(N=5) = min(CRAWL_MAX_CHUNKS=10, 5) = 5` (see `lib/services/geo-crawler.ts:1110-1115` + `lib/config.ts:25`).

#### b.16.9 Live-services E2E architecture (Aditya pivot 2026-04-21 corr `0ab24f1a`)

This section codifies the post-pivot architecture introduced by AC-30. SUPERSEDES the retired mock-server architecture; companion to §b.16.7 (QStash callback pathways) which was previously E2E-only-bypass and is now also the live-services pathway.

**Scope:** the E2E suite hits LIVE external service vendors. Local-only services (Supabase Postgres + Auth, Mailpit) are unchanged.

| Layer | Local or live? | Endpoint | Notes |
|-------|----------------|----------|-------|
| Postgres | LOCAL | `127.0.0.1:54322` | AC-7(b) gate; seed/teardown writes here |
| Supabase Auth | LOCAL | `127.0.0.1:54321` | AC-7(c) gate; AC-24 admin.createUser |
| Mailpit | LOCAL | `127.0.0.1:54324` | §b.14 `getOtp("login", ...)` source |
| Gmail IMAP (Resend → Gmail) | LIVE | `imap.gmail.com:993` | §b.14 `getOtp("verify", ...)` source — Resend production sender via vendor |
| Firecrawl | LIVE | `api.firecrawl.dev` (SDK default) | `FIRECRAWL_BASE_URL` UNSET in E2E env |
| OpenAI | LIVE | `api.openai.com` (SDK default) | `OPENAI_BASE_URL` UNSET in E2E env |
| Anthropic | LIVE | `api.anthropic.com` (SDK default) | `ANTHROPIC_BASE_URL` UNSET in E2E env |
| Perplexity | LIVE | `api.perplexity.ai` (SDK default) | `PERPLEXITY_BASE_URL` UNSET in E2E env |
| QStash (publish) | LIVE | `qstash.upstash.io` (SDK default) | `QSTASH_URL` UNSET in E2E env |
| QStash (callback target) | LOCAL via tunnel | `localhost:3000` via cloudflared tunnel | `QSTASH_CALLBACK_BASE` set to tunnel URL at run-time per §b.16.7 |

**Cloudflared tunnel bridge:** QStash publish → vendor backbone → cloudflared tunnel → localhost:3000 Next dev server (the `/api/pipeline/stage` callback). Tunnel lifecycle: operator starts `cloudflared tunnel --url http://localhost:3000` before E2E run, exports the resulting public URL into `QSTASH_CALLBACK_BASE`, runs the suite. If the tunnel dies mid-suite, the next QStash callback times out and the affected spec FAILS — surfaced, not silent.

**Cost-budget table (USD, indicative — actual varies by vendor pricing + crawl size):**

| Spec / batch | Expected vendor calls | USD cost | Halt criterion |
|--------------|----------------------|----------|----------------|
| DRY-01 (login/logout) | 0 vendor (Supabase OTP via Mailpit local) | $0.00 | n/a |
| DRY-02 (single-URL audit) | 1 Firecrawl scrape (~5 pages) + 1-3 LLM calls (citation/competitor/tree) + 1 QStash publish | $0.05–$0.15 | per-spec > $0.50 → operator review before next run |
| DRY-03 (citation check) | 4–6 LLM provider calls (one per provider in the citation check) | $0.05–$0.20 | per-spec > $0.50 → operator review |
| DRY-04 (add competitor) | 0 vendor (UI mutation only; competitor add is a DB write) | $0.00 | n/a |
| DRY-05 (bulk 5 URLs) | 5 Firecrawl scrapes + ~5-15 LLM calls | $0.20–$0.45 | per-spec > $0.50 → operator review |
| **Phase A 5-spec dry-run total** | sum of above | **$0.30–$0.80** | batch > $2 without completion → **HALT** |
| **Phase B 65-spec heavy wave** | category mix per §b.16.2 | **$5–$15** | batch > $20 without completion → **HALT**; per-batch monitoring required |

**Halt criteria (operational):** the runner monitors cumulative API spend (estimated from response counts; SD wires this in the run harness OR operator monitors vendor dashboards). On per-spec > $0.50 OR per-batch > the table threshold WITHOUT proportional completion progress, the runner ALERTS (does not auto-kill — operator decides whether to continue). This guards against runaway cost from a stuck retry loop or a misconfigured spec hammering an endpoint.

**Rate-limit awareness for heavy wave:** Phase B 65-spec wave runs SEQUENTIALLY (`workers: 1` in `playwright.config.ts`, already pinned per existing config). Parallel runners would hit per-vendor rate limits — OpenAI tier-1 caps at 500 RPM for some models; Anthropic at 50 RPM; QStash at low rates per Upstash tier. Sequencing also keeps cost monitoring tractable. If Phase B's wall-clock becomes painful (say > 90 min), CoFounder dispatches a follow-up TS to introduce per-vendor concurrency limiters at the run-harness level — NOT in product code.

**Determinism note (lead-in to AC-34):** every live vendor call is non-deterministic in content. Crawl results vary as upstream sites change. LLM completions vary by sampling. AC-34 governs which assertion classes are allowed (exact for DB / status / credit; tolerant for crawl content / LLM verbatim). AC-31 integer-literal credit-delta rule is unaffected because credit math is deterministic regardless of crawl output.

**Failure-handling note (lead-in to AC-35):** when a live-services spec or batch hits a 5xx, an unhandled exception, or any unexpected failure mode, the **fix-before-retry policy** at AC-35 applies: HALT the retry sequence, surface the error context, apply a targeted fix, then resume from a known-good seed state. Blind retry-loops on 5xx are PROHIBITED (they hide product bugs and burn vendor budget). Acceptable bounded retries (max 3 attempts) only for explicit retry-class errors per AC-35 (b).

##### b.16.9.5 Test-domain selection criterion (Aditya corr `9fabb91b`)

Test domains for DRY-02, DRY-05, and any Phase B audit-triggering specs MUST be **minimal-page public sites** — crawlable surface < 10 pages per audit. The criterion bounds wall-clock under the 25-min per-spec cap and cost under the $0.50 per-spec ceiling from the §b.16.9 cost table.

**RECOMMENDED domains** (small, stable, public, allowed to crawl):
- `example.com` — IANA reserved domain, single page, deterministic content
- `example.org` — same family
- `example.net` — same family
- `httpbin.org` — small HTTP-tooling surface (~10–20 endpoints, mostly machine-readable)
- `jsonplaceholder.typicode.com` — small static API-docs landing page (verified 2026-04-21: HTTP 200, ~8 KB real HTML, no bot protection)

**PROHIBITED domains** (large surfaces — exhaust time + cost budgets; or active bot-protection blocking Firecrawl):
- `w3.org` — hundreds of pages
- `ietf.org` — RFC index is enormous
- `httpbin.com` — Cloudflare bot-protection returns challenge pages to headless browsers; triggers Firecrawl bot-challenge detection and fails the audit (RM rm-phaseA-4of5 diagnosis 2026-04-21 corr `3b9ee0d5`). Note: `httpbin.org` is safe; `httpbin.com` is the blocked variant.
- Any large news / e-commerce / content site (NYT, Wikipedia article roots, Amazon, etc.)
- Customer-owned production domains (cost + risk of crawling someone's actual site repeatedly)

**Rationale:** large sites exhaust the 25-min wall-clock cap and the $0.50/spec USD cost ceiling. Minimal sites exercise the same `/api/sites → discovery → Firecrawl → tree-extract → citation → competitor` pipeline code path with predictable wall-clock and predictable Firecrawl page-count (~1–5 returned URLs), producing the deterministic `credit_balance` net delta documented in §b.16.8 worked examples.

**Source-of-truth for spec authors:** when picking a domain for a new audit-triggering spec, choose from the RECOMMENDED list above unless the spec specifically tests behaviour against a particular real domain (in which case the spec carries a `// rationale: <reason>` comment naming the exception). The PROHIBITED list is enforced by `UT-27` grep guard.

Verified by `UT-27` (grep guard against the PROHIBITED list in spec files + bulk-CSV fixtures).

### b.13 FIXME — deferred for Stripe (AC-10)

`scripts/e2e/seed.ts` MUST contain a top-of-file comment block:

```ts
// FIXME-DEFERRED: Stripe test-mode fixture
// ============================================
// FI-042 (credit purchase flow) requires:
//   - Stripe test-mode webhook signing secret
//   - Test-mode price IDs for each credit pack
//   - Mock/forwarded webhook delivery into local Next.js
// These are out-of-scope for ES-e2e-fixtures. Follow-up ES will scope
// Stripe test-mode setup. For now, FI-042 specs MUST be marked
// test.fixme() with a link to this comment.
```

No code paths in seed touch `stripe_customer_id`, `stripe_subscription_id`, or `stripe_checkout_session_id`. All five fixtures leave those columns `NULL`.

---

## c) File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `scripts/e2e/seed.ts` | CREATE | Main seed. ~180 lines est. |
| `scripts/e2e/teardown.ts` | CREATE | Teardown. ~60 lines est. Shares safety-gate helper with seed. |
| `scripts/e2e/fixtures/per-page-samples.ts` | CREATE | Typed fixture payloads for `perPageResults`/`perPageFixes`. |
| `scripts/e2e/lib/safety.ts` | CREATE | `assertLocalDb()` helper reused by seed + teardown. |
| `e2e/fixtures/ids.ts` | CREATE | UUID + slug + email constants. Specs `import { TEST_TEAM_ID, SITE_IDS } from "./fixtures/ids"`. |
| `e2e/helpers/otp.ts` | CREATE (§b.14, Phase 0 Track A) | Unified OTP facade. Exports `getOtp(flow: "login" \| "verify", email, opts?)` + re-exports `OtpTimeoutError`. |
| `e2e/global-setup.ts` | MODIFY | Insert `execFileSync("npm", ["run", "db:seed:e2e"])` per §b.11. |
| `package.json` | MODIFY | Add `db:seed:e2e` and `db:teardown:e2e` scripts. |

**Existing files referenced but unmodified by this ES:** `e2e/helpers/mailpit.ts` (exports `getOtpForEmail` + `clearMailpit`; confirmed present on branch tip `4b0e53d`), `e2e/fixtures/otp-helper.ts` (exports `getLatestOtp` + `OtpTimeoutError`). Both remain as-is; the new facade simply re-dispatches to them per `OtpFlow`.

No changes to `e2e/helpers/db.ts` — it stays for OTP-code specs that need a throwaway site outside the fixture surface. But `createSiteWithKnownOtp` users SHOULD migrate to fixtures over time (non-blocking).

---

## d) Acceptance Criteria

1. **AC-1 (identity):** `ids.ts` exports exact UUIDs listed in §b.1. `TEST_USER_EMAIL === "adityanittoor+geotests@gmail.com"` — byte-equal to `e2e/fixtures/otp-helper.ts:14`. Grep test asserts this constant appears identically in both files.
2. **AC-2 (seeded sites):** after `db:seed:e2e`, `SELECT count(*) FROM geo_sites WHERE team_id=$TEST_TEAM_ID` returns `5`. Each row matches the state in the table in §b.2. `perPageResults` array lengths match (12, null, null, 5, 3). `pipelineStatus` set per fixture.
3. **AC-3 (credits):** `teams.credit_balance = 10`; `SELECT count(*) FROM credit_transactions WHERE team_id=$TEST_TEAM_ID` = 3; running sum `SUM(credits_changed)` = 10. Balance-before/after chain is consistent (tx_N.balanceAfter = tx_{N+1}.balanceBefore).
4. **AC-4 (consent):** exactly one row in `consent_records` with `user_id=TEST_USER_ID`, `tos_version="1.0"`, `eula_version="1.0"`. Table name is `consent_records` (NOT `consent_acceptances` — the task payload used the wrong name; spec-rigour correction noted in §b.6).
5. **AC-5 (dependent rows + NOT NULLs):** every `geo_sites` row has `token_expires_at IS NOT NULL` and in the future. `citation_check_scores` row exists for `paidFullAudit` and `historicalAudit`. `geo_page_views` rows (≥6) exist for `paidFullAudit`. Every FK (`team_domains.site_id`, `credit_transactions.site_id`, `citation_check_responses.site_id`) resolves.
6. **AC-6 (idempotency — full md5-agg, HP-260):** `db:seed:e2e && db:seed:e2e` completes both times without error. After the second run, the `md5` of a deterministic serialization over EVERY row in EVERY tagged table (including ALL timestamp columns — `created_at`, `updated_at`, `accepted_at`, `token_expires_at`, `token_rotated_at`, `viewed_at`, `last_crawl_at`, `expires_at`, `redeemed_at`, `reset_at`) is **byte-identical** to after the first run. This is stronger than the pre-HP-260 "snapshot-ish" claim — the seed uses SEED_EPOCH absolute anchoring so every timestamp on every row is deterministic. Verified by `IT-2`.
7. **AC-7 (production safety — HP-253 dual guard + Supabase-URL local gate extension):** seed and teardown abort with exit code `2` in ALL of the following cases: **(a)** `NODE_ENV === "production"`, regardless of what `DATABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL` says (catches SSH-tunnel-to-prod where URLs look local but the process is running under a prod framework/container); **(b)** `DATABASE_URL` does not match regex `/^postgres(ql)?:\/\/[^@]*@(127\.0\.0\.1|localhost):54322\//`; **(c)** `NEXT_PUBLIC_SUPABASE_URL` does not match regex `/^https?:\/\/(127\.0\.0\.1|localhost):54321(\/|$)/` — fires BEFORE any `supabase.auth.admin.createUser` or sibling admin call. The NODE_ENV guard fires FIRST, then DB-URL, then Supabase-URL. Zero SQL connections AND zero Supabase admin HTTP calls opened in any failure path. **Rationale for (c):** diff-verification on a developer's laptop can have `.env.local` holding a PROD `NEXT_PUBLIC_SUPABASE_URL` (e.g. `https://<project>.supabase.co`) even while `DATABASE_URL` remains local; running `npm run db:seed:e2e` directly from shell (bypassing playwright.config.ts's `Object.assign(process.env, LOCAL_SUPABASE_ENV)` pre-populate at line 15) would pick up PROD values and `admin.createUser` would mutate prod `auth.users`. AC-7(c) closes that window. **Implementation contract:** `lib/safety.ts` either extends `assertLocalDb()` with a sibling `assertLocalSupabaseUrl()` OR combines both checks behind a single `assertLocalEnv()` umbrella — SpecMaster pins the three regexes and the exit-2 behaviour; ScriptDev picks the code shape. Verified by `UT-1a` (NODE_ENV case), `UT-1b` (DB-URL case), and `UT-1c` (Supabase-URL case) — `UT-1c` covers three sub-cases: prod host (`https://project.supabase.co`) rejects; `http://127.0.0.1:54321` accepts; `http://localhost:54321` accepts; missing var rejects.
8. **AC-8 (global-setup wiring):** running `npx playwright test` (with local Supabase up) produces seed output in the Playwright report before the first spec banner. Forcing seed failure (temporarily broken SQL) causes Playwright to abort with a non-zero exit and no specs run. Verified by `IT-5`.
9. **AC-9 (teardown — public-schema scope, HP-265 clarification + Phase-E-retry rotation-safety):** `db:teardown:e2e` purges all rows enumerated by the tags in §b.9 and leaves **zero orphans in public-schema tables after a teardown+seed cycle, EVEN IF deterministic-id constants rotate between runs** (e.g. `TEST_USER_ID`, `TEST_TEAM_ID`, or any literal in `e2e/fixtures/ids.ts` is changed to a new value). Asserted by `UT-3` (row-count delta) and `IT-1` (full cycle); rotation-safety specifically asserted by a new test `UT-3b`/`IT-1c` that simulates a `TEST_USER_ID` rotation and verifies the subsequent `teardown → seed` completes without a PK collision (see §f). Teardown is declared "optional in dev, required in CI" in the README section of `scripts/e2e/seed.ts` top comment. **Rotation-safety mechanism:** teardown follows the §b.12.0 `user_id OR PK` pattern on every table that has BOTH a deterministic PK and a scope column. Without the OR-union filter, a prior run's rows keyed by the OLD `user_id` survive and collide with the next INSERT on the deterministic PK (consent_records was the Phase E blocker). **Scope clarification (HP-265):** (a) AC-9 covers the public-schema tables enumerated in §b.9; it does NOT cover the Supabase `auth.users` row created by AC-24. (b) The `auth.users` row owned by seed is **self-healed by the next seed's pre-delete step** (AC-24 bullet 1: `listUsers → find by email === TEST_USER_EMAIL → deleteUser`). (c) Between teardown and the next seed, a stale `auth.users` row at `TEST_USER_ID` may remain; this is acceptable for test-infra purposes because no downstream behaviour depends on its absence — Supabase enforces email-uniqueness, so a future `signInWithOtp({ email: TEST_USER_EMAIL })` against the stale row reuses the same UUID, and the next seed's pre-delete restores idempotency. Reason for not making teardown stateful on Supabase admin HTTP calls: avoids coupling the cleanup path to async cross-service side effects, simplifies failure semantics, and keeps teardown a pure DB-tx purge.
10. **AC-10 (FIXME for Stripe):** `scripts/e2e/seed.ts` begins with the `FIXME-DEFERRED` block from §b.13. Zero `stripe_*` columns touched. FI-042 specs carry `test.fixme(...)` marker referencing this ES.
11. **AC-11 (rate_limits teardown — non-OTP burst prefixes, narrowed per HP-261):** `db:teardown:e2e` purges `rate_limits` rows matching any of the 10 grep-verified real prefixes from §b.12 (`otp_send:`, `otp_verify:`, `invite:`, `sites_create:`, `csp_report:`, `auth_proxy:`, `audit-ip:`, `oauth:`, `chatbot:`, `citation_check:`), scoped to `TEST_USER_EMAIL`, `TEST_USER_ID`, loopback IPs `127.0.0.1` + `::1`, the five fixture `SITE_IDS`, and `oauth:e2e%`. Post-teardown, `SELECT count(*) FROM rate_limits` over the union of those patterns is zero. **This AC makes no claim about OTP-lockout repeatability** — OTP-lockout is covered separately by AC-11b. Verified by `IT-1` and `UT-9`.
11b. **AC-11b (OTP-lockout repeatability via geoSites reseed, NEW per HP-261):** OTP-lockout state lives on `geoSites.otpAttempts` (schema.ts:195, `integer notNull default 0`) and `geoSites.otpLockedUntil` (schema.ts:196, nullable `timestamp`), as implemented by the atomic `incrementOtpAttempt` at `lib/rate-limit.ts:79–100`. It does NOT live in the `rate_limits` table. OTP-lockout repeatability is therefore a side-effect of the existing `geo_sites` DELETE+INSERT cycle (§b.7): every seed run resets `otpAttempts = 0` and `otpLockedUntil = NULL` for every fixture siteId. Post-`db:teardown:e2e` + `db:seed:e2e`, for each siteId in `SITE_IDS`: `SELECT otp_attempts, otp_locked_until FROM geo_sites WHERE id = $siteId` returns `0, NULL`. Verified by `UT-14`.
12. **AC-12 (tagging completeness):** enumerate the §b.9 table; every row the seed writes is covered. Verified by `UT-3`: teardown → `SELECT count(*) FROM <table> WHERE <tag>` is zero for every table listed; and `SELECT count(*)` on each table in total is unchanged from pre-seed (no non-tagged rows deleted).
13. **AC-13 (spec-rigour, HP-169/184):** every column name referenced in §b.X sections of this ES exists on `e2e-comprehensive-suite` branch tip at `geo/lib/db/schema.ts`. A compile-time check (tsc) against `@/lib/db/schema` imports in `seed.ts` enforces this. `check_id`, `per_page_results`, `token_expires_at`, `token_rotated_at`, `consent_records.*`, `rate_limits.*`, `geo_site_view.*`, and all the `geoSites.*` fields referenced here are verified (schema.ts line refs throughout).
14. **AC-14 (single-transaction semantics):** failure anywhere in the INSERT phase rolls back the prior DELETEs via `BEGIN … COMMIT`. Partial seed state is impossible. Verified by `IT-1b`.
15. **AC-15 (seed runtime SLO):** seed completes in under 5 s against an empty local Supabase; teardown under 2 s. Violations flag CI. No profiling beyond wall-time logging (§f).
16. **AC-16 (FK-complete DELETE, HP-252):** seed's DELETE block covers `api_clients` (FK team_id → teams.id, schema.ts:443) and `firecrawl_jobs` (FK site_id → geoSites.id, schema.ts:325). A human-inserted row in either table referencing `TEST_TEAM_ID` / `SITE_IDS[*]` before `db:seed:e2e` runs is purged by the DELETE phase and does not block the `teams` / `geo_sites` deletes that follow. Verified by `IT-10`. Regrep on `lib/db/schema.ts` at tip `1cae951` for `references(() => teams.id)` / `references(() => geoSites.id)` confirmed only these two previously-missed children (cascade-marked refs are covered implicitly).
17. **AC-17 (firecrawl_jobs stub + deterministic time, HP-259 + HP-260):** `midPipelineAudit.crawlJobIds=["e2e-stub-job-1"]` resolves to a real `firecrawl_jobs` row with `id="e2e-stub-job-1"`, `site_id=SITE_IDS.midPipelineAudit`, `status="scraping"`, `urls_submitted=["https://mid-pipeline.e2e.flowblinq.test/"]`, `urls_completed=[]`, `created_at=SEED_EPOCH - 2m`, `updated_at=SEED_EPOCH - 1m`. Every timestamp is `SEED_EPOCH + fixed-offset`; no `NOW()`, no `new Date()`, no drizzle `$defaultFn` fallback. Verified by `UT-10` (stub shape) and `IT-11` (FK resolves + timestamp determinism).
18. **AC-18 (OTP routing discipline, Phase 0 Track A):** every spec that consumes an OTP MUST call `getOtp(flow, email, opts?)` from `e2e/helpers/otp.ts` with `flow ∈ {"login", "verify"}`, OR import the underlying helper directly (`getOtpForEmail` from `e2e/helpers/mailpit.ts` for login flow; `getLatestOtp` from `e2e/fixtures/otp-helper.ts` for verify flow). A spec calling `getOtpForEmail` (Mailpit) for a flow that went through `lib/email.ts` → Resend → Gmail — or vice-versa — is a crossed wire and must be fixed. Routing map: `/auth/login` page, `/api/auth/otp/send`, and any call to `supabase.auth.signInWithOtp` → `flow="login"`. Anything through `lib/email.ts:sendVerificationEmail` (`app/api/sites/route.ts:254` and peers) → `flow="verify"`. Verified by `UT-15` (facade dispatch correctness) and `IT-13` (both flows return a real OTP end-to-end).
19. **AC-19 (bounded OTP timeout):** facade default `timeoutMs = 20_000`; specs MAY lower but MUST NOT raise the bound. Both underlying helpers throw a named error on timeout — Mailpit helper throws `Error("No OTP email received for … within … ms")`, IMAP helper throws `OtpTimeoutError`. Neither hangs, neither returns `undefined`, neither silently retries forever. Verified by `UT-16` (timeout error classes + messages).
20. **AC-20 (no-crossed-wires regression guard):** a spec that invokes `getOtp("login", email)` for a flow whose email was actually Resend-delivered (or vice-versa) times out and throws the named error — NOT hangs to the Playwright per-spec timeout. This is asserted by `IT-13b` (deliberate miswire → expect timeout error within `timeoutMs + 2s` window, not the Playwright default 30 s).
21. **AC-21 (selector-hardening pattern discipline, Phase 0 Track B):** every `/auth/login` spec follows the 6 canonical patterns in §b.15.2 — (1) email input via `getByPlaceholder(/you@yourcompany\.com/i)`, (2) OTP input via `getByPlaceholder(/6-digit code/i)`, (3) `getByRole("button", …)` with a preceding `await expect(btn).toBeEnabled()` gate, (4) error assertions against `page.locator('[role="alert"]').toContainText(...)`, (5) FI-056 deep-link invalid-token via `toHaveTitle(/404/)` + `h1.next-error-h1`. Pattern (6) — adding `data-testid` — is a non-gating secondary finding. Specs MUST NOT use `getByLabel(/email/i)` or `getByLabel(/otp\|verify.../i)` on `/auth/login` because no `<label>` / `aria-label` exists. Grep test enforces: zero `getByLabel(/email/i)` hits under `e2e/tests/01-auth/`. Verified by `UT-17`.
22. **AC-22 (FI-001 native HTML5 email-validation — HP-263 rewrite, supersedes prior disabled-button claim):** the `/auth/login` email-validation gate is **native HTML5 `<input type="email" required>`** — NOT a disabled-button state, NOT an inline error text, NOT a toast. Verified against `app/auth/login/page.tsx:199` (`type="email"`, `required` at line 204) and `app/auth/login/page.tsx:222` (`disabled={loading || !email.trim()}` — the button disables ONLY on empty input or loading state, it does NOT disable on invalid email format). The authoritative gate is the browser's native constraint validation API: on submit with an invalid email, the browser blocks form submission and surfaces its own validation bubble (no API call reaches the server; the `role="alert"` container stays empty because there is no *application-level* error to report). FI-001 invalid-email assertion pattern is **`await expect(emailInput).toHaveJSProperty('validity.valid', false)`** (primary) with two alternatives documented in §b.15.4. Specs MUST NOT assert `toBeDisabled()` for invalid-email format (the button stays enabled on `"not-an-email"` because the input is non-empty), and MUST NOT assert on `role="alert"` text for format validation. **Supersedes the prior-version AC-22** that claimed disabled-button-as-validation-signal — that earlier claim was factually wrong per re-grep of the product JSX. Native HTML5 `type="email"` `required` is the deliberate design choice (browser-consistent, free i18n, accessible). Verified by FI-001 spec assertion once rewritten per §b.15.4.
23. **AC-23 (FI-004 returning-user-skips-consent as data-flow assertion, Phase 0 Track B):** FI-004 asserts that a returning user with a seeded `consent_records` row (AC-4) completes OTP login AND reaches `/dashboard` WITHOUT visiting `/consent`. Assertion is route-transition-based per §b.15.5: track `page.on("framenavigated", …)`, call `page.getByRole("button", { name: /verify/i }).click()`, assert `page.url()` reaches `/dashboard` AND that no visited URL matched `/\/consent(\b|$|\/)/`. The spec does NO DOM inspection of `/consent`. A new-user variant FI-004b is flagged as a FOLLOW-UP TS (out of scope for this ES). Verified by `IT-14`. **Depends on AC-24** (without a seeded `auth.users` row at `TEST_USER_ID`, the `/api/consent` lookup misses and the spec breaks regardless of selectors).
24. **AC-24 (seed provisions a Supabase `auth.users` row, Fix 4 — depends on §b.1 design note):** the seed script MUST provision a Supabase `auth.users` row at `TEST_USER_ID` **before the postgres transaction's `BEGIN`** in `scripts/e2e/seed.ts` (after env-load, after the AC-7 safety-gate, BEFORE the pg-tx DELETE+INSERT block — aligned with bullet 7 below; line-ref context for the pg-tx block at branch tip `97703b4`: DELETE block lines 496–514, INSERT block lines 518–528). Mechanics:
    - **Pre-delete (idempotency):** `await supabase.auth.admin.listUsers()` → find any user with `email === TEST_USER_EMAIL` → `await supabase.auth.admin.deleteUser(existing.id)`. Required because Supabase `auth.users.email` is unique per project; a stale row from a prior crashed run blocks the create with the deterministic id.
    - **Create with deterministic id:** `await supabase.auth.admin.createUser({ id: TEST_USER_ID, email: TEST_USER_EMAIL, email_confirm: true })`. The `id` parameter pins the UUID so subsequent `signInWithOtp({ email: TEST_USER_EMAIL })` → `verifyOtp` resolves to the same deterministic `auth.users.id` that every seeded `public.*` row references.
    - **`email_confirm: true`** skips the confirmation-email step — the user starts in a "confirmed" state so OTP verification is the only remaining gate.
    - **Service-role client:** the admin API requires `SUPABASE_SERVICE_ROLE_KEY` (NOT the anon key). Read **directly from `process.env`** — the live-env pattern, NOT the `~/.mailenv` file-based loader. `playwright.config.ts:5–15` defines `LOCAL_SUPABASE_ENV` (with local-demo `NEXT_PUBLIC_SUPABASE_URL="http://127.0.0.1:54321"`, local-demo `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and local-demo `SUPABASE_SERVICE_ROLE_KEY` — the well-known Supabase-local demo JWTs) and pre-populates `process.env` via `Object.assign(process.env, LOCAL_SUPABASE_ENV)` BEFORE `globalSetup` fires. Seed simply reads `process.env.SUPABASE_SERVICE_ROLE_KEY`; fail-fast-if-missing (empty string, undefined, or whitespace-only → seed exits non-zero before any admin call). **Contrast with `GMAIL_APP_PASSWORD` (which keeps the `~/.mailenv` loader, unchanged):** `MAIL_APP_PASSWORD` is a cross-service credential (Gmail IMAP, not project-scoped) — the file-based loader is authoritative because it's the operator's personal secret. `SUPABASE_SERVICE_ROLE_KEY` is **project-scoped**: it MUST match the Supabase instance that `NEXT_PUBLIC_SUPABASE_URL` points to. Using `~/.mailenv` here would risk stamping a PROD key over a LOCAL URL (or vice-versa) — a classic "right secret, wrong instance" bug. `process.env` is the only source that stays consistent across the (URL, key) pair, because playwright.config.ts sets both together in the same object-literal. **Safety coupling:** AC-7(c) (Supabase-URL local gate) fires BEFORE seed reads the key, so a rogue-shell invocation with PROD env never reaches the admin call. **Direct-shell invocation path:** running `npm run db:seed:e2e` outside playwright skips the `Object.assign` pre-populate; operators MUST then source local values into `process.env` themselves (e.g. `export $(cat .env.local.supabase | xargs) && npm run db:seed:e2e`). AC-7(c) catches the miss if they forget.
    - **Fail-fast:** if `process.env.SUPABASE_SERVICE_ROLE_KEY` is empty/missing AFTER env-load, seed throws with a clear error and exits non-zero BEFORE the DELETE block runs. Aligned with the §b.10 / AC-7 safety-gate pattern (also fail-fast).
    - **Never log the key.** Console output reports presence-only (e.g. `[seed] SUPABASE_SERVICE_ROLE_KEY: present`), mirroring the `GMAIL_APP_PASSWORD` pattern at `e2e/global-setup.ts:54–57`.
    - **Ordering relative to DB transaction:** the auth.users provision happens OUTSIDE the postgres transaction (Supabase admin API is a separate HTTP call, not a SQL statement). Sequence: env-load → safety-gate (AC-7) → `auth.users` delete-then-create (AC-24) → BEGIN; DELETE…INSERT; COMMIT (§b.7).
    - **Failure semantics:** if the auth.users provision fails, seed exits non-zero before opening any postgres transaction; no public-table state changes. If the postgres transaction later fails (rollback), the auth.users row is left in place — an orphan but harmless because the next seed run's pre-delete step purges it.

    Verified by `UT-18` (mock the Supabase admin client; assert listUsers→deleteUser→createUser sequence with the right args; assert key-presence check fires before any call) and `IT-15` (real local Supabase: assert `SELECT id FROM auth.users WHERE email = $TEST_USER_EMAIL` returns exactly `TEST_USER_ID` post-seed, and that `id` survives a `signInWithOtp` + `verifyOtp` round-trip).
25. **AC-25 (zero `test.fixme()` hard gate, Phase A — applies universally):** at the HolePoker ratify gate AND at PR-submit time, `grep -rn 'test\.fixme(' e2e/` returns ZERO matches. HolePoker FAILS ratify if any `test.fixme()` remains. The ONLY acceptable skip mechanism is the AC-27 product-gap surface protocol (class-tagged `test.skip("… — product-gap-<class> TS-NNN", …)` with adjacent comment). Verified by `UT-19` (grep guard) and a CI lint step. Rationale per §b.16.4: silent `fixme` defeats the whole "specs surface reality" premise of the dry-run + heavy-wave gate sequence.
26. **AC-26 (Supabase-service-role DB assertion contract, Phase A — applies universally):** every spec MUST end with at least one DB assertion via `e2e/helpers/supabase-assert.ts`. **UI-only assertions are NOT acceptable** for any spec — even read-only specs MUST call `assertNoMutation([...tables])` to prove their no-mutation guarantee at the DB level. Helper exports per §b.16.3: `assertRowExists`, `assertRowCount` (or `assertRowCountDelta`), `assertColumnDelta`, `assertNoMutation`, `assertAuthSessionExists`, `assertRefreshTokenValid`. Service-role connection sourced from `process.env.SUPABASE_SERVICE_ROLE_KEY` per the AC-24 pattern (NOT `~/.mailenv`); fail-fast at module load if absent. Local-only — same `DATABASE_URL` as seed/teardown, gated by AC-7(b) + AC-7(c). Connection failure throws (no silent pass). Verified by `UT-19` (mock-postgres backend exercises every export + the fail-fast key-presence check) and by Phase A ITs IT-16..IT-20 (DRY-01..05 each end with a Supabase assert per §b.16.2).
27. **AC-27 (product-gap surface protocol — class tags, Phase A — applies universally):** when a spec's underlying product flow is NOT yet implemented, the author surfaces the gap in ONE of three ways — `test.fixme()` is BANNED (AC-25 enforces): (a) **fix the product** in the same PR; spec asserts the fixed behaviour; (b) **fail the spec** with a `// FIXME-GAP: TS-NNN` adjacent comment and an explicit assertion that fails today and goes green when TS-NNN lands; (c) **class-tag the spec** as `test.skip("<spec name> — product-gap-<class> TS-NNN", …)` with a same-line or adjacent comment naming the class. Class-tag values defined in §b.16.4 (extensible): `product-gap-stripe-deferred`, `product-gap-ui-missing`, `product-gap-api-not-built`, `product-gap-design-pending`. Class-tagged specs are visibly tracked in CI by class, traceable to a TS, and removable when the product catches up. They do NOT count against AC-25 because they are NOT `fixme()`-tagged. Stripe-adjacent heavy-wave specs (DRY-06 territory, dropped per Aditya D2) use class `product-gap-stripe-deferred` until Phase B revisit. Verified by `UT-19` grep enforcement (every `test.skip(` outside `dry-run/` has either a `FIXME-GAP: TS-` adjacent comment OR a `product-gap-<class> TS-` substring in the test name). **Launch-scoped relaxation REMOVED (Aditya urgent correction 2026-04-21, corr `04732191`); content-tolerance scope clarified (Aditya pivot corr `0ab24f1a`):** the prior "launch-scoped relaxation" pattern for DRY-02 and DRY-05 (assert audit *initiated* rather than `pipeline_status='complete'`) is RETRACTED. Post-pivot — driven by AC-30 (live external services, no mock servers) + AC-31 (exact per-tier credit delta) + AC-33 (two-phase post-complete-only) + **AC-34 (content tolerance for non-deterministic vendor responses)** — DRY-02 and DRY-05 use **full-completion + exact-credit assertions**: `assertRowExists("geo_sites", { id: <siteId>, pipeline_status: "complete" })` AND `assertRowExists("geo_site_view", { site_id: <siteId> })` AND **EXACT** `assertColumnDelta("teams", …, "credit_balance", -<exact cost per AC-31 §b.16.8>)` — **no tolerance band, no range check on credit deltas**. **Crawl content + LLM verbatim** are NON-deterministic under live vendors and are governed by AC-34 — specs MUST NOT assert on specific URLs returned by Firecrawl, scrape text content, or LLM output verbatim. RM re-authors DRY-02/05 after SD strips mock-server scaffolding + lands the AC-30 live-services env config + HolePoker ratifies. No other spec used launch-scoped relaxation, so this tightening is DRY-02/05-scoped only. Class tag `product-gap-stripe-deferred` (and the other three classes) remain valid for Stripe-adjacent Phase B specs — unchanged.
28. **AC-28 (one-shot 200-credit grant for dry-run, Phase A — extends AC-3/AC-4):** dry-run setup runs a one-shot credit grant via service-role BEFORE DRY-01..05 execute. Mechanics:
    - **Script:** `scripts/e2e/grant-credits.ts` — invoked from `db:seed:e2e` after the existing seed completes, OR as a separate `npm run db:grant-credits:e2e` step (ScriptDev's call; either timing is acceptable as long as the grant is observable before the dry-run suite starts).
    - **DB ops (single transaction):** `SELECT credit_balance FROM teams WHERE id = TEST_TEAM_ID FOR UPDATE` → compute `balanceBefore`; `UPDATE teams SET credit_balance = credit_balance + 200 WHERE id = TEST_TEAM_ID` → compute `balanceAfter = balanceBefore + 200`; `INSERT INTO credit_transactions (id, team_id, site_id, type, pages_consumed, credits_changed, balance_before, balance_after, created_at) VALUES ('e2e-tx-grant-200', TEST_TEAM_ID, NULL, 'topup', 0, 200, balanceBefore, balanceAfter, SEED_EPOCH)`. The `id` literal `'e2e-tx-grant-200'` is the deterministic PK so AC-9 rotation-safe DELETE pattern (§b.12.0) covers it without modification.
    - **Service-role required:** uses `SUPABASE_SERVICE_ROLE_KEY` per AC-24 + AC-26 pattern. Fail-fast if absent.
    - **Idempotency:** grant runs ONCE per seed cycle. Re-running seed re-runs the grant. The §b.12.0 DELETE pattern (`WHERE team_id = TEST_TEAM_ID OR id = 'e2e-tx-grant-200'`) purges the prior grant on teardown so the next cycle starts clean. Steady-state balance after grant = baseline §b.4 balance (10) + grant (200) = 210 credits.
    - **Aditya observability:** spec setup prints `[grant-credits] team=${TEST_TEAM_ID} pre=${balanceBefore} post=${balanceAfter} delta=+200` to console. NEVER logs the service-role key. Aligns with the GMAIL_APP_PASSWORD presence-only logging convention (`e2e/global-setup.ts:54-57`).
    - **AC-3/AC-4 extension:** the §b.4 baseline (10 credits + 3 tx rows) remains unchanged; AC-28's grant is ON TOP of that baseline. AC-3 invariant `teams.credit_balance === SUM(credit_transactions.credits_changed)` remains true (10 + 200 = 210 = sum after grant).
    - Verified by `UT-20` (mock-postgres: assert SELECT-FOR-UPDATE → UPDATE → INSERT sequence with the right balanceBefore/balanceAfter chain; key-presence fail-fast; no-key-leak in console) and `IT-24` (real local Supabase: post-seed+grant assert teams.credit_balance=210, credit_transactions row count=4 with the new tx_grant entry).
29. **AC-29 (OPT-B storageState — one OTP login per test project, Aditya ratify 2026-04-21):** each Playwright test project performs EXACTLY ONE OTP login at `globalSetup` (run AFTER the DB seed per AC-28 / §b.11), saves the resulting session state to `e2e/.playwright-storage-state.json` (gitignored), and configures `use.storageState` to reuse that file by default for every spec. New helper file `e2e/helpers/global-setup-auth.ts` (CREATE — ScriptDev) performs the login using the §b.14 `getOtp("login", TEST_USER_EMAIL)` facade, drives the Supabase `verifyOtp` round-trip, and writes the state file. Per-project opt-out: specs that intentionally test login/logout flow (DRY-01, and any FI-001..FI-003 session spec) override `use.storageState = undefined` at the project or file level so they exercise the real login path. **Rationale:** Supabase enforces `signInWithOtp` rate-limit of **1 request per 60 seconds per email**; a Phase A/B batch of ≥5 specs that each login individually would space-out at > 5 min just on rate-limited waits. Reusing a single session cuts to one login per full suite, enabling ≥5 specs back-to-back with no limiter pause. Verified by `UT-21` (mock `globalSetup`: assert login runs exactly once, storage-state file written to the configured path, file is non-empty JSON with `cookies` + `origins` keys) and `IT-25` (real local Supabase end-to-end: run globalSetup, assert state file exists, run 3+ specs sequentially that all land authenticated without re-triggering OTP). Opt-out coverage: specs in `e2e/tests/01-auth/` that must exercise login/logout explicitly set `use.storageState = undefined` — grep-enforced that no `01-auth/` spec silently inherits the shared session.
30. **AC-30 (live external services — env-vars unset, fall through to vendor defaults; Aditya pivot 2026-04-21 corr `0ab24f1a`. SUPERSEDES BOTH the original "crawl-mock-as-product-code" draft AND the intermediate "env-configurable URLs + mock servers" draft — both RETIRED. Aditya Rule 2 still in force: ZERO product-code changes for tests):** the E2E suite hits **live external service vendors** (Firecrawl, OpenAI, Anthropic, Perplexity, QStash). Provider URL env-vars (`FIRECRAWL_BASE_URL`, `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `QSTASH_URL`, etc.) are **UNSET** in the E2E run config — each SDK falls through to its built-in default vendor hostname. Product code is therefore exercised end-to-end against the real provider chain, exactly as production does.

    **Rule 2 BANNED list (preserved):** any conditional of the form `if (process.env.NODE_ENV === "test") { … mock path … }` in product code. Any `lib/mocks/*` file that is imported by non-test product code. Any test-motivated branch in product code. HolePoker fails ratify on any such diff. (The retired mock-server architecture is gone; ScriptDev deletes any in-flight `e2e/mock-servers/` scaffolding in the parallel SD strip dispatch.)

    **QStash callback bridge — cloudflared tunnel:** QStash's `publishJSON` callback target must be reachable from QStash's Upstash backbone, which means a public URL. For E2E runs against a localhost Next dev server, a `cloudflared` tunnel bridges `localhost:3000` to a public hostname; `QSTASH_CALLBACK_BASE` env var (set in the E2E run env) points QStash at the tunnel URL. The tunnel URL is session-specific and is set by the operator at run time (per §b.16.7 — non-E2E pathway documented there is now also the E2E pathway since both hit live QStash). Tunnel lifecycle is operator-managed; if the tunnel dies mid-suite, the suite fails with a QStash callback timeout — surface, not silent.

    **Mailpit + Supabase remain LOCAL** — only external vendors are live. Supabase Auth + Postgres run at `127.0.0.1:54321/54322` (per AC-7 gate); Mailpit captures `/auth/login` Supabase OTP emails at `127.0.0.1:54324` per §b.14. These do NOT hit external vendors. The OTP routing facade (§b.14) is unaffected by this pivot — `getOtp("login", ...)` still hits Mailpit; `getOtp("verify", ...)` still hits Gmail IMAP (Resend → Gmail is the production path, also live).

    **Cost + latency consequences (full detail in §b.16.9):** real vendor calls take real time and cost real money. Per-spec wall-clock now ranges 30 s – 2 min (vs the retired sub-15 s mock target). USD cost per spec ranges $0.05–$0.30 typical; per 5-spec dry-run batch ~$0.30–$0.80; per 65-spec heavy wave ~$5–$15. See §b.16.9 cost-budget table for the full breakdown + halt criteria.

    **Determinism:** vendor responses are NON-deterministic (LLM completions vary; Firecrawl crawl results vary as upstream sites change). AC-34 (content-tolerance) governs which assertion classes are allowed — exact for DB rows + credit deltas + status transitions; tolerant for crawl content + LLM verbatim. AC-31 integer-literal credit-delta rule is UNAFFECTED — credit math is deterministic regardless of crawl content.

    **Rationale:** mock servers added engineering surface (server impl, payload curation, drift risk against real vendor protocols) for a determinism gain that AC-34 + AC-33 (post-complete-only assertions) can match without the mock infra. Live services exercise the actual production chain end-to-end, catching protocol drift / vendor breakage immediately. Cost is bounded per §b.16.9; latency is acceptable per Phase A 5-spec budget.

    Verified by `UT-22` (RETIRED — mock-server protocol contract no longer applicable; see UT-26 for the new content-tolerance guard) and `IT-26` (RETIRED — mock-server E2E flow no longer applicable; live-services equivalent is exercised by every Phase A/B audit spec naturally). Both RETIRED rows are marked in place in §e/§f for renumbering stability.
31. **AC-31 (per-tier EXACT credit delta — no ranges, Aditya Rule 1, urgent correction 2026-04-21 corr `04732191`):** every spec assertion on a credit delta MUST be an EXACT equality — `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", <exact integer per tier per action>)`. Range checks, tolerance bands, or `within [min,max]` patterns are BANNED. The source-of-truth per-tier cost table lives at §b.16.8 (populated from an SD code audit of `app/api/sites/**` + the pricing surfaces; stub at commit time, populated in a follow-up micro-amendment if audit is still in flight). For a given spec, the author seeds the test user to the tier whose exact delta that spec asserts. Worked examples (illustrative — real values per §b.16.8):
    - DRY-02 seeded at `free` tier, audits a 0-cost-per-audit domain → `assertColumnDelta(..., "credit_balance", 0)`.
    - DRY-02 seeded at `pro` tier, audits a 1-credit-per-audit domain → `assertColumnDelta(..., "credit_balance", -1)`.
    - DRY-05 seeded at `pro` tier, bulk 5 URLs at 1 credit per URL → `assertColumnDelta(..., "credit_balance", -5)`.

    Never `delta ∈ [-5, 0]` or `delta ≤ 0`. If a spec genuinely needs to cover multiple tiers, author SEPARATE specs — one per tier — each asserting exact. Verified by `UT-23` (grep guard: scan every `assertColumnDelta(` call site under `e2e/tests/` and assert the 4th arg is an integer literal, not a range-expression or tolerance-band; negative case throws with the offending `file:line`) and `IT-27` (DRY-02 and DRY-05 re-authored post-OPT-B assert exact per-tier deltas; two DRY-02 variants — one free-tier one pro-tier — both pass with the exact numbers from §b.16.8).
32. **AC-32 (seed simulates free-tier-exhausted state via `monthly_page_allowance = 0`, Aditya corr `d8a5afd6`, additive to AC-3/AC-4):** the seed's `teams` row for `TEST_TEAM_ID` MUST set `monthly_page_allowance = 0` (overriding the default `FREE_MAX_PAGES = 20`). This places the test user in the "Free + exhausted" row of §b.16.8 by default, so credit-debiting specs (DRY-02 single-URL audit, DRY-05 bulk CSV) produce EXACT non-zero deltas matching AC-31's integer-literal rule. Specifically, DRY-02 asserts `-1` (1 credit per single URL in the exhausted state) and DRY-05 asserts `-1` (`ceil(5/10)=1` for 5 URLs). Citation and competitor actions (DRY-03, DRY-04) are tier-flat and their deltas (`-5`, `0`) do NOT depend on this setting, but they still benefit from a deterministic baseline. **Alternative coverage via a pro-tier seeded user is DEFERRED to Phase B** — if Phase B needs pro-tier coverage, CoFounder dispatches a separate TS for the tier-switching helper (either a `scripts/e2e/set-tier.ts` helper or an extension parameter on `scripts/e2e/seed.ts`). This ES does NOT introduce the pro-tier seed path. **Why allowance=0 over a different knob:** `monthly_page_allowance` is the gate the product reads in its tier-branch to decide whether to absorb or debit (`app/api/sites/route.ts`); setting it to 0 is the one-column change that flips the entire tier branch deterministically. Bumping `monthly_pages_used` to `20` would have the same effect but creates a surprising "already-used-full-month" shape that masks the underlying cause. Verified by `UT-24` (mock-DB: assert seed row has `monthly_page_allowance = 0` post-seed; assert teams baseline `credit_balance = 10` unchanged) and `IT-28` (real local Supabase: post-seed `SELECT monthly_page_allowance FROM teams WHERE id = $TEST_TEAM_ID` returns `0`; run DRY-02 against the seeded state; assert `credit_balance` decremented by exactly 1).
33. **AC-33 (two-phase reserve-then-refund credit semantics — assert post-complete only, RC1 ratify 2026-04-21 corr `853b80e0`; PAGES_PER_CREDIT corrected to 10 per HP-271; "reserve-then-debit" clarified to "reserve-then-refund" per DRY-02 milestone finding corr `4af52a3d`):** crawl-debiting actions (single-URL audit, bulk audit) write `credit_transactions` in TWO phases: (i) **reserve row at launch** — `credits_changed = -ceil(page_estimate / PAGES_PER_CREDIT)`; (ii) **refund row at `pipeline_status = "complete"`** — `credits_changed = +(reserve_amount - ceil(actual_pages / PAGES_PER_CREDIT))`, reconciling the over-estimate. Net `credit_balance` change = `-ceil(actual_pages / PAGES_PER_CREDIT)`. `PAGES_PER_CREDIT = 10` per `lib/config.ts:12`. Citation-check, competitor-discovery, and manual-competitor-add are single-phase (no reserve). **Spec assertion contract:**

    **Row-type taxonomy (verified against branch tip at edit time — each emit site's line number AND conditional independently checked):**

    - **`"crawl_reserve"` — emit sites:**
      - `app/api/sites/route.ts:170` — **bulk aggregate** inside `if (skipOtp)` block; unconditional within that block when `creditsToDeduct > 0` (where `creditsToDeduct = min(bulkCreditsRequired(totalUrls), team.creditBalance)`). For DRY-05 (5 URLs) → `creditsToDeduct = 1` → 1 row emitted with `credits_changed = -1`, `site_id = primarySiteId`.
      - `app/api/sites/route.ts:551` — **single-URL** path, guarded by `if (creditsToReserve > 0)` at line 542. Emits 1 row when the single-URL audit crosses the free-tier allowance into overflow. For DRY-02 with AC-32 seed (`monthly_page_allowance = 0`) + AC-28 200-credit grant: `creditsToReserve = maxPages = 2` → 1 row with `credits_changed = -2`.

    - **`"crawl_refund"` — emit sites (both CONDITIONAL; specs MUST NOT assert existence for minimal fixtures):**
      - `app/api/pipeline/stage/route.ts:133` — **SINGLE-site failure path**; guarded by `if (reserved > 0 && site?.teamId)` at line 122. Emits only when a single-URL pipeline FAILED and reserved credits are being returned. NOT hit by DRY-02 (success path) or any DRY-05 bulk flow.
      - `app/api/pipeline/stage/route.ts:1114` — **SINGLE-site complete-reconciliation**; guarded by `if (site.auditMode !== "bulk" && site.creditsReserved && site.teamId && crawlData)` at line 1095 AND `if (actualCredits < reservedCredits)` at line 1100. Bulk flows skip this entirely via the `auditMode !== "bulk"` guard. DRY-02 hits it: reserved=2, actual=`bulkCreditsRequired(actual_pages)`=1 → refund = 1 row with `credits_changed = +1`.

    - **`"bulk_crawl_refund"` — emit site (CONDITIONAL; specs MUST NOT assert existence for minimal fixtures):**
      - `app/api/pipeline/stage/route.ts:1076` — **BULK per-site complete-reconciliation**; guarded by `if (actualCredits < reservedCredits && site.teamId)` at line 1062. Emits 1 row PER SITE where `actualCredits < reservedCredits`. For DRY-05 minimal-page fixture: 4 non-primary sites have `creditsReserved = 0` → guard never fires (nothing is less than 0); the primary site has `reservedCredits = 1` and `actualCredits = bulkCreditsRequired(actual_pages) = 1` (small upstream pages) → equality skips the refund. **Net: 0 refund rows emitted for the minimal fixture.**

    - **`"crawl_debit"` type** is RESERVED for admin / manual-adjustment / Stripe-dispute reconciliation paths — NO audit-flow emit site. Specs asserting on `type: "crawl_debit"` for any audit-launch path will fail (the product correctly doesn't write this row). This supersedes earlier versions of AC-33 that said "reserve-then-debit" — the product pattern is reserve-then-refund (and the refund is conditional on over-reservation).

    - **Deprecated `/verify` page flow — `"bulk_crawl_reserve"` at `app/api/sites/[id]/verify/route.ts:595` + `app/api/sites/[id]/retry-failed/route.ts:153`, `"single_crawl_reserve"` at `verify/route.ts:678`** — all part of the `/verify/[id]` page flow flagged DEPRECATED per Aditya 2026-04-21 directive. Live audits do NOT exercise these paths. Specs MUST NOT assert on any `bulk_*_reserve` / `single_*_reserve` types.

    - **Spec-assertion implication:** (a) crawl_reserve existence is RELIABLE (unconditional within its launch block when `creditsToDeduct/creditsToReserve > 0`) — safe to `assertRowExists`. (b) crawl_refund and bulk_crawl_refund are CONDITIONAL on over-reservation; minimal-page fixtures frequently produce zero refund rows. Specs MUST rely on the NET `credit_balance` delta (AC-31 integer-literal rule via `assertColumnDelta`) to capture the invariant, NOT on refund-row existence. Where a spec deliberately exercises an over-reservation scenario (e.g. a hypothetical DRY-05 variant with a 20-URL-estimate / 5-URL-actual fixture), refund-row existence can be asserted — otherwise it's brittle.

    - **Schema.ts:66 comment is STALE:** `type: text("type").notNull(), // "crawl_debit" | "topup" | "signup_bonus" | "refund"` — doesn't enumerate the actual types the product writes. Not blocking; ScriptDev or a cleanup TS can refresh the comment post-Phase-A.
    - Specs asserting on credit deltas MUST wait for `pipeline_status = "complete"` BEFORE asserting. **No mid-flight assertions** — checking `credit_balance` between discovery and complete will see the reserve-only state and produce a transient value that is NOT the contract-pinned cost in §b.16.8.
    - Post-complete, the spec MUST verify all of: (a) the `crawl_reserve` row exists with the expected `credits_changed`; (b) the `crawl_debit` row exists with the expected `credits_changed`; (c) the NET `credit_balance` delta from action-start-baseline to post-complete matches the §b.16.8 cost integer EXACTLY (per AC-31).
    - The reserve and debit rows reconcile such that the net `credit_balance` change equals the §b.16.8 cost — the reserve is effectively superseded by the debit (whether the product writes an explicit refund row, an adjusted-debit `credits_changed`, or the debit row's value supersedes the reserve in balance-application is an SD impl detail; the ES contract is the post-complete net delta + presence of both rows).
    - Citation/competitor (single-phase) actions assert post-action: one debit-style row + net delta matching §b.16.8.
    - **Worked example (DRY-02 with mock Firecrawl returning 5 URLs):** `page_estimate = 5` → `crawl_reserve.credits_changed = -1` at discovery; `actual_pages = 5` → `crawl_debit.credits_changed = -1` at complete; net `credit_balance` delta from baseline to post-complete = `-1`. Spec asserts the `-1` net via `assertColumnDelta` AFTER observing `pipeline_status = "complete"`.
    - **Worked example with reconciliation (DRY-02 with `page_estimate = 20`, `actual_pages = 10`):** reserve `-ceil(20/10) = -2` at discovery; debit reconciles such that net = `-ceil(10/10) = -1` post-complete (the over-estimated reserve refunds 1 credit at complete). Spec asserts `-1` net post-complete; the impl mechanism (refund row vs adjusted debit) is SD's call.
    - Rule 1 exact-delta (AC-31) is preserved — the value asserted is still an integer literal, just on the post-complete state.

    Verified by `UT-25` (mock-DB: invoke a simulated two-phase txn sequence — write reserve row, then write debit row, then read `credit_balance`; assert net delta matches §b.16.8 cost; assert mid-flight read between phases sees the reserve-only transient state, demonstrating why mid-flight assertions are banned) and `IT-29` (real local Supabase + LIVE Firecrawl per AC-30: drive DRY-02 end-to-end; wait for `pipeline_status = "complete"`; assert BOTH `crawl_reserve` AND `crawl_debit` rows exist for the new siteId; assert `credit_balance` net delta = `-1` exact via `assertColumnDelta`).
34. **AC-34 (content-tolerance contract for non-deterministic vendor responses, Aditya pivot 2026-04-21 corr `0ab24f1a`):** under AC-30 live external services, vendor responses (Firecrawl crawl URL lists, LLM completion text, citation/competitor JSON shapes) are NON-deterministic across runs. Specs MUST classify each assertion into ONE of two columns and use the matching pattern:

    | Assertion class | Allowed forms | Examples |
    |-----------------|---------------|----------|
    | **EXACT** (deterministic — applies to product-side state) | `assertRowExists`, `assertRowCount` (integer), `assertColumnDelta` (integer literal), `expect(page).toHaveURL(...)`, `expect(status).toBe(200)` | DB row existence; credit_balance integer delta; pipeline_status === "complete"; HTTP status; URL transition |
    | **TOLERANT** (non-deterministic — applies to vendor-content state) | `expect(...).toBeGreaterThan(0)`, `expect(arr.length).toBeGreaterThanOrEqual(1)`, `expect(text).toMatch(/regex/)`, `expect(...).toBeDefined()`, `expect(arr).toContain.objectMatching({type: "url"})` shape-only | "at least one URL crawled"; "any string returned in LLM response"; "citation array contains items with `provider` field"; "scrape text contains the brand name (case-insensitive)" |

    **BANNED patterns:**
    - `expect(true).toBe(true)` or any tautology — provides zero signal.
    - `Math.abs(value - expected) < tolerance` on any COUNTED value (row counts, credit deltas) — masks bugs. Tolerance is allowed ONLY on vendor-content (e.g. "expect at least 3 URLs returned" via `toBeGreaterThanOrEqual(3)`, not "expect 5 ± 2 via Math.abs").
    - `expect(text).toBe("specific verbatim LLM output")` — non-deterministic; will flake.
    - `expect(urls).toEqual(["https://example.com/about", "https://example.com/contact"])` — Firecrawl crawl results vary; assert SHAPE not CONTENTS.
    - `expect.any(Number)` on credit deltas — credit math is deterministic per AC-31; integer literals required.

    **Allowed tolerance examples:**
    - DRY-02 post-complete: `expect(crawledPageCount).toBeGreaterThanOrEqual(1)` — at least one URL was crawled, exact count varies.
    - DRY-03 post-complete: `expect(citationResponses.length).toBeGreaterThanOrEqual(1)` AND `expect(citationResponses[0]).toEqual(expect.objectContaining({ provider: expect.any(String), response: expect.any(String) }))` — shape-checked, content tolerated.
    - DRY-05 post-complete: `expect(firecrawlJobsRows.length).toBeGreaterThanOrEqual(1)` — at least one chunk job written, exact count depends on bulk fan-out.

    **Cross-cut with AC-31:** integer-literal credit deltas REMAIN exact (Rule 1). Credit math is product-side state, not vendor-content state — `assertColumnDelta("teams", …, "credit_balance", -1)` MUST be the integer literal `-1`, never a tolerance band. AC-34 only relaxes assertions on vendor-content state.

    Verified by `UT-26` (grep guard: scan every assertion call site under `e2e/tests/`; flag (a) any `expect(true)` tautology; (b) any `Math.abs(` applied to a numeric assertion; (c) any `expect(...).toBe("...")` against a string variable that traces to a vendor response; (d) any tolerance band on `assertColumnDelta` 4th arg — overlaps with UT-23 which is intentionally redundant for defence-in-depth). Negative cases throw with offending `file:line`. Phase A IT coverage is implicit — every DRY spec naturally exercises both classes.
35. **AC-35 (fix-before-retry operational policy — 5xx HALT rule, Aditya corr `318f04c9`):** when a spec, batch run, or manual dev session hits a 5xx HTTP response, an unhandled exception, or any unexpected failure mode, the responsible operator/agent MUST stop, diagnose, and apply a targeted fix before any retry. Blind retry-loops on 5xx-class failures are PROHIBITED — they hide product bugs and waste vendor budget. Five-clause contract:
    - **(a) HALT-then-fix on 5xx / exception / unexpected failure:** any spec or session that hits a 5xx, an unhandled exception, or an unexpected failure mode MUST halt the retry sequence, capture the error context (stderr log lines, stack trace, last successful state, last 3 successful events before failure), surface to CoFounder/Shastri for diagnosis, apply a targeted fix, then resume from a known-good state. No automatic retry on this class.
    - **(b) Acceptable retry classes (BOUNDED, max 3 attempts, each attempt explicitly logged):** transient network errors (HTTP 408 Request Timeout, 5xx ONLY when the response carries an explicit `Retry-After` header), HTTP 429 rate-limit responses, vendor-SDK errors with documented retry semantics (e.g. OpenAI 429 backoff, Anthropic 529 overload). Any retry harness MUST classify the error class BEFORE deciding to retry; an untyped retry on any 5xx is a violation.
    - **(c) Specs MUST NOT mark 5xx failures as "flaky":** when a spec fails with a 5xx, the failure surfaces with full context (HTTP status, response body, server-side log excerpt, last 3 successful events). Marking the spec `test.fixme()` or `test.skip(... "flaky")` is BANNED — that pattern hides product bugs. The AC-25 zero-`fixme` gate enforces this; AC-27 product-gap class tags are the legitimate alternative if the gap is real.
    - **(d) Batch-run 5xx → ABORT batch:** when a Phase A or Phase B batch run hits a 5xx in any spec, ABORT the entire remaining batch, surface the error per (a), apply the fix, and re-run the batch from a known-good seed state (`db:teardown:e2e && db:seed:e2e` per AC-9 + AC-28 + AC-32). Do NOT partial-retry — partial state from an aborted batch can mask the diagnosis.
    - **(e) Scope:** this policy applies to ScriptDev (implementation-time debugging — fix the bug, don't loop the retry), ReviewMaster (spec-run surveillance — flag 5xx and halt, don't auto-rerun), and CoFounder (orchestration cadence — pause and dispatch a diagnosis dispatch on 5xx, don't fire-and-forget another batch).

    **Cross-cut with AC-25 / AC-27:** a 5xx that traces to a known product gap MAY be class-tagged per AC-27 (e.g. `product-gap-api-not-built TS-NNN`); the spec then `test.skip` per AC-27 path (c). A 5xx with no diagnosed cause is NOT a product gap — it requires the AC-35 (a) HALT + diagnose loop, not a class-tag escape hatch.

    Verified by `UT-28` (grep guard: scan every spec file under `e2e/tests/` and any retry-harness module under `e2e/helpers/`; flag any retry loop construct — `for (let i=0; i<N; i++) { … attempt … }`, `while (failed && attempts < N) { … }`, `pRetry(...)` with no error-class predicate, `axios-retry` with default config — that does not gate on an error-class predicate per (b); flag any `test.skip(... /flaky/i)` or `test.fixme(... /5xx/i)` patterns. Negative cases throw with offending `file:line`.) and `IT-30` (real local Supabase + a stubbed test endpoint that returns HTTP 500 on a controlled fixture path: drive a spec that hits the stub; assert spec FAILS within a single attempt — does NOT retry — and surfaces the 5xx with HTTP status + response body in the failure message; assert no `Retry-After` header was honoured because the stub doesn't send one).

---

## e) Unit Test Plan

**Location:** `scripts/e2e/__tests__/seed.test.ts`, `scripts/e2e/__tests__/teardown.test.ts`, `scripts/e2e/__tests__/safety.test.ts`.
**Runner:** `vitest` (already configured), `--env node`.

| # | Target | Assertion |
|---|--------|-----------|
| UT-1a | `assertLocalDb` — NODE_ENV guard (HP-253) | with `NODE_ENV="production"` and local DATABASE_URL: throws + exits 2 with "NODE_ENV=production" message; NO URL regex reached (spy asserts it's never called). **AC-7(a).** |
| UT-1b | `assertLocalDb` — URL regex | NODE_ENV unset/`development`/`test`: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` passes; `postgresql://x@prod.supabase.co:5432/postgres` throws + exits 2; `postgresql://postgres:postgres@localhost:54322/postgres` passes; missing URL → throws; URL with port 5432 (prod-like) → throws. **AC-7(b).** |
| UT-1c | `assertLocalSupabaseUrl` — NEXT_PUBLIC_SUPABASE_URL regex (Fix 4 env-switch + AC-7(c)) | with NODE_ENV + DATABASE_URL both passing prior gates, exercise `NEXT_PUBLIC_SUPABASE_URL`: `http://127.0.0.1:54321` passes; `http://localhost:54321` passes; `http://127.0.0.1:54321/` (trailing slash) passes; `https://mkwjqntnlmogwjqxezqw.supabase.co` throws + exits 2; `https://<project>.supabase.co:443` throws; empty/undefined throws; wrong-port `http://127.0.0.1:54322` throws (that's DB, not Supabase API). Spy asserts no `supabase.auth.admin` client was constructed when any case throws. **AC-7(c).** |
| UT-2 | `buildSeedPlan()` (pure fn that returns the INSERT payloads without running SQL) | shape matches `ids.ts` constants; all 5 sites present; `teams.creditBalance===10`; `consent_records.length===1`; sum of `creditsChanged` rows equals 10. **AC-2, AC-3, AC-4.** |
| UT-3 | idempotency modelling | mock-DB: run `seed()` twice via the fake sql client; resulting in-memory row set is byte-identical (order-independent JSON diff). **AC-6.** |
| UT-4 | tag-enumeration | mock-DB seeded with 100 non-tagged rows + the fixture's tagged rows; `teardown()` deletes only the tagged rows (count check on both subsets). **AC-12.** |
| UT-5 | `token_expires_at` always set | iterate every `geo_sites` INSERT in the plan; assert `token_expires_at` is a Date in the future; assert it's set explicitly (not relying on drizzle default). **AC-5.** |
| UT-6 | DELETE order vs FK | DELETE sequence in §b.7 respects FK dependencies (e.g. `credit_transactions` before `geo_sites`, `team_domains` before `geo_sites` and `teams`). **AC-14 preliminary.** |
| UT-7 | FIXME marker present | read `seed.ts` as text; assert the `FIXME-DEFERRED: Stripe test-mode fixture` block appears; assert no `stripe_customer_id` / `stripe_subscription_id` / `stripe_checkout_session_id` string in the file. **AC-10.** |
| UT-8 | email constant shared | read both `e2e/fixtures/ids.ts` and `e2e/fixtures/otp-helper.ts`; assert `TEST_USER_EMAIL` byte-equals the `TO_FILTER` constant. **AC-1.** |
| UT-9 | rate_limits teardown — 10 real prefixes (HP-261) | mock-DB pre-populated with rate_limits rows keyed using the 10 real prefixes from §b.12 — at minimum: `otp_send:adityanittoor+geotests@gmail.com`, `otp_verify:adityanittoor+geotests@gmail.com`, `invite:${TEST_USER_ID}`, `sites_create:127.0.0.1`, `csp_report:::1`, `auth_proxy:127.0.0.1`, `audit-ip:127.0.0.1`, `oauth:e2e-client`, `chatbot:${SITE_IDS.paidFullAudit}`, `citation_check:${SITE_IDS.paidFullAudit}` — plus 3 unrelated rows (`otp_send:someone-else@example.com`, `sites_create:10.0.0.1`, `chatbot:random-site-id`). Run `teardown()`. Assert all 10 real-prefix rows are gone; the 3 unrelated rows remain. **AC-11.** |
| UT-10 | firecrawl_jobs stub shape (HP-259) | `buildSeedPlan()` returns exactly 1 firecrawl_jobs row; all NOT NULL columns set (id, site_id, firecrawl_job_id, chunk_index, url_count, status, urls_submitted); `id === "e2e-stub-job-1"` (matches `crawlJobIds[0]`); `status === "scraping"`. **AC-17.** |
| UT-11 | no NOW() / Date.now() anywhere in seed.ts (HP-260) | static text scan of `scripts/e2e/seed.ts` and `scripts/e2e/fixtures/per-page-samples.ts`: zero occurrences of `Date.now()`, `new Date()` (without a literal arg), `NOW()`, `CURRENT_TIMESTAMP`, `$defaultFn`. **AC-6, AC-17.** |
| UT-12 | SEED_EPOCH constant (HP-260) | `import { SEED_EPOCH } from "scripts/e2e/lib/constants"` equals exactly `new Date("2026-04-01T00:00:00.000Z")`; all derived offsets (`SEED_EPOCH_MINUS_10M`, `SEED_EPOCH_PLUS_90D`, etc. if exported) compute deterministically. **AC-6.** |
| UT-13 | FK-complete DELETE enumeration (HP-252) | `buildTeardownPlan()` returned statement list includes `DELETE FROM api_clients` and `DELETE FROM firecrawl_jobs`; both appear BEFORE the `teams` / `geo_sites` deletes in the ordered list. **AC-16.** |
| UT-14 | OTP-lockout reset via geoSites reseed (HP-261) | mock-DB with 5 seeded `geo_sites` fixture rows each pre-poisoned to `otp_attempts = 5, otp_locked_until = NOW() + 1h` (simulating a prior wrong-OTP loop). Run `teardown()` then `seed()`. For each siteId in `SITE_IDS`, assert `otp_attempts === 0` and `otp_locked_until === null`. No assertion against `rate_limits` — this UT is scoped to the geoSites column mechanism that actually holds OTP-lockout state per `lib/rate-limit.ts:79–100`. **AC-11b.** |
| UT-15 | OTP facade dispatch (Phase 0 Track A) | `import { getOtp } from "e2e/helpers/otp"` with mocks for `getOtpForEmail` and `getLatestOtp`. `getOtp("login", "x@y.z")` → only `getOtpForEmail` called (once, with `"x@y.z"` and default `timeoutMs=20_000`); `getLatestOtp` NOT called. `getOtp("verify", "x@y.z")` → only `getLatestOtp` called with `{ maxWaitMs: 20_000 }`; Mailpit path NOT touched. `getOtp("bogus" as any, …)` → throws with message containing `"unknown flow"` and `"Supabase→Mailpit"` and `"Resend→Gmail"`. **AC-18.** |
| UT-16 | OTP facade timeout ceiling (Phase 0 Track A) | `getOtp("login", …, { timeoutMs: 10_000 })` — Mailpit helper called with `10_000`, no coerce; `getOtp("verify", …, { timeoutMs: 5_000 })` — IMAP helper called with `{ maxWaitMs: 5_000 }`; `getOtp("login", …, { timeoutMs: 100_000 })` — facade still passes the value through (lint/review catches raising the bound; not runtime-enforced per §b.14.3). Timeout errors: Mailpit-mock throws `Error("No OTP email received …")` → facade rethrows unchanged; IMAP-mock throws `OtpTimeoutError` → facade rethrows unchanged (re-exported error class is the same constructor). **AC-19.** |
| UT-17 | Selector-hardening grep + regex correctness (Phase 0 Track B) | (a) `grep -rn 'getByLabel(/email/i)' e2e/tests/01-auth/` returns zero hits (AC-21 enforcement). (b) Regex-escape sanity: the literal strings `"you@yourcompany.com"` and `"6-digit code"` match the canonical patterns `/you@yourcompany\.com/i` (backslash-escaped dot) and `/6-digit code/i` respectively. (c) Counter-case: `"you@yourcompanyXcom"` does NOT match `/you@yourcompany\.com/i` (escaped dot is not a wildcard). (d) `"6-DIGIT CODE"` matches `/6-digit code/i` (flag `i`). **AC-21.** |
| UT-18 | auth.users provisioning sequence (Fix 4, AC-24) | Mock `supabase.auth.admin` with stub `listUsers`, `deleteUser`, `createUser`. Run seed's `provisionAuthUser()` step. Assert: (a) `process.env.SUPABASE_SERVICE_ROLE_KEY` presence-check fires FIRST and throws if missing (no admin call made); (b) with key present, `listUsers` is called once; (c) if a user with `email === TEST_USER_EMAIL` is returned, `deleteUser(existing.id)` is called once before create; (d) `createUser({ id: TEST_USER_ID, email: TEST_USER_EMAIL, email_confirm: true })` is called exactly once with those exact arg values; (e) the key value itself never appears in any console.log output (spy on console). **AC-24.** |
| UT-19 | Supabase-assert helper + grep guards (Phase A AC-25/26/27) | (a) Mock-postgres backend: `assertRowExists("geo_sites", { id: SITE_IDS.paidFullAudit })` passes when row matched; throws on miss. (b) `assertRowCount("citation_check_responses", { check_id: "x" }, { min: 1 })` passes for ≥1 returned; throws on 0. (c) `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", -5)` reads pre, applies mock UPDATE, reads post, asserts delta=-5; throws on mismatch. (d) `assertNoMutation(["geo_sites","credit_transactions"], { teamId: TEST_TEAM_ID })` snapshots row counts before-block, asserts unchanged after-block. (e) Module-load fail-fast: temporarily delete `process.env.SUPABASE_SERVICE_ROLE_KEY`, re-import → throws with "SUPABASE_SERVICE_ROLE_KEY missing" message. (f) Console spy: helper never logs the key value. (g) Grep guard 1 (AC-25): `grep -rn 'test\.fixme(' e2e/` returns 0 on a clean tree; positive case throws an explicit error naming the offending file:line. (h) Grep guard 2 (AC-27): `grep -rn 'test\.skip(' e2e/` — every match outside `dry-run/` has either an adjacent `// FIXME-GAP: TS-NNN` comment OR a `product-gap-<class> TS-NNN` substring in the test name; positive cases that violate the rule throw. **AC-25, AC-26, AC-27.** |
| UT-20 | grant-credits one-shot sequence (Phase A AC-28) | Mock-postgres backend: invoke `grantCredits(TEST_TEAM_ID, 200)`. Assert: (a) `process.env.SUPABASE_SERVICE_ROLE_KEY` presence-check fires before the SELECT; throws if missing. (b) Sequence: `SELECT credit_balance ... FOR UPDATE` runs first; `UPDATE teams SET credit_balance = credit_balance + 200` runs second; `INSERT INTO credit_transactions (id='e2e-tx-grant-200', type='topup', credits_changed=200, balance_before=<read>, balance_after=<read>+200)` runs third — all inside one tx. (c) `balance_before/balance_after` chain matches the pre/post read values. (d) Console output contains exactly one line `[grant-credits] team=… pre=… post=… delta=+200`; the service-role key value never appears. (e) Re-running grantCredits twice in a row inside the same seed cycle is FORBIDDEN — second call throws (idempotency is per-seed-cycle, not per-process). **AC-28.** |
| UT-21 | storageState globalSetup-auth (OPT-B AC-29) | Mock Supabase `signInWithOtp` + `verifyOtp` + the §b.14 `getOtp("login",…)` facade. Run `e2e/helpers/global-setup-auth.ts` entry point. Assert: (a) login invoked EXACTLY ONCE (spy on getOtp); (b) storage-state file written to `e2e/.playwright-storage-state.json` with a non-empty JSON object containing `cookies` array + `origins` array keys; (c) file is marked gitignored (grep `.gitignore` for the path); (d) running the helper twice in the same process is FORBIDDEN — second call short-circuits (idempotent per process). (e) Grep enforcement: no spec under `e2e/tests/01-auth/` silently inherits the shared session — each 01-auth spec sets `use.storageState = undefined` at the spec or project level. **AC-29.** |
| ~~UT-22~~ | **RETIRED (Aditya pivot 2026-04-21 corr `0ab24f1a`)** — mock-server protocol contract no longer applicable under the live-services AC-30. Original body preserved in git history. Rule-2-grep enforcement (no `lib/mocks/*` import by product; no `NODE_ENV==='test'` branches in product) MOVED to `UT-26` clause **(e)** (HP textual-consistency fix per Aditya corr `9fabb91b` — prior text said "(a)/(b)"). |
| UT-23 | Exact-delta grep guard (OPT-B AC-31, Aditya Rule 1) | Scan every `assertColumnDelta(` call site under `e2e/tests/`. For the 4th argument, assert it is an integer literal (e.g. `-5`, `0`, `-1`) — NOT a range expression, NOT an object literal with `min`/`max` keys, NOT a call to a tolerance helper. Permitted forms: `-5`, `0`, `-1`, `+200`, `-<integer>`. Banned forms: `{ min: -5, max: 0 }`, `within(-5, 0)`, `Math.abs(…) < 5`, `expect.any(Number)`. Positive-case violations throw with offending `file:line`. Also grep for `assertRowCount` tolerance forms — same rule: exact-count only for Phase B credit-adjacent specs; tolerance `{ min, max }` permitted ONLY for inherently non-deterministic counts (e.g. `citation_check_responses` row count depends on provider count; AC-26 UT-19 already allows tolerance there). **AC-31.** |
| UT-24 | Seed sets monthly_page_allowance=0 (AC-32) | Mock-postgres backend: run `buildSeedPlan()`; inspect the planned `teams` INSERT row; assert `monthly_page_allowance === 0`. Assert `credit_balance === 10` (unchanged baseline per §b.4). Assert the plan's credit_transactions rows are untouched (3 rows: signup_bonus +5, topup +10, crawl_debit -5 — sum = 10). Negative case: if a future seed mistakenly omits the `monthly_page_allowance` override, the assertion catches it at UT time, before any spec runs. **AC-32.** |
| UT-25 | Two-phase reserve+debit txn sequence (AC-33, RC1) | Mock-postgres backend with seeded baseline `credit_balance = 10` (or 210 post-grant per AC-28 — UT-25 reads the baseline first). (a) Simulate discovery phase: insert `crawl_reserve` row with `credits_changed = -1`, decrement balance to baseline−1. Read mid-flight `credit_balance` — assert it equals `baseline − 1` AND warn this is the transient state per AC-33 ("no mid-flight assertions"). (b) Simulate complete phase: insert `crawl_debit` row with `credits_changed = -1` reconciling against the reserve such that final `credit_balance = baseline − 1` (NOT `baseline − 2`). (c) Post-complete read: assert net delta = `-1` exact. (d) Assert BOTH rows present in `credit_transactions`. (e) Negative case: if test asserts mid-flight delta, it sees `-1` but the §b.16.8 cost is also `-1` so the assertion would *accidentally* pass for DRY-02; UT-25 covers the divergent case (e.g. `page_estimate = 10, actual = 5` where mid-flight = `-2` but post-complete = `-1`) to prove the AC-33 wait-for-complete rule. **AC-33.** |
| UT-26 | Content-tolerance grep guard + Rule-2 hard gate (AC-30 + AC-34, post-pivot) | Scan every assertion call site under `e2e/tests/`. Negative cases (any positive match throws with offending `file:line`): (a) `expect(true)` tautology anywhere; (b) `Math.abs(` in any test assertion expression (range-check pattern); (c) `expect(<varname>).toBe("<verbatim string>")` where `<varname>` traces (via lightweight static analysis or naming convention — `*Response`, `*Text`, `*Output`, `*Completion`) to a vendor SDK return — vendor verbatim is non-deterministic; (d) tolerance band on `assertColumnDelta` 4th arg (overlaps UT-23 — defence-in-depth); (e) **Rule 2 HP hard gate (inherited from retired UT-22):** grep-enforce that no file under `lib/`, `app/`, `components/`, `scripts/` (i.e. non-test directories) imports from `e2e/mock-servers/` (which should not exist post-strip) OR `lib/mocks/*` (also should not exist), and contains no `if (process.env.NODE_ENV === "test")` conditional that branches product behaviour. **AC-30, AC-34.** |
| UT-27 | Test-domain selection grep guard (§b.16.9.5, Aditya corr `9fabb91b`; updated 2026-04-21 corr `3b9ee0d5`) | Scan every spec file under `e2e/tests/**/*.spec.ts` AND every CSV fixture under `e2e/fixtures/csv/*.csv` for domain string literals. (a) **FAIL** if ANY match the PROHIBITED list: `w3.org`, `ietf.org`, `httpbin.com` (Cloudflare bot-protection — see §b.16.9.5) (extensible — list maintained at §b.16.9.5). (b) **WARN** (non-fatal, surfaced in test output) if ANY match a domain that is NOT on the RECOMMENDED list AND NOT carrying a same-line `// rationale:` comment justifying the exception. (c) Detection regex: hostname-shape `[a-z0-9-]+\.[a-z]{2,}` (case-insensitive), with allow-list filtering for `example.com\|example.org\|example.net\|httpbin.org\|jsonplaceholder.typicode.com` and the fixture domains under `.e2e.flowblinq.test` (per §b.1). (d) Positive matches against PROHIBITED throw with offending `file:line` and the matched domain. **§b.16.9.5.** |
| UT-28 | Fix-before-retry grep guard (AC-35, Aditya corr `318f04c9`) | Scan every spec file under `e2e/tests/**/*.spec.ts` AND every retry-harness module under `e2e/helpers/`. Negative cases (any positive match throws with offending `file:line`): (a) any retry-loop construct — `for (let i = 0; i < N; i++) { … attempt … }`, `while (failed && attempts < N) { … }`, `pRetry(...)`, `axios-retry` default config — that does NOT gate on an error-class predicate (per AC-35 (b)); a retry harness MUST inspect the error class (network 408, 5xx-with-Retry-After, 429, documented SDK retry codes) before deciding to retry. (b) any `test.skip(...)` or `test.fixme(...)` whose label matches `/flaky|5xx|500|503/i` — masks 5xx-class product bugs, banned per AC-35 (c) (overlaps AC-25 zero-fixme — defence-in-depth). (c) any catch block that swallows a 5xx without re-throw OR explicit failure-context capture (`console.error(err)` without test failure assertion). **AC-35.** |

Coverage target: 100 % of `safety.ts`, 80 % of `seed.ts` and `teardown.ts` pure helpers. (Transactional DB code paths are covered by ITs.)

---

## f) Integration Test Plan

**Location:** `scripts/e2e/__tests__/integration.test.ts`. Requires a real local Supabase running at 127.0.0.1:54322 (standard dev loop). Tests guard with `beforeAll(() => assertLocalDb())` and skip if the DB is unreachable.

| # | Scenario | Assertion |
|---|----------|-----------|
| IT-1 | seed → teardown → seed cycle | after cycle 1 + cycle 2: `SELECT md5(...) FROM geo_sites WHERE team_id=...` identical; zero rows remain after teardown; `rate_limits` zero matching rows. **AC-6, AC-9, AC-11.** |
| IT-1b | transactional rollback | monkey-patch the `INSERT INTO consent_records` step to throw; re-run seed; DB state equals pre-seed (no partial rows). **AC-14.** |
| IT-2 | 5 sites present + shape | after seed, `SELECT slug, pipeline_status, jsonb_array_length(per_page_results) FROM geo_sites WHERE team_id=...` matches the table in §b.2. **AC-2.** |
| IT-3 | credits invariant | after seed, `teams.credit_balance = sum of credit_transactions.credits_changed`. **AC-3.** |
| IT-4 | consent + token_expires_at | `consent_records` count=1, `geo_sites` with `token_expires_at IS NULL` count=0. **AC-4, AC-5.** |
| IT-5 | global-setup bails on failure | force a seed failure (e.g. `DATABASE_URL` swapped to prod-pattern); run `npx playwright test --list`; assert non-zero exit and stdout contains "REFUSING". No browser launched. **AC-7, AC-8.** |
| IT-6 | geo_site_view mirror | after seed, 5 rows in `geo_site_view` with `team_id=$TEST_TEAM_ID`; `site_id` values match `geo_sites.id`. **AC-2.** |
| IT-7 | golden-path spec (smoke) | a trivial Playwright spec imports `SITE_IDS.paidFullAudit` and hits `/sites/<id>` — expects 200 OK and score "58" rendered. Confirms the end-to-end wiring. Gated on actual app up. |
| IT-8 | Stripe columns untouched | post-seed, `SELECT count(*) FROM geo_sites WHERE team_id=$TEST_TEAM_ID AND (stripe_customer_id IS NOT NULL OR stripe_subscription_id IS NOT NULL)` equals 0. **AC-10.** |
| IT-9 | tag completeness | for every table in the §b.9 enumeration, `SELECT count(*) WHERE NOT <tag>` post-seed equals the pre-seed count (no untagged rows leaked). **AC-12.** |
| IT-10 | FK-complete DELETE (HP-252) | pre-seed: manually INSERT a fake api_clients row (team_id=$TEST_TEAM_ID, client_id="e2e-manual-x", other NOT NULL columns filled), AND a fake firecrawl_jobs row (site_id=$SITE_IDS.paidFullAudit); run `db:seed:e2e`; assert it succeeds (prior implementation without HP-252 would FK-error on the teams/geoSites DELETE); assert both fake rows are gone. **AC-16.** |
| IT-11 | firecrawl_jobs stub resolves (HP-259) + deterministic timestamps (HP-260) | post-seed: `SELECT id, site_id, status, urls_submitted, urls_completed, created_at FROM firecrawl_jobs WHERE id='e2e-stub-job-1'` returns exactly one row with `site_id=SITE_IDS.midPipelineAudit`, `status='scraping'`, `created_at='2026-04-01T00:00:00.000Z' - 2 minutes`; `SELECT id FROM geo_sites WHERE id=SITE_IDS.midPipelineAudit AND crawl_job_ids @> '["e2e-stub-job-1"]'::jsonb` returns one row (FK/link resolves). Re-run seed; `md5_agg` over firecrawl_jobs rows is byte-identical. **AC-17.** |
| IT-12 | NODE_ENV guard fires first (HP-253) | spawn the script with `NODE_ENV=production DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`; assert exit code 2, stdout contains "NODE_ENV=production", and zero connections opened (check via `pg_stat_activity` before/after). **AC-7(a).** |
| IT-13 | Both OTP flows return a real code end-to-end (Phase 0 Track A) | with local Supabase + Mailpit up AND Gmail IMAP reachable (`GMAIL_APP_PASSWORD` in env): trigger `supabase.auth.signInWithOtp({ email: "e2e-login-$ts@test.local" })`; `getOtp("login", "e2e-login-$ts@test.local")` returns a 6-digit string within 20 s; AND separately trigger `/api/sites` with the TEST_USER_EMAIL; `getOtp("verify", TEST_USER_EMAIL)` returns a 6-digit string within 20 s. Both codes are distinct inboxes; both succeed in one test run. **AC-18.** |
| IT-13b | Deliberate miswire fails fast (Phase 0 Track A) | trigger a Supabase login-flow OTP to `e2e-login-$ts@test.local`; call `getOtp("verify", "e2e-login-$ts@test.local", { timeoutMs: 3_000 })` — wrong flow for wrong inbox. Assert that within `3_000 + 2_000` ms the call throws `OtpTimeoutError` (the IMAP-helper class). Assert NOT a Playwright per-spec timeout (5-30 s) — the bounded timeout fires first. **AC-20.** |
| IT-14 | Returning-user-skips-consent (Phase 0 Track B, §b.15.5) | With local Supabase + Mailpit up AND seeded `consent_records` row for `TEST_USER_ID` (per §b.6 seed). Drive the login flow per the §b.15.5 code sample: fill placeholder-selected email + OTP inputs, assert buttons-enabled before click, register `page.on("framenavigated", …)` before the verify click, assert `page.url()` reaches `/dashboard`, assert no visited URL matches `/\/consent(\b|$|\/)/`. Also tear-down + reseed before the test to prove determinism. **AC-23, AC-24** (depends on auth.users seeded so `/api/consent` resolves to `TEST_USER_ID`). |
| IT-15 | auth.users deterministic provisioning end-to-end (Fix 4, AC-24) | With local Supabase up: run `db:teardown:e2e && db:seed:e2e`. Then assert: (a) `SELECT id FROM auth.users WHERE email = $TEST_USER_EMAIL` returns exactly one row with `id = TEST_USER_ID`; (b) re-run seed; assert the row is still present and `id` unchanged (idempotency — pre-delete + create with deterministic id is a no-op net effect); (c) drive a Supabase OTP round-trip (`signInWithOtp({ email: TEST_USER_EMAIL })` → fetch code via `getOtp("login", TEST_USER_EMAIL)` → `verifyOtp({ email, token, type: "email" })`) and assert the resulting session's `user.id === TEST_USER_ID`; (d) hit `/api/consent` with that session's cookie and assert response is `{ hasConsent: true }` (the seeded `consent_records` row matches because `auth.users.id` and `consent_records.user_id` both equal `TEST_USER_ID`). **AC-24, AC-23 (transitively).** |
| IT-16 | DRY-01 login → logout (Phase A §b.16.2) | With local Supabase + Mailpit up + AC-28 grant applied. Drive the login flow per §b.14 facade (`getOtp("login", TEST_USER_EMAIL)`); reach `/dashboard`. Assert `assertAuthSessionExists(TEST_USER_ID, 1)`. Click logout. Assert `page.url()` returns to `/auth/login`. Assert `assertAuthSessionExists(TEST_USER_ID, 0)` OR `assertNoMutation(["auth.sessions"])` per product behaviour. **AC-26, §b.16.2 DRY-01.** |
| IT-17 | DRY-02 single-domain audit (Phase A §b.16.2) | From `/dashboard`, launch a single-domain audit on a fresh fixture domain. Wait for `pipeline_status` to flip off `"pending"` (poll DB or wait for UI signal). Assert `assertRowExists("geo_sites", { domain, team_id: TEST_TEAM_ID })`. Assert `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", -<observed page count>)` with baseline read at spec-arrange. Assert `assertRowExists("credit_transactions", { team_id: TEST_TEAM_ID, type: "crawl_debit", site_id: <new siteId> })`. **AC-26, §b.16.2 DRY-02.** |
| IT-18 | DRY-03 citation check (Phase A §b.16.2) | On the DRY-02 site, trigger a citation check via the citation tab. Wait for completion. Assert `assertRowExists("citation_check_scores", { site_id: <DRY-02 siteId> })`. Assert `assertRowCount("citation_check_responses", { check_id: <new checkId> }, { min: 1 })`. Assert credit-balance delta matches the citation cost via `assertColumnDelta("teams", …, "credit_balance", -<cost>)`. **AC-26, §b.16.2 DRY-03.** |
| IT-19 | DRY-04 map competitors (Phase A §b.16.2) | Open competitor settings on the DRY-02 site, add a user-defined competitor, save. Assert UI pill renders. Assert `assertRowExists("geo_sites", { id: <DRY-02 siteId> })` returns a row whose `user_competitors` JSONB contains the new competitor name (or assert via `assertColumnDelta` on JSONB array length if helper supports). **AC-26, §b.16.2 DRY-04.** |
| IT-20 | DRY-05 bulk CSV ≥5 URLs (Phase A §b.16.2) | Upload a 5-row CSV from `/dashboard`. Wait for bulk-mode classification. Assert `assertRowExists("geo_sites", { team_id: TEST_TEAM_ID, audit_mode: "bulk" })`. Assert `bulk_url_count = 5` on that row. Assert `assertRowCount("firecrawl_jobs", { site_id: <bulk siteId> }, { min: 1 })`. Assert `assertColumnDelta("teams", …, "credit_balance", -5)` (one credit per URL minimum). **AC-26, §b.16.2 DRY-05.** |
| IT-24 | grant-credits end-to-end (Phase A AC-28) | With local Supabase up: run `db:teardown:e2e && db:seed:e2e` (which includes the AC-28 grant step). Assert `SELECT credit_balance FROM teams WHERE id = $TEST_TEAM_ID` returns `210` (baseline 10 from §b.4 + grant 200). Assert `SELECT count(*) FROM credit_transactions WHERE team_id = $TEST_TEAM_ID` returns `4` (3 baseline + 1 grant). Assert the grant row exists at `id='e2e-tx-grant-200'` with `type='topup'`, `credits_changed=200`, `balance_before=10`, `balance_after=210`. Re-run seed cycle; assert balance still `210` and grant row still present (idempotent). **AC-28.** |
| IT-25 | storageState reused across specs (OPT-B AC-29) | With local Supabase + Mailpit up. Run Playwright globalSetup; assert `e2e/.playwright-storage-state.json` exists + non-empty. Then run 3 consecutive specs (pick any 3 from DRY-02/03/04 post-OPT-B) sequentially — all three land already authenticated at `/dashboard` without firing a fresh `signInWithOtp`. Spy-count on Supabase `signInWithOtp` endpoint = 1 across the whole run (globalSetup only). DRY-01 (login/logout) explicitly overrides `use.storageState = undefined` — its signInWithOtp count = 1 in isolation but does NOT add to the shared run's count. Total signInWithOtp calls across a DRY-02/03/04 + DRY-01 suite run = 2 (one for shared-session globalSetup, one for DRY-01's opt-out). Rate-limiter pauses: zero. **AC-29.** |
| ~~IT-26~~ | **RETIRED (Aditya pivot 2026-04-21 corr `0ab24f1a`)** — mock-server E2E flow no longer applicable under the live-services AC-30. Original body preserved in git history. Live-services equivalent is exercised implicitly by every Phase A audit spec (DRY-02 / DRY-03 / DRY-05 ITs already drive the live chain end-to-end). Wall-clock budget moves from < 15 s to per-spec ranges in §b.16.9 cost table. |
| IT-27 | DRY-02/05 exact-delta per tier (OPT-B AC-31, post-OPT-B re-author) | Two DRY-02 variants: (a) seed user at `free` tier → exact `assertColumnDelta(..., "credit_balance", <free-tier exact cost from §b.16.8>)`; (b) seed user at `pro` tier → exact `assertColumnDelta(..., "credit_balance", <pro-tier exact cost from §b.16.8>)`. Plus DRY-05 bulk-CSV variant seeded at whichever tier the bulk-per-URL cost is non-zero at → exact `assertColumnDelta(..., "credit_balance", -<5 × per-URL cost>)`. No spec uses range check or tolerance band. Exact integer values are pinned at §b.16.8 (populated from SD audit). **AC-31.** |
| IT-28 | Seed+DRY-02 deliver exact -1 credit delta (AC-32) | With local Supabase up: run `db:teardown:e2e && db:seed:e2e`. Assert `SELECT monthly_page_allowance FROM teams WHERE id = $TEST_TEAM_ID` returns `0` (AC-32 seed behaviour). Assert `SELECT credit_balance FROM teams WHERE id = $TEST_TEAM_ID` returns `10` (unchanged baseline — the grant row per AC-28 adds +200 so actual balance is `210` if grant already ran; IT-28 reads BEFORE the grant OR adjusts the expectation to `210` depending on grant-ordering — SD pins at impl). Drive DRY-02 single-URL audit end-to-end. Post-audit assert `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", -1)` — exact integer, no tolerance. Assert a new `credit_transactions` row with `type = "crawl_debit"`, `credits_changed = -1`, `pages_consumed = 1` (or whatever the single-URL crawl resolved to). **AC-32, AC-31, AC-28 interaction verified.** |
| IT-29 | DRY-02 two-phase reserve+debit end-to-end (AC-33, RC1; PAGES_PER_CREDIT=10 per HP-271; **LIVE Firecrawl per AC-30 pivot 2026-04-21**) | With local Supabase up + LIVE Firecrawl (per AC-30 — `FIRECRAWL_BASE_URL` UNSET) + cloudflared tunnel for QStash callback (§b.16.7 / §b.16.9) + seed default `monthly_page_allowance = 0`. Capture `credit_balance` baseline pre-action. Drive DRY-02 single-URL audit against a stable test fixture domain. Wait for `pipeline_status = "complete"` (poll `geo_sites.pipeline_status` or watch the UI signal — AC-33 forbids asserting on `credit_balance` until complete is observed). **Per-spec wall-clock budget: 30 s – 2 min** per §b.16.9 (was < 15 s pre-pivot; live vendors take real time). **Per-spec USD cost: $0.05 – $0.15** per §b.16.9 cost table. Post-complete assertions: (a) `assertRowExists("credit_transactions", { site_id: <DRY-02 siteId>, type: "crawl_reserve" })` — assert the row's `credits_changed = -1` (reserve = `-ceil(actual_pages/10)`; for ~5 pages from a single URL crawl, this is `-1`); (b) `assertRowExists("credit_transactions", { site_id: <DRY-02 siteId>, type: "crawl_debit" })` — assert `credits_changed = -1`; (c) `assertColumnDelta("teams", { id: TEST_TEAM_ID }, "credit_balance", -1)` — exact net delta from baseline to post-complete. **Crawl content NOT asserted** (per AC-34 — Firecrawl results vary). Demonstrates the two-phase contract: both rows exist, net = `-1`, reserve+debit reconcile to §b.16.8 "Free + exhausted, single-URL" cost. **AC-33, AC-31, AC-32, AC-30, AC-34 interaction verified.** |
| IT-30 | Fix-before-retry: 5xx surfaces, no auto-retry (AC-35, Aditya corr `318f04c9`) | With local Supabase up + a stubbed test endpoint at `/api/__test_500__` (or equivalent — operator/SD wires a `e2e/helpers/stub-500-server.ts` test-side responder OR uses Playwright `page.route()` to fulfil with status 500 on a controlled fixture path; product code untouched per Rule 2). Drive a spec that hits the stub. Assert: (a) the spec FAILS within ONE attempt — does NOT retry (verified by spy on the underlying request count); (b) the failure message contains the HTTP status (`500`), the response body (or a meaningful excerpt thereof), and (if available) the test-side server log excerpt — context per AC-35 (a); (c) no automatic backoff/retry occurs because the stub does NOT send `Retry-After` header — per AC-35 (b) only retry-class errors with explicit retry semantics warrant retry; (d) the spec is NOT marked `flaky` or `fixme` despite the controlled failure (this is the assertion that AC-35 (c) holds at the spec-author convention level — IT-30 itself fails LOUDLY). **AC-35.** |

ITs skip when `DATABASE_URL` is missing or not local — so CI that runs without a live Supabase simply reports "skipped", not "failed".

---

## g) Profiling Requirements

Not applicable beyond seed/teardown wall-time. Seed logs `[seed] complete in Xms`; teardown logs `[teardown] purged N rows in Xms`. If seed exceeds 5 s or teardown exceeds 2 s, log a WARN line — this is the SLO violation alert surface (AC-15). No tracing, no metrics export — operator-local only.

---

## h) Load Test Plan

Not applicable. Seed is a one-shot batch insert of ~30 rows run once per test suite invocation. There is no concurrent write path, no user-facing SLO. `rate_limits` teardown is O(rows-for-test-user), which is bounded by AC-11.

---

## i) Logging & Instrumentation

Seed prints a 5-line header (env, target URL with password masked, seed tag) + one line per table with row count, then `[seed] complete in Xms`. Teardown prints an analogous footer. Both honour `stdio: "inherit"` from global-setup so the output lives in the Playwright run log. Errors carry the offending SQL fragment (from `postgres` driver) and exit non-zero so global-setup fails hard (AC-8). No structured logger; no shipping. Operator-local only.

---

## j) Constraints + Rollout

- **Spec-only.** No code in this commit. ScriptDev implements next.
- **Branch:** `e2e-comprehensive-suite`. This ES commits there. Implementation PR also targets that branch.
- **No push.** CoFounder coordinates with Aditya for push approval.
- **No Co-Authored-By trailer.** Per dispatch constraint.
- **No `--no-verify`.** Pre-commit hooks apply.
- **Schema reference pinning:** every column referenced in this ES is pinned against `geo/lib/db/schema.ts` at `a36606e`. If the schema changes (migration adds/removes/renames a column), this ES needs an amendment before implementation proceeds.

---

## k) References

- Schema: `geo/lib/db/schema.ts` at branch `e2e-comprehensive-suite` tip `a36606e` — line refs inline.
- Playwright config: `geo/playwright.config.ts` — `DATABASE_URL` pattern.
- Supabase config: `geo/supabase/config.toml` — ports 54322 (DB), 54323 (Studio), 54324 (Mailpit).
- Existing global-setup: `geo/e2e/global-setup.ts` (40 lines) — extension point per §b.11.
- Existing ad-hoc seeder: `geo/e2e/helpers/db.ts:createSiteWithKnownOtp` — kept for OTP-specific specs; NOT used by fixture-driven specs.
- OTP helper: `geo/e2e/fixtures/otp-helper.ts:14` — `TO_FILTER` constant that `TEST_USER_EMAIL` must match.
- HP rigour rule references: HP-169, HP-184, HP-163, HP-164 — do not invent column names.
- ES-090 §b.1 CRIT-1 — source of `token_expires_at NOT NULL` constraint (schema.ts:91–97).
- Pipeline contract: `.agents/CLAUDE.md` §"Development pipeline — binding contract" — pipeline next stage is HolePoker adversarial spec review.

---

## l) FIXME-deferred areas

- **FI-042 Stripe credit purchase flow** — Stripe test-mode webhook + price IDs. Separate ES required. This ES emits the in-file marker (§b.13) and AC-10; specs touching FI-042 MUST use `test.fixme(...)` referencing ES-e2e-fixtures.
