# TS-044: Per-Page Fixes, Tone Shift, and ZIP for All Audit Modes

## What

Enhance the GEO audit report with:
1. Per-page fix generation (suggested titles, meta descriptions, heading fixes, pillar-specific fixes)
2. Technical tone shift in LLM-generated text for paid/connected users
3. Per-page analysis for single audits (currently bulk-only)
4. ZIP download for single audits (currently bulk-only)
5. Re-audit implementation tracking (flag which suggested fixes were/weren't implemented)

## Why

- Paid users see sales-oriented copy ("FlowBlinq moves your score from X to Y") instead of actionable technical guidance
- Pillars like `metadata_freshness`, `semantic_html`, `content_structure` require site-side changes (title tags, H1s, heading hierarchy) that we identify but don't provide specific fixes for
- Per-page breakdown and ZIP download are locked to bulk audits, but single audit users need them too
- No mechanism to track whether users implemented suggested fixes across re-audits

## Dependencies

- Existing pipeline: `discover → crawl-fanout → poll-chunk → merge-crawl → research → analyze → generate-fanout → generate-chunk (x5) → assemble`
- `extractPerPageVulnerabilities()` in `lib/services/per-page-analyzer.ts` — already works on any crawlData, just gated to bulk
- `matchesPageTarget()` in `lib/serve-utils.ts` — reusable for matching schema blocks to pages
- `generatedSchemaBlocks` with `pageTarget` field per block
- OpenAI `gpt-4o-mini` for per-page fix generation

## Branch

`feat/per-page-fixes` from `feat/exchange-code-auth` (commit `5caf53f`)

---

## Interfaces

### New Type: `PerPageFix`

```typescript
interface PerPageFix {
  url: string;
  pageType: string;
  currentTitle: string;
  suggestedTitle: string | null;        // null if current title is fine
  suggestedMetaDescription: string | null;
  h1Fix: string | null;                 // null if H1 is correct
  headingFixes: string | null;          // description of heading hierarchy fix
  pillarFixes: Array<{
    pillar: string;                     // pillar ID
    pillarName: string;                 // human-readable name
    fix: string;                        // specific actionable fix
    fixScope: "site-side";              // always "site-side" — explicitly out of FlowBlinq scope
  }>;
  matchedSchemaBlocks: string[];        // names of generated schema blocks targeting this page
}
```

### New Type: `ImplementationStatus`

```typescript
interface ImplementationStatus {
  url: string;
  fixes: Array<{
    fixType: "title" | "meta_description" | "h1" | "heading" | "schema" | "pillar";
    suggested: string;
    implemented: boolean;
    currentValue: string | null;
  }>;
  implementedCount: number;
  totalFixes: number;
}
```

### Modified: `assembleResults()` signature

```typescript
// BEFORE:
function assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData)
// AFTER:
function assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData, isPaidUser: boolean)
```

### Modified: `generatePerPageHtml()` signature

```typescript
// BEFORE:
function generatePerPageHtml(result: PerPageResult, domain: string): string
// AFTER:
function generatePerPageHtml(result: PerPageResult, domain: string, perPageFix?: PerPageFix): string
```

### Modified: `buildReportZip()` signature

```typescript
// BEFORE:
function buildReportZip(site: SiteForZip, perPageResults: PerPageResult[]): Promise<Buffer>
// AFTER:
function buildReportZip(site: SiteForZip, perPageResults: PerPageResult[], perPageFixes?: PerPageFix[], implementationStatus?: ImplementationStatus[]): Promise<Buffer>
```

### Modified: `GenerateChunkType`

```typescript
// BEFORE:
type GenerateChunkType = "llms" | "business" | "schema-sitewide" | "schema-faq" | "schema-article";
// AFTER:
type GenerateChunkType = "llms" | "business" | "schema-sitewide" | "schema-faq" | "schema-article" | "page-fixes";
```

---

## DB Schema Changes

Two new JSONB columns on `geo_sites`:

```sql
ALTER TABLE geo_sites ADD COLUMN per_page_fixes jsonb;
ALTER TABLE geo_sites ADD COLUMN previous_per_page_fixes jsonb;
```

Drizzle schema additions in `lib/db/schema.ts`:
```typescript
perPageFixes:         jsonb("per_page_fixes"),
previousPerPageFixes: jsonb("previous_per_page_fixes"),
```

---

## Implementation — 6 Phases

### Phase 1: Foundation (no LLM calls)

**1A. Enable per-page analysis for single audits**

File: `app/api/pipeline/stage/route.ts` line 699

Current code runs `extractPerPageVulnerabilities` only for bulk (`if (site.auditMode === "bulk" && crawlData)`). Change to:
- Extract per-page results for ALL audit modes when `crawlData` exists
- Keep bulk-specific credit reconciliation (lines 703-748) inside a nested `if (site.auditMode === "bulk")` block
- Include `perPageResults` in the DB update for all modes

**1B. Enable ZIP download for single audits**

File: `app/api/sites/[id]/download-report/route.ts` line 27

Remove the `site.auditMode !== "bulk"` guard. Keep `teamId` (Pro) and `pipelineStatus === "complete"` checks.

**1C. DB migration + Drizzle schema**

Add `per_page_fixes` and `previous_per_page_fixes` columns as described above.

**1D. Type definitions**

New file: `lib/services/page-fix-generator.ts` — `PerPageFix` interface (types only in this phase).

---

### Phase 2: Per-Page Fix Generation (new pipeline chunk)

**2A. Add "page-fixes" to generate-chunk types**

File: `lib/qstash.ts` — add `"page-fixes"` to `GenerateChunkType` union.

File: `app/api/pipeline/stage/route.ts` — add `"page-fixes"` to `GENERATE_CHUNK_TYPES` array (line 486). This automatically bumps `generateChunksTotal` from 5 to 6.

**2B. Implement `generatePerPageFixes()`**

File: `lib/services/page-fix-generator.ts`

```typescript
export async function generatePerPageFixes(
  domain: string,
  crawlData: CrawlData,
  geoScorecard: GeoScorecard,
  schemaBlocks: SchemaBlock[],
  isPaidUser: boolean
): Promise<PerPageFix[]>
```

- Batch 15 pages per LLM call (gpt-4o-mini, JSON response format)
- Each prompt sends: URL, current title, current H1, headings array, content snippet (200 chars), relevant pillar findings for impacted pages
- Tone toggle: `isPaidUser` = exact HTML code; `!isPaidUser` = general guidance
- Match schema blocks via `matchesPageTarget()` from `lib/serve-utils.ts`
- Cap at 100 highest-vulnerability pages for sites with 100+ pages
- Parallel batches via `Promise.all` — 7 batches @ ~3s = ~21s, within 105s timeout

Prompt:
```
You are a technical SEO/GEO consultant. For each page, suggest specific fixes.
- suggestedTitle: exact <title> content (50-60 chars), or null if current is fine
- suggestedMetaDescription: exact content (120-155 chars), or null if current is fine
- h1Fix: exact H1 text, or null if current is correct
- headingFixes: description of heading hierarchy fix, or null
- pillarFixes: [{pillar, pillarName, fix}] for relevant pillar issues

All fixes are site-side changes. Be specific and actionable.
Do NOT mention FlowBlinq. Give exact values, not vague guidance.
```

**2C. Pipeline handler**

File: `app/api/pipeline/stage/route.ts` — add `case "page-fixes"` in `handleGenerateChunk` switch:

```typescript
case "page-fixes": {
  const schemaBlocks = (site.generatedSchemaBlocks ?? []) as SchemaBlock[];
  const isPaid = site.teamId != null;
  const fixes = await Promise.race([
    generatePerPageFixes(domain, crawlData, geoScorecard, schemaBlocks, isPaid),
    stageTimeout("generate-chunk[page-fixes]"),
  ]);
  await db.update(geoSites)
    .set({ perPageFixes: fixes as unknown as Record<string, unknown>[], updatedAt: new Date() })
    .where(eq(geoSites.id, siteId));
  break;
}
```

Falls through to `fanInGenerateChunk` at line 634 (same as llms/business chunks).

---

### Phase 3: Re-Audit Implementation Tracking

**3A. Snapshot previous fixes**

File: `app/api/pipeline/stage/route.ts` — in `handleDiscover` (around line 176), after `previousRunSnapshot`:

```typescript
if (site.perPageFixes) {
  await db.update(geoSites)
    .set({ previousPerPageFixes: site.perPageFixes })
    .where(eq(geoSites.id, siteId));
}
```

**3B. Implementation tracker**

New file: `lib/services/implementation-tracker.ts`

Pure deterministic comparison (no LLM, <1s for 500 pages):
- Title: `suggestedTitle` vs current `page.title` — case-insensitive match, Levenshtein distance < 5
- H1: `h1Fix` vs current `page.h1` — same approach
- Schema: check if suggested `@type` now appears in `page.existingSchema`
- Meta description: best-effort — check if key noun phrases appear in page content

**3C. Wire into assemble**

File: `app/api/pipeline/stage/route.ts` — in `handleAssemble`, after per-page extraction:

```typescript
const previousFixes = site.previousPerPageFixes as PerPageFix[] | null;
let implementationStatus = null;
if (previousFixes?.length && crawlData) {
  implementationStatus = computeImplementationTracking(previousFixes, crawlData);
}
```

Include in DB update.

---

### Phase 4: Tone Shift

**4A. Executive summary prompt**

File: `lib/services/assembler.ts` — add `isPaidUser: boolean` parameter to `assembleResults()`.

Paragraph 3 prompt change:
- **Free (current):** "What FlowBlinq changes — how the score moves from X to ~Y"
- **Paid (new):** "What to change — specific technical actions. E.g. 'Adding FAQPage schema to your 12 service pages and fixing the 3 pages with missing H1 tags moves the score from X to ~Y.' Do NOT mention FlowBlinq."

**4B. Wire through pipeline**

File: `app/api/pipeline/stage/route.ts` — in `handleAssemble`:
```typescript
const isPaidUser = site.teamId != null;
assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData, isPaidUser)
```

**4C. geo-analyzer.ts — NO CHANGE NEEDED**

Gemini pillar findings are already technical. No prompt change required.

---

### Phase 5: Report & ZIP Enhancement

**5A. Per-page HTML reports**

File: `lib/services/report-generator.ts`

Enhance `generatePerPageHtml()` with optional `PerPageFix`:
- New section: "Suggested Fixes" after vulnerabilities
- Current vs suggested title (diff highlight)
- Suggested meta description
- H1 fix, heading fixes
- Each tagged "Site-side change"
- Implementation badges if re-audit data available

**5B. Aggregate report**

Enhance `generateAggregateHtml()`:
- Fix implementation summary: "X of Y suggested fixes implemented"
- Per-page fix count distribution

**5C. ZIP builder**

File: `lib/services/zip-builder.ts`

Accept `perPageFixes?` and `implementationStatus?`. Match fixes to per-page results by URL. Add `fixes-summary.csv` (URL, Suggested Title, Suggested Meta Description, H1 Fix, Schema Blocks, Implementation Status).

**5D. Download route**

File: `app/api/sites/[id]/download-report/route.ts`

Pass `perPageFixes` and `implementationStatus` from site data to `buildReportZip()`.

---

### Phase 6: UI

**6A. Server component**

File: `app/sites/[id]/page.tsx`

Pass `perPageResults`, `perPageFixes`, `implementationStatus` to `safeSite` for paid tier. Null for free.

**6B. Dashboard — new "Pages" section**

File: `app/sites/[id]/ResultsDashboard.tsx`

- Add "Pages" nav pill between "Recs" and "History"
- New section: "Page-by-Page Analysis"
  - Filter: health status (All / Good / Needs Work / Poor), sort (health, fix count)
  - Paginated table (20 per page): URL, Health badge, Fix count, expand arrow
  - Expandable: current vs suggested title, meta description, H1, heading fixes, pillar fixes ("Site-side change" tag), matched schema blocks
  - Re-audit: "Implemented" / "Not yet" badges
- Free tier: health distribution counts visible, fix details blurred, upgrade CTA

**6C. Download button**

Move ZIP download button to header actions area — visible for both single + bulk, paid tier only.

---

## Acceptance Criteria

1. Single audit sites get `perPageResults` populated (not just bulk)
2. Single audit paid users can download ZIP report
3. `perPageFixes` contains suggested title/description/H1/heading/pillar fixes per page
4. Fixes are explicitly marked `fixScope: "site-side"`
5. Paid user executive summary paragraph 3 doesn't mention FlowBlinq — gives technical actions instead
6. Re-audit shows which previously-suggested fixes were implemented vs not
7. ZIP includes per-page fix suggestions and `fixes-summary.csv`
8. Dashboard shows expandable per-page analysis with fix details
9. Free tier sees health distribution but fix details are gated behind upgrade
10. No regressions: existing bulk pipeline, schema generation, serve routes all pass tests

## Risks

1. **LLM token cost** — Per-page fix generation adds an OpenAI call per 15 pages. For 100 pages = ~7 calls @ ~$0.01 each = ~$0.07 per audit. Acceptable.
2. **Timeout** — 100 pages / 15 per batch = 7 batches. Even sequential at 5s each = 35s. With `Promise.all` = ~5s. Well within 105s stage timeout.
3. **Fix quality** — gpt-4o-mini may produce mediocre title/description suggestions. Mitigate: strong prompt with examples, validate output structure.
4. **Implementation tracking accuracy** — Title comparison is fuzzy (Levenshtein). May produce false positives/negatives. Acceptable for v1 — surface-level heuristic, not a guarantee.
5. **DB column bloat** — `perPageFixes` for 500 pages @ ~500 bytes each = ~250KB JSONB. Well within Postgres limits.
