# TS-053: GEO Improvement Tier 1 — Crawl Intelligence, Tree Extraction, Prompt Generation

**Author:** CoFounder
**Date:** 2026-03-23
**Branch:** `dev-an-geo`
**Issues:** #136 (C1), #137 (C2), #138 (C3), #139 (C4)
**Status:** Draft

---

## 1. What

Four interconnected changes to the GEO pipeline that fix how the system understands a business's scope:

| Component | Current | Proposed |
|-----------|---------|----------|
| **C1: Crawl page selection** | URL pattern matching, no structural priority | Sitemap/nav-aware page selection with structural page prioritization |
| **C2: Geographic tree** | None | Extract geo tree from crawl data, store on site record |
| **C3: Category tree** | None | Extract category/service tree from crawl data, store on site record |
| **C4: Citation prompt gen** | Single Haiku call, 400 chars grounding | Sonnet, grounded on trees + generated files, geo×category sampling |

## 2. Why

**The Manipal Hospitals case** (3% citation score) revealed a cascade failure validated from first principles:

```
Bad crawl (93/99 blog posts, no structural pages)
  → Weak generated files (llms.txt: "Infectious Disease" as primary service)
    → Misaligned prompts (40 telemedicine queries for a 50-specialty, 30-city hospital chain)
      → Meaningless citation score (3%)
```

**First-principles validation (not Manipal-specific):**
- Every business has a geographic footprint (universal — tree depth varies, graceful degradation)
- Every business has a service/product taxonomy (universal — single-product businesses get shallow trees)
- 400 chars of homepage content is lossy for any business (universal)
- Crawl quality determines everything downstream (pure data pipeline logic)

**Classification:** 38 of 60 recommendations are Universal (first principles), 22 Scale with complexity (graceful degradation to no-op for simple sites). Zero are Manipal-specific.

## 3. Pipeline Integration Point

Current pipeline:
```
discover → crawl-fanout → poll-chunk → merge-crawl → research → analyze → generate-fanout → generate-chunk×6 → assemble
```

Proposed pipeline:
```
discover* → crawl-fanout → poll-chunk → merge-crawl → EXTRACT-TREES → research → analyze* → generate-fanout → generate-chunk×6* → assemble*
```

Changes marked with `*`. New stage: `extract-trees`.

| Change | Where in pipeline | What changes |
|--------|-------------------|--------------|
| C1: Crawl priority | `discover` stage | Page selection logic before crawl-fanout |
| C2+C3: Tree extraction | New `extract-trees` stage (after merge-crawl, before research) | Builds geo + category trees from crawl data |
| C4: Prompt gen | `citation-check` route (separate from pipeline) | Reads cached trees, generates prompts via Sonnet |
| Trees used by | `generate-chunk` (llms, business), `assemble` (recommendations) | Enriches file generation and recommendations |

**Why after merge-crawl, before research:** Trees need the full crawl data (all pages merged). Research stage can use the trees for better competitive intel ("competitors in Bangalore for oncology" vs generic "competitors for manipalhospitals.com"). Analyze and generate stages also benefit.

---

## 4. Schema Changes

### 4.1 New fields on `geoSites`

```typescript
// Geographic Circle of Influence
geoTree: jsonb("geo_tree").$type<GeoTree>(),

// Category Circle of Influence
categoryTree: jsonb("category_tree").$type<CategoryTree>(),

// Sparse mapping: which categories are valid at which locations
geoCategoryMapping: jsonb("geo_category_mapping").$type<GeoCategoryMapping>(),
```

### 4.2 Type Definitions

