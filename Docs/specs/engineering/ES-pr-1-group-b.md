# ES-pr-1-group-b — AI Surface Audit Experiment (retroactive)

**Mode:** Reverse-engineering retroactive ES. Code already exists on branch `pr-1-group-b` (tip `44e5195`, cherry-picked from `fix/signup-alert-email` commits `e01608f..f9c6e2b`).
**Source TS:** none — reverse-engineered from commit history.
**Surface:** Research/experiment tooling only. All 17 files live under `geo/scripts/experiments/ai-surface-audit/`. Zero mainline-app, API, DB, UI, auth, or billing surface touched.

---

## a) Overview

`scripts/experiments/ai-surface-audit/` is a standalone pipeline that reverse-engineers which merchant-site signals correlate with visibility across five AI shopping surfaces (ChatGPT Shopping, Perplexity, Google AI Overviews, Meta AI, Amazon Rufus-sim), then funnels results into outreach emails and HTML pitch decks via an external `pitchgen` tool.

It runs offline (CLI only), reads hard-coded cohort + queries JSON, writes to a local `results/` folder plus (on operator macOS) a Cofounder deliverables path `/Users/adithya/Code/Cofounder/deliverables/...`. No production route, no DB write, no user-visible path.

### Commit provenance (7 commits, oldest → newest on branch)

| SHA | Subject | Adds |
|-----|---------|------|
| `fa86fa5` | feat: AI shopping surface ranking factor experiment | `surface-probes.mjs`, `signal-extractor.mjs`, `correlator.mjs`, `run-experiment.mjs`, `merchant-cohort.json`, `shopping-queries.json`, `run-weekly.sh`, `EXPERIMENT.md` |
| `cf4b062` | feat: markdown reports + cumulative tracking history | MD generators + `tracking-history.md` append in `correlator.mjs` + `run-experiment.mjs` |
| `198601a` | feat: rebuild cohort around live clients + outreach generator | `outreach-generator.mjs`; rewrites `merchant-cohort.json` |
| `50a1ea3` | data: final cohort — 98 businesses across 10 verticals | `merchant-cohort.json` |
| `5fc90db` | fix: brand mention detection + first test run results | `test-run.mjs`, `test-run-healthcare.json`, `test-run-healthcare.md`; hardens `detectMerchantMention` split-suffix patterns in `surface-probes.mjs` |
| `6328f00` | feat: pitch-bridge — experiment results → pitchgen HTML decks | `pitch-bridge.mjs`; adds `results/audit-jsons/`, `results/pitches/` |
| `44e5195` | data: first pitch decks — Manipal + Apollo | `results/audit-jsons/*.json`, `results/pitches/*-pitch.html` |

### 17 files on branch (verified against tip 44e5195)

Scripts: `surface-probes.mjs` (403 L), `signal-extractor.mjs` (322 L), `correlator.mjs` (680 L), `run-experiment.mjs` (417 L), `test-run.mjs` (348 L), `outreach-generator.mjs` (266 L), `pitch-bridge.mjs` (243 L), `run-weekly.sh` (52 L).
Data: `merchant-cohort.json` (121 L, 98 items), `shopping-queries.json` (75 L, 10 verticals), `test-run-healthcare.json`, `test-run-healthcare.md`.
Docs: `EXPERIMENT.md`.
Generated artifacts in `results/`: `audit-jsons/apollohospitals-com.json`, `audit-jsons/manipalhospitals-com.json`, `pitches/apollohospitals-com-pitch.html`, `pitches/manipalhospitals-com-pitch.html`.

---

## b) Explicit NON-goals

