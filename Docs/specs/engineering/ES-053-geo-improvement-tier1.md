# ES-053: GEO Improvement Tier 1 — Crawl Intelligence, Tree Extraction, Prompt Generation

**Source:** TS-053-geo-improvement-tier1.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #136 (C1), #137 (C2), #138 (C3), #139 (C4)

---

## a) Overview

### What This Covers

Four interconnected improvements to the GEO pipeline that fix how the system understands a business's scope:

| Component | Summary |
|-----------|---------|
| **C1** | Crawl structural page prioritization — intelligent URL selection before crawl |
| **C2** | Geographic tree extraction from crawl data |
| **C3** | Category/service tree extraction from crawl data |
| **C4** | Citation prompt generation from trees via Sonnet (replaces Haiku generator) |

### Current Implementation State

**Exists:**
- Pipeline: discover → crawl-fanout → poll-chunk → merge-crawl → research → analyze → generate-fanout → generate-chunk×6 → assemble
- `geo/lib/services/geo-crawler.ts` — `discoverSite()` with Firecrawl mapUrl + Gemini page selection for large pools; `mapDocumentToPage()`; `scoreCrawlQuality()`
- `geo/lib/services/citation-prompt-generator.ts` — Haiku-based prompt gen with fallback chain (OpenAI → Google → Perplexity), 48 prompts (40 indirect + 8 direct), pillar-based distribution
- `geo/lib/types/citation.ts` — `CitationPrompt { type, pillar, prompt }`
- `geo/lib/db/schema.ts` — `geoSites` table with `discoveryData`, `crawlData`, pipeline state; `citationCheckScores` with visibility metrics
- `geo/lib/qstash.ts` — `PipelineStage` type, `StagePayload` interface, `enqueueStage()` function
- `geo/app/api/pipeline/stage/route.ts` — stage dispatcher with all handlers
- `geo/app/api/sites/[id]/citation-check/route.ts` — SSE-based citation check

**Does not exist (new):**
- `crawl-prioritizer.ts` service
- `tree-extractor.ts` service
- `extract-trees` pipeline stage
- `geoTree`, `categoryTree`, `geoCategoryMapping` columns on geoSites
- `promptMetadata` column on citationCheckScores
- Tree-based prompt generation logic

### Proposed Pipeline

```
discover* → crawl-fanout → poll-chunk → merge-crawl → EXTRACT-TREES → research → analyze* → generate-fanout → generate-chunk×6* → assemble*
```

New stage: `extract-trees` (between merge-crawl and research).

### Recommended Implementation Order

1. **C2+C3 first** (tree extraction) — new stage + service. Works with existing crawl quality.
2. **C1 next** (crawl priority) — improves tree quality on re-audit.
3. **C4 last** (prompt gen) — consumes cached trees, replaces current generator.

---

## b) Implementation Requirements

### b.1 Schema Changes

**File:** `geo/lib/db/schema.ts`

Add 3 nullable JSONB columns to `geoSites` table (after existing JSONB fields around line 89):

```typescript
// Geographic Circle of Influence (C2)
geoTree: jsonb("geo_tree").$type<GeoTree>(),

// Category Circle of Influence (C3)
categoryTree: jsonb("category_tree").$type<CategoryTree>(),

// Sparse mapping: which categories are valid at which locations (C2+C3)
geoCategoryMapping: jsonb("geo_category_mapping").$type<GeoCategoryMapping>(),
```

Add 1 nullable JSONB column to `citationCheckScores` table (after `promptsUsed` field, around line 277):

```typescript
// Full prompt array with geo/category/tier tags (C4)
promptMetadata: jsonb("prompt_metadata").$type<CitationPrompt[]>(),
```

**SQL migration** (new file `geo/drizzle/XXXX_tree_columns.sql`):

```sql
ALTER TABLE geo_sites
  ADD COLUMN geo_tree jsonb,
  ADD COLUMN category_tree jsonb,
  ADD COLUMN geo_category_mapping jsonb;

ALTER TABLE citation_check_scores
  ADD COLUMN prompt_metadata jsonb;
```

All columns nullable. No default values. No indexes needed (read by PK only).

### b.2 Type Definitions

**File:** `geo/lib/types/trees.ts` (NEW)