```typescript
// ── Geographic Tree ──────────────────────────────────────────────

type GeoNode = {
  id: string;           // e.g. "in", "in-ka", "in-ka-blr"
  name: string;         // e.g. "India", "Karnataka", "Bangalore"
  level: "global" | "country" | "state" | "city";
  children: GeoNode[];
  // Crawl-derived evidence
  pageCount: number;    // how many crawled pages reference this location
  evidence: string[];   // sample URLs that reference this location (max 3)
};

type GeoTree = {
  root: GeoNode;        // level: "global", always present
  leafCount: number;    // total city-level nodes (0 for pure-digital)
  extractedAt: string;  // ISO-8601
};

// ── Category Tree ────────────────────────────────────────────────

type CategoryNode = {
  id: string;           // e.g. "healthcare", "healthcare-oncology"
  name: string;         // e.g. "Healthcare", "Oncology"
  level: number;        // depth in tree (0 = root)
  children: CategoryNode[];
  // Crawl-derived evidence
  pageCount: number;    // how many crawled pages reference this category
  evidence: string[];   // sample URLs (max 3)
};

type CategoryTree = {
  root: CategoryNode;   // top-level industry node
  leafCount: number;    // total leaf-level service/product nodes
  extractedAt: string;  // ISO-8601
};

// ── Sparse Mapping ───────────────────────────────────────────────

type GeoCategoryMapping = {
  entries: GeoCategoryEntry[];
  totalEntries: number;
  extractedAt: string;  // ISO-8601
};

type GeoCategoryEntry = {
  geoId: string;        // references GeoNode.id (city-level preferred)
  categoryId: string;   // references CategoryNode.id (leaf-level preferred)
  strength: "strong" | "moderate" | "inferred";
  // "strong": dedicated page exists (e.g. /locations/bangalore/oncology)
  // "moderate": mentioned on a page but no dedicated page
  // "inferred": LLM inferred from context, no direct evidence
  evidence: string[];   // sample URLs (max 2)
};
```

### 4.3 Graceful Degradation Examples

| Business Type | geoTree | categoryTree | mapping |
|---------------|---------|-------------|---------|
| Manipal Hospitals (30 cities, 50 specialties) | Deep: Global→India→{KA,TN,DL,...}→{Bangalore,Chennai,Delhi,...} | Deep: Healthcare→Hospital→{Oncology,Cardiology,Transplant,...} | ~200 entries |
| Local restaurant (1 city, 1 cuisine) | Shallow: Global→India→Maharashtra→Mumbai | Shallow: Food→Restaurant→Italian | 1 entry |
| SaaS tool (no physical presence) | Empty: Global (leaf=0) | Moderate: Software→SEO→{Keyword Research, Rank Tracking} | 0 entries (no geo) |
| Personal blog | Empty: Global (leaf=0) | Shallow: Media→Blog→{Topic} | 0 entries |

---

## 5. C1: Crawl Structural Page Prioritization

### 5.1 Problem

Current page selection in `discover` stage uses URL pattern matching (`/about`, `/pricing`, `/blog`, etc.) with no priority ordering. The crawler processes pages in discovery order, which is often blog-heavy for content-rich sites.

### 5.2 Design

**Phase 1: Architecture detection** (new, runs in `discover` stage before crawl-fanout)

Before selecting pages for crawling, analyze the discovered URL set to understand site structure:

```typescript
type SiteArchitecture = {
  navPages: string[];       // URLs found in top-level navigation
  structuralPages: string[]; // URLs matching structural patterns
  contentPages: string[];    // URLs matching content patterns (blog, articles)
  otherPages: string[];      // everything else
};
```

**Detection sources (in priority order):**
1. **Sitemap.xml** — already fetched in discover stage. Parse all URLs.
2. **Homepage navigation** — extract all links from the homepage's `<nav>` elements and main header/footer links (already in crawlData for homepage).
3. **URL pattern classification** — enhanced pattern matching.

**Phase 2: Priority-ordered page selection**

Assign each discovered URL a priority tier:

