# ES-068 — Per-Page Schema Block Serving

**Source:** TS-068-per-page-schema-serving.md
**Status:** Ready for review
**Agent:** DaVinci (Agent 10) — frontend + API route work

---

## a) Overview

**What:** Serve schema blocks per-page instead of as one monolithic blob. Adds a new API endpoint for filtered/grouped schema serving, enriches the Pages tab with per-page schema blocks + copy buttons, adds a Schema Blocks card to the Setup tab, and makes `schema.js` page-aware.

**Current state:**
- `GET /api/serve/{slug}/schema.json` returns ALL `generatedSchemaBlocks[].jsonLd` as a flat array (line 42, `schema.json/route.ts`)
- `GET /api/serve/{slug}/schema.js` delegates to `buildSchemaInjectionJs()` which **already** separates sitewide vs page-specific blocks and generates page-aware injection JS (`schema-js-builder.ts`). The builder reads `pageTarget`, matches via `new URL(pageTarget).pathname`, and emits `if (p === "/path")` guards. **This deliverable is already done.**
- `serve-utils.ts` exports `matchesPageTarget(pageTarget, requestPath)` and `normalizePath()` — handles `"all pages"`, `"homepage"`, full URLs, and bare paths.
- `serve-lookup.ts` exports `resolveSiteForServing(slug, assetField)` — resolves latest complete audit for domain.
- Pages tab (`ResultsDashboard.tsx` `PageByPageSection`) shows per-page fixes with `matchedSchemaBlocks: string[]` (names only, no JSON-LD or copy).
- Setup tab shows AI files grid with "Structured data: N block(s) · /geo-schema.json" — no grouped view, no per-page breakdown, no copy per block.
- `SchemaBlock` interface in `ResultsDashboard.tsx:24`: `{ name, type, jsonLd, instructions, pageTarget }`.
- `SchemaBlock` interface in `schema-js-builder.ts:9`: `{ type?, pageTarget?, jsonLd }` (subset).
- DB: `geoSites.generatedSchemaBlocks` is `jsonb` (line 104, `schema.ts`). Each block has `{ name, type, jsonLd, instructions, pageTarget }`.

**Key insight from TS-068 risk section:** `pageTarget` format varies — full URLs, `"all pages"`, `"homepage"`. `matchesPageTarget()` in `serve-utils.ts` already handles all cases. Reuse it.

---

## b) Implementation Requirements

### Deliverable 1 — New API: `GET /api/serve/{slug}/schema/{page}`

**Create:** `geo/app/api/serve/[slug]/schema/[page]/route.ts`

**Function signature:**
```typescript
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string; page: string }> }
): Promise<NextResponse>
```

**Behavior:**

1. Extract `slug` and `page` from params. Decode `page` via `decodeURIComponent()`.
2. Rate-limit check (same pattern as `schema.json/route.ts`): `checkRateLimit`, `isKnownAICrawler`.
3. Resolve site via `resolveSiteForServing(slug, "generatedSchemaBlocks")`.
4. If no site or no blocks → 404 with `{ error: "not found" }`.
5. Cast `site.generatedSchemaBlocks` as `SchemaBlock[]`.
6. **Route on `page` value:**

   **Case A — `_sitewide`:**
   Return blocks where `matchesPageTarget(block.pageTarget, "/") === true && block.pageTarget matches "all pages"` — i.e., only blocks with `pageTarget === "all pages"` or sitewide types (Organization, WebSite, BreadcrumbList, DefinedTerm, SpeakableSpecification). Use same logic as `schema-js-builder.ts` `SITEWIDE_TYPES` and `SITEWIDE_TARGETS`.
   ```json
   { "page": "_sitewide", "blocks": [...], "scriptTag": "<script ...>...</script>" }
   ```

   **Case B — `_all` (with `?format=grouped`):**
   Group all blocks into: `sitewide[]`, `homepage[]`, `pages: Record<string, SchemaBlock[]>`.
   - `sitewide`: pageTarget `"all pages"` or type in SITEWIDE_TYPES
   - `homepage`: pageTarget `"homepage"` (not in sitewide)
   - `pages`: keyed by full page URL, all other blocks
   ```json
   {
     "sitewide": [...],
     "homepage": [...],
     "pages": { "https://example.com/pricing": [...], ... }
   }
   ```

   **Case C — specific page (e.g., `blog%2Fai-commerce-roi`):**
   - Construct `requestPath = "/" + decodedPage` (prepend slash if missing)
   - Filter blocks: `matchesPageTarget(block.pageTarget, requestPath)` — this picks up both page-specific matches AND "all pages" sitewide blocks
   - Separate into `blocks` (page-specific) and `sitewide` (pageTarget "all pages" or sitewide type)
   - Build combined `scriptTag`: `<script type="application/ld+json">[...all jsonLd]</script>`
   ```json
   {
     "page": "https://www.example.com/blog/ai-commerce-roi",
     "blocks": [...page-specific...],
     "sitewide": [...sitewide...],
     "scriptTag": "<script type=\"application/ld+json\">[...]</script>"
   }
   ```