```typescript
// ── Geographic Tree ──────────────────────────────────────────────

export type GeoNodeLevel = "global" | "country" | "state" | "city";

export type GeoNode = {
  id: string;           // e.g. "in", "in-ka", "in-ka-blr"
  name: string;         // e.g. "India", "Karnataka", "Bangalore"
  level: GeoNodeLevel;
  children: GeoNode[];
  pageCount: number;    // how many crawled pages reference this location
  evidence: string[];   // sample URLs that reference this location (max 3)
};

export type GeoTree = {
  root: GeoNode;        // level: "global", always present
  leafCount: number;    // total city-level nodes (0 for pure-digital)
  extractedAt: string;  // ISO-8601
};

// ── Category Tree ────────────────────────────────────────────────

export type CategoryNode = {
  id: string;           // e.g. "healthcare", "healthcare-oncology"
  name: string;         // e.g. "Healthcare", "Oncology"
  level: number;        // depth in tree (0 = root)
  children: CategoryNode[];
  pageCount: number;    // how many crawled pages reference this category
  evidence: string[];   // sample URLs (max 3)
};

export type CategoryTree = {
  root: CategoryNode;   // top-level industry node
  leafCount: number;    // total leaf-level service/product nodes
  extractedAt: string;  // ISO-8601
};

// ── Sparse Mapping ───────────────────────────────────────────────

export type GeoCategoryStrength = "strong" | "moderate" | "inferred";

export type GeoCategoryEntry = {
  geoId: string;        // references GeoNode.id (city-level preferred)
  categoryId: string;   // references CategoryNode.id (leaf-level preferred)
  strength: GeoCategoryStrength;
  evidence: string[];   // sample URLs (max 2)
};

export type GeoCategoryMapping = {
  entries: GeoCategoryEntry[];
  totalEntries: number;
  extractedAt: string;  // ISO-8601
};

// ── Extraction Result (returned by tree-extractor) ───────────────

export type TreeExtractionResult = {
  geoTree: GeoTree;
  categoryTree: CategoryTree;
  mapping: GeoCategoryMapping;
};

// ── Empty Trees (constants for fallback) ─────────────────────────

export const EMPTY_GEO_TREE: GeoTree = {
  root: { id: "global", name: "Global", level: "global", children: [], pageCount: 0, evidence: [] },
  leafCount: 0,
  extractedAt: new Date().toISOString(),
};

export const EMPTY_CATEGORY_TREE: CategoryTree = {
  root: { id: "root", name: "Unknown", level: 0, children: [], pageCount: 0, evidence: [] },
  leafCount: 0,
  extractedAt: new Date().toISOString(),
};

export const EMPTY_MAPPING: GeoCategoryMapping = {
  entries: [],
  totalEntries: 0,
  extractedAt: new Date().toISOString(),
};
```

### b.3 C1: Crawl Structural Page Prioritization

**File:** `geo/lib/services/crawl-prioritizer.ts` (NEW)

#### Types

```typescript
export type PagePriorityTier = "P0" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6";

export type SiteArchitecture = {
  navPages: string[];       // URLs found in top-level navigation
  structuralPages: string[]; // URLs matching structural patterns (services, locations, etc.)
  contentPages: string[];    // URLs matching content patterns (blog, articles)
  otherPages: string[];      // everything else
};

type PrioritizedUrl = {
  url: string;
  tier: PagePriorityTier;
  depth: number;             // URL path depth (number of / segments)
};
```

#### Exports

```typescript
/**
 * Detect site architecture from discovered URLs + homepage crawl data.
 * Sources (priority order): sitemap URLs, homepage <nav> links, URL patterns.
 */
export function detectArchitecture(
  urls: string[],
  homepageContent?: string   // homepage HTML/markdown for nav extraction
): SiteArchitecture;

/**
 * Assign priority tier to each URL based on architecture + industry.
 */
export function classifyUrls(
  urls: string[],
  architecture: SiteArchitecture,
  industry?: string
): PrioritizedUrl[];

/**
 * Select top N URLs from prioritized set, respecting tier order and budget constraints.
 * - Fills from P0 down
 * - Within each tier, shallower URLs first
 * - P5 (blog/content) capped at 30% of crawlLimit
 * - Returns ordered URL list
 */
export function prioritizeUrls(
  urls: string[],
  architecture: SiteArchitecture,
  industry?: string,
  crawlLimit?: number         // defaults to maxPages from config
): string[];
```

#### Priority Tier Classification

| Tier | Weight | URL Patterns |
|------|--------|-------------|
| **P0** | 1.0 | `/` (homepage), `/about*`, `/contact*`, `/team*`, `/pricing*` |
| **P1** | 0.9 | `/services/*`, `/products/*`, `/departments/*`, `/specialties/*`, `/solutions/*`, `/features/*` |
| **P2** | 0.9 | `/locations/*`, `/offices/*`, `/branches/*`, `/{city-name}/*` (detected from architecture) |
| **P3** | 0.7 | Any URL in `architecture.navPages` not already classified P0-P2 |
| **P4** | 0.6 | `/faq*`, `/testimonials*`, `/case-studies*`, `/docs*`, `/resources*` |
| **P5** | 0.3 | `/blog/*`, `/articles/*`, `/news/*`, `/press/*` |
| **P6** | 0.2 | Everything else |

#### Industry-Specific Boosts (→ P1)

| Industry Pattern | Boosted URL Patterns |
|-----------------|---------------------|
| healthcare | `/departments/*`, `/doctors/*`, `/specialties/*`, `/treatments/*` |
| ecommerce | `/products/*`, `/categories/*`, `/collections/*`, `/shop/*` |
| saas/software | `/features/*`, `/integrations/*`, `/solutions/*`, `/use-cases/*` |
| education | `/programs/*`, `/courses/*`, `/faculties/*`, `/admissions/*` |
| restaurant/food | `/menu/*`, `/locations/*`, `/catering/*` |

Industry detection: use `geoSites.siteType` if available, else infer from URL patterns.

#### Budget Allocation Algorithm

```
1. Classify all URLs into tiers
2. Sort within each tier by URL depth (ascending — shallower first)
3. Fill budget from P0 through P6:
   - P5 (content) capped at 30% of crawlLimit
   - If structural pages (P0-P2) alone exceed budget, prioritize breadth:
     take first URL per unique path prefix, then fill remaining
4. Return ordered URL list capped at crawlLimit
```

#### Integration Point

**File:** `geo/app/api/pipeline/stage/route.ts` — `handleDiscover()`

After `discoverSite()` returns `discoveryData`, before storing to DB:

