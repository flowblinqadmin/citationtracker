# GEO Crawler Architecture

## Performance Targets
| Site Size | Target Time |
|-----------|-------------|
| ≤ 50 pages | 60s |
| 51–100 pages | 90s |
| 101–500 pages | 5 min |

---

## Pipeline Overview

```
regenerate (user clicks retry)
  → check active_crawls < 5 in DB
  → if >= 5: status = "queued", wait for slot
  → if < 5:  kick off pipeline

discoverSite()
  → fc.mapUrl(domain)              ~8s, 1 credit, guaranteed URL list

deepCrawl(urls)
  → Jina parallel on ALL urls      ~15s flat, free, concurrent
  → collect failed (< 500 chars or error page)
  → chunk failed into batches of 50
  → fire up to 5 fc.asyncCrawlUrl() simultaneously
  → as each batch completes, fire next batch
  → merge all results

analyze / generate / assemble      ~60s, OpenAI calls
```

---

## Tier Details

### Tier 1: Firecrawl mapUrl (URL Discovery)
- **What**: `fc.mapUrl(domain, { limit: 200 })`
- **Why**: Direct fetch blocked (429), Jina blocked (422) on hostile sites. Firecrawl is the only reliable URL discovery.
- **Cost**: 1 credit per domain regardless of URL count
- **Time**: ~8s
- **Fallback**: none — this is the guaranteed foundation

### Tier 2: Jina (Free Crawl Pass)
- **What**: `fetch('https://r.jina.ai/' + url)` on ALL urls in parallel
- **Why**: Free, fast, handles most normal sites. No credits consumed.
- **Cost**: Free (API key required)
- **Time**: ~15s flat regardless of URL count (fully parallel)
- **Pass threshold**: content >= 500 chars AND not an error page
- **Failure**: pages with < 500 chars or bot-challenge content → Tier 3

### Tier 3: Firecrawl asyncCrawlUrl (Failed Pages Only)
- **What**: `fc.asyncCrawlUrl(domain, { includePaths: failedPaths })`
- **Why**: Runs on Firecrawl's infra (not Vercel), handles JS rendering and anti-bot
- **Cost**: 1 credit per page crawled
- **Concurrency**: max 5 simultaneous crawl jobs (hobby plan)
- **Batching**: chunk failed pages into groups of 50, fire 5 batches at once, queue rest
- **Time**: ~50s per batch of 50 pages (parallel on Firecrawl's infra)
- **Polling**: QStash re-enqueues poll every 15s, each poll function < 5s

### Tier 4: Apify (Discovery fallback only)
- **What**: `apifyClient.actor('aYG0l9s7dbB7j3gbS').start({ startUrls })`
- **Why**: Residential proxies + Playwright, bypasses Cloudflare/WAF
- **Cost**: ~$5 free/month on Apify free tier
- **When**: Only if fc.mapUrl() returns 0 URLs (extremely rare)
- **NOT used for**: per-page crawling (22s cold start makes it too slow)
- **Pattern**: async start → store runId → QStash poll every 30s

---

## Concurrency & Queuing

```
geo_sites.pipeline_status values:
  "pending"    → ready, not started
  "queued"     → waiting for a Firecrawl slot (>= 5 active crawls)
  "crawling"   → Firecrawl job(s) running
  "analyzing"  → OpenAI calls in progress
  "complete"   → done
  "failed"     → error, user can retry

Active crawl limit: 5 (Firecrawl hobby plan)

/api/cron/process-queue (runs every 30s via QStash)
  → count sites WHERE status = "crawling"
  → slots_free = 5 - count
  → take next slots_free sites WHERE status = "queued" ORDER BY queued_at ASC
  → kick off their crawl pipelines
```

---

## Vercel Function Budget

Every Vercel function must complete in < 300s (5 min limit).

| Route | What it does | Max time |
|-------|-------------|----------|
| `/api/sites/[id]/regenerate` | fc.mapUrl + start Jina pass + fire Firecrawl jobs | ~30s |
| `/api/pipeline/poll` | check crawl status, merge results if done, trigger analyze | ~60s |
| `/api/cron/process-queue` | check slots, dequeue waiting sites | ~5s |

No long-running functions. All heavy work happens on Firecrawl/Apify infra.

---

## Cost Model

| Scenario | Credits/run |
|----------|-------------|
| Normal site (Jina gets 80%) | ~11 credits (1 map + 10 pages Firecrawl) |
| Hostile site (Jina gets 0%) | ~51 credits (1 map + 50 pages Firecrawl) |
| 100-page normal site | ~21 credits |
| 500-page hostile site | ~501 credits |

Firecrawl hobby plan: 3,000 credits/month
- Normal sites: ~272 full audits/month
- Hostile sites: ~58 full audits/month

Upgrade trigger: Growth plan ($83/mo, 100k credits, 20 concurrent) when onboarding paying customers.

---

## What We Tested (2026-02-24)

| Test | Result |
|------|--------|
| Direct fetch flowblinq.com sitemap | 429 blocked |
| Jina sitemap | 422 blocked |
| Firecrawl mapUrl flowblinq.com | 31 URLs in 8.5s ✓ |
| Jina parallel on flowblinq.com pages | 1/3 succeeded (about page only) |
| Apify 3-page crawl | 7 pages in 82s, 6108 chars homepage ✓ |
| Apify targeted 2 failed pages | 1/2 returned (dedup issue on redirects) |
| Firecrawl asyncCrawlUrl 5 pages | 5 pages in 20s, 12591 chars homepage ✓ |
| Full pipeline locally | 2m23s, score 43→62, complete ✓ |

### Key findings
- flowblinq.com is on Vercel with aggressive rate limiting — blocks direct, Jina, ScraperAPI
- Apify has a 22s cold start overhead — not suitable for per-page fallback
- Apify deduplicates URLs that redirect to same canonical — loses pages
- Firecrawl asyncCrawlUrl is the right tool: fires instantly, runs on their infra, rich content
- Jina is genuinely useful for normal sites — got /about with 5807 chars free

---

## Files To Refactor

- `lib/services/geo-crawler.ts` — replace sequential fallback chain with parallel Jina + async Firecrawl batching
- `lib/pipeline/runner.ts` — split into discover → crawl → analyze stages
- `app/api/sites/[id]/regenerate/route.ts` — add concurrency gate (check active_crawls < 5)
- `app/api/pipeline/run/route.ts` — replace with poll route
- `app/api/cron/process-queue/route.ts` — new: dequeue waiting sites every 30s
- `app/sites/[id]/SitePageClient.tsx` — already fixed (queued → not idle)