7. Log crawl: `logCrawl(req, site.id, slug, "schema_page")`.
8. Response headers: `Cache-Control: public, max-age=3600`, `Access-Control-Allow-Origin: *`, `X-Generated-By: FlowBlinq GEO Platform`.

**Shared helper — create:** `geo/lib/schema-block-filter.ts`

```typescript
import { matchesPageTarget, normalizePath } from "@/lib/serve-utils";

export interface SchemaBlock {
  name: string;
  type: string;
  jsonLd: Record<string, unknown>;
  instructions: string;
  pageTarget: string;
}

export const SITEWIDE_TYPES = new Set([
  "Organization", "WebSite", "BreadcrumbList", "DefinedTerm", "SpeakableSpecification",
]);
export const SITEWIDE_TARGETS = new Set(["all pages"]);
const SKIP_TYPES = new Set(["RobotsTxt"]);

export function isSitewideBlock(block: SchemaBlock): boolean {
  return SITEWIDE_TYPES.has(block.type) || SITEWIDE_TARGETS.has(block.pageTarget?.trim().toLowerCase() ?? "");
}

export function isHomepageBlock(block: SchemaBlock): boolean {
  return block.pageTarget?.trim().toLowerCase() === "homepage";
}

export function groupSchemaBlocks(blocks: SchemaBlock[]): {
  sitewide: SchemaBlock[];
  homepage: SchemaBlock[];
  pages: Record<string, SchemaBlock[]>;
} {
  const sitewide: SchemaBlock[] = [];
  const homepage: SchemaBlock[] = [];
  const pages: Record<string, SchemaBlock[]> = {};

  for (const block of blocks) {
    if (SKIP_TYPES.has(block.type)) continue;
    if (isSitewideBlock(block)) {
      sitewide.push(block);
    } else if (isHomepageBlock(block)) {
      homepage.push(block);
    } else {
      const key = block.pageTarget ?? "unknown";
      if (!pages[key]) pages[key] = [];
      pages[key].push(block);
    }
  }

  return { sitewide, homepage, pages };
}

export function filterBlocksForPage(blocks: SchemaBlock[], requestPath: string): {
  pageBlocks: SchemaBlock[];
  sitewideBlocks: SchemaBlock[];
} {
  const pageBlocks: SchemaBlock[] = [];
  const sitewideBlocks: SchemaBlock[] = [];

  for (const block of blocks) {
    if (SKIP_TYPES.has(block.type)) continue;
    if (isSitewideBlock(block)) {
      sitewideBlocks.push(block);
    } else if (matchesPageTarget(block.pageTarget ?? "", requestPath)) {
      pageBlocks.push(block);
    }
  }

  return { pageBlocks, sitewideBlocks };
}

export function buildScriptTag(blocks: SchemaBlock[]): string {
  const jsonLds = blocks.map(b => b.jsonLd);
  if (jsonLds.length === 0) return "";
  const json = jsonLds.length === 1
    ? JSON.stringify(jsonLds[0])
    : JSON.stringify(jsonLds);
  return `<script type="application/ld+json">${json}</script>`;
}
```