```typescript
// C1: Prioritize URLs based on site architecture
const architecture = detectArchitecture(
  discoveryData.urls,
  /* homepage content from discoveryData if available */
);
const prioritizedUrls = prioritizeUrls(
  discoveryData.urls,
  architecture,
  site.siteType,     // industry hint
  maxPages
);

// Replace URL list with prioritized set + store architecture
discoveryData.urls = prioritizedUrls;
discoveryData.siteArchitecture = architecture;
discoveryData.totalPages = prioritizedUrls.length;
```

**File:** `geo/lib/services/geo-crawler.ts` — extend `DiscoveryData`:

```typescript
// Add to DiscoveryData interface (around line 54):
siteArchitecture?: SiteArchitecture;
```

Import `SiteArchitecture` from `crawl-prioritizer.ts`.

### b.4 C2+C3: Tree Extraction (New Pipeline Stage)

**File:** `geo/lib/services/tree-extractor.ts` (NEW)

#### Exports

```typescript
import type { CrawlData, CrawledPage } from "@/lib/services/geo-crawler";
import type { DiscoveryData } from "@/lib/services/geo-crawler";
import type {
  GeoTree, CategoryTree, GeoCategoryMapping, TreeExtractionResult,
  EMPTY_GEO_TREE, EMPTY_CATEGORY_TREE, EMPTY_MAPPING,
} from "@/lib/types/trees";

/**
 * Build the page inventory string from crawl data for the LLM prompt.
 * Includes: URL, pageType, title, H1, headings list.
 * Capped at 200 pages (prioritize structural pages P0-P3).
 */
export function buildPageInventory(
  crawlData: CrawlData,
  siteArchitecture?: SiteArchitecture
): string;

/**
 * Validate extracted trees:
 * - Every node has id, name, level/children
 * - geoId/categoryId refs in mapping exist in trees
 * - geo leafCount ≤ 500, category leafCount ≤ 100, mapping entries ≤ 1000
 * Returns { valid: true } or { valid: false, errors: string[] }.
 */
export function validateTrees(result: TreeExtractionResult): { valid: boolean; errors: string[] };

/**
 * Extract geo tree, category tree, and mapping from crawl data via LLM.
 * Primary: Claude Sonnet 4 (claude-sonnet-4-6)
 * Fallback: GPT-4o
 * Last resort: empty trees (pipeline continues)
 */
export async function extractTrees(
  crawlData: CrawlData,
  discoveryData: DiscoveryData,
  domain: string,
  industry?: string
): Promise<TreeExtractionResult>;
```

#### LLM Call Details

