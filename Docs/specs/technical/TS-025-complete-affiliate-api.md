# TS-025 — Complete Affiliate API: Wire Pipeline Stages, Analytics, Tests, Deploy

**Date:** 2026-03-04
**Priority:** P2
**Status:** HOLD — dispatch to SpecMaster after WordPress plugin (TS-019) is released
**Author:** CoFounder (Agent 1)

---

## What

Finish the remaining ~30% of the standalone Hono affiliate microservice at `/home/aditya/flowblinq_stage/affiliate-api/`. The service is structurally complete (schema, pipeline runner, attribution, commission ledger) but two pipeline stages are unwired stubs and analytics aggregation is unimplemented. Test coverage is ~30%.

---

## Why

The affiliate service is the monetization engine for Flowblinq's content portal. Brands pay commissions when affiliate-generated content drives conversions. Until the service is complete, no affiliate revenue can flow. This is a direct revenue dependency.

Shipping constraint: Do NOT touch this until the WordPress plugin (TS-019/ES-019) is released and stable. Affiliate infrastructure is isolated from the v1 API — no shared routes, no shared schema.

---

## Dependencies

- TS-019 (WordPress Plugin + Public API) released and stable in production
- Postgres DB for affiliate-api (isolated, port 4005 locally) — already provisioned
- `BRANDS_API_URL` env var pointing to the ACP brands service
- `GEO_BASE_URL` env var pointing to the GEO service (`/api/serve/{slug}/business.json`)
- `INTERNAL_API_KEY` already used in `brand-fetcher.ts`

---

## Current State Assessment

**Location:** `/home/aditya/flowblinq_stage/affiliate-api/`

**Schema (complete):** 8-table Postgres schema — `content_pages`, `affiliate_links`, `attributions`, `commissions`, `commission_rules`, `link_clicks`, `content_access_logs`, `content_generation_jobs`

**Pipeline runner (complete):** 5-stage async orchestrator in `src/pipeline/runner.ts`

**Attribution engine (complete):** `src/services/attribution-engine.ts` — direct-click / same-session / time-window with confidence scores

**Commission ledger (complete):** `src/services/commission-service.ts` — pending → confirmed → paid → reversed state machine

**Routes (complete):** `brands-portal`, `commissions`, `content`, `directory`, `links`, `admin`, `analytics`, `internal`

**Incomplete:**

| Component | File | Gap |
|-----------|------|-----|
| Brand Discovery stage | `src/pipeline/stages/brand-discovery.ts` | Fetches active brands and scores them — but `fetchActiveBrands()` is not wired to real `BRANDS_API_URL/.well-known/acp/brands`. Service currently works from `brand-fetcher.ts` which IS correctly implemented. Pipeline stage needs to call the service correctly. |
| GEO Optimization stage | `src/pipeline/stages/geo-optimization.ts` | Builds Schema.org markup but does NOT fetch a brand's actual GEO score from `GET /api/serve/{slug}/business.json`. `geoScore` defaults to null / 30 in the brand scoring composite. |
| Analytics aggregation | `src/routes/analytics.ts` | Routes exist but metrics (CTR, conversion rate, revenue) are not computed from `link_clicks` + `attributions` + `commissions` tables. Likely returns empty/stub data. |
| Test coverage | All `*.test.ts` | ~30% — mostly integration stubs. Core services (attribution, commission) have tests; pipeline stages do not. |

---

## Phase A: Wire Pipeline Stages

### A1 — Brand Discovery: verify `brand-fetcher.ts` integration

`brand-discovery.ts` calls `fetchActiveBrands()` from `brand-fetcher.ts`, which already uses `BRANDS_API_URL`. The stage appears structurally correct — it fetches brands, fetches feeds, scores compositely, and selects top N.

**Gap to close:** The `geoScore` field in the composite scoring uses `fetchGeoScore(brand.slug)` from `brand-fetcher.ts`. Verify that `fetchGeoScore` is implemented and hitting `GET {GEO_BASE_URL}/api/serve/{slug}/business.json`. If not, implement it.

