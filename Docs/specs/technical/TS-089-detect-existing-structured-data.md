# TS-089 — Detect Existing Structured Data on Customer Sites

**Author:** Adithya Rao + Claude
**Date:** 2026-04-09
**Priority:** P0 — every Firecrawl-scraped page falsely reports no structured data
**Scope:** Crawl pipeline, discovery probes, per-page analysis
**Status:** READY FOR DISPATCH

---

## 1. The Bug

Every page crawled via Firecrawl (95%+ of all pages) is flagged as having
no JSON-LD structured data. This is false. The code to detect it already
exists (`extractSchemaTypes` at `geo-crawler.ts:352`) but is only called
on the direct-fetch/ScraperAPI fallback paths.

`mapDocumentToPage` (the Firecrawl path) hardcodes:
```ts
existingSchema: [],
hasStructuredData: false,
```

Root cause: we request only `["markdown"]` from Firecrawl. Markdown strips
all `<script>` tags including `<script type="application/ld+json">`.

### Customer impact
- Per-page vulnerability cards show "High: No JSON-LD structured data found"
  on every page, even sites with rich schema markup
- `structured_data` pillar score capped at 15/100 for all Firecrawl-scraped sites
- Customers who invested in structured data see no credit for it
- The GEO integration badge ("JSON-LD is automatically injected") is shown
  as a workaround, but the underlying score is still penalized

---

## 2. Fix: Add rawHtml to Firecrawl formats

### 2a. Firecrawl batch scrape — add rawHtml format

**File:** `app/api/pipeline/stage/route.ts` (batch scrape call, ~line 366)

Change:
```ts
formats: ["markdown"]
```
To:
```ts
formats: ["markdown", "rawHtml"]
```

**Cost:** Zero additional Firecrawl credits. rawHtml is included in the
same scrape request. Payload increases ~50-200KB per page but we discard
it after extraction (not stored in DB).

### 2b. mapDocumentToPage — use existing extractSchemaTypes

**File:** `lib/services/geo-crawler.ts` (`mapDocumentToPage`, ~line 922)

Currently:
```ts
existingSchema: [],
hasStructuredData: false,
```

Change to:
```ts
const rawHtml = (doc as any).rawHtml as string | undefined;
const schemaTypes = rawHtml ? extractSchemaTypes(rawHtml) : [];
// ...
existingSchema: schemaTypes,
hasStructuredData: schemaTypes.length > 0,
```

`extractSchemaTypes` already exists at line 352 — it parses
`<script type="application/ld+json">` blocks and returns `@type` values.

### 2c. Do NOT store rawHtml in crawlData

The `CrawledPage` type stays unchanged. rawHtml is used only during
`mapDocumentToPage` to extract schema types, then discarded. The DB
payload size is unaffected.

---

## 3. Discovery-phase probes for known asset endpoints

### 3a. New probes during discover stage

Add lightweight HEAD/GET probes for well-known structured data endpoints
during `discoverSite`. Same pattern as existing `/llms.txt` and
`/.well-known/ucp` checks.

| Endpoint | Method | What it tells us |
|----------|--------|-----------------|
| `/feed.xml` or `/feed/` or `/rss.xml` | HEAD | Site has RSS feed (content freshness signal) |
| `/.well-known/agent.json` | HEAD | Site has agent manifest (AI-readiness signal) |
| `/openapi.json` or `/swagger.json` | HEAD | Site exposes API spec (developer-facing signal) |
| `/manifest.json` or `/site.webmanifest` | HEAD | Site is a PWA (modern web signal) |

### 3b. Store on DiscoveryData

Add to the `DiscoveryData` type:
```ts
hasFeed?: boolean;
hasAgentJson?: boolean;
hasOpenApi?: boolean;
hasManifest?: boolean;
```

### 3c. Feed into geo-analyzer

These signals enrich the AI-readiness assessment:
- `hasFeed` → content freshness pillar
- `hasAgentJson` → emerging agent-readiness (bonus, not penalized if absent)
- `hasOpenApi` → technical maturity signal
- `hasManifest` → modern web practices

---

## 4. Enhanced schema extraction (Priority 2)

### 4a. Extract full JSON-LD blocks, not just @type

Currently `extractSchemaTypes` only returns the `@type` string array.
Enhance to also return key fields for richer analysis:

```ts
interface ExtractedSchema {
  type: string;              // e.g. "Organization", "FAQPage"
  name?: string;
  url?: string;
  dateModified?: string;
  hasMainEntity?: boolean;   // FAQPage with questions
}
```

Store as `existingSchemaDetails: ExtractedSchema[]` on `CrawledPage`
(in addition to the existing `existingSchema: string[]` for backward
compatibility).

### 4b. Differentiate schema quality

The per-page analyzer can now distinguish:
- Bare Organization schema (Yoast default) → basic
- Rich FAQPage with 5+ Q&A pairs → good
- Product + Review + BreadcrumbList → excellent
- No schema → vulnerability

---

## 5. Meta tag extraction from rawHtml (Priority 3)

Once rawHtml is available, also extract:
- `<meta property="og:title|description|image">` → Open Graph
- `<meta name="description">` → meta description
- `<link rel="alternate" type="application/rss+xml">` → feed discovery
- `<meta name="robots">` → indexing directives

Store relevant signals on `CrawledPage` for per-page analysis.

---

## 6. TDD Plan

### RED tests (write first):

**Test 1:** `mapDocumentToPage` with Firecrawl doc containing rawHtml with
JSON-LD → `hasStructuredData: true`, `existingSchema: ["Organization"]`
(currently FAILS: hardcoded false)

**Test 2:** `mapDocumentToPage` with Firecrawl doc with NO rawHtml →
`hasStructuredData: false` (regression guard, should PASS)

**Test 3:** `mapDocumentToPage` with rawHtml containing multiple JSON-LD
blocks → returns all `@type` values

**Test 4:** Per-page vulnerability analyzer does NOT flag "No JSON-LD" when
`hasStructuredData: true` (currently FAILS for Firecrawl pages)

**Test 5:** Batch scrape call includes `"rawHtml"` in formats array

**Test 6:** Discovery probes check `/feed.xml`, `/.well-known/agent.json`

### GREEN implementation:
1. Add `"rawHtml"` to Firecrawl formats
2. Update `mapDocumentToPage` to call `extractSchemaTypes`
3. Add discovery probes
4. Update DiscoveryData type
5. Run Docker, verify all tests pass

---

## 7. Execution

| Priority | What | LOC | Risk |
|----------|------|-----|------|
| P0 | rawHtml format + mapDocumentToPage fix | ~10 | Low — using existing function |
| P1 | Discovery probes for known endpoints | ~40 | Low — HEAD requests, fail-soft |
| P2 | Enhanced schema extraction (full blocks) | ~30 | Low — additive |
| P3 | Meta tag extraction | ~40 | Low — additive |

P0 alone fixes the false-negative bug. P1-P3 are enrichments.

---

## 8. Constraints

- rawHtml increases Firecrawl response payload (~50-200KB/page) but is
  discarded after extraction — no DB impact
- HEAD probes must respect the discovery-phase budget (existing 8s total)
- New probes are fail-soft — timeout/error → `false`, no throw
- No new Firecrawl credits consumed
- No new external service dependencies