- **No mainline production path affected.** No changes to `geo/app/**`, `geo/lib/**` outside `scripts/experiments/`, no new API route, no DB migration, no schema change, no middleware touch.
- **No security surface.** Scripts consume existing env vars (`OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, optional `BRAVE_API_KEY`, `TOGETHER_API_KEY`, `DATABASE_URL` in `test-run.mjs`). No new auth, no new secret handling, no write to any shared service.
- **No UX.** Operator-only CLI. Output is local filesystem artifacts.
- **No customer-visible behavior.** No mention in prod pages, API, or emails-to-customers. Outreach emails are *drafts* for Aditya approval, never auto-sent.
- **No PII boundary.** Only public-web data (sites listed in the cohort) is fetched. `test-run.mjs` reads one internal table (`geo_sites`) for the operator's own Manipal row.

---

## c) Script contracts

### c.1 `surface-probes.mjs` — surface query + mention detection library

**Exports (branch tip `pr-1-group-b`, post-ScriptDev test-fixture surface — HP-250):**
- `TIMEOUT_MS: number` — 45 000 ms constant (line 21).
- `withTimeout(promise, ms?) → Promise<any>` — cancellable-timeout helper used by surface query fns (line 30).
- `SURFACES: Array<{name, label, fn}>` — 5 entries: `chatgpt_shopping`, `perplexity_shopping`, `google_ai_overview`, `meta_ai`, `amazon_rufus` (line 265).
- `detectMerchantMention(text: string, domain: string) → {mentioned, position, sentiment, matchType}` (line 275).
- `extractCitedDomains(text: string) → string[]` (line 338).
- `probeMerchant(domain: string, queries: string[]) → Promise<SurfaceResult[]>` (line 353).

**Input contract (`probeMerchant`):** `domain` = bare host (e.g. `"manipalhospitals.com"`); `queries` = array of natural-language strings. Env: `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`; optional `ANTHROPIC_API_KEY` (Meta fallback), `TOGETHER_API_KEY` (Meta primary), `BRAVE_API_KEY` (Rufus context).

**Output contract (`SurfaceResult[]`):** one item per surface:
```
{
  surface, label, totalQueries, mentionCount, visibilityScore (0..100),
  avgPosition (number | null), dominantSentiment ("positive"|"neutral"|"negative"|null),
  allCitedDomains: string[], allCitationUrls: string[],
  responses: Array<{ query, text, citations, responseTimeMs, error, mention, citedDomains }>
}
```

**Determinism:** non-deterministic (LLM calls). Consumers cache via `results/probes.json`.

**Constants (authoritative):** `TIMEOUT_MS=45000`, `BATCH_SIZE=5`, `BATCH_DELAY_MS=500` (lines 21–23).

### c.2 `signal-extractor.mjs` — site signal extraction library

**Exports:**
- `SIGNAL_CATEGORIES: Record<string,string>` (line 18) — 7 keys: schema, reviews, freshness, crawlability, technical, content, social.
- `extractSignalsFromPage(url, html, markdown) → SignalObject` (line 58).
- `extractSiteLevelSignals(domain) → Promise<SignalObject>` (line 162) — hits `/robots.txt`, `/llms.txt`, `/sitemap.xml`, 10 s timeouts each.
- `crawlAndExtractSignals(domain) → Promise<SignalObject>` (line 219) — requires `FIRECRAWL_API_KEY`, scrapes 5 candidate URLs (`/`, `/about`, `/products`, `/shop`, `/contact`) via `https://api.firecrawl.dev/v1/scrape`, 500 ms rate-limit.

**Signal keys (boolean):** `hasProductSchema`, `hasOfferSchema`, `hasReviewSchema`, `hasOrgSchema`, `hasFAQSchema`, `hasBreadcrumbs`, `hasSearchAction`, `hasMerchantReturn`, `hasShippingDetails`, `hasLlmsTxt`, `hasSitemap`, `hasRobotsTxt`, `allowsAIBots`, `blocksGPTBot`, `blocksCCBot`, `blocksPerplexityBot`, `hasAnyReviews`, `hasFAQContent`, `hasComparisonContent`, `hasPricingContent`, `hasShippingInfo`, `hasReturnPolicy`, `hasCanonicalTag`, `hasMetaDescription`, `hasOpenGraph`, `mentionsCurrentYear`.

**Signal keys (continuous):** `schemaCount`, `schemaScore` (0..100), `reviewPlatformCount`, `estimatedReviewCount`, `freshnessScore`, `contentScore`, `maxWordCount`, `socialChannelCount`.

**Deterministic** given identical HTML/markdown input. Network paths are nondeterministic.

### c.3 `correlator.mjs` — correlation + report generation library

**Exports (branch tip `pr-1-group-b`, post-ScriptDev test-fixture surface — HP-250):** `pearson(xs, ys) → number | null` (line 17), `pointBiserial(booleans, continuous) → number | null` (line 39), `computeCorrelations(merchants) → Record<surface, SurfaceReport>` (line 94), `buildInstrumentabilityMatrix(correlations)` (line 166), `buildCrossSurfaceSummary(correlations)` (line 192), `generateReport(...)` (plain text, line 234), `generateMarkdownReport(...)` (line 355), `generateMerchantProfileMd(merchant)` (line 518), `generateSurfaceDeepDiveMd(surfaceName, surfaceData, instrumentability)` (line 615).

**Input shape (`merchants`):** `Array<{ domain, vertical, platform, signals, visibility: [{surface, visibilityScore, mentionCount, avgPosition}] }>`.

**Math:**
- `pearson(xs, ys)` — returns `null` if n<3 or variance=0, else r ∈ [−1,+1].
- `pointBiserial(booleans, continuous)` — 0/1 encoding of booleans.
- Guard: skip signals where all merchants share the same value.
- Instrumentability score = `|r| × effort_multiplier` where low=100, medium=70, high=40, and `|r| ≥ 0.15` threshold.

**Deterministic** given identical input.

### c.4 `run-experiment.mjs` — end-to-end CLI

**CLI flags (verified lines 58–82):** `--merchants N`, `--surfaces S1,S2`, `--skip-crawl`, `--skip-probes`, `--output DIR`, `--queries-per-vertical N` (default 5).

**Pipeline:** load cohort + queries → Phase 1 extract signals (cached → `results/signals.json`) → Phase 2 probe surfaces (cached → `results/probes.json`) → Phase 3 correlate → Phase 4 emit reports.

**Outputs (written to `opts.outputDir` unless otherwise noted):**
- `signals.json`, `probes.json` — incremental caches.
- `ranking-factors-YYYY-MM-DD.txt` (plain), `.md` (markdown), `.json` (machine-readable).
- `merchant-profiles/<domain>.md` (one per merchant).
- `surface-deep-dives/<surface>.md` (one per surface).
- `tracking-history.md` (append-only cumulative).
- Mirrors to `/Users/adithya/Code/Cofounder/deliverables/tech/` (operator-local; path will no-op on non-macOS via `mkdirSync(..., {recursive:true})` — may fail on Linux CI, see AC-9).

**Hard requirement:** exits non-zero with message if `mergedMerchants.length < 5` (line 211–214).

### c.5 `test-run.mjs` — healthcare-only smoke test

**Shape:** hard-coded 2 merchants × 2 queries × 3 surfaces = 12 API calls (≈ $0.10–0.15 per run).
**DB read:** when `merchant.pullFromDb === true` (Manipal only), opens a single-connection `postgres` client against `DATABASE_URL`, `SELECT geo_scorecard, crawl_data, discovered_competitors, extracted_categories, generated_llms_txt, executive_summary FROM geo_sites WHERE domain = $1 AND pipeline_status = 'complete' ORDER BY created_at DESC LIMIT 1` (line 117–123). Read-only. Closed in `finally`.
**Outputs:** `results/test-run-healthcare.json`, `results/test-run-healthcare.md`, plus Cofounder mirror `/Users/adithya/Code/Cofounder/deliverables/tech/ai-surface-test-run-healthcare.md`.

### c.6 `outreach-generator.mjs` — email draft generator

**Exports (branch tip `pr-1-group-b`, post-ScriptDev test-fixture surface — HP-250):** `generateEmail(merchant, caseStudy, gaps) → {subject, body, domain, vertical, avgVis, gapCount}` (line 99). Remaining helpers (`pickCaseStudy`, `describeGaps`, `generateBatch`, `generateOutreachReport`, `main`) are module-private.

**Input:** either `--results <json>` (from `run-experiment.mjs`) or fall-back to `results/signals.json` + `results/probes.json` + `merchant-cohort.json`.
**Output:** `results/outreach-drafts-YYYY-MM-DD.md` + mirror to `/Users/adithya/Code/Cofounder/deliverables/sales/ai-visibility-outreach-YYYY-MM-DD.md`.
**Hard invariant:** emits *drafts only*; the script never sends mail. Report header says "DRAFT — requires Adithya approval before sending" (line 161).

### c.7 `pitch-bridge.mjs` — experiment → pitchgen HTML

**Exports (branch tip `pr-1-group-b`, post-ScriptDev test-fixture surface — HP-250):** `buildAuditJson(merchant, signals, visibility) → AuditJson` (line 43). Remaining helpers (`generatePitchForMerchant`, `main`) and the `VERTICAL_TO_INDUSTRY` map are module-private.

**CLI flags:** `--domain`, `--tier`, `--vertical`, `--max N` (default 5).
**Input sources (prefer first found):** `results/signals.json`, `results/probes.json`, plus `results/test-run-healthcare.json` (line 207–211).
**Mapping:** 10 `VERTICAL_TO_INDUSTRY` entries covering every cohort vertical (healthcare, bespoke_tailoring, electronics_repair, pr_agency, cloud_finops, snack_brand, mortgage_broker, wellness, social_media_agency, office_supplies); unmapped verticals fall through to `"ecommerce"`.
**External tool:** shells out to `cd /Users/adithya/Code/Cofounder/tools/pitchgen && python3 generate_pitch.py --customer "<Name>" --industry <industry> --geo-audit <audit.json> --output <html>` with 120 s timeout.
**Outputs:** `results/audit-jsons/<domain-dashed>.json` (one per merchant), `results/pitches/<domain-dashed>-pitch.html` (one per merchant).
**Audit JSON schema** (emitted by `buildAuditJson`, line 48–137):
```
{
  domain, score, max_score (100), pages_audited, audit_date (YYYY-MM-DD),
  issues: Array<{name, severity: "high"|"medium"|"low", time_estimate, description}>,
  projected_score_after_fixes: "<n>+",
  ai_surface_visibility: Record<surface, "<n>%">,
  competitor_visibility: any[]
}
```

### c.8 `run-weekly.sh` — cron wrapper

Runs `node --env-file=.env.local run-experiment.mjs --output results/ | tee results/run-<DATE>.log`. Conditionally commits results under `CI=true && AUTO_COMMIT=true`. `set -euo pipefail`.

---

## d) Data contracts

### d.1 `merchant-cohort.json`

**Top-level shape:**
```
{ description, created, stats: {live_clients, competitors, lookalikes, total, verticals, regions}, cohort: Array<MerchantEntry> }
```
`cohort.length === 98` on branch tip (verified). Header `stats.total` says 105 — this is a **known discrepancy**; see AC-6.

**MerchantEntry required fields:** `domain` (bare host), `vertical` (snake_case string), `tier` (`"live_client" | "competitor" | "lookalike"`).
**Optional fields:** `geoScore`, `aiVisibility`, `source`, `notes`, `region`, `platform`.
**Verticals (10):** `healthcare, bespoke_tailoring, electronics_repair, pr_agency, cloud_finops, snack_brand, mortgage_broker, wellness, social_media_agency, office_supplies` — must match `shopping-queries.json` keys and `VERTICAL_TO_INDUSTRY` keys in `pitch-bridge.mjs`.

### d.2 `shopping-queries.json`

```
{ description, queries: Record<vertical, string[]> }
```
10 keys, 5 queries each (verified). Queries are intent-bearing shopping prompts (e.g. "Best multi-specialty hospitals in Bangalore"). Not escaped — string contents are user-prompt-safe only because the operator authored them.

### d.3 `test-run-healthcare.json`

Output fixture, shape documented in `test-run.mjs` line 257–258:
```
{
  meta: { date, runtime, queries, surfaces, estimatedCost },
  results: Array<{
    domain, label, signals, visibility, avgPosition, perSurface, mentionedCount, totalProbes,
    allCitedDomains, probes: Array<ProbeRecord>
  }>
}
```

---

## e) Acceptance Criteria

1. **AC-1 (file inventory):** branch tip `44e5195` has exactly these 17 tracked items under `scripts/experiments/ai-surface-audit/` — 7 `.mjs`, 1 `.sh`, 2 JSON data files, 1 `EXPERIMENT.md`, 2 files under `results/` root (`test-run-healthcare.json`, `test-run-healthcare.md`), 2 files under `results/audit-jsons/`, 2 files under `results/pitches/`. `git ls-tree -r 44e5195 -- scripts/experiments/ai-surface-audit/` verifies.
2. **AC-2 (exports pinned — HP-250, branch tip `pr-1-group-b`):** `surface-probes.mjs` exports exactly `TIMEOUT_MS`, `withTimeout`, `SURFACES`, `detectMerchantMention`, `extractCitedDomains`, `probeMerchant`. `signal-extractor.mjs` exports `SIGNAL_CATEGORIES`, `extractSignalsFromPage`, `extractSiteLevelSignals`, `crawlAndExtractSignals`. `correlator.mjs` exports `pearson`, `pointBiserial`, `computeCorrelations`, `buildInstrumentabilityMatrix`, `buildCrossSurfaceSummary`, `generateReport`, `generateMarkdownReport`, `generateMerchantProfileMd`, `generateSurfaceDeepDiveMd`. `outreach-generator.mjs` exports `generateEmail`. `pitch-bridge.mjs` exports `buildAuditJson`. These export lists are what unit tests import; any additions/removals require a spec amendment.
3. **AC-3 (surface registry):** `SURFACES` length is 5 and names match `["chatgpt_shopping","perplexity_shopping","google_ai_overview","meta_ai","amazon_rufus"]` in order.
4. **AC-4 (mention detection — deterministic):** given text containing `"manipalhospitals.com"`, `detectMerchantMention(text, "manipalhospitals.com")` returns `{mentioned:true, matchType:"domain", ...}`. Given text containing `"Manipal Hospitals"` (no URL), it returns `{mentioned:true, matchType:"brand", ...}` via the split-suffix pattern. Given unrelated text, `{mentioned:false, matchType:null, position:null}`.
5. **AC-5 (position parsing):** for text `"1. Apollo\n2. Manipal Hospitals\n3. Fortis"`, `detectMerchantMention(...,"manipalhospitals.com").position === 2`.
6. **AC-6 (cohort integrity, known discrepancy):** `cohort` array length equals 98 and every entry has `domain`, `vertical`, `tier`. Header `stats.total` says 105 — acknowledged drift; flagged here as a documentation bug, not blocking.
7. **AC-7 (vertical coverage):** every `vertical` value in `merchant-cohort.json` appears as a key in `shopping-queries.json`. Conversely, every key in `shopping-queries.json` appears on at least one cohort entry.
8. **AC-8 (correlation correctness):** `pearson([1,2,3,4,5],[2,4,6,8,10])` ≈ `1.0`; `pearson([1,1,1],[1,2,3])` returns `null`; `pointBiserial([true,false,true,false],[10,0,10,0])` ≈ `+1.0`.
9. **AC-9 (Linux portability caveat):** `run-experiment.mjs` and `test-run.mjs` hard-code macOS paths `/Users/adithya/Code/Cofounder/...`. On Linux, `mkdirSync(..., {recursive:true})` will succeed up to `/Users` then fail with `EACCES` at `writeFileSync`. AC is that this is **documented**, not fixed — operator runs only on macOS. CI must skip invocation of these two scripts.
10. **AC-10 (pitch-bridge external dependency):** `pitch-bridge.mjs` requires `/Users/adithya/Code/Cofounder/tools/pitchgen/generate_pitch.py` and Python 3. Test coverage scope is limited to `buildAuditJson` (pure function) and argument parsing. HTML generation is out-of-scope for this ES.
11. **AC-11 (HTML output well-formed):** The 2 committed pitch HTML files (`results/pitches/*.html`) parse without errors. A minimal HTML parser check (jsdom, fast-html-parser, or `htmlparser2`) asserts a single `<html>` root, closed tags, and presence of at least one `<h1>` and one `<table>`.
12. **AC-12 (audit JSON shape):** both committed `results/audit-jsons/*.json` files conform to the schema in §c.7 — required keys present, `issues[].severity ∈ {high,medium,low}`, `score ∈ [0,100]`.
13. **AC-13 (outreach guardrail):** `outreach-generator.mjs` never imports `nodemailer`, `@sendgrid/mail`, `postmark`, `resend`, or calls any SMTP API. Grep test asserts absence.
14. **AC-14 (env boundary):** `surface-probes.mjs`, `signal-extractor.mjs`, and `test-run.mjs` each only read env via `process.env.X` (never write). Grep test asserts no `process.env.X =` assignments anywhere under `scripts/experiments/ai-surface-audit/`.
15. **AC-15 (DB read is read-only):** `test-run.mjs`'s single `postgres` call executes only a `SELECT`. Grep: no `INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER` in the file.
16. **AC-16 (no prod surface):** `git diff main...pr-1-group-b --stat` touches zero files outside `scripts/experiments/ai-surface-audit/`. If any file outside this prefix appears, the PR fails review.
17. **AC-17 (commit provenance preserved):** 7 commits `fa86fa5..44e5195` with subjects matching §a table exist on `pr-1-group-b`; each commit originates from `fix/signup-alert-email` range `e01608f..f9c6e2b` (cherry-pick trailer or identical diff).

---

## f) Unit Test Plan

**Test file:** `scripts/experiments/ai-surface-audit/__tests__/experiment.test.mjs` (new).
**Runner:** `vitest` (already in `geo/` dev deps) with `--env node`.

| # | Target | Assertion |
|---|--------|-----------|
| U1 | `detectMerchantMention` | domain match → `matchType:"domain"` (AC-4) |
| U2 | `detectMerchantMention` | brand-only match via split-suffix `"manipal hospitals"` (AC-4) |
| U3 | `detectMerchantMention` | unrelated text → `{mentioned:false, matchType:null}` (AC-4) |
| U4 | `detectMerchantMention` | position parsing from numbered list (AC-5) |
| U5 | `detectMerchantMention` | sentiment classification "best", "leading", "top" → `"positive"` |
| U6 | `extractCitedDomains` | filters infra domains (google.com, wikipedia.org, etc.) |
| U7 | `extractCitedDomains` | bare-domain regex captures `"revzilla.com"` in plain prose |
| U8 | `extractSignalsFromPage` | JSON-LD `"@type":"Product"` → `hasProductSchema:true`, `schemaCount≥1` |
| U9 | `extractSignalsFromPage` | `robots` noindex meta → `noindexPresent:true` |
| U10 | `extractSignalsFromPage` | `wordCount` split on whitespace, filters empty |
| U11 | `pearson` (via re-export test hook) | perfect linear → ≈ 1.0 (AC-8) |
| U12 | `pearson` | zero variance → `null` (AC-8) |
| U13 | `pointBiserial` | `[T,F,T,F]` vs `[10,0,10,0]` → ≈ 1.0 (AC-8) |
| U14 | `computeCorrelations` | skips boolean signals where all merchants share same value |
| U15 | `buildInstrumentabilityMatrix` | drops signals with `|r|<0.15` |
| U16 | `buildInstrumentabilityMatrix` | ranks by `|r|×effort_multiplier` (low=100,med=70,high=40) |
| U17 | `buildCrossSurfaceSummary` | averages r across surfaces; consistency=percent of sign agreement |
| U18 | `buildAuditJson` (pitch-bridge) | missing `hasProductSchema` & `hasOrgSchema` → "No machine-readable business identity" with severity `"high"` |
| U19 | `buildAuditJson` | `allowsAIBots === false` → high-severity "AI bots blocked" issue |
| U20 | `buildAuditJson` | score clamps into `[0,100]` |
| U21 | `generateEmail` (outreach) | output never contains `"approved"`, always starts with `"Hey — I ran an AI visibility audit"` (keeps the draft-only tone guard) |
| U22 | cohort loader | JSON.parse succeeds, `cohort.length===98`, all entries have `domain/vertical/tier` (AC-6) |
| U23 | cohort/queries alignment | every cohort `vertical` is a key in `shopping-queries.json` (AC-7) |

**Coverage target:** 80 % line coverage across `correlator.mjs`, `surface-probes.mjs` (excluding network fns), `pitch-bridge.mjs` pure helpers, `outreach-generator.mjs` pure helpers.

---

## g) Integration Test Plan

**Test file:** `scripts/experiments/ai-surface-audit/__tests__/integration.test.mjs`.
**Scope:** deterministic paths only — all LLM, Firecrawl, Brave, DB network calls **mocked**.

| # | Scenario | Mocks | Assertion |
|---|----------|-------|-----------|
| I1 | `run-experiment.mjs` with `--skip-crawl --skip-probes` and pre-seeded `signals.json`+`probes.json` | fs | writes `ranking-factors-*.txt`, `.md`, `.json`; `tracking-history.md` appended; exit 0 |
| I2 | `run-experiment.mjs --merchants 3` with mergedMerchants<5 | fs | exits non-zero with the documented `"Insufficient data"` message |
| I3 | `pitch-bridge.mjs --domain apollohospitals.com --max 1` | `execSync` → no-op returning success; fs | produces `results/audit-jsons/apollohospitals-com.json` conforming to §c.7 schema; `execSync` invoked once with `--industry healthcare` |
| I4 | `outreach-generator.mjs --results <fixture>` | fs | produces `outreach-drafts-*.md` containing a row per non-FlowBlinq merchant; draft-only header present |
| I5 | `test-run.mjs` with `DATABASE_URL` pointing to sqlite-postgres shim OR fully mocked `postgres` client | `postgres` mock returning one Manipal row | writes `test-run-healthcare.json`, `test-run-healthcare.md`; zero write-SQL executed (AC-15) |
| I6 | `surface-probes.queryChatGPTShopping` timeout path | OpenAI client throws after `TIMEOUT_MS` | returns `{text:"", citations:[], error:"timeout"}` within `TIMEOUT_MS + 2 s` |
| I7 | `signal-extractor.extractSiteLevelSignals` robots.txt 404 | `fetch` → 404 | `hasRobotsTxt:false, allowsAIBots:true` (no-robots = allow all) |

**Cohort golden test (I8):** validates §c.7 output files match the committed `results/audit-jsons/*.json` byte-for-byte when regenerated from the committed `test-run-healthcare.json` + cohort, confirming the cached pipeline is reproducible.

---

## h) Profiling Requirements

Not applicable. This is an operator-invoked batch tool; there are no SLOs. Runtime is dominated by upstream LLM/Firecrawl latency. A single full `run-experiment.mjs` run with 20 merchants × 5 queries × 5 surfaces ≈ 500 LLM calls at ~2–5 s each ≈ 15–30 min wall. Documented in `EXPERIMENT.md`, not measured here.

---

## i) Load Test Plan

Not applicable. No concurrent users, no service endpoint. The only rate concern is upstream API quota, already mitigated by `BATCH_SIZE=5` + `BATCH_DELAY_MS=500` in `surface-probes.mjs` and 500 ms inter-page sleep in `signal-extractor.mjs`. No load SLO to verify.

---

## j) Logging & Instrumentation

Scripts log to stdout only — decorative unicode box drawings (`═`, `─`), per-merchant progress lines, and per-surface emoji result lines (🟢/🟡/🔴). No structured logger, no log shipping, no metric emission. `run-weekly.sh` tees to `results/run-<DATE>.log`. This is the entire logging surface and is acceptable for an operator-only tool.

**Error paths:** every surface-query fn catches and returns `{error: e.message}` rather than throwing; `crawlAndExtractSignals` lets per-page errors through but the caller (`run-experiment.mjs`) catches and records `{error}` into `signalData[domain]`. Top-level `main()` in each script installs `.catch(e => { console.error(...); process.exit(1); })`.

---

## k) References

- Branch: `pr-1-group-b`, tip `44e5195`.
- Origin commits on `fix/signup-alert-email`: `e01608f..f9c6e2b`.
- Source files verified at commit `44e5195` — every function name, line number, and constant in §c is a line-exact reference; spec-rigour rule: no invented identifiers.
- Reverse-engineering mode per `.agents/CLAUDE.md` §"Reverse-engineering mode for existing branches" (pipeline resumes at ReviewMaster after HP adversarial spec review).
