# TS-068 — Per-Page Schema Block Serving

## What

Serve schema blocks per-page, not just as one monolithic blob. Customers need to install schema on specific pages — the current `/api/serve/{slug}/schema.json` dumps all blocks as a flat array with no way to filter by page.

## Why

The audit generates 20-40 schema blocks per site, each with a `pageTarget` field indicating which page it belongs to (e.g., `"https://flowblinq.com/blog/ai-commerce-roi"`, `"all pages"`, `"homepage"`). Today these are:

1. Served as one array at `schema.json` — useless for per-page installation
2. Shown in the Setup tab as a code block — but no way to filter by page or copy individual blocks
3. The `schema.js` injection script injects ALL blocks on every page — no page-level targeting

A customer looking at their `/pricing` page audit results should be able to:
- See exactly which schema blocks apply to that page
- Copy the JSON-LD for that specific page
- Get a `<script>` tag they can paste into that page's `<head>`

## Dependencies

- `generated_schema_blocks` column in `geo_sites` (exists)
- Each block has `{ name, type, jsonLd, instructions, pageTarget }` (exists)
- Per-page results in `per_page_results` with page URLs (exists)

## Interfaces

### 1. New API endpoint: `GET /api/serve/{slug}/schema/{page}`

Serves schema blocks filtered to a specific page.

**URL pattern:** `/api/serve/{slug}/schema/{page}` where `{page}` is a URL-encoded page path or `_sitewide` for blocks targeting "all pages".

**Request:**
```
GET /api/serve/flowblinq-com-abc123/schema/blog%2Fai-commerce-roi
GET /api/serve/flowblinq-com-abc123/schema/_sitewide
GET /api/serve/flowblinq-com-abc123/schema/_all?format=grouped
```

**Response (single page):**
```json
{
  "page": "https://www.flowblinq.com/blog/ai-commerce-roi",
  "blocks": [
    {
      "name": "FAQPage: AI Commerce ROI",
      "type": "FAQPage",
      "jsonLd": { "@context": "https://schema.org", ... },
      "instructions": "Add this to the <head> of your pricing page"
    }
  ],
  "sitewide": [
    {
      "name": "Organization Schema",
      "type": "Organization",
      "jsonLd": { ... }
    }
  ],
  "scriptTag": "<script type=\"application/ld+json\">[...combined]</script>"
}
```

**Response (grouped — `_all?format=grouped`):**
```json
{
  "sitewide": [ ... blocks with pageTarget "all pages" ... ],
  "homepage": [ ... blocks with pageTarget "homepage" ... ],
  "pages": {
    "https://www.flowblinq.com/blog/ai-commerce-roi": [ ... ],
    "https://www.flowblinq.com/pricing": [ ... ]
  }
}
```

### 2. UI: Per-page schema in Pages tab

In the Pages tab, each page row's expanded view shows the schema blocks that target that page.

**Current:** Pages tab shows `overallPageHealth`, vulnerabilities, and fix instructions.

**New:** Add a "Schema Blocks" section in the expanded page view showing:
- List of schema blocks targeting this page (by matching `pageTarget` to the page URL)
- Plus sitewide blocks that apply to all pages
- Each block shows: type badge, name, copy-JSON button
- A combined `<script>` tag with a copy button for easy installation

### 3. UI: Schema section in Setup tab

**Current:** Setup tab shows AI files (llms.txt, business.json, etc.) with download links.

**New:** Add a "Schema Blocks" card below the AI files section:
- Summary: "N schema blocks across M pages"
- Grouped list: sitewide blocks first, then per-page blocks grouped by URL
- Each block: type badge + name + expandable JSON-LD + copy button
- "Copy all for this page" button per page group

### 4. Update `schema.js` injection script

**Current:** `schema.js` injects ALL schema blocks on every page load.

**New:** `schema.js` reads `window.location.pathname`, fetches the grouped schema endpoint, and injects only:
- Sitewide blocks (always)
- Blocks matching the current page URL
- Homepage blocks (only on `/` or `/index`)

This makes the injection script page-aware — each page only gets its relevant schema.

## Acceptance Criteria

1. `GET /api/serve/{slug}/schema/{page}` returns blocks filtered by page + sitewide blocks
2. `GET /api/serve/{slug}/schema/_all?format=grouped` returns blocks grouped by page
3. Pages tab expanded view shows schema blocks per page with copy buttons
4. Setup tab shows grouped schema blocks with copy-all per page
5. `schema.js` only injects blocks relevant to the current page
6. Sitewide blocks (pageTarget="all pages") always included regardless of page filter
7. Homepage blocks (pageTarget="homepage") only included on root path
8. Existing `schema.json` endpoint continues to work (backward compatible)

## Risks

- `pageTarget` format varies: some are full URLs (`https://www.flowblinq.com/blog/...`), some are relative (`homepage`, `all pages`). The matching logic needs to handle both.
- Large sites with 100+ pages could have 200+ schema blocks — the grouped response needs pagination or lazy loading in the UI.
- The `schema.js` update requires a new fetch call per page load — adds latency. Consider inlining the page-grouped data as a JSON object in the script itself.