Expected `business.json` response shape (from GEO service):
```json
{
  "domain": "example.com",
  "overallScore": 68,
  "pillars": [...],
  "generatedAt": "2026-03-04T..."
}
```

`fetchGeoScore(slug)` should return `overallScore` as a number (0–100) or `null` on 404/error.

### A2 — GEO Optimization: enrich Schema.org with real GEO scores

`geo-optimization.ts` currently generates valid Schema.org ItemList markup using brand data and content but does not incorporate real GEO scores into the output.

**Change:** Add a `geoScore` field to each brand's `ListItem` as a custom extension:
```json
{
  "@type": "ListItem",
  "position": 1,
  "item": {
    "@type": "LocalBusiness",
    "name": "Brand Name",
    "url": "https://affiliate.flowblinq.com/afl/brand-slug",
    "additionalProperty": {
      "@type": "PropertyValue",
      "name": "flowblinqGeoScore",
      "value": 68
    }
  }
}
```

This is a non-breaking extension — AI crawlers can use or ignore the custom property.

**Source of GEO score:** The `BrandData` object flowing through the pipeline already has `geoScore` from Step A1. No new API calls in the optimization stage.

---

## Phase B: Analytics Aggregation

### B1 — Implement metric computation

`src/routes/analytics.ts` must compute and return:

| Metric | Computation |
|--------|------------|
| `totalClicks` | COUNT of `link_clicks` rows in period |
| `uniqueVisitors` | COUNT DISTINCT `visitor_id` in `link_clicks` |
| `attributions` | COUNT of `attributions` rows by `attribution_type` |
| `conversionRate` | `attributions.length / link_clicks.length × 100` |
| `pendingRevenue` | SUM of `commissions.amount` WHERE `status = 'pending'` |
| `confirmedRevenue` | SUM of `commissions.amount` WHERE `status = 'confirmed'` |
| `paidRevenue` | SUM of `commissions.amount` WHERE `status = 'paid'` |
| `topContentPages` | Top 5 `content_pages` by click count via JOIN |
| `topBrands` | Top 5 brands by attribution count |

**Query pattern:** Accept `?from=` and `?to=` ISO date params (default: last 30 days). All queries filter by date range on `created_at`.

**Caching:** Wrap in a 5-minute in-memory cache keyed by `(from, to)` string. No Redis required — Hono middleware or simple Map.

### B2 — `content_generation_jobs` status endpoint

`GET /analytics/jobs` — returns pending/running/complete/failed job counts. Supports operator monitoring of pipeline health.

---

## Phase C: Test Coverage ≥ 70%

### C1 — Unit tests for pipeline stages

`src/pipeline/stages/brand-discovery.test.ts` — mock `fetchActiveBrands`, `fetchBrandFeed`, `fetchGeoScore`. Verify:
- Composite scoring formula (weights: ACP 40%, GEO 30%, catalog 15%, diversity 15%)
- Filtering of brands with 0 products
- Top-N selection by content type

`src/pipeline/stages/geo-optimization.test.ts` — verify Schema.org output shape, `additionalProperty` field, ItemList structure.

`src/pipeline/stages/content-generation.test.ts` — mock LLM call, verify content structure.

`src/pipeline/stages/quality-check.test.ts` — verify readability scoring.

`src/pipeline/stages/publishing.test.ts` — mock DB insert, verify `content_pages` row shape.

### C2 — Integration tests for analytics routes

`src/routes/analytics.test.ts` — seed `link_clicks`, `attributions`, `commissions`; verify aggregated metrics match expected values. Test date range filtering.

### C3 — Existing tests pass

All existing `*.test.ts` files must pass. No regressions.

---

## Phase D: Deployment

### D1 — Railway deployment (recommended over Vercel)

