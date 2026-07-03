# ES-045: Per-Page Fixes, Tone Shift, and ZIP for All Audit Modes

**Source:** TS-044-per-page-fixes-and-tone-shift.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-03-14
**Status:** Ready for review
**Branch:** `feat/per-page-fixes` from `feat/exchange-code-auth` (commit `5caf53f`)

---

## a) Overview

### What
Enhance the GEO audit with:
1. Per-page fix generation — suggested titles, meta descriptions, H1 fixes, heading fixes, pillar-specific fixes (new generate-chunk type `"page-fixes"`)
2. Tone shift — paid users get actionable technical guidance, not sales copy, in executive summary paragraph 3
3. Per-page analysis for single audits — currently gated to bulk only
4. ZIP download for single audits — currently gated to bulk only
5. Re-audit implementation tracking — compare previous suggested fixes vs current page state

### Current State
- `extractPerPageVulnerabilities()` in `lib/services/per-page-analyzer.ts` works on any crawlData but is called only for `auditMode === "bulk"` (route.ts:699)
- `buildReportZip()` in `lib/services/zip-builder.ts` takes `(site, perPageResults)` — no fix data
- Download route (`app/api/sites/[id]/download-report/route.ts:27`) rejects non-bulk audits
- `assembleResults()` in `lib/services/assembler.ts` has no `isPaidUser` parameter — paragraph 3 always mentions FlowBlinq
- `GenerateChunkType` = `"llms" | "business" | "schema-sitewide" | "schema-faq" | "schema-article"` (5 types)
- `GENERATE_CHUNK_TYPES` array at route.ts:486 drives `generateChunksTotal` (currently 5)
- `geo_sites` has `perPageResults` JSONB column but no `perPageFixes` or `previousPerPageFixes` columns
- `handleDiscover` snapshots previous run data (route.ts:176-184) but not per-page fixes

### Key Types (existing)
- `PerPageResult` — `{ url, pageType, title, vulnerabilities[], overallPageHealth }` (per-page-analyzer.ts:13-19)
- `PerPageVulnerability` — `{ pillar, pillarName, severity, finding, recommendation }` (per-page-analyzer.ts:5-11)
- `GeoScorecard` — `{ overallScore, pillars[], topThreeImprovements }` (geo-analyzer.ts)
- `SchemaBlock` — includes `pageTarget` field per block
- `AssemblyResult` — `{ executiveSummary, rankedRecommendations }` (assembler.ts:17-20)

---

## b) Implementation Requirements

### 6 Phases, ~12 files modified/created

---

### Phase 1: Foundation (no LLM calls)

#### 1A. Enable per-page analysis for single audits

**File:** `app/api/pipeline/stage/route.ts`

**Current** (line 699):
```typescript
if (site.auditMode === "bulk" && crawlData) {
```

**Change:** Extract per-page results for ALL audit modes when crawlData exists. Keep bulk-specific credit reconciliation inside a nested check.

```typescript
// Per-page analysis for ALL audit modes
let perPageUpdates: Record<string, unknown> = {};
if (crawlData) {
  const scorecardForAnalysis = geoScorecard as { pillars: Array<{ pillar: string; impactedPages?: string[] }> };
  const perPageResults = extractPerPageVulnerabilities(crawlData, scorecardForAnalysis);
  perPageUpdates = {
    perPageResults: perPageResults as unknown as Record<string, unknown>[],
  };
}

// Bulk-specific post-processing: credit reconciliation + failed URL classification
let bulkUpdates: Record<string, unknown> = {};
if (site.auditMode === "bulk" && crawlData) {
  // ... existing lines 703-748 (URL classification + credit refund) ...
  bulkUpdates = {
    crawlData: crawlDataWithFailed as unknown as Record<string, unknown>,
  };
}
```

Then in the DB update (line 784):
```typescript
...perPageUpdates,
...bulkUpdates,
```