**Also update:** `geo/lib/schema-js-builder.ts` — refactor to import `SITEWIDE_TYPES`, `SITEWIDE_TARGETS` from `schema-block-filter.ts` instead of redeclaring them. Keep `buildSchemaInjectionJs()` behavior identical.

---

### Deliverable 2 — Pages tab: per-page schema blocks with copy

**Modify:** `geo/app/sites/[id]/ResultsDashboard.tsx` — `PageByPageSection` component

**Changes to expanded page view** (inside the `{isExpanded && ...}` block, after the existing `matchedSchemaBlocks` section):

Replace the existing `matchedSchemaBlocks` display (lines 656–663) with a richer schema blocks section:

1. Instead of just showing block names as a comma-separated string, show actual schema block details.
2. Match blocks to the page: use the full `schemas` array (already available at line 782) and filter by matching `pageTarget` to `fix.url`.
3. For each matched block, render:
   - Type badge (e.g., `FAQPage`, `Product`) — same badge style as pillar fixes
   - Block name
   - Copy JSON-LD button (uses existing `CopyButton` component)
4. At the bottom of the schema section, show a "Copy all for this page" button that copies a combined `<script type="application/ld+json">` tag containing all matched blocks' jsonLd.

**Implementation detail:**

```typescript
// Inside PageByPageSection, derive matched full blocks (not just names):
const schemasForPage = (schemas: SchemaBlock[]) => (pageUrl: string): SchemaBlock[] => {
  return schemas.filter(block => {
    const target = block.pageTarget ?? "all pages";
    try {
      const urlPath = new URL(pageUrl).pathname;
      return matchesPageTarget(target, urlPath);
    } catch {
      return matchesPageTarget(target, pageUrl);
    }
  });
};
```

The `schemas` array and `matchesPageTarget` import are needed. Import `matchesPageTarget` from `@/lib/serve-utils`. The `schemas` array is already derived at line 782 — pass it into `PageByPageSection` as a prop.

**Props change:**
```typescript
function PageByPageSection({ site, schemas }: { site: SiteData; schemas: SchemaBlock[] })
```

---

### Deliverable 3 — Setup tab: Schema Blocks card

**Modify:** `geo/app/sites/[id]/ResultsDashboard.tsx` — Setup section (lines 1966–1997)

After the existing "AI Files" grid (`rd-ai-files-grid`), add a new "Schema Blocks" card:

1. **Summary line:** "N schema blocks across M pages" — count unique pageTargets (excluding "all pages").
2. **Grouped display:**
   - **Sitewide** section first: blocks with `pageTarget === "all pages"` or type in SITEWIDE_TYPES. Each shows type badge + name + expandable JSON-LD + copy button.
   - **Homepage** section: blocks with `pageTarget === "homepage"`.
   - **Per-page** sections: grouped by `pageTarget` URL. Each group has a header showing the page URL and a "Copy all for this page" button.
3. Each block row: type badge, name, expand/collapse toggle for JSON-LD, copy-JSON button.
4. Use `<pre>` with monospace for expanded JSON-LD (same style as integration config blocks).

**New component:** `SchemaBlocksCard` (inline in ResultsDashboard.tsx, not a separate file)

```typescript
function SchemaBlocksCard({ schemas }: { schemas: SchemaBlock[] }) {
  // Group using inline logic (same as schema-block-filter.ts groupSchemaBlocks)
  // Render grouped sections
  // Each block: type badge + name + expand toggle + CopyButton
  // Each page group: "Copy all <script>" button
}
```

Gated behind `site.tier === "paid"` (same as domain integration).

---

### Deliverable 4 — `schema.js` page-aware injection

