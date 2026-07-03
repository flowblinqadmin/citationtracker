# Firecrawl API Reference

> Engineer reference. Firecrawl v2 API. Updated: 2026-02-22.

## Auth & Install

```
Authorization: Bearer fc-YOUR_API_KEY
Base URL: https://api.firecrawl.dev/v2
```

```bash
npm install @mendable/firecrawl-js zod
```

```typescript
import Firecrawl from '@mendable/firecrawl-js';
const fc = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
```

---

## POST /scrape — Single URL

**1 credit/page. +4 credits if json format used. +4 for stealth proxy.**

```typescript
// Request
{
  url: string;                        // required
  formats?: (string | FormatObject)[];// default: ["markdown"]
  only_main_content?: boolean;        // default: true
  includeTags?: string[];             // e.g. ["h1", "p", ".main-content"]
  excludeTags?: string[];             // e.g. ["#footer", "nav", ".ads"]
  waitFor?: number;                   // extra ms wait after smart detection
  timeout?: number;                   // ms, default: 30000
  maxAge?: number;                    // cache freshness ms, default: 172800000 (2d); 0 = force fresh
  storeInCache?: boolean;             // default: true
  location?: { country: string; languages?: string[] }; // ISO 3166-1 alpha-2
  actions?: Action[];                 // browser interactions before scrape
}

// Response
{
  success: boolean;
  data: {
    markdown?: string;
    html?: string;
    rawHtml?: string;
    screenshot?: string;
    links?: string[];
    images?: string[];
    summary?: string;
    json?: Record<string, any>;
    branding?: BrandingObject;
    metadata: {
      title: string; description: string; language: string;
      ogTitle: string; ogImage: string; sourceURL: string; statusCode: number;
    };
  };
}
```

```typescript
const result = await fc.scrape('https://example.com', {
  formats: ['markdown', 'links'],
  excludeTags: ['#footer', 'nav'],
  maxAge: 0,
});
```

---

## POST /batch/scrape — Multi-URL Async

Same params as `/scrape` but `urls: string[]`. SDK polls automatically.

```typescript
const result = await fc.batchScrape(
  ['https://example.com/a', 'https://example.com/b'],
  { formats: ['markdown'], pollInterval: 2, timeout: 120 }
);
```

---

## POST /crawl — Full Site Crawl

**1 credit/page crawled. Async — returns job ID.**

```typescript
// Request
{
  url: string;
  limit?: number;                   // default: 10000
  crawlEntireDomain?: boolean;
  allowSubdomains?: boolean;
  sitemap?: 'include' | 'skip';     // default: 'include'
  scrapeOptions?: {
    formats?: (string | FormatObject)[];
    only_main_content?: boolean;
    includeTags?: string[];
    excludeTags?: string[];
    maxAge?: number;
    proxy?: 'auto' | 'basic' | 'stealth';
  };
  webhook?: { url: string; secret?: string; events?: CrawlEvent[] };
}

// Initial response
{ success: true; id: string; url: string; }

// Status/completed response
{
  status: 'scraping' | 'completed' | 'failed';
  total: number; completed: number; creditsUsed: number;
  expiresAt: string;   // results persist 24 hours
  next?: string;       // pagination URL — results chunked at 10MB
  data: Array<{ markdown?: string; html?: string; metadata: {...} }>;
}
```

```typescript
// Wait for completion (SDK auto-polls)
const result = await fc.crawl('https://example.com', {
  limit: 100,
  scrapeOptions: { formats: ['markdown'], only_main_content: true },
});

// Async + manual poll
const { id } = await fc.startCrawl('https://example.com', { limit: 10 });
const status = await fc.getCrawlStatus(id);

// WebSocket watcher
const { id } = await fc.startCrawl('https://example.com', { limit: 5 });
const watcher = fc.watcher(id, { kind: 'crawl', pollInterval: 2 });
watcher.on('document', doc => console.log(doc));
watcher.on('done', state => console.log(state.status));
await watcher.start();
```

**Webhook events:** `crawl.started` | `crawl.page` | `crawl.completed` | `crawl.failed`
Includes `X-Firecrawl-Signature` header (HMAC-SHA256) for verification.

---

## POST /map — URL Discovery

**1 credit per call (any number of URLs returned).**

```typescript
// Request
{
  url: string;
  limit?: number;
  sitemap?: 'include';
  search?: string;     // filter by keyword relevance
  location?: { country: string; languages?: string[] };
}

// Response
{ success: boolean; links: Array<{ url: string; title?: string; description?: string }>; }
```

