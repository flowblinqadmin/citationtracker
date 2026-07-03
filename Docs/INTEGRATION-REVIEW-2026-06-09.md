# Integration review + customer-flow harnesses — 2026-06-09

From driving the customer-critical flows end-to-end (billing lifecycle, bulk audit, serve endpoints) on local infra.

## Harnesses added (customer-critical flows)
| Harness | Flow | State |
|---------|------|-------|
| `e2e/billing-lifecycle.spec.ts` | activation / renewal / past-due / cancellation (signed Stripe webhooks → DB) | ✅ 4/4 |
| `e2e/customer-integration.spec.ts` | serve `llms.txt` / `llms-full.txt` / `business.json` / `schema.json` / `urls.txt` to customer sites + AI crawlers | ✅ 10/10 (also proves RLS-safety) |
| `e2e/bulk-flowblinq.spec.ts` | bulk audit of 10 flowblinq URLs through the pipeline | ⏭️ skipped in CI — verified manually (submit 201 + real crawl fan-in 8/10); full completion needs a public callback (below) |

## Did the 2026-06-09 updates break customer website integration? **No.**
The public serve/beacon endpoints all read via the **service role**, which bypasses RLS + the new `REVOKE FROM anon,authenticated`:
- `serve/[slug]/*` + `report/[shareToken]` → `db` from `@/lib/db` (postgres superuser).
- `t/collect`, `t/[slug]` beacon → `supabase-edge` service-role key (`BYPASSRLS`).
- Proven empirically: serve endpoints return **200 with real content** under RLS (customer-integration harness, 3 assets), and never **500**. The migration revoked from `anon`/`authenticated` only.

## Simpler / more effective integration pathways (recommendations)
1. **Crawl fan-in: poll-first, not webhook-first.** Crawl-fanout submits Firecrawl jobs with `webhook=true`, so even local/CI runs need a public callback tunnel (cloudflared/QStash). The poll fallback works without a tunnel, but its fan-in counter under-reports (`8/0`) in `LOCAL_PIPELINE`, so merge never fires and the audit stalls. **Fix:** poll-first (or poll-only when `LOCAL_PIPELINE=1`) and correct the fan-in total so `merge-crawl` triggers. Removes the tunnel dependency and makes the *full* pipeline testable locally/CI.
2. **Single LLM gateway.** `lib/llm/openai-route.ts` centralizes the OpenAI-compatible calls (now locally routable), but Gemini/Anthropic-native calls still hit their own SDKs/endpoints — so local-LLM testing only covers part of the pipeline. **Fix:** route every LLM call through one OpenAI-compatible gateway (a proxy for Gemini/Anthropic, or the Vercel AI Gateway) so `LLM_LOCAL=1` exercises the *whole* pipeline against a local model.
3. **`geo_site_view` is a base table, not a view** — confusing name for a denormalized read-model. **Fix:** rename (`geo_site_read_model`) or document; confirm the CDN-push path and the serve-endpoint pull stay consistent.
4. **Test-DB isolation.** The e2e seed FK-conflicts with in-flight pipeline rows (`firecrawl_jobs`, `team_domains`). **Fix:** cascade-clean child tables in the seed, or use per-test transaction rollback (the integration harness pattern).
5. **Env hygiene.** Test vs live Stripe/Firecrawl keys are split across `.env` (test/valid) and `.env.local` (live/dead), with the **live** key as the default-loaded value — risky for local testing. **Fix:** a dedicated `.env.test` with test keys; never leave a live key as the default-loaded value.

## Add-on step: performance (after correctness is confirmed)
Run once the above are green:
- **Serve-endpoint latency** — AI crawlers hit `llms.txt`/`schema.json` directly; measure TTFB + p95 under load (these should be CDN-cacheable; verify cache headers — `llms.txt` sets `max-age=3600`).
- **Pipeline stage timing** — record per-stage durations (discover/crawl/analyze/assemble) to find the slow stage; the bulk crawl fan-in is the current bottleneck.
- **RLS overhead** — confirm RLS+REVOKE adds negligible cost for the service-role path (it bypasses RLS, so ~0; verify with EXPLAIN on the hot serve query).
- Tooling: the `seo-performance` / Lighthouse path + a simple `autocannon` load test against the serve endpoints.