Rationale: The affiliate-api is a long-running Hono Node.js server (port 4005) with persistent state. Vercel serverless functions have 60s timeout and no persistent connections. Railway supports always-on Node.js services natively.

**Deployment spec:**
- `railway.toml` at repo root: `startCommand = "node dist/server.js"`, `buildCommand = "npm run build"`
- Environment variables: `DATABASE_URL`, `BRANDS_API_URL`, `GEO_BASE_URL`, `INTERNAL_API_KEY`, `PORT=4005`
- Health check: `GET /health` → `{ status: "ok", version: "..." }`
- Auto-deploy from `main` branch on push

**Alternative — Vercel separate project:**
If Railway is not available, Vercel can host this as a separate project with serverless function adapter. Requires `@hono/vercel` adapter. Max execution time constraint applies — analytics aggregation queries must complete in <60s.

**Recommended:** Railway. Simpler ops, no timeout constraints.

### D2 — Database migration

The affiliate-api schema is isolated (separate DB from GEO). Migrations run via `drizzle-kit push` against `DATABASE_URL`. Include `npm run db:migrate` as part of the Railway deploy hook.

---

## Files to Change

| File | Change |
|------|--------|
| `src/services/brand-fetcher.ts` | Verify/implement `fetchGeoScore(slug)` → hits `GET {GEO_BASE_URL}/api/serve/{slug}/business.json`, returns `overallScore` or null |
| `src/pipeline/stages/geo-optimization.ts` | Add `additionalProperty` GEO score extension to each ListItem |
| `src/routes/analytics.ts` | Implement metric aggregation queries (see B1); add 5-min cache |
| `src/pipeline/stages/brand-discovery.test.ts` | New: unit tests for composite scoring and top-N selection |
| `src/pipeline/stages/geo-optimization.test.ts` | New: unit tests for Schema.org output |
| `src/routes/analytics.test.ts` | New: integration tests for aggregated metrics |
| `railway.toml` | New: Railway deployment config |
| `src/server.ts` | Add `GET /health` endpoint |

---

## Acceptance Criteria

1. **Brand Discovery:** `discoverBrands()` returns brands with real GEO scores (not null/default-30). Test: mock `fetchGeoScore` to return 75 → verify composite score = `acpScore×0.4 + 75×0.3 + catalogNorm×0.15 + 50×0.15`.

2. **GEO Optimization:** `optimizeForGeo()` output includes `additionalProperty.value` = GEO score for each ListItem. Test: verify JSON-LD shape.

3. **Analytics:** `GET /analytics/summary?from=2026-01-01&to=2026-03-04` returns all 9 metrics with correct values. Cached response on second call (same params, <5min).

4. **Health check:** `GET /health` returns `200 { status: "ok" }`.

5. **Test coverage ≥ 70%:** Measured by vitest coverage report. Pipeline stages and analytics route must individually exceed 70%.

6. **No regressions:** All pre-existing tests pass.

7. **Railway deploy:** Service starts on Railway with correct environment variables. `npm run build && node dist/server.js` completes without errors.

8. **Hard isolation:** Zero imports from GEO codebase (`/home/aditya/flowblinq/geo`). All GEO data fetched via HTTP (`GEO_BASE_URL`).

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `GEO_BASE_URL` business.json endpoint not deployed yet | Medium | Verify ES-023 includes `GET /api/serve/{slug}/business.json`. If not, add stub fallback (geoScore = null) and file separate issue. |
| Railway billing not set up | Low | Verify with Aditya before deploying. Vercel is fallback. |
| Analytics queries slow on large datasets | Low | Add `created_at` indexes if not present. Cache absorbs repeat queries. |
| Hono version incompatibility with railway.toml | Low | Use latest Hono stable. Test `npm run build` locally before deploy PR. |

---

## Out of Scope

- `/api/v1/*` affiliate endpoints (wait for WP release to be stable)
- WordPress plugin integration with affiliate routes
- Dashboard UI for affiliate analytics (TS-026)
- ACP commerce dashboard (separate product)