**Key constraint:** `perPageResults` is now set by `perPageUpdates` for all modes. Remove `perPageResults` from `bulkUpdates` to avoid duplication.

#### 1B. Enable ZIP download for single audits

**File:** `app/api/sites/[id]/download-report/route.ts`

**Remove** lines 27-29:
```typescript
if (site.auditMode !== "bulk") {
  return NextResponse.json({ error: "Download only available for bulk audits." }, { status: 400 });
}
```

Keep `teamId` (Pro) check at line 31 and `pipelineStatus === "complete"` check at line 35.

#### 1C. DB migration

**File:** New migration file in `geo/drizzle/` (next sequential number)

```sql
ALTER TABLE geo_sites ADD COLUMN per_page_fixes jsonb;
ALTER TABLE geo_sites ADD COLUMN previous_per_page_fixes jsonb;
```

#### 1D. Drizzle schema

**File:** `lib/db/schema.ts`

Add after `perPageResults` (line 113):
```typescript
perPageFixes:         jsonb("per_page_fixes"),
previousPerPageFixes: jsonb("previous_per_page_fixes"),
```

#### 1E. Type definitions

**File:** New file `lib/services/page-fix-generator.ts` (types only in Phase 1, implementation in Phase 2)

```typescript
export interface PerPageFix {
  url: string;
  pageType: string;
  currentTitle: string;
  suggestedTitle: string | null;
  suggestedMetaDescription: string | null;
  h1Fix: string | null;
  headingFixes: string | null;
  pillarFixes: Array<{
    pillar: string;
    pillarName: string;
    fix: string;
    fixScope: "site-side";
  }>;
  matchedSchemaBlocks: string[];
}
```

---

### Phase 2: Per-Page Fix Generation (new pipeline chunk)

#### 2A. Add `"page-fixes"` to generate-chunk types

**File:** `lib/qstash.ts` (line 5)

```typescript
// BEFORE:
export type GenerateChunkType = "llms" | "business" | "schema-sitewide" | "schema-faq" | "schema-article";
// AFTER:
export type GenerateChunkType = "llms" | "business" | "schema-sitewide" | "schema-faq" | "schema-article" | "page-fixes";
```

**File:** `app/api/pipeline/stage/route.ts` (line 486)

```typescript
// BEFORE:
const GENERATE_CHUNK_TYPES: GenerateChunkType[] = ["llms", "business", "schema-sitewide", "schema-faq", "schema-article"];
// AFTER:
const GENERATE_CHUNK_TYPES: GenerateChunkType[] = ["llms", "business", "schema-sitewide", "schema-faq", "schema-article", "page-fixes"];
```

This automatically bumps `generateChunksTotal` from 5 to 6 (line 518: `const total = GENERATE_CHUNK_TYPES.length`).

#### 2B. Implement `generatePerPageFixes()`

**File:** `lib/services/page-fix-generator.ts`

```typescript
export async function generatePerPageFixes(
  domain: string,
  crawlData: CrawlData,
  geoScorecard: GeoScorecard,
  schemaBlocks: SchemaBlock[],
  isPaidUser: boolean
): Promise<PerPageFix[]>
```

**Algorithm:**
1. Sort pages by vulnerability count (descending) from crawlData
2. Cap at 100 pages (highest-vulnerability first)
3. Batch 15 pages per LLM call
4. For each batch, build prompt with: URL, current title, current H1, headings array, content snippet (200 chars), relevant pillar findings from scorecard's `impactedPages`
5. Call OpenAI `gpt-4o-mini` with JSON response format
6. Match schema blocks to pages via `matchesPageTarget()` from `lib/serve-utils.ts`
7. Parallel batches via `Promise.all` — max 7 batches

**Tone toggle:**
- `isPaidUser === true`: exact HTML code (`suggestedTitle` = exact `<title>` content, 50-60 chars)
- `isPaidUser === false`: general guidance (e.g., "Consider adding location keywords to your title")