**Model:** `claude-sonnet-4-6`, temperature 0, max_tokens 8000.
**Timeout:** 90 seconds (leave 15s buffer for Vercel's 105s stage timeout).

**System prompt:** As specified in TS-053 §6.3 (geo_tree_rules, category_tree_rules, mapping_rules). Include the output JSON schema.

**User prompt assembly:**

```
<page_inventory>
{buildPageInventory output — max 200 pages}
</page_inventory>

<domain>{domain}</domain>
<industry>{industry or "Unknown"}</industry>

{Optional: generated files summary if available}
<generated_summary>
business.json services: [...]
llms.txt (first 500 chars): ...
</generated_summary>
```

#### Validation & Retry Logic

1. Parse JSON response. If invalid JSON → retry once with temperature 0.3.
2. Call `validateTrees()`. If invalid → retry once with temperature 0.3.
3. After 2 attempts with Sonnet: try GPT-4o with identical prompt.
4. After GPT-4o fails: return `{ geoTree: EMPTY_GEO_TREE, categoryTree: EMPTY_CATEGORY_TREE, mapping: EMPTY_MAPPING }`.
5. Log: `[extract-trees] ${domain}: tree extraction failed, continuing with empty trees`.

#### Error Handling

- `Anthropic.APIError` or timeout → fall to GPT-4o.
- `OpenAI.APIError` or timeout → fall to empty trees.
- Never throw — always return a valid `TreeExtractionResult`.

### b.5 Pipeline Integration for extract-trees

**File:** `geo/lib/qstash.ts`

Add `"extract-trees"` to `PipelineStage` type (between `"merge-crawl"` and `"research"`):

```typescript
export type PipelineStage =
  | "discover"
  | "crawl-fanout"
  | "poll-chunk"
  | "merge-crawl"
  | "extract-trees"   // NEW — C2+C3
  | "research"
  | "analyze"
  | "generate"
  | "generate-fanout"
  | "generate-chunk"
  | "assemble";
```

**File:** `geo/app/api/pipeline/stage/route.ts`

**Modify `handleMergeCrawl()`** — change the enqueue target from `"research"` to `"extract-trees"`:

```typescript
// In handleMergeCrawl(), after storing crawlData:
// BEFORE: await enqueueStage({ ...payload, stage: "research" });
// AFTER:
await enqueueStage({ ...payload, stage: "extract-trees" });
```

Update `pipelineStatus` in merge-crawl to `"extracting"` (new status value) instead of directly going to `"researching"`.

**Add new handler `handleExtractTrees(siteId, domain)`:**

```typescript
async function handleExtractTrees(siteId: string, domain: string) {
  // 1. Read site: crawlData, discoveryData, siteType, generatedBusinessJson, generatedLlmsTxt
  const site = await db.query.geoSites.findFirst({
    where: eq(geoSites.id, siteId),
    columns: {
      crawlData: true,
      discoveryData: true,
      siteType: true,
      generatedBusinessJson: true,
      generatedLlmsTxt: true,
    },
  });

  if (!site?.crawlData) {
    console.error(`[extract-trees] ${domain}: no crawlData, skipping`);
    // Still enqueue research — don't block pipeline
    await enqueueStage({ siteId, domain, stage: "research" });
    return;
  }

  // 2. Extract trees
  const result = await extractTrees(
    site.crawlData as CrawlData,
    site.discoveryData as DiscoveryData,
    domain,
    site.siteType ?? undefined
  );

  // 3. Store trees atomically
  await db.update(geoSites)
    .set({
      geoTree: result.geoTree,
      categoryTree: result.categoryTree,
      geoCategoryMapping: result.mapping,
      pipelineStatus: "researching",
    })
    .where(eq(geoSites.id, siteId));

  // 4. Enqueue next stage
  await enqueueStage({ siteId, domain, stage: "research" });
}
```

**Add to stage dispatcher** (switch statement around line 915):

```typescript
case "extract-trees":
  await handleExtractTrees(siteId, domain);
  break;
```

**Add `"extract-trees"` to retryable stages array** (around line 960):

```typescript
const RETRYABLE_STAGES = ["research", "analyze", "extract-trees", "generate-chunk", "assemble"];
```

### b.6 C4: Citation Prompt Generation from Trees

**File:** `geo/lib/types/citation.ts` — Extend CitationPrompt

```typescript
export type CitationPromptTier = "buy" | "solve" | "learn";
export type CitationQueryType =
  | "definition"
  | "recommendation"
  | "comparison"
  | "evaluation"
  | "how-to"
  | "cost"
  | "landscape"
  | "use-case";

export type CitationPrompt = {
  type:       "indirect" | "direct";
  pillar:     string | null;        // retained for backward compat
  prompt:     string;
  // New fields (C4) — all nullable for backward compat
  geoId?:     string | null;
  categoryId?: string | null;
  tier?:      CitationPromptTier | null;
  queryType?: CitationQueryType | null;
};
```

**File:** `geo/lib/services/citation-prompt-generator.ts` — Major rewrite

#### New Exports

```typescript
import type { GeoTree, CategoryTree, GeoCategoryMapping } from "@/lib/types/trees";
import type { CitationPrompt, CitationPromptTier, CitationQueryType } from "@/lib/types/citation";

type AllocationCase = "A" | "B" | "C";

type SamplingPlan = {
  case: AllocationCase;
  categoryOnly: number;
  geoOnly: number;
  geoCrossCategory: number;
  intentDiverse: number;
  mappingSamples: Array<{ geoId: string; categoryId: string }>;
};

/**
 * Determine allocation case based on tree depth.
 */
export function determineAllocationCase(
  geoTree: GeoTree,
  categoryTree: CategoryTree,
  mapping: GeoCategoryMapping
): AllocationCase;

/**
 * Build the sampling plan for the LLM prompt.
 * - Case A: rich (multi-geo, multi-cat) → 8/6/16/10
 * - Case B: moderate (1-geo, multi-cat) → 15/0/10/15
 * - Case C: shallow (no geo) → 20/0/0/20
 * Selects mapping samples sorted by strength desc, then pageCount desc.
 * Caps: no single geo node >25% of geo-specific prompts, same for category.
 */
export function buildSamplingPlan(
  geoTree: GeoTree,
  categoryTree: CategoryTree,
  mapping: GeoCategoryMapping
): SamplingPlan;

/**
 * Prune tree to max N nodes for LLM prompt (keep most-referenced nodes).
 */
export function pruneTree<T extends { children: T[]; pageCount: number }>(
  root: T,
  maxNodes: number
): T;

/**
 * Generate citation prompts from trees via Sonnet.
 * Primary: claude-sonnet-4-6
 * Fallback 1: gpt-4o
 * Fallback 2: legacy Haiku generator (current behavior, ignores trees)
 * @param site - geoSites row with crawlData, trees, generated files
 * @returns CitationPrompt[] — 40 indirect + 8 direct
 */
export async function generatePrompts(
  site: {
    domain: string;
    siteType?: string | null;
    geoTree?: GeoTree | null;
    categoryTree?: CategoryTree | null;
    geoCategoryMapping?: GeoCategoryMapping | null;
    generatedLlmsTxt?: string | null;
    generatedBusinessJson?: unknown;
    crawlData?: CrawlData | null;
  }
): Promise<CitationPrompt[]>;
```

#### Allocation Case Logic

```
geoLeafCount  = geoTree?.leafCount ?? 0
catLeafCount  = categoryTree?.leafCount ?? 0
mappingCount  = geoCategoryMapping?.totalEntries ?? 0

if (mappingCount > 10):     Case A (rich)
else if (geoLeafCount > 0): Case B (moderate)
else:                        Case C (shallow)
```

| Case | categoryOnly | geoOnly | geoCrossCategory | intentDiverse |
|------|-------------|---------|------------------|---------------|
| A    | 8           | 6       | 16               | 10            |
| B    | 15          | 0       | 10               | 15            |
| C    | 20          | 0       | 0                | 20            |

Within each bucket, tier distribution: 20% buy, 40% solve, 40% learn.

#### Mapping Sampling Algorithm

1. Sort `mapping.entries` by `strength` (strong > moderate > inferred), then by category `pageCount` desc.
2. Select top N for geo×category prompts (N = geoCrossCategory count from plan).
3. Enforce 25% cap per geo node: if a single geoId appears in >25% of selected entries, replace excess with entries from other geoIds.
4. Same 25% cap per category node.

#### LLM Call Details

**Model:** `claude-sonnet-4-6`, temperature 0, max_tokens 4000.

**System prompt:** As specified in TS-053 §7.4 (rules for indirect/direct, geo-specific, category-specific, tier tagging, sentence variation).

**User prompt:** Assembled dynamically per TS-053 §7.4 — business profile, pruned trees (max 50 nodes each), sampling plan.

#### Post-Generation Processing

1. Parse JSON array from LLM response.
2. **Domain leak filter** — strip any indirect prompt containing the domain (existing logic, retained).
3. **Shape validation** — each element has `{ type, prompt }` at minimum; new fields optional.
4. **Geo/category tag validation** — verify `geoId` exists in geoTree, `categoryId` exists in categoryTree. Strip invalid refs (set to null) rather than rejecting the prompt.
5. **Distribution check** — warn (console.warn) if >25% of prompts reference same geo/category node. Do not reject.
6. **Cap** — max 40 indirect + 8 direct.
7. **Backward compat** — set `pillar` to null for tree-generated prompts (or map if queryType aligns with a known GEO_PILLARS entry).

#### Fallback Chain

1. Sonnet → parse/validate → return.
2. If Sonnet fails → GPT-4o with same prompt → parse/validate → return.
3. If GPT-4o fails → call `generatePromptsLegacy(site)` (rename current `generatePrompts` to `generatePromptsLegacy`). This preserves the Haiku→OpenAI→Google→Perplexity chain as final fallback.
4. Log: `[citation-prompts] ${domain}: tree-based generation failed, falling back to legacy generator`.

#### Trees Not Available (Backward Compat Path)

If `geoTree` and `categoryTree` are both null/empty (leafCount=0 on both), skip tree-based generation entirely and go straight to `generatePromptsLegacy()`. This handles:
- Sites audited before C2+C3 deployed (no trees cached)
- Sites where tree extraction failed (empty trees stored)

### b.7 Citation Check Route Changes

**File:** `geo/app/api/sites/[id]/citation-check/route.ts`

**Modify prompt generation call** — pass trees to `generatePrompts()`:

```typescript
// BEFORE:
const prompts = await generatePrompts(site);

// AFTER:
const prompts = await generatePrompts({
  domain: site.domain,
  siteType: site.siteType,
  geoTree: site.geoTree as GeoTree | null,
  categoryTree: site.categoryTree as CategoryTree | null,
  geoCategoryMapping: site.geoCategoryMapping as GeoCategoryMapping | null,
  generatedLlmsTxt: site.generatedLlmsTxt,
  generatedBusinessJson: site.generatedBusinessJson,
  crawlData: site.crawlData as CrawlData | null,
});
```

**Store promptMetadata** — when persisting to `citationCheckScores`:

```typescript
// Add to the INSERT for citationCheckScores:
promptMetadata: prompts,   // full CitationPrompt[] with geo/category/tier tags
```

**Extend site query** — add `geoTree`, `categoryTree`, `geoCategoryMapping` to the columns fetched from geoSites.

### b.8 Generate & Assemble Stage Enrichment

**File:** `geo/app/api/pipeline/stage/route.ts`

Trees are available on geoSites after extract-trees stage. Existing generate-chunk and assemble handlers can optionally read them for enrichment:

- **generate-chunk "llms"**: include tree summary in LLM prompt for better llms.txt.
- **generate-chunk "business"**: include category tree for accurate services list.
- **assemble**: include trees in recommendation generation context.

These are optional enrichments — the handlers should read `geoTree`/`categoryTree` from the site record and include them in LLM prompts if present. If null, existing behavior is preserved.

---

## c) Unit Test Plan

**File:** `geo/__tests__/services/crawl-prioritizer.test.ts` (NEW)

**Minimum coverage:** 90% of crawl-prioritizer.ts

### Test Cases

| # | Test | Input | Expected Output |
|---|------|-------|----------------|
| U1 | detectArchitecture extracts nav pages from homepage | URLs + homepage with `<nav>` links | navPages populated |
| U2 | detectArchitecture classifies structural vs content | URLs with /services/*, /blog/* mix | structuralPages has /services, contentPages has /blog |
| U3 | classifyUrls assigns P0 to homepage, about, contact | `["/", "/about", "/contact"]` | All P0 |
| U4 | classifyUrls assigns P1 to /services/* | `["/services/oncology"]` | P1 |
| U5 | classifyUrls assigns P2 to /locations/* | `["/locations/bangalore"]` | P2 |
| U6 | classifyUrls assigns P5 to /blog/* | `["/blog/post-1"]` | P5 |
| U7 | classifyUrls respects industry boost | `/departments/*` + industry="healthcare" | P1 (boosted from P6) |
| U8 | prioritizeUrls fills P0 first, then P1 | 10 P0 + 20 P1 + 100 P5, limit=50 | First 10 are P0, next 20 are P1, then fill from P5 up to 30% cap |
| U9 | prioritizeUrls caps blog at 30% | 5 P0 + 200 P5, limit=100 | 5 P0 + 30 P5 + 65 P6 (or fewer if none) |
| U10 | prioritizeUrls sorts by depth within tier | `/services/` (depth 1) vs `/services/oncology/treatments` (depth 3) | Shallower first |
| U11 | prioritizeUrls handles empty URL list | `[]` | `[]` |
| U12 | prioritizeUrls with no structural pages | All P5/P6 | Returns up to crawlLimit, blog capped at 30% |

**File:** `geo/__tests__/services/tree-extractor.test.ts` (NEW)

**Minimum coverage:** 85% of tree-extractor.ts

| # | Test | Input | Expected Output |
|---|------|-------|----------------|
| U13 | buildPageInventory formats pages correctly | CrawlData with 5 pages | String with URL, pageType, H1, headings per page |
| U14 | buildPageInventory caps at 200 pages | CrawlData with 300 pages | Output has exactly 200 entries |
| U15 | buildPageInventory prioritizes structural pages | 50 structural + 250 blog pages | Structural pages included, blogs fill remainder |
| U16 | validateTrees accepts valid result | Well-formed TreeExtractionResult | `{ valid: true, errors: [] }` |
| U17 | validateTrees rejects missing node id | GeoNode with no id | `{ valid: false, errors: [...] }` |
| U18 | validateTrees rejects orphan mapping refs | mapping.geoId not in geoTree | `{ valid: false, errors: [...] }` |
| U19 | validateTrees rejects oversized trees | leafCount=600 on geoTree | `{ valid: false, errors: [...] }` |
| U20 | extractTrees returns valid trees for healthcare site | Mock Sonnet response with multi-geo, multi-category | Valid GeoTree + CategoryTree + Mapping |
| U21 | extractTrees returns valid trees for SaaS site | Mock Sonnet response with no geo, moderate category | GeoTree.leafCount=0, CategoryTree populated |
| U22 | extractTrees returns empty trees on Sonnet failure | Mock Sonnet timeout + GPT-4o timeout | EMPTY_GEO_TREE, EMPTY_CATEGORY_TREE, EMPTY_MAPPING |
| U23 | extractTrees falls back to GPT-4o on Sonnet error | Mock Sonnet 500 error | GPT-4o called, returns valid result |
| U24 | extractTrees retries with higher temperature on invalid JSON | Mock Sonnet returns invalid JSON first, valid second | Valid result on second attempt |

**File:** `geo/__tests__/services/citation-prompt-generator.test.ts` (EXTEND existing)

| # | Test | Input | Expected Output |
|---|------|-------|----------------|
| U25 | determineAllocationCase returns "A" for rich trees | mappingCount=50 | "A" |
| U26 | determineAllocationCase returns "B" for moderate | geoLeafCount=3, mappingCount=5 | "B" |
| U27 | determineAllocationCase returns "C" for shallow | geoLeafCount=0, mappingCount=0 | "C" |
| U28 | buildSamplingPlan Case A allocation | Rich trees | { categoryOnly: 8, geoOnly: 6, geoCrossCategory: 16, intentDiverse: 10 } |
| U29 | buildSamplingPlan enforces 25% geo cap | 20 mapping entries all same geoId | mappingSamples diversified |
| U30 | pruneTree keeps top N nodes by pageCount | Tree with 100 nodes | Pruned to 50, highest pageCount retained |
| U31 | generatePrompts with trees calls Sonnet | Site with geoTree + categoryTree | Sonnet called, not Haiku |
| U32 | generatePrompts without trees falls to legacy | Site with null trees | Legacy Haiku generator called |
| U33 | generatePrompts strips domain leak | Sonnet returns indirect prompt containing domain | That prompt removed |
| U34 | generatePrompts validates geo/category tags | Prompt with invalid geoId | geoId set to null, prompt retained |
| U35 | generatePrompts caps at 40 indirect + 8 direct | Sonnet returns 50+10 | Capped to 40+8 |
| U36 | generatePrompts falls back Sonnet→GPT-4o→legacy | Mock all Sonnet + GPT-4o fail | Legacy prompts returned |
| U37 | generatePrompts sets pillar=null for tree prompts | Any tree-based generation | All prompts have pillar=null |

**Mocking requirements:**
- Mock `@anthropic-ai/sdk` for Sonnet calls
- Mock `openai` for GPT-4o calls
- Mock DB queries (`db.query.geoSites.findFirst`) for site data
- Use `vi.mock()` / `vi.spyOn()` (Vitest)

---

## d) Integration Test Plan

**File:** `geo/__tests__/integration/pipeline-extract-trees.test.ts` (NEW)

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT1 | Full pipeline discover→extract-trees | Trigger discover, assert extract-trees enqueued after merge-crawl | extract-trees stage called with correct siteId |
| IT2 | extract-trees stores trees on geoSites | Run handleExtractTrees with real DB | geoTree, categoryTree, geoCategoryMapping columns populated |
| IT3 | extract-trees enqueues research stage | Run handleExtractTrees | Next QStash message is "research" stage |
| IT4 | extract-trees skips gracefully if no crawlData | Call with siteId that has null crawlData | research stage still enqueued, empty trees not stored |
| IT5 | extract-trees retry on transient failure | Sonnet 503 first call, success second | Trees stored after retry |

**File:** `geo/__tests__/integration/citation-check-trees.test.ts` (NEW)

| # | Test | Scenario | Expected |
|---|------|----------|----------|
| IT6 | Citation check reads cached trees | Site has geoTree + categoryTree from prior pipeline run | generatePrompts receives trees, Sonnet prompt includes tree data |
| IT7 | Citation check stores promptMetadata | Complete citation check flow | citationCheckScores.promptMetadata is non-null array |
| IT8 | Citation check with no trees falls back | Site audited before C2+C3 (no trees) | Legacy prompt generator used, check succeeds |
| IT9 | Crawl priority changes URL order | Site with 500 discovered URLs, 200 blog | Stored discoveryData.urls has structural pages first |
| IT10 | End-to-end: discover→trees→citation-check | Full pipeline + citation check | Prompts reference correct geo/category from extracted trees |

**Mocking:** QStash (enqueueStage), Firecrawl (discovery/crawl), LLM providers (Anthropic, OpenAI). Use test DB (Drizzle + test schema).

---

## e) Profiling Requirements

### What to Measure

| Metric | Target | Tool |
|--------|--------|------|
| extract-trees stage latency (LLM call) | < 30s p95 | Custom timer in handler |
| extract-trees total stage time | < 90s p99 (under 105s Vercel limit) | QStash delivery → response timing |
| Tree-based prompt generation latency | < 20s p95 | Custom timer in generatePrompts |
| Memory: page inventory assembly | < 50MB for 200-page site | Node.js heap snapshot |
| Token usage: tree extraction | < 10K input + 4K output per call | Anthropic API usage headers |
| Token usage: prompt generation | < 6K input + 4K output per call | Anthropic API usage headers |

### Baseline Expectations

- Current merge-crawl → research transition: ~0s (direct enqueue)
- New: merge-crawl → extract-trees → research adds ~10-15s median
- Current Haiku prompt gen: ~3-5s
- New Sonnet prompt gen: ~8-12s (acceptable — citation check is user-initiated, SSE streams)

---

## f) Load Test Plan

### Scenarios

| Scenario | Description | Success Criteria |
|----------|-------------|-----------------|
| L1 | 10 concurrent extract-trees stages | All complete < 105s, no timeouts |
| L2 | 50 sequential tree extractions (batch audit) | No OOM, consistent latency |
| L3 | Prompt generation for 100 sites in series | No rate limiting from Anthropic/OpenAI |
| L4 | Large site (500 crawled pages) tree extraction | Inventory pruning works, < 90s |

### Success Criteria

- p50 < 15s, p95 < 30s, p99 < 60s for extract-trees
- p50 < 10s, p95 < 20s for prompt generation
- Zero OOM kills (Node.js heap < 256MB)
- Anthropic rate limit: handled via retry (existing SDK behavior)

### Resource Consumption Bounds

- Memory per extraction: < 50MB (page inventory is string, not full CrawlData)
- LLM cost per pipeline run: +$0.05 (tree extraction) — total pipeline cost increases from ~$0.30 to ~$0.35
- LLM cost per citation check: +$0.04 (Sonnet vs Haiku delta) — total check cost increases from ~$0.02 to ~$0.06

---

## g) Logging & Instrumentation

### Events to Log

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `extract-trees.start` | info | domain, siteId, pageCount | Stage starts |
| `extract-trees.inventory.built` | debug | domain, pageCount, prunedCount | Page inventory assembled |
| `extract-trees.llm.call` | info | domain, provider ("sonnet"\|"gpt4o"), inputTokens | LLM call initiated |
| `extract-trees.llm.response` | info | domain, provider, outputTokens, latencyMs | LLM responded |
| `extract-trees.llm.error` | warn | domain, provider, error.message | LLM call failed |
| `extract-trees.validation.fail` | warn | domain, errors[], attempt | Tree validation failed |
| `extract-trees.fallback.empty` | warn | domain | All providers failed, using empty trees |
| `extract-trees.complete` | info | domain, geoLeafCount, catLeafCount, mappingEntries, latencyMs | Trees stored |
| `crawl-priority.classified` | debug | domain, tierCounts: Record<PagePriorityTier, number> | URL classification complete |
| `crawl-priority.budget` | info | domain, totalUrls, selectedUrls, blogCapped | Budget allocation result |
| `citation-prompts.tree-based` | info | domain, allocationCase, promptCount | Tree-based prompts generated |
| `citation-prompts.tree-fallback` | warn | domain, reason | Fell back to legacy generator |
| `citation-prompts.distribution-skew` | warn | domain, skewedNode, percentage | >25% on single node |

### Metrics to Emit

- `pipeline.extract_trees.duration_ms` (histogram)
- `pipeline.extract_trees.provider` (counter by provider)
- `pipeline.extract_trees.fallback_to_empty` (counter)
- `citation_prompts.allocation_case` (counter by A/B/C)
- `citation_prompts.tree_based` (counter — vs legacy)
- `crawl_priority.blog_percentage` (histogram — % of budget used by blog)

### Log Level Guidance

- **info**: Stage boundaries, LLM calls, completion, budget decisions
- **warn**: Fallbacks, validation failures, distribution skew
- **error**: Unexpected exceptions (should not happen — all paths degrade gracefully)
- **debug**: Inventory details, classification breakdowns

---

## h) Acceptance Criteria

### C1: Crawl Structural Page Prioritization

- [ ] **AC1**: `crawl-prioritizer.ts` exists with `detectArchitecture()`, `classifyUrls()`, `prioritizeUrls()` exports
- [ ] **AC2**: For a site with 500 discovered URLs (200 blog, 30 structural, 270 other), structural pages are crawled first
- [ ] **AC3**: Blog pages (P5) never exceed 30% of the crawl budget
- [ ] **AC4**: `siteArchitecture` is stored in `discoveryData` on geoSites after discover stage
- [ ] **AC5**: Industry-specific patterns boost relevant page types to P1 (healthcare: /departments/*, etc.)
- [ ] **AC6**: Within a priority tier, shallower URLs (fewer path segments) are selected first
- [ ] **AC7**: Empty URL list returns empty result (no crash)
- [ ] **AC8**: Unit tests U1–U12 pass

### C2+C3: Tree Extraction

- [ ] **AC9**: `tree-extractor.ts` exists with `buildPageInventory()`, `validateTrees()`, `extractTrees()` exports
- [ ] **AC10**: `extract-trees` pipeline stage runs after `merge-crawl`, before `research`
- [ ] **AC11**: For a multi-location, multi-service site (e.g., Manipal-like): geoTree has ≥5 city nodes and categoryTree has ≥10 service/specialty nodes
- [ ] **AC12**: For a single-page SaaS site: both trees are shallow (≤3 nodes each), mapping is empty
- [ ] **AC13**: Trees stored on geoSites record as `geo_tree`, `category_tree`, `geo_category_mapping` (JSONB)
- [ ] **AC14**: If Sonnet fails AND GPT-4o fails: pipeline continues with empty trees (no crash, research stage enqueued)
- [ ] **AC15**: Stage completes within 105 seconds (Vercel limit) for sites with up to 200 pages
- [ ] **AC16**: Page inventory capped at 200 pages (structural pages prioritized if >200)
- [ ] **AC17**: Validation rejects: missing node ids, orphan mapping refs, oversized trees (>500 geo leaves, >100 category leaves, >1000 mapping entries)
- [ ] **AC18**: `extract-trees` is in the retryable stages list (max 2 retries with backoff)
- [ ] **AC19**: Unit tests U13–U24 pass

### C4: Citation Prompt Generation from Trees

- [ ] **AC20**: `CitationPrompt` type extended with optional `geoId`, `categoryId`, `tier`, `queryType` fields
- [ ] **AC21**: For a rich-tree site (Case A): prompts include geo×category cross-product queries (e.g., "best oncology hospital in Bangalore")
- [ ] **AC22**: For a shallow-tree site (Case C): prompts are category-focused with no geo queries
- [ ] **AC23**: No single geo node dominates >25% of geo-specific prompts (logged if violated, not hard-rejected)
- [ ] **AC24**: No single category node dominates >25% of category-specific prompts (same: logged, not rejected)
- [ ] **AC25**: Backward compatible: `pillar` field retained (set to null for tree-generated prompts), `pillarVisibility` scoring still computes
- [ ] **AC26**: Fallback to legacy Haiku generator works if: (a) trees are null/empty, OR (b) Sonnet + GPT-4o both fail
- [ ] **AC27**: `promptMetadata` stored on `citationCheckScores` as full `CitationPrompt[]` with tags
- [ ] **AC28**: Domain leak filter still strips indirect prompts containing the domain name
- [ ] **AC29**: Prompt count capped: max 40 indirect + 8 direct
- [ ] **AC30**: Unit tests U25–U37 pass

### Schema & Infrastructure

- [ ] **AC31**: Migration adds `geo_tree`, `category_tree`, `geo_category_mapping` (nullable jsonb) to `geo_sites`
- [ ] **AC32**: Migration adds `prompt_metadata` (nullable jsonb) to `citation_check_scores`
- [ ] **AC33**: All new columns are nullable — no breaking changes to existing rows
- [ ] **AC34**: `PipelineStage` type includes `"extract-trees"`
- [ ] **AC35**: Integration tests IT1–IT10 pass

### Cross-Cutting

- [ ] **AC36**: `pipelineStatus` value `"extracting"` used during extract-trees stage (visible in UI if applicable)
- [ ] **AC37**: No changes to citation execution mechanics (4 providers, batch of 20, scoring — all unchanged)
- [ ] **AC38**: Sites audited before this change (no cached trees) still work: citation check falls back to legacy

---

## ScriptDev Notes

1. **Implementation order matters:** C2+C3 (tree extraction) → C1 (crawl priority) → C4 (prompt gen). C4 depends on cached trees from C2+C3. C1 improves tree quality but is independent.

2. **The `generatePromptsLegacy()` rename:** Current `generatePrompts()` in `citation-prompt-generator.ts` should be renamed to `generatePromptsLegacy()` and kept as the final fallback. New `generatePrompts()` is the tree-based entry point.

3. **Empty tree constants** (`EMPTY_GEO_TREE`, `EMPTY_CATEGORY_TREE`, `EMPTY_MAPPING`) must use `new Date().toISOString()` at call time, not at import time. Implement as factory functions or compute at usage.

4. **Page inventory assembly** in `buildPageInventory()`: use existing `CrawledPage` fields (url, pageType, title, h1, headings). Do NOT include full `content` field — it's 3000 chars per page and would blow the token budget for 200 pages.

5. **Sonnet model ID:** Use `"claude-sonnet-4-6"` (current latest). Use existing Anthropic SDK client from the project.

6. **GPT-4o model ID:** Use `"gpt-4o"` (not mini — this is a complex extraction task). Use existing OpenAI SDK client.

7. **The `siteArchitecture` field** on `DiscoveryData` is in-memory only (stored in the JSONB `discoveryData` column). No separate DB column needed.

8. **Rate limiting note:** Tree extraction adds 1 Sonnet call per pipeline run (~$0.05). At 100 audits/day, that's $5/day. Monitor via Anthropic dashboard.

9. **Vercel timeout:** The 105s `STAGE_TIMEOUT_MS` applies to extract-trees. The LLM call should timeout at 90s to leave buffer for DB write + QStash enqueue.

10. **Bulk audit path:** Bulk audits skip discover (use CSV URLs directly). They still go through merge-crawl → extract-trees. `siteArchitecture` will be null for bulk audits — tree extraction still works (uses URL patterns from crawled pages instead of architecture data).