**No changes needed.** `schema-js-builder.ts` already implements page-aware injection:
- Separates sitewide from page-specific blocks (lines 36–46)
- Builds pathname → JSON-LD map (lines 49–64)
- Emits JS with `if (p === "/path")` guards (lines 77–84)
- Reads `window.location.pathname` at runtime (line 89)

TS-068 describes this as "New" but the implementation already exists and is correct. The existing `schema.js` route already calls `buildSchemaInjectionJs()` which does exactly what's described. **This deliverable is already complete — mark as no-op in AC.**

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/unit/schema-block-filter.test.ts`

**Minimum coverage:** 95% of `schema-block-filter.ts`

| # | Test case | Input | Expected |
|---|-----------|-------|----------|
| U1 | `isSitewideBlock` — Organization type | `{ type: "Organization", pageTarget: "/about" }` | `true` |
| U2 | `isSitewideBlock` — "all pages" target | `{ type: "FAQPage", pageTarget: "all pages" }` | `true` |
| U3 | `isSitewideBlock` — page-specific | `{ type: "FAQPage", pageTarget: "https://example.com/faq" }` | `false` |
| U4 | `isHomepageBlock` — "homepage" | `{ pageTarget: "homepage" }` | `true` |
| U5 | `isHomepageBlock` — case-insensitive | `{ pageTarget: "Homepage" }` | `true` |
| U6 | `isHomepageBlock` — not homepage | `{ pageTarget: "/about" }` | `false` |
| U7 | `groupSchemaBlocks` — mixed blocks | 6 blocks: 2 sitewide, 1 homepage, 2 page-specific, 1 RobotsTxt | sitewide: 2, homepage: 1, pages: 2 groups, RobotsTxt skipped |
| U8 | `groupSchemaBlocks` — empty array | `[]` | `{ sitewide: [], homepage: [], pages: {} }` |
| U9 | `groupSchemaBlocks` — all sitewide | 3 Organization blocks | sitewide: 3, homepage: 0, pages: {} |
| U10 | `filterBlocksForPage` — specific page | `/pricing` + blocks with various targets | Returns matching page blocks + all sitewide blocks |
| U11 | `filterBlocksForPage` — homepage | `/` + blocks including homepage target | Returns homepage + sitewide blocks |
| U12 | `filterBlocksForPage` — no matches | `/nonexistent` | Returns only sitewide blocks |
| U13 | `buildScriptTag` — single block | 1 block | `<script type="application/ld+json">{...}</script>` |
| U14 | `buildScriptTag` — multiple blocks | 3 blocks | `<script type="application/ld+json">[{...},{...},{...}]</script>` |
| U15 | `buildScriptTag` — empty | 0 blocks | `""` |

**Test file:** `geo/__tests__/unit/schema-page-route.test.ts`

| # | Test case | Input | Expected |
|---|-----------|-------|----------|
| U16 | `_sitewide` page param | `GET /api/serve/slug/schema/_sitewide` | Returns only sitewide blocks |
| U17 | `_all?format=grouped` | `GET /api/serve/slug/schema/_all?format=grouped` | Returns grouped response |
| U18 | Specific page — URL-encoded | `GET /api/serve/slug/schema/blog%2Fai-roi` | Returns blocks for `/blog/ai-roi` + sitewide |
| U19 | Specific page — with scriptTag | `GET /api/serve/slug/schema/pricing` | Response includes `scriptTag` field |
| U20 | No blocks → 404 | Site exists but no generatedSchemaBlocks | 404 |
| U21 | No site → 404 | Unknown slug | 404 |
| U22 | Rate limit hit | 11th request in 60s window | 429 |
| U23 | AI crawler bypasses rate limit | UA = "GPTBot" | 200 even after rate limit |

**Test file:** `geo/__tests__/unit/schema-blocks-ui.test.tsx`

| # | Test case | Expected |
|---|-----------|----------|
| U24 | Pages tab expanded view — shows schema blocks for page | Renders type badges, names, copy buttons for matched blocks |
| U25 | Pages tab — no schema matches | "Recommended Schema" section not shown |
| U26 | Pages tab — copy all button | Click copies combined `<script>` tag to clipboard |
| U27 | Setup tab — Schema Blocks card shows summary | "N blocks across M pages" text rendered |
| U28 | Setup tab — sitewide blocks first | Sitewide section before per-page sections |
| U29 | Setup tab — expand JSON-LD toggle | Click shows formatted JSON |
| U30 | Setup tab — copy per-page button | Copies all blocks for that page |
| U31 | Setup tab — free tier gated | SchemaBlocksCard not shown for free tier |
| U32 | Pages tab — CopyButton copies correct JSON | Clipboard receives `JSON.stringify(block.jsonLd, null, 2)` |

**Total unit tests: 32**

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/schema-page-serve.test.ts`