**Prompt (per batch):**
```
You are a technical SEO/GEO consultant. For each page, suggest specific fixes.
Return a JSON array of objects, one per page.

For each page:
- suggestedTitle: exact <title> content (50-60 chars), or null if current is fine
- suggestedMetaDescription: exact content (120-155 chars), or null if current is fine
- h1Fix: exact H1 text, or null if current is correct
- headingFixes: description of heading hierarchy fix, or null
- pillarFixes: [{pillar, pillarName, fix, fixScope: "site-side"}] for relevant pillar issues

All fixes are site-side changes the business owner must make.
Be specific and actionable. Do NOT mention FlowBlinq.
Give exact values, not vague guidance.

Pages:
[...batch of 15 page summaries...]
```

**Error handling:**
- If OpenAI returns invalid JSON for a batch → skip that batch, log warning, return fixes from successful batches
- If all batches fail → return empty array (non-fatal, pipeline continues)

**Performance budget:** 7 batches × ~3s each via `Promise.all` ≈ 3-5s. Well within 105s stage timeout.

#### 2C. Pipeline handler — `"page-fixes"` case

**File:** `app/api/pipeline/stage/route.ts` — add case in `handleGenerateChunk` switch (before `default:`, line 628)

```typescript
case "page-fixes": {
  const schemaBlocks = (site.generatedSchemaBlocks ?? []) as SchemaBlock[];
  const isPaid = site.teamId != null;
  const fixes = await Promise.race([
    generatePerPageFixes(domain, crawlData, geoScorecard, schemaBlocks, isPaid),
    stageTimeout("generate-chunk[page-fixes]"),
  ]);
  await db.update(geoSites)
    .set({
      perPageFixes: fixes as unknown as Record<string, unknown>[],
      updatedAt: new Date(),
    })
    .where(eq(geoSites.id, siteId));
  break;
}
```

Falls through to `fanInGenerateChunk` at line 634 (same as llms/business chunks). No schema fan-in needed.

**Important:** This chunk runs in parallel with the other 5 chunks. It reads `generatedSchemaBlocks` which may not be fully populated yet (schema chunks may still be running). This is acceptable — schema block matching is best-effort. If `generatedSchemaBlocks` is empty/partial, `matchedSchemaBlocks` will be empty for those pages.

---

### Phase 3: Re-Audit Implementation Tracking

#### 3A. Snapshot previous fixes in `handleDiscover`

**File:** `app/api/pipeline/stage/route.ts` — in `handleDiscover` (after line 184, after `previousRunSnapshot`)

```typescript
// Snapshot per-page fixes for implementation tracking on re-audit
if (site.perPageFixes) {
  await db.update(geoSites)
    .set({ previousPerPageFixes: site.perPageFixes })
    .where(eq(geoSites.id, siteId));
}
```

**Why separate from the `updateStatus` call at line 189:** The existing `previousRunSnapshot` is set in the same `updateStatus` call. Adding `previousPerPageFixes` there would work too — ScriptDev can choose. The key requirement is that it's set BEFORE the pipeline overwrites `perPageFixes` in Phase 2C.

#### 3B. Implementation tracker

**File:** New file `lib/services/implementation-tracker.ts`

```typescript
export interface ImplementationStatus {
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

export function computeImplementationTracking(
  previousFixes: PerPageFix[],
  crawlData: CrawlData
): ImplementationStatus[]
```

**Algorithm (pure deterministic, no LLM, <1s for 500 pages):**

1. Build a Map from `crawlData.pages` keyed by URL
2. For each `PerPageFix` in `previousFixes`:
   a. Find matching page in crawlData by URL
   b. If no match (page removed or URL changed) → skip
   c. Compare each fix:
      - **Title:** `suggestedTitle` vs `page.title` — case-insensitive, Levenshtein distance < 5 = implemented
      - **Meta description:** Check if key noun phrases (3+ word sequences) from `suggestedMetaDescription` appear in page content. If ≥50% of phrases found → implemented
      - **H1:** `h1Fix` vs `page.headings[0]` (first H1) — case-insensitive, Levenshtein < 5
      - **Schema:** Check if schema block's `@type` now appears in `page.existingSchema`
      - **Pillar fixes:** Not auto-detectable — always mark `implemented: false` (user must confirm manually)
   d. Compute `implementedCount` and `totalFixes`
