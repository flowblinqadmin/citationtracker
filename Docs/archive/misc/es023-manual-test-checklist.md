# ES-023 Manual Test Checklist — Crawl Fan-out Pipeline

**Spec:** `.agents/specs/engineering/ES-023-crawl-fanout-pipeline.md`
**Date written:** 2026-03-04
**Who runs this:** Aditya (manual, on production Vercel + Supabase)

---

## What changed in ES-023

The crawl phase of the pipeline was rewritten. Previously:
- `handleCrawl()` ran a scrape pass then fired Firecrawl async jobs serially — ~80–140s for a standard audit
- `handleCrawlBulk()` chunked URLs and submitted batches **sequentially** — ~500s for 500 URLs
- `handlePoll()` polled all jobs together with exponential backoff

After ES-023:
- `handleCrawlFanout()` submits **all** URL chunks concurrently to Firecrawl in ~5–10s, then enqueues one independent `poll-chunk` QStash job per chunk and returns immediately
- `handlePollChunk()` — one QStash job per chunk, polls independently, re-enqueues itself if still running
- `fanInChunk()` — atomic Postgres `UPDATE … RETURNING` counter; the last chunk to finish atomically detects `done === total` and enqueues `merge-crawl`
- `handleMergeCrawl()` — flattens all chunk results, quality-checks, writes `crawl_data`, enqueues `research`

Both standard and bulk audits use the same code path. `chunked-firecrawl.ts` is deleted.

**Affected entry points:** all three — single audit (free + paid), bulk CSV, and API v1.

**New DB columns on `geo_sites`:**
| Column | Type | Purpose |
|--------|------|---------|
| `crawl_chunks_total` | integer | How many chunks were submitted |
| `crawl_chunks_done` | integer | Fan-in counter — incremented atomically as each chunk completes |
| `crawl_chunk_results` | jsonb | `CrawledPage[][]` — one array per chunk, flattened by merge-crawl |
| `crawl_started_at` | timestamp | Set at crawl-fanout start, used for circuit breaker |

---

## Prerequisites — run these before any testing

- [ ] **Migration applied** — connect to production Supabase and confirm the 4 new columns exist on `geo_sites`:
  ```sql
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'geo_sites'
    AND column_name IN ('crawl_chunks_total','crawl_chunks_done','crawl_chunk_results','crawl_started_at');
  ```
  Expected: 4 rows returned. If not, run:
  ```sql
  ALTER TABLE geo_sites ADD COLUMN crawl_chunks_total  integer;
  ALTER TABLE geo_sites ADD COLUMN crawl_chunks_done   integer;
  ALTER TABLE geo_sites ADD COLUMN crawl_chunk_results jsonb;
  ALTER TABLE geo_sites ADD COLUMN crawl_started_at    timestamp;
  ```

- [ ] **Vercel deploy is live** — check Vercel dashboard, confirm the ES-023 commit shows "Ready" on production

- [ ] **Supabase table editor open** — you'll watch `geo_sites` rows in real time during tests

- [ ] **QStash dashboard open** — `console.upstash.com` → Messages tab, filter by your endpoint URL. Used to verify fan-out job counts

---

## Block 1 — Single Audit, Free Tier

_Free path: anonymous user, max 20 pages, 1 chunk expected._

- [ ] **1.1** Go to the homepage, enter a domain not previously audited, submit without logging in
- [ ] **1.2** Confirm `pipeline_status` moves from `pending` → `crawling` in Supabase within ~30s
- [ ] **1.3** Confirm `crawl_chunks_total` is set (expect `1` for a small site) and `crawl_chunks_done = 0` while crawling
- [ ] **1.4** Confirm `crawl_chunks_done` reaches `crawl_chunks_total` (fan-in completes)
- [ ] **1.5** Confirm `pipeline_status` moves to `analyzing` then `complete` — `crawl_chunk_results` and `crawl_data` are non-null
- [ ] **1.6** Results page renders: 16-pillar scorecard visible with scores, no blank sections
- [ ] **1.7** Timing: crawl phase (from `crawl_started_at` to `crawl_data` being written) should be under 45s

---

## Block 2 — Single Audit, Paid Tier

_Paid path: logged-in team user with credits, max 100 pages, may produce multiple chunks._

- [ ] **2.1** Log in with a team account that has credits, submit a new audit for a content-rich domain (aim for a site with 50+ pages)
- [ ] **2.2** Confirm `crawl_limit` on the `geo_sites` row is 100 (not 20)
- [ ] **2.3** If site has > 50 pages, confirm `crawl_chunks_total > 1` in Supabase — multiple concurrent chunks
- [ ] **2.4** Check QStash dashboard — confirm multiple `poll-chunk` jobs were enqueued within seconds of each other (not sequentially minutes apart)
- [ ] **2.5** Watch `crawl_chunks_done` increment across refreshes — chunks should complete in overlapping time windows
- [ ] **2.6** Confirm exactly ONE `merge-crawl` QStash job appears — if you see more than one, fan-in has a bug
- [ ] **2.7** Results page renders with content from all chunks merged (richer content → higher content richness scores expected)
- [ ] **2.8** Timing: crawl phase completes in under 60s for a 100-page site