| # | Test case | Scenario |
|---|-----------|----------|
| IT1 | End-to-end: create site with schema blocks → call `_all?format=grouped` | Returns correct grouping of all blocks |
| IT2 | Page filter → returns page + sitewide blocks | Blocks with pageTarget URL matching requested page appear; non-matching absent |
| IT3 | `_sitewide` returns only sitewide | No page-specific blocks in response |
| IT4 | Backward compat: `schema.json` still returns flat array | Existing endpoint unchanged |
| IT5 | Backward compat: `schema.js` still returns page-aware JS | Existing endpoint unchanged |
| IT6 | Homepage filter matches "homepage" pageTarget | `GET /schema/` or `GET /schema/_sitewide` includes homepage-targeted blocks at root |
| IT7 | `pageTarget` as full URL matches correctly | Block with `pageTarget: "https://example.com/about"` matched by `GET /schema/about` |
| IT8 | Mixed `pageTarget` formats in same site | Full URLs, "all pages", "homepage" — all grouped correctly |
| IT9 | Large site: 200+ blocks, grouped response | Response returns within 500ms, all blocks present |
| IT10 | CORS headers present on new endpoint | `Access-Control-Allow-Origin: *` in response |

**Total integration tests: 10**

---

## e) Profiling Requirements

| Metric | Measurement | Baseline |
|--------|-------------|----------|
| Grouped response latency (200 blocks) | Time from request to response | < 200ms |
| Per-page filter latency (200 blocks) | `filterBlocksForPage` execution | < 5ms |
| Memory: grouped response payload size | JSON response bytes for 200 blocks | < 500KB |
| UI: Pages tab expand with 10 schema blocks | Time to interactive after click | < 100ms |

---

## f) Load Test Plan

| Scenario | Concurrency | Duration | Success criteria |
|----------|-------------|----------|------------------|
| Steady state: schema/page requests | 50 concurrent | 60s | p50 < 100ms, p95 < 300ms, p99 < 500ms |
| Burst: grouped endpoint | 100 concurrent | 30s | p95 < 500ms, 0 errors |
| Mixed: schema.json + schema/{page} | 30 each | 60s | No regression on schema.json latency |

**Resource bounds:** No new DB queries (blocks come from in-memory `generatedSchemaBlocks` JSONB). CPU bound on JSON grouping only.

---

## g) Logging & Instrumentation

| Event | Log level | Fields |
|-------|-----------|--------|
| `schema_page_served` | INFO | `slug`, `page`, `blockCount`, `sitewideCount`, `format` |
| `schema_page_not_found` | WARN | `slug`, `page` |
| `schema_page_rate_limited` | WARN | `slug`, `ip` |

**Metrics:**
- `schema_page_requests_total` — counter, labels: `page_type` (sitewide/grouped/specific)
- `schema_page_latency_ms` — histogram
- `schema_blocks_per_response` — histogram

---

## h) Acceptance Criteria