3. Return array of `ImplementationStatus` (one per page that had fixes)

**Levenshtein helper:** Implement inline (simple DP, ~15 lines). No external dependency needed.

#### 3C. Wire into `handleAssemble`

**File:** `app/api/pipeline/stage/route.ts` — in `handleAssemble`, after the per-page analysis block (Phase 1A)

```typescript
// Implementation tracking for re-audits
const previousFixes = site.previousPerPageFixes as PerPageFix[] | null;
let implementationStatus: ImplementationStatus[] | null = null;
if (previousFixes?.length && crawlData) {
  implementationStatus = computeImplementationTracking(previousFixes, crawlData);
}
```

Include in DB update:
```typescript
...(implementationStatus ? { implementationStatus: implementationStatus as unknown as Record<string, unknown>[] } : {}),
```

**Note:** This requires adding `implementationStatus` column to `geo_sites`. Add to the migration in Phase 1C:
```sql
ALTER TABLE geo_sites ADD COLUMN implementation_status jsonb;
```

And to Drizzle schema:
```typescript
implementationStatus: jsonb("implementation_status"),
```

---

### Phase 4: Tone Shift

#### 4A. Modify `assembleResults()` signature

**File:** `lib/services/assembler.ts`

```typescript
// BEFORE (line 511):
export async function assembleResults(
  domain: string, crawlData: CrawlData, geoScorecard: GeoScorecard,
  generatedContent: ResearchData, researchData?: ResearchData
): Promise<AssemblyResult>

// AFTER:
export async function assembleResults(
  domain: string, crawlData: CrawlData, geoScorecard: GeoScorecard,
  generatedContent: ResearchData, researchData?: ResearchData,
  isPaidUser?: boolean
): Promise<AssemblyResult>
```

#### 4B. Modify paragraph 3 prompt

**File:** `lib/services/assembler.ts` — in the `summaryPrompt` string (line 553)

Replace paragraph 3 instruction (currently lines 572-574):
```
PARAGRAPH 3 — What FlowBlinq changes
Score moves from ${geoScorecard.overallScore} to ~${projectedScore}. Name the 1-2 changes that matter most. Close on timing: the category is open now but won't stay that way.
```

With conditional:
```typescript
const para3 = isPaidUser
  ? `PARAGRAPH 3 — What to change
Specific technical actions the business owner should take. E.g. "Adding FAQPage schema to your 12 service pages and fixing the 3 pages with missing H1 tags moves the score from ${geoScorecard.overallScore} to ~${projectedScore}." Name exact page counts and specific fixes. Do NOT mention FlowBlinq. Close on timing: the category is open now but won't stay that way.`
  : `PARAGRAPH 3 — What FlowBlinq changes
Score moves from ${geoScorecard.overallScore} to ~${projectedScore}. Name the 1-2 changes that matter most. Close on timing: the category is open now but won't stay that way.`;
```

**Implementation:** Build the prompt string with template literals. Insert `para3` in place of the current PARAGRAPH 3 block.

#### 4C. Wire through pipeline

**File:** `app/api/pipeline/stage/route.ts` — in `handleAssemble` (line 662)

```typescript
// BEFORE:
() => assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData),