---

## Block 3 — Bulk CSV Audit

_Bulk path: multiple URLs, up to 500 pages, `auditMode = "bulk"`, multiple chunks expected._

- [ ] **3.1** Upload a CSV with 100–200 URLs via the bulk entry point while logged in
- [ ] **3.2** Confirm `audit_mode = 'bulk'` on the `geo_sites` row in Supabase
- [ ] **3.3** Confirm `crawl_chunks_total` matches expected chunk count (URL count ÷ 50 URLs/chunk, rounded up). E.g. 200 URLs → `crawl_chunks_total = 4`
- [ ] **3.4** Check QStash dashboard — confirm that many `poll-chunk` jobs were enqueued nearly simultaneously, not one-at-a-time
- [ ] **3.5** Watch `crawl_chunks_done` increment from 0 to `crawl_chunks_total`
- [ ] **3.6** Confirm exactly ONE `merge-crawl` job fires
- [ ] **3.7** ZIP report is generated, per-page results are populated, overall scorecard reflects the full URL set
- [ ] **3.8** Timing: crawl phase for 200 URLs should complete in 30–60s (previously would have been ~200s+)

---

## Block 4 — API (v1 via CLI or direct HTTP)

_API path: `POST /api/v1/audit` → `discover` → `crawl-fanout` fan-out. Also tests the `verify` re-crawl path._

- [ ] **4.1** Submit an audit via CLI:
  ```bash
  flowblinq audit --domain example.com
  ```
- [ ] **4.2** Poll for completion:
  ```bash
  flowblinq audit --poll <audit-id>
  ```
  Confirm status transitions: `crawling` → `analyzing` → `complete`
- [ ] **4.3** In Supabase, confirm `crawl_chunks_total` and `crawl_chunks_done` populated correctly on the API-submitted audit
- [ ] **4.4** Trigger the second run (verify endpoint):
  ```bash
  curl -X POST https://flowblinq.com/api/v1/audit/<id>/verify \
    -H "Authorization: Bearer <token>"
  ```
  Confirm a new `crawl-fanout` stage is enqueued in QStash (not `crawl` — the old stage name)
- [ ] **4.5** Confirm MCP output is valid:
  ```bash
  flowblinq audit --poll <audit-id> --json
  ```
  Response should be well-formed JSON with scorecard fields

---

## Block 5 — Recovery Paths

_Tests the cron recovery and retry paths — ensures stale/failed sites are re-processed correctly._

- [ ] **5.1 Stale crawling recovery** — find a site stuck in `crawling` (or create one by submitting an audit and pausing QStash). Trigger the recovery cron manually:
  ```
  GET /api/cron/process-queue  (with cron secret header)
  ```
  Confirm the site is re-enqueued with stage `crawl-fanout`, NOT the old `crawl` stage (check QStash or Vercel logs for `[stage:crawl-fanout]`)

- [ ] **5.2 Retry-failed** — on a failed site in the dashboard, click "Retry". In Vercel logs, confirm the sequence is `discover` → `crawl-fanout` (not `crawl`)

- [ ] **5.3 Single-chunk failure** — not easy to trigger manually, but if you see a site where `crawl_chunks_done < crawl_chunks_total` and status is stuck, check whether the circuit breaker kicked in (Vercel log line: `[stage:poll-chunk] ... circuit breaker fired`). The site should eventually complete merge with whatever pages were collected

---

## Block 6 — Regression Checks

_Existing functionality must not be broken by ES-023._

- [ ] **6.1 Old completed audits still render** — open an audit that completed before ES-023 was deployed. The new columns will be null on old rows. Scorecard must still display normally
- [ ] **6.2 Citation check (AI Visibility)** — on any completed paid-tier audit, run the AI Visibility check. Confirm it completes and results are saved. ES-023 does not touch citation routes
- [ ] **6.3 Dashboard and domain list** — logged-in dashboard loads, domain cards appear, clicking through to a domain works
- [ ] **6.4 API key management** — create and revoke an API key from the dashboard. Confirm the DB rows change correctly
- [ ] **6.5 OAuth token** — `POST /api/oauth/token` with valid client credentials returns a JWT

---

## What to capture if something fails

For any failure, record:

1. **`siteId`** from Supabase
2. **`pipeline_status`**, `crawl_chunks_total`, `crawl_chunks_done` at time of failure
3. **Vercel function log** for the failing stage — filter by:
   - `[stage:crawl-fanout]` — fan-out submission issues
   - `[stage:poll-chunk]` — individual chunk polling issues
   - `[stage:merge-crawl]` — flatten/merge issues
4. **QStash message log** — check if the expected number of `poll-chunk` jobs were enqueued
5. **Whether `crawl_chunk_results` is null or partially populated** — indicates which chunks completed before failure

File issues against ES-023 with the above data.