| Tier | Pattern | Examples | Weight |
|------|---------|----------|--------|
| **P0: Core structural** | Homepage, /about, /contact, /team, /pricing | Always crawled first | 1.0 |
| **P1: Service/product** | /services/*, /products/*, /departments/*, /specialties/* | High priority | 0.9 |
| **P2: Location** | /locations/*, /offices/*, /{city-name}/* | High priority | 0.9 |
| **P3: Nav-linked** | Any URL found in homepage `<nav>` not already in P0-P2 | Medium priority | 0.7 |
| **P4: Supporting** | /faq, /testimonials, /case-studies, /docs | Medium priority | 0.6 |
| **P5: Content** | /blog/*, /articles/*, /news/* | Lower priority | 0.3 |
| **P6: Other** | Everything else | Lowest | 0.2 |

**Page budget allocation:**
- Given a crawl limit of N pages, fill from P0 down.
- Within each tier, sort by URL depth (shallower first — `/departments/` before `/departments/oncology/treatments/chemo/side-effects`).
- P5 (blog/content) gets at most 30% of the page budget, ensuring structural pages are always crawled.
- If structural pages alone exceed budget, prioritize breadth over depth within each tier.

**Industry-specific boost** (uses industry classifier output if available):

| Industry | Boosted patterns (→ P1) |
|----------|------------------------|
| Healthcare | /departments/*, /doctors/*, /specialties/*, /treatments/* |
| E-commerce | /products/*, /categories/*, /collections/*, /shop/* |
| SaaS | /features/*, /integrations/*, /solutions/*, /use-cases/* |
| Education | /programs/*, /courses/*, /faculties/*, /admissions/* |
| Restaurant | /menu/*, /locations/*, /catering/* |

### 5.3 Changes to Existing Code

**File:** `lib/services/geo-crawler.ts` (or new `lib/services/crawl-prioritizer.ts`)

- New function: `prioritizeUrls(urls: string[], siteArchitecture: SiteArchitecture, industry?: string, crawlLimit: number): string[]`
- Called in `discover` stage after URL collection, before `crawl-fanout`
- Returns reordered URL list capped at `crawlLimit`
- The `discoveryData.urls` stored on geoSites should reflect the prioritized set, not the raw discovery order

**File:** `app/api/pipeline/stage/route.ts` (discover handler)

- After fetching sitemap + homepage, call `prioritizeUrls()` before storing `discoveryData`
- Add `siteArchitecture` to `discoveryData` for downstream use

---

## 6. C2 + C3: Tree Extraction (New Pipeline Stage)

### 6.1 Stage: `extract-trees`

**Trigger:** Enqueued by `merge-crawl` after crawl data is assembled.
**Input:** Full `crawlData` (all pages), `discoveryData` (all URLs + pageMap), `siteArchitecture` (from C1).
**Output:** `geoTree`, `categoryTree`, `geoCategoryMapping` stored on geoSites.
**Model:** Claude Sonnet 4 (`claude-sonnet-4-6`)
**Timeout:** 105 seconds (Vercel limit)
**Cost:** ~$0.05 per extraction (8K input, 2K output)

### 6.2 Input Assembly

Build a structured extraction prompt from:

1. **Page inventory** (all crawled pages — URL, pageType, title, H1, headings list):
   ```
   Page 1: /departments/oncology | type: services | H1: "Oncology Department" | headings: ["Types of Cancer We Treat", "Our Oncologists", ...]
   Page 2: /locations/bangalore | type: about | H1: "Manipal Hospital Bangalore" | headings: ["Address", "Departments Available", ...]
   ...
   ```
   - Use URL + title + H1 + heading list per page. NOT full page content (too large).
   - Cap at 200 pages. If more, prioritize P0-P3 (structural) pages.

2. **Domain and industry** (from geoSites):
   ```
   Domain: manipalhospitals.com
   Industry: Healthcare (high confidence)
   ```

3. **Generated files summary** (if already generated in a prior run):
   - business.json services list
   - llms.txt first 500 chars

### 6.3 LLM Prompt Design

**System prompt:**
```
You are a business analyst extracting the geographic and service footprint of a business from its website structure.

You will receive a page inventory (URL, title, headings) from a crawled website.
Extract two hierarchical trees and a mapping between them.

<geo_tree_rules>
- Hierarchy: global → country → state/province → city
- Only include locations where the business has a PHYSICAL presence (office, store, clinic, warehouse)
- A location page (/locations/bangalore) is strong evidence
- A city name in a heading ("Our Bangalore Team") is moderate evidence
- If only one country is detected, omit the global level for brevity
- Pure-digital businesses with no physical presence: return empty tree (root only, no children)
- Leaf node = city. Do NOT go below city level.
</geo_tree_rules>

<category_tree_rules>
- Root = industry (e.g., "Healthcare", "Software", "Food Service")
- Intermediate nodes = business lines / departments / product categories
- Leaf nodes = specific services / products / specialties
- Only include categories evidenced by the page inventory
- A dedicated page (/departments/oncology) is strong evidence
- A heading mentioning a service ("Cardiology Services") is moderate evidence
- Do NOT infer categories not evidenced in the pages
- Keep depth ≤ 4 levels. Keep leaf count ≤ 100.
</category_tree_rules>

<mapping_rules>
- Map category leaf nodes to geo leaf nodes where evidence exists
- A page like /locations/bangalore/oncology maps oncology → bangalore (strong)
- A page about oncology that mentions "available in Bangalore and Delhi" maps oncology → bangalore, oncology → delhi (moderate)
- If no geographic overlap evidence exists, omit the mapping entry
- strength: "strong" (dedicated page), "moderate" (mentioned), "inferred" (contextual)
- For businesses with no geo presence: return empty mapping
</mapping_rules>

Return ONLY valid JSON matching the schema below. No prose. No markdown fences.
```

**Output schema (provided in prompt):**
```json
{
  "geoTree": { "root": { "id": "...", "name": "...", "level": "...", "children": [...], "pageCount": 0, "evidence": [] } },
  "categoryTree": { "root": { "id": "...", "name": "...", "level": 0, "children": [...], "pageCount": 0, "evidence": [] } },
  "mapping": [
    { "geoId": "...", "categoryId": "...", "strength": "strong|moderate|inferred", "evidence": ["url1"] }
  ]
}
```

**User prompt:** The assembled page inventory + domain + industry context.

### 6.4 Validation

After LLM returns:
1. Parse JSON. If invalid, retry once with temperature 0.1 → 0.3.
2. Validate tree structure: every node has `id`, `name`, `level`, `children` array.
3. Validate mapping: every `geoId` exists in geo tree, every `categoryId` exists in category tree.
4. Validate sizes: geo leafCount ≤ 500, category leafCount ≤ 100, mapping entries ≤ 1000.
5. If validation fails after retry, store empty trees (graceful degradation — pipeline continues).

### 6.5 Fallback

If Sonnet is unavailable or times out:
- Try GPT-4o as fallback (same prompt, OpenAI API).
- If all fail: store empty trees. Pipeline continues without trees.
- Log warning: `[extract-trees] ${domain}: tree extraction failed, continuing with empty trees`

### 6.6 Storage

Atomic update on geoSites:
```sql
UPDATE geo_sites
SET geo_tree = $geoTree,
    category_tree = $categoryTree,
    geo_category_mapping = $mapping,
    pipeline_status = 'researching'
WHERE id = $siteId
```

Then enqueue `research` stage (next in pipeline).

---

## 7. C4: Citation Prompt Generation from Trees

### 7.1 Overview

Replace `citation-prompt-generator.ts` with a new Sonnet-powered generator that reads cached trees and samples from the geo × category cross-product.

**Triggered:** During citation-check route (unchanged — still a separate user action).
**Input:** `geoTree`, `categoryTree`, `geoCategoryMapping`, `generatedLlmsTxt`, `generatedBusinessJson`, `domain`, `siteType`.
**Output:** `CitationPrompt[]` (same type as today, extended with geo/category tags).
**Model:** Claude Sonnet 4 (`claude-sonnet-4-6`)
**Cost:** ~$0.05 per generation

### 7.2 Extended CitationPrompt Type

```typescript
export type CitationPrompt = {
  type:       "indirect" | "direct";
  pillar:     string | null;        // retained for backward compatibility
  prompt:     string;
  // New fields
  geoId:      string | null;        // references GeoNode.id (null if not geo-specific)
  categoryId: string | null;        // references CategoryNode.id (null if not category-specific)
  tier:       "buy" | "solve" | "learn" | null; // business-value tier (null for direct)
  queryType:  string | null;        // one of 8 types: definition, recommendation, comparison, evaluation, how-to, cost, landscape, use-case
};
```

### 7.3 Prompt Budget Allocation

Total: 40 indirect + 8 direct = 48.

**Indirect prompt allocation (40 total):**

The allocation depends on tree depth:

**Case A: Rich trees (multi-location, multi-service — e.g., Manipal)**
| Bucket | Count | Example |
|--------|-------|---------|
| Category-only (national/global) | 8 | "best hospitals for organ transplant in India" |
| Geo-only (city/region) | 6 | "top hospitals in Bangalore" |
| Geo × Category (cross-product) | 16 | "best oncology hospital in Bangalore" |
| Intent-diverse (how-to, evaluation) | 10 | "how to choose a hospital for knee replacement" |

**Case B: Moderate trees (single-location, multi-service — e.g., local multi-specialty clinic)**
| Bucket | Count | Example |
|--------|-------|---------|
| Category-only | 15 | "best dental clinics for implants" |
| Geo × Category | 10 | "best dental implant clinic in Austin" |
| Intent-diverse | 15 | "what to expect during a root canal" |

**Case C: Shallow trees (single-product, no geo — e.g., SaaS tool)**
| Bucket | Count | Example |
|--------|-------|---------|
| Category-only | 20 | "best SEO tools for keyword research in 2026" |
| Intent-diverse | 20 | "how to track keyword rankings over time" |

**Allocation algorithm:**
```
geoLeafCount = geoTree.leafCount
catLeafCount = categoryTree.leafCount
mappingCount = geoCategoryMapping.totalEntries

if mappingCount > 10:     Case A (rich)
else if geoLeafCount > 0: Case B (moderate)
else:                      Case C (shallow)
```

**Within each bucket, sample by business-value tier:**
- 20% Buy (recommendation, comparison)
- 40% Solve (how-to, evaluation, use-case)
- 40% Learn (definition, landscape, cost)

**Sampling from cross-product:**
- Sort mapping entries by `strength` (strong first), then by category `pageCount` (higher = more important).
- Sample top N entries for geo × category prompts.
- Ensure no single geo node gets more than 25% of geo-specific prompts (spread across cities).
- Ensure no single category node gets more than 25% of category-specific prompts (spread across services).

### 7.4 Prompt Generation LLM Call

**Model:** Claude Sonnet 4 (`claude-sonnet-4-6`), temperature 0, max_tokens 4000.

**System prompt:**
```
You are a market query generator for AI citation measurement.
Generate natural-language questions that real buyers and researchers type into ChatGPT, Perplexity, and Google AI.

You will receive:
1. A business profile (domain, industry, generated summary)
2. A geographic tree (where the business operates)
3. A category tree (what services/products the business offers)
4. A sampling plan (how many prompts per bucket)

Generate queries that match the sampling plan exactly.

<rules>
- Indirect queries MUST NOT contain the domain name or any variation of it
- Direct queries MUST contain the domain name
- Every query must sound like a real buyer question that naturally produces a ranked list
- Geo-specific queries must name the city/region explicitly
- Category-specific queries must reference the specific service/product
- Cross-product queries combine both: "best {category} in {city}"
- Vary sentence structure — no two queries should share the same template
- Tag each query with its geoId, categoryId, tier, and queryType
</rules>
```

**User prompt (assembled dynamically):**
```
<business>
Domain: {domain}
Industry: {siteType or categoryTree.root.name}
Summary: {generatedLlmsTxt first 1000 chars OR generatedBusinessJson}
</business>

<geo_tree>
{JSON of geoTree, pruned to max 50 nodes}
</geo_tree>

<category_tree>
{JSON of categoryTree, pruned to max 50 nodes}
</category_tree>

<sampling_plan>
Case: {A|B|C}
Allocation:
- category_only: {N} queries
- geo_only: {N} queries
- geo_x_category: {N} queries (use these mapping entries: [{geoId, categoryId}, ...])
- intent_diverse: {N} queries
Total indirect: 40
Total direct: 8 (use standard templates with {domain})

Tier distribution per bucket: 20% buy, 40% solve, 40% learn
</sampling_plan>

Generate 48 queries as a JSON array. Return ONLY valid JSON.
```

### 7.5 Post-Generation Processing

Retained from current system:
1. **Domain leak filter** — strip indirect prompts leaking domain name (unchanged)
2. **Validation** — array ≥20, correct shape (extended for new fields)
3. **Cap** — 40 indirect + 8 direct max

New:
4. **Geo/category tag validation** — verify geoId/categoryId references exist in trees
5. **Distribution check** — warn if >25% of prompts reference same geo/category node

### 7.6 Fallback

If Sonnet fails:
1. Try GPT-4o (same prompt).
2. If all fail: fall back to current Haiku generator (ignore trees, use 400-char grounding). This ensures citation check never fails entirely.
3. Log: `[citation-prompts] ${domain}: tree-based generation failed, falling back to legacy generator`

### 7.7 Backward Compatibility

- `pillar` field retained on CitationPrompt (set to null for tree-generated prompts, or mapped if query type aligns with a pillar)
- `pillarVisibility` scoring still works (null-pillar prompts excluded from pillar breakdown, included in overall)
- New fields (`geoId`, `categoryId`, `tier`, `queryType`) are nullable — old prompts without them still work
- `promptsUsed` on citationCheckScores stores the prompt strings (unchanged)
- New: `promptMetadata` field on citationCheckScores (jsonb) stores the full CitationPrompt array with tags for per-city/per-category scoring

---

## 8. Dependencies

```
C1 (crawl priority) ← no dependency, modifies discover stage
C2+C3 (tree extraction) ← depends on C1 (better crawl = better trees, but works without it)
C4 (prompt gen) ← depends on C2+C3 (reads cached trees, falls back to legacy if empty)
```

**Recommended implementation order:**
1. C2+C3 first (tree extraction) — can work with existing crawl quality, provides immediate value
2. C1 next (crawl priority) — improves tree quality for re-audits
3. C4 last (prompt gen) — consumes trees, replaces current generator

**Rationale:** C2+C3 on existing crawl data still extracts better trees than none. C1 improves things further on re-audit. C4 is the user-facing payoff.

---

## 9. Acceptance Criteria

### C1: Crawl Priority
- [ ] For a site with 500 discovered URLs (200 blog, 30 structural, 270 other), structural pages are crawled first
- [ ] Blog pages never exceed 30% of the crawl budget
- [ ] `siteArchitecture` is stored in `discoveryData`
- [ ] Industry-specific patterns boost relevant page types to P1

### C2+C3: Tree Extraction
- [ ] `extract-trees` stage runs after `merge-crawl`, before `research`
- [ ] For Manipal Hospitals: geo tree has ≥5 city nodes (Bangalore, Delhi, Kolkata, Gurugram, ...) and category tree has ≥10 specialty nodes (Oncology, Cardiology, Neurology, ...)
- [ ] For a single-page SaaS site: both trees are shallow (≤3 nodes each), mapping is empty
- [ ] Trees stored on geoSites record as `geo_tree`, `category_tree`, `geo_category_mapping`
- [ ] If Sonnet fails, pipeline continues with empty trees (no crash)
- [ ] Stage completes within 105 seconds (Vercel limit)

### C4: Prompt Generation
- [ ] For Manipal (rich trees): prompts include "best oncology hospital in Bangalore", "top hospitals in Delhi", etc. — not "telemedicine" tunnel vision
- [ ] For SaaS tool (shallow trees): prompts are category-focused, no geo queries
- [ ] Each prompt tagged with geoId, categoryId, tier, queryType
- [ ] No single geo/category node dominates >25% of prompts
- [ ] Backward compatible: pillar field retained, pillarVisibility still computes
- [ ] Fallback to legacy generator works if Sonnet unavailable
- [ ] promptsUsed + promptMetadata stored on citationCheckScores

---

## 10. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Sonnet timeout on large sites (>200 pages) | High | Prune page inventory to 200 entries. Summarize rather than enumerate. |
| Tree extraction adds pipeline latency | Medium | Single LLM call, ~5-10s. Small vs overall pipeline time (2-5 min). |
| LLM hallucates locations/categories not on site | Medium | Validation: every node must have pageCount>0 or evidence URL. Drop ungrounded nodes. |
| Empty trees for poorly crawled sites (pre-C1) | Medium | Acceptable — falls back to legacy behavior. C1 fixes this on re-audit. |
| Schema migration for new fields | Low | All new fields are nullable jsonb. No migration needed — just add columns. |
| Cost increase for prompt generation | Low | $0.05 per extraction + $0.05 per prompt gen = $0.10 total. Revenue $1.00/check. 85% margin. |

---

## 11. Out of Scope

- Per-city / per-category visibility breakdown in scoring (C5 — Tier 2)
- Geographic signals scoring pillar (C7 — Tier 2)
- Content strategy scoring (C8 — Tier 3)
- Content zone suggestions (C9 — Tier 3)
- Real prompt discovery from PAA/Reddit (C12 — Tier 4)
- Content optimization / rewriting (Tier 3-4)
- Changes to citation execution (4 providers, batch of 20 — no change)

---

## 12. Files Affected

| File | Change |
|------|--------|
| `lib/db/schema.ts` | Add `geoTree`, `categoryTree`, `geoCategoryMapping` fields to geoSites |
| `lib/services/crawl-prioritizer.ts` | **New.** Page priority scoring and budget allocation |
| `lib/services/tree-extractor.ts` | **New.** Geo + category tree extraction via Sonnet |
| `lib/services/citation-prompt-generator.ts` | **Replace.** Tree-based prompt generation via Sonnet |
| `app/api/pipeline/stage/route.ts` | Add `extract-trees` stage handler. Modify `discover` to call crawl-prioritizer. |
| `app/api/sites/[id]/citation-check/route.ts` | Pass trees to new prompt generator. Store `promptMetadata`. |
| `lib/types/citation.ts` | Extend `CitationPrompt` type with new fields |

---

## 13. New DB Columns

```sql
ALTER TABLE geo_sites
  ADD COLUMN geo_tree jsonb,
  ADD COLUMN category_tree jsonb,
  ADD COLUMN geo_category_mapping jsonb;

ALTER TABLE citation_check_scores
  ADD COLUMN prompt_metadata jsonb;
```

All nullable. No migration script needed — Drizzle handles additive column changes.