// AFTER:
const isPaidUser = site.teamId != null;
// ...
() => assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData, isPaidUser),
```

---

### Phase 5: Report & ZIP Enhancement

#### 5A. Per-page HTML reports

**File:** `lib/services/report-generator.ts`

**Modify** `generatePerPageHtml()` signature:
```typescript
// BEFORE:
export function generatePerPageHtml(result: PerPageResult, domain: string): string
// AFTER:
export function generatePerPageHtml(result: PerPageResult, domain: string, perPageFix?: PerPageFix): string
```

**Add section** after vulnerabilities list (when `perPageFix` is provided):
- "Suggested Fixes" heading
- Current vs suggested title (if `suggestedTitle` is not null): show both, highlight diff
- Suggested meta description (if not null)
- H1 fix (if not null)
- Heading fixes (if not null)
- Pillar-specific fixes: list each with pillar name and "Site-side change" badge
- Matched schema blocks: list names
- Implementation badges (if re-audit): green "Implemented" / red "Not yet"

All values escaped via existing `escapeHtml()`.

#### 5B. Aggregate report

**File:** `lib/services/report-generator.ts`

Enhance `generateAggregateHtml()`:
- Add section: "Fix Implementation Summary" — `X of Y suggested fixes implemented` (only if `implementationStatus` is available)
- Add: per-page fix count distribution (how many pages have 0, 1-2, 3+ fixes)

#### 5C. ZIP builder

**File:** `lib/services/zip-builder.ts`

**Modify** `buildReportZip()` signature:
```typescript
// BEFORE:
export async function buildReportZip(site: SiteForZip, perPageResults: PerPageResult[]): Promise<Buffer>
// AFTER:
export async function buildReportZip(
  site: SiteForZip,
  perPageResults: PerPageResult[],
  perPageFixes?: PerPageFix[],
  implementationStatus?: ImplementationStatus[]
): Promise<Buffer>
```

**Changes:**
1. Match fixes to per-page results by URL
2. Pass matched fix to `generatePerPageHtml()` for each page
3. Add `fixes-summary.csv` to ZIP root:
   - Columns: `URL, Current Title, Suggested Title, Suggested Meta Description, H1 Fix, Heading Fixes, Schema Blocks, Implementation Status`
   - One row per page with fixes
   - CSV properly escaped (quotes around values containing commas)

#### 5D. Download route

**File:** `app/api/sites/[id]/download-report/route.ts`

Pass new data to `buildReportZip()`:
```typescript
const perPageFixes = (site.perPageFixes as PerPageFix[]) ?? [];
const implementationStatus = (site.implementationStatus as ImplementationStatus[]) ?? [];
const zipBuffer = await buildReportZip(site, perPageResults, perPageFixes, implementationStatus);
```

---

### Phase 6: UI

#### 6A. Server component

**File:** `app/sites/[id]/page.tsx`

Add to `safeSite` for paid tier (alongside existing fields):
```typescript
perPageFixes: tier === "paid" ? site.perPageFixes : null,
implementationStatus: tier === "paid" ? site.implementationStatus : null,
```

For free tier: `perPageFixes: null`, `implementationStatus: null`.

**Note:** `perPageResults` is already passed for bulk — ensure it's now passed for all audit modes (Phase 1A makes it available).

#### 6B. ResultsDashboard — new "Pages" section

**File:** `app/sites/[id]/ResultsDashboard.tsx`

**Add to `SiteData` interface:**
```typescript
perPageFixes?: PerPageFix[] | null;
implementationStatus?: ImplementationStatus[] | null;
```

**New nav pill:** "Pages" between existing "Recs" and "History" pills.

**New section: "Page-by-Page Analysis"**

Components:
1. **Filter bar:** Health status (All / Good / Needs Work / Poor), sort (health ascending, fix count descending)
2. **Paginated table** (20 per page): URL (truncated, linked), Health badge (color-coded), Fix count, expand arrow
3. **Expandable row content:**
   - Current vs Suggested title (side-by-side, diff highlighted)
   - Suggested meta description
   - H1 fix
   - Heading fixes
   - Pillar fixes (each with pillar name badge + "Site-side change" tag)
   - Matched schema blocks
   - Re-audit badges: "Implemented" (green) / "Not yet" (red) per fix
4. **Free tier gate:** Health distribution counts visible (count of Good/Needs Work/Poor). Fix details blurred with upgrade CTA overlay.

#### 6C. Download button

Move ZIP download button to header actions area — visible for both single + bulk, paid tier only. Currently somewhere in bulk-specific UI.

---

## c) Unit Test Plan

**File:** `__tests__/page-fix-generator.test.ts`

| # | Test | Input | Expected |
|---|---|---|---|
| U1 | `generatePerPageFixes returns fixes for pages with vulnerabilities` | 3 pages, 2 with missing titles | Array of 3 `PerPageFix`, 2 have non-null `suggestedTitle` |
| U2 | `caps at 100 pages` | 150 pages | Result length ≤ 100 |
| U3 | `isPaidUser=true gives exact values` | 1 page, isPaid=true | `suggestedTitle` is exact HTML (not guidance text) |
| U4 | `isPaidUser=false gives general guidance` | 1 page, isPaid=false | `suggestedTitle` contains guidance language |
| U5 | `matches schema blocks via matchesPageTarget` | 2 pages, 1 schema block targeting page 1 | page 1 has `matchedSchemaBlocks.length === 1`, page 2 has 0 |
| U6 | `handles OpenAI JSON parse failure gracefully` | Mock OpenAI returns invalid JSON | Returns empty array, no throw |
| U7 | `fixScope is always "site-side"` | Any page with pillar fixes | Every pillarFix has `fixScope === "site-side"` |

**File:** `__tests__/implementation-tracker.test.ts`

| # | Test | Input | Expected |
|---|---|---|---|
| U8 | `detects implemented title fix` | Previous: suggestedTitle="New Title", Current page title="New Title" | `implemented: true` |
| U9 | `detects unimplemented title fix (Levenshtein)` | Previous: suggestedTitle="New Title", Current: "Old Title" | `implemented: false` |
| U10 | `title match is case-insensitive` | Suggested="new title", Current="New Title" | `implemented: true` |
| U11 | `handles removed pages` | Previous fix for url X, no matching page in crawlData | Page skipped, not in result |
| U12 | `H1 fix detection` | Previous: h1Fix="Better H1", Current h1="Better H1" | `implemented: true` |
| U13 | `schema implementation detection` | Previous fix matched "FAQPage", current page has FAQPage in existingSchema | `implemented: true` |
| U14 | `pillar fixes always unimplemented` | Any pillar fix | `implemented: false` |
| U15 | `computes implementedCount and totalFixes` | 3 fixes, 2 implemented | `implementedCount: 2, totalFixes: 3` |
| U16 | `empty previousFixes returns empty array` | `[]` | `[]` |
| U17 | `Levenshtein distance < 5 counts as match` | Suggested="Best SEO Title Here", Current="Best SEo Title Here" (1 char diff) | `implemented: true` |
| U18 | `Levenshtein distance >= 5 counts as no match` | Suggested="Completely Different", Current="Not Even Close At All" | `implemented: false` |

**File:** `__tests__/assembler.test.ts` (add to existing)

| # | Test | Input | Expected |
|---|---|---|---|
| U19 | `isPaidUser=true prompt has "What to change"` | Mock callClaude, isPaidUser=true | Prompt contains "What to change", NOT "What FlowBlinq changes" |
| U20 | `isPaidUser=false prompt has "What FlowBlinq changes"` | isPaidUser=false | Prompt contains "What FlowBlinq changes" |
| U21 | `isPaidUser=undefined defaults to free tone` | omit parameter | Prompt contains "What FlowBlinq changes" |

**Minimum coverage:** 90% line coverage for `page-fix-generator.ts` and `implementation-tracker.ts`.

---

## d) Integration Test Plan

**File:** `__tests__/integration/per-page-fixes.test.ts`

| # | Test | Scenario | Assert |
|---|---|---|---|
| IT1 | `single audit produces perPageResults` | Run pipeline for single-mode site through assemble | `site.perPageResults` is non-null array |
| IT2 | `single audit can download ZIP` | Complete single audit, call download-report | 200 response, content-type `application/zip` |
| IT3 | `page-fixes chunk stores perPageFixes` | Run generate-chunk with type "page-fixes" | `site.perPageFixes` is non-null array of PerPageFix |
| IT4 | `generate-fanout enqueues 6 chunks` | Trigger generate-fanout | 6 QStash enqueue calls (was 5) |
| IT5 | `fan-in triggers assemble after 6 chunks` | Complete all 6 chunks | `assemble` stage enqueued |
| IT6 | `re-audit snapshots previousPerPageFixes` | Set perPageFixes on site, run discover | `site.previousPerPageFixes` matches previous `perPageFixes` |
| IT7 | `implementation tracking in assemble` | Set previousPerPageFixes, run assemble with new crawlData where title was implemented | `implementationStatus` contains entry with `implemented: true` |
| IT8 | `paid user gets technical tone in executive summary` | Run assemble with `teamId` set | `executiveSummary` paragraph 3 does NOT contain "FlowBlinq" |
| IT9 | `free user gets sales tone in executive summary` | Run assemble with `teamId` null | `executiveSummary` paragraph 3 contains "FlowBlinq" |
| IT10 | `ZIP includes fixes-summary.csv` | Download ZIP for site with perPageFixes | ZIP contains `fixes-summary.csv` with correct column headers |
| IT11 | `free tier cannot see fix details in API` | Request site data as free tier | `perPageFixes` is null in response |

---

## e) Profiling Requirements

| Metric | Target | How to Measure |
|---|---|---|
| `generatePerPageFixes()` latency (100 pages) | < 10s | Console.warn timestamp diff |
| `computeImplementationTracking()` latency (500 pages) | < 100ms | Console.warn timestamp diff |
| `assembleResults()` with `isPaidUser` param | No regression vs current | Existing profiling |
| ZIP build with fixes + CSV | < 5s for 500 pages | Timer in buildReportZip |

---

## f) Load Test Plan

Not applicable — per-page fix generation is rate-limited by the existing QStash pipeline (one chunk per audit). No concurrent load concerns beyond existing pipeline capacity.

---

## g) Logging & Instrumentation

| Event | Log Level | Fields |
|---|---|---|
| `page_fixes_generated` | `warn` (structured JSON) | `siteId`, `domain`, `pageCount`, `fixCount`, `durationMs`, `isPaid` |
| `page_fixes_batch_failed` | `warn` | `siteId`, `domain`, `batchIndex`, `error` |
| `implementation_tracking_complete` | `warn` | `siteId`, `domain`, `totalFixes`, `implementedCount`, `trackingDurationMs` |
| `tone_shift_applied` | `warn` | `siteId`, `domain`, `isPaidUser` |
| `single_audit_zip_download` | `warn` | `siteId`, `domain`, `auditMode` |

---

## h) Acceptance Criteria

### Phase 1 — Foundation
- [ ] **AC1:** Single audit sites get `perPageResults` populated (not just bulk)
- [ ] **AC2:** Single audit paid users can download ZIP report (200 response, valid ZIP)
- [ ] **AC3:** DB migration adds `per_page_fixes`, `previous_per_page_fixes`, `implementation_status` columns
- [ ] **AC4:** Drizzle schema matches migration

### Phase 2 — Per-Page Fixes
- [ ] **AC5:** `GenerateChunkType` includes `"page-fixes"`, `GENERATE_CHUNK_TYPES` has 6 entries
- [ ] **AC6:** `generateChunksTotal` is 6 after generate-fanout
- [ ] **AC7:** `perPageFixes` contains `PerPageFix[]` with suggested title/description/H1/heading/pillar fixes per page
- [ ] **AC8:** All pillar fixes have `fixScope: "site-side"`
- [ ] **AC9:** Pages capped at 100 highest-vulnerability
- [ ] **AC10:** Schema blocks matched to pages via `matchesPageTarget()`
- [ ] **AC11:** OpenAI batch failure is non-fatal (returns partial results or empty array)

### Phase 3 — Re-Audit Tracking
- [ ] **AC12:** `handleDiscover` snapshots `perPageFixes` into `previousPerPageFixes` before pipeline overwrites
- [ ] **AC13:** `computeImplementationTracking()` correctly detects implemented title/H1/schema fixes
- [ ] **AC14:** Pillar fixes are always marked `implemented: false` (not auto-detectable)
- [ ] **AC15:** Implementation tracking is pure/deterministic (<100ms for 500 pages)

### Phase 4 — Tone Shift
- [ ] **AC16:** Paid user (`teamId != null`) executive summary paragraph 3 doesn't mention FlowBlinq — gives technical actions instead
- [ ] **AC17:** Free user paragraph 3 maintains current FlowBlinq-mentioning behavior
- [ ] **AC18:** `assembleResults()` accepts optional `isPaidUser` parameter (backward compatible)

### Phase 5 — Reports & ZIP
- [ ] **AC19:** Per-page HTML report includes "Suggested Fixes" section when fix data available
- [ ] **AC20:** Aggregate HTML includes fix implementation summary when available
- [ ] **AC21:** ZIP includes `fixes-summary.csv` with correct columns and escaped values
- [ ] **AC22:** `buildReportZip()` accepts optional `perPageFixes` and `implementationStatus` (backward compatible)

### Phase 6 — UI
- [ ] **AC23:** Dashboard has "Pages" nav pill showing page-by-page analysis with filter/sort/pagination
- [ ] **AC24:** Expandable rows show all fix details (current vs suggested, pillar fixes, schema blocks)
- [ ] **AC25:** Re-audit implementation badges show per-fix status
- [ ] **AC26:** Free tier sees health distribution counts but fix details are gated behind upgrade CTA
- [ ] **AC27:** ZIP download button visible for both single + bulk, paid tier only

### Regressions
- [ ] **AC28:** Existing bulk pipeline still works (per-page analysis, credit reconciliation, ZIP download)
- [ ] **AC29:** Existing 5 generate-chunk types (llms, business, schema-*) produce same results
- [ ] **AC30:** Serve routes (`/llms.txt`, `/.well-known/ucp.json`, etc.) unaffected

---

## ScriptDev Notes

1. **Fan-in count change:** Adding `"page-fixes"` to `GENERATE_CHUNK_TYPES` changes `generateChunksTotal` from 5 to 6. Existing in-flight audits with `generateChunksTotal=5` will need to reach 5/5 to trigger assemble — they won't be affected because their fan-out already happened. Only new audits get 6 chunks.

2. **page-fixes chunk timing:** This chunk runs in parallel with schema chunks. `generatedSchemaBlocks` may not be fully populated when page-fixes runs. `matchedSchemaBlocks` will be best-effort — empty if schema chunks haven't completed yet. This is acceptable for v1.

3. **DB column for implementationStatus:** TS-044 didn't mention a DB column for this, but it's needed to persist tracking across requests. Add `implementation_status jsonb` to the same migration as `per_page_fixes`.

4. **Levenshtein implementation:** Implement inline in `implementation-tracker.ts`. Standard DP algorithm, ~15 lines. No npm dependency.

5. **CSV escaping:** For `fixes-summary.csv`, wrap every cell in double quotes and escape internal double quotes by doubling them (`"` → `""`). Use `\n` as line separator.

6. **Phase ordering:** Phases 1-3 can be implemented and tested independently. Phase 4 is isolated to the assembler. Phase 5 depends on types from Phase 1E and implementation from Phase 3. Phase 6 depends on all prior phases.

7. **Backward compatibility:** All signature changes add optional parameters with defaults. No breaking changes to existing callers.

8. **Free tier gating pattern:** Follow existing pattern in `app/sites/[id]/page.tsx` (lines 78-98) where `tier === "paid"` controls data visibility.
