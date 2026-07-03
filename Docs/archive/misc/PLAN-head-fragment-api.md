# GEO Head Fragment API + Generic Client Integration — STASHED PLAN

**Status:** Implementation started, interrupted. Stashed 2026-03-14.

## What was done

1. **`geo/lib/serve-utils.ts`** — Created. Path matching utility (`matchesPageTarget`, `normalizePath`). Complete.
2. **`geo/app/api/serve/[slug]/head/`** — Directory created, route.ts not yet written.
3. WordPress plugin changes — not started.
4. Tests — not started.

## What remains

### Part 1: API Endpoint
- Write `app/api/serve/[slug]/head/route.ts` (follows schema.json pattern exactly)
- Query param `path` (required), filters `generatedSchemaBlocks` by `pageTarget`
- Returns `text/html` with `<script type="application/ld+json">` blocks
- 204 for no matches, proper cache headers, CORS `*`

### Part 2: WordPress Plugin
- `includes/class-bot-head-injector.php` — bot UA detection + output buffering + API fetch + injection
- Modify `flowblinq-geo.php` to instantiate injector
- Modify `class-proxy.php` to skip `inject_schema_jsonld` for bots when injector active
- Modify `class-admin-page.php` for toggle setting

### Part 3: Tests
- `__tests__/serve-head.test.ts` — 11 test cases
- `__tests__/serve-utils.test.ts` — 6 test cases
- `testing/integration/test-bot-injection.php` — 13 test cases

### Part 4: Integration guide snippets (docs only)

## Key patterns discovered

- All serve routes use identical structure: slug lookup, rate limit (bypass for AI crawlers), logCrawl fire-and-forget
- `generatedSchemaBlocks` is `Array<{ name, type, jsonLd, instructions, pageTarget }>`
- `pageTarget` values: `"all pages"`, `"homepage"`, or a URL like `https://domain.com/about`
- `logCrawl` FileType needs new value `"head_html"` added
- WordPress plugin uses transient caching, stale-while-revalidate for schema

## Full plan

See the original plan in the conversation or at:
`/home/aditya/.claude/projects/-home-aditya-flowblinq--agents-workspaces-1-cofounder/69323d20-bfb8-47df-a93e-95a1e90045ba.jsonl`