| # | Criterion | Section |
|---|-----------|---------|
| AC1 | `GET /api/serve/{slug}/schema/{page}` returns blocks filtered by page + sitewide blocks | D1 |
| AC2 | `GET /api/serve/{slug}/schema/_all?format=grouped` returns blocks grouped by sitewide/homepage/pages | D1 |
| AC3 | `GET /api/serve/{slug}/schema/_sitewide` returns only sitewide blocks | D1 |
| AC4 | Response includes `scriptTag` field with combined `<script type="application/ld+json">` for single-page requests | D1 |
| AC5 | Rate limiting applies (10 req/60s per slug:ip, AI crawlers exempt) | D1 |
| AC6 | 404 returned when site or blocks not found | D1 |
| AC7 | CORS headers (`Access-Control-Allow-Origin: *`) present on all responses | D1 |
| AC8 | `schema-block-filter.ts` exports `groupSchemaBlocks`, `filterBlocksForPage`, `buildScriptTag`, `isSitewideBlock` | D1 |
| AC9 | `schema-js-builder.ts` imports SITEWIDE_TYPES/SITEWIDE_TARGETS from `schema-block-filter.ts` (DRY) | D1 |
| AC10 | Pages tab expanded view shows matched schema blocks with type badge, name, and copy-JSON button | D2 |
| AC11 | Pages tab shows "Copy all for this page" button that copies combined `<script>` tag | D2 |
| AC12 | Pages tab uses `matchesPageTarget()` from `serve-utils.ts` for block matching | D2 |
| AC13 | `PageByPageSection` receives `schemas: SchemaBlock[]` prop | D2 |
| AC14 | Setup tab shows "Schema Blocks" card with summary "N blocks across M pages" | D3 |
| AC15 | Setup tab groups blocks: sitewide first, then homepage, then per-page | D3 |
| AC16 | Each block in Setup tab has expand/collapse JSON-LD toggle + copy button | D3 |
| AC17 | Setup tab "Copy all for this page" button per page group | D3 |
| AC18 | Schema Blocks card gated behind `tier === "paid"` | D3 |
| AC19 | `schema.js` endpoint behavior unchanged (already page-aware — no regression) | D4 |
| AC20 | Existing `schema.json` endpoint continues to return flat array (backward compatible) | D4 |
| AC21 | 32 unit tests pass | UT |
| AC22 | 10 integration tests pass | IT |

**Files to create:**
1. `geo/app/api/serve/[slug]/schema/[page]/route.ts` (new API endpoint)
2. `geo/lib/schema-block-filter.ts` (shared filter/group helpers)

**Files to modify:**
3. `geo/app/sites/[id]/ResultsDashboard.tsx` (Pages tab schema display + Setup tab Schema Blocks card)
4. `geo/lib/schema-js-builder.ts` (import SITEWIDE_TYPES/SITEWIDE_TARGETS from schema-block-filter.ts)

---

## ScriptDev Notes

1. **D4 is a no-op.** `schema-js-builder.ts` already does page-aware injection. Verify with a quick manual test — no code changes needed for the injection behavior.
2. The `[page]` dynamic segment in Next.js App Router catches `_sitewide`, `_all`, and URL-encoded paths. Use `decodeURIComponent()` on the page param.
3. For `_all?format=grouped`, read `req.nextUrl.searchParams.get("format")`. If format is not "grouped", return same as `_all` but as a flat array (backward-compat).
4. `CopyButton` already exists in ResultsDashboard.tsx — reuse it for all copy interactions.
5. For the Setup tab SchemaBlocksCard, keep state local (expanded block index). Don't over-engineer — a simple `useState<number | null>` for which block's JSON-LD is expanded.
6. The `matchesPageTarget` import from `serve-utils.ts` is a server-side module. For the client-side Pages tab, inline the matching logic (or duplicate the 3-line check) rather than importing a server module into a `"use client"` component. Alternatively, move `matchesPageTarget` and `normalizePath` to a shared util that has no server dependencies.
7. `serve-utils.ts` has no server-only imports (no `db`, no `next/server`) — it's pure functions. Safe to import in client components.