```typescript
const { links } = await fc.map('https://example.com', { limit: 500, search: 'product' });
const productUrls = links.map(l => l.url).filter(u => u.includes('/products/'));
```

---

## POST /extract — Multi-URL LLM Extraction

```typescript
// Request
{
  urls: string[];              // supports wildcards: ["https://example.com/*"]
  prompt?: string;
  schema?: object;             // JSON Schema or Zod-converted
  enableWebSearch?: boolean;   // expand crawl for enrichment
  agent?: { model: 'FIRE-1' }; // for complex navigation
}

// Response
{
  success: boolean;
  data: Record<string, any>;
  status: 'completed' | 'processing' | 'failed' | 'cancelled';
  expiresAt: string;
}
```

```typescript
// Async variant
const { id } = await fc.startExtract(['https://example.com/*'], { schema: MySchema });
const result = await fc.getExtractStatus(id);
```

---

## Output Formats

| Format | Description | Extra Credits |
|--------|-------------|---------------|
| `markdown` | Cleaned markdown | — |
| `html` | Cleaned HTML | — |
| `rawHtml` | Unmodified original HTML | — |
| `links` | All extracted hyperlinks | — |
| `images` | All image URLs | — |
| `summary` | LLM-condensed overview | — |
| `screenshot` | Page screenshot | — |
| `json` | Structured LLM extraction | +4/page |
| `branding` | Colors, fonts, logo, typography | varies |

---

## LLM Extraction (json format)

```typescript
import { z } from 'zod';

const Schema = z.object({
  name: z.string(),
  price: z.number(),
  inStock: z.boolean(),
  description: z.string().optional(),
});

// With Zod schema
const result = await fc.scrape('https://shop.example.com/product/1', {
  formats: [{ type: 'json', schema: Schema }],
});
// result.data.json is typed as z.infer<typeof Schema>

// With prompt (no schema)
const result = await fc.scrape('https://example.com', {
  formats: [{ type: 'json', prompt: 'Extract company name, founding year, CEO.' }],
});
```

---

## Browser Actions

Executed sequentially before the page is scraped.

```typescript
actions: [
  { type: 'wait', milliseconds: 2000 },
  { type: 'click', selector: '#cookie-accept' },
  { type: 'write', text: 'search term', selector: 'input[name="q"]' },
  { type: 'press', key: 'Enter' },
  { type: 'screenshot' },                                      // mid-flow capture
  { type: 'executeJavascript', script: 'window.scrollTo(0,1000)' },
]
```

---

## Credit Costs Summary

| Operation | Credits |
|-----------|---------|
| `/scrape` per page | 1 |
| `/crawl` per page crawled | 1 |
| `/map` per call | 1 |
| `json` format (any endpoint) | +4/page |
| Enhanced/stealth proxy | +4/page |
| PDF parsing | +1/PDF page |

---

## Error Codes

| Status | Meaning | Fix |
|--------|---------|-----|
| `401` | Bad/missing API key | Check `Bearer fc-...` header |
| `402` | No credits | Top up at firecrawl.dev/app |
| `429` | Rate limited | Exponential backoff |
| `500` | Server error | Retry; check status.firecrawl.dev |
| `503` | Unavailable | Retry with backoff |

```typescript
async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err: any) {
      if ((err.status === 429 || err.status >= 500) && i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * 2 ** i));
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}
```

---

## Rate Limits

Plan-dependent — check firecrawl.dev/app dashboard. General rules:
- Crawl jobs are async and do not consume per-minute request budget during execution
- Status polling: use `pollInterval` in SDK (avoid tight loops)
- Crawl results available via API for 24 hours post-completion
- Paginate large crawl results via `next` URL (chunked at 10MB)

---

## Type Reference

```typescript
type Format = 'markdown' | 'html' | 'rawHtml' | 'links' | 'images' | 'summary' | 'screenshot' | 'branding';
type FormatObject =
  | { type: 'json'; schema?: ZodSchema | object; prompt?: string }
  | { type: 'screenshot'; fullPage?: boolean; quality?: number; viewport?: { width: number; height: number } };

type Action =
  | { type: 'wait'; milliseconds: number }
  | { type: 'click'; selector: string }
  | { type: 'write'; text: string; selector?: string }
  | { type: 'press'; key: string }
  | { type: 'screenshot' }
  | { type: 'executeJavascript'; script: string };

type CrawlEvent = 'crawl.started' | 'crawl.page' | 'crawl.completed' | 'crawl.failed';
```
