# Runtime Policy

Single source of truth for which runtime serves each route. Enforced by
`scripts/check-runtime-policy.ts` (run via `npm run check:runtime-policy`).

Two runtime classes:

1. **Vercel Fluid** — Node.js runtime on Vercel. Long-running paid-client
   jobs (audit pipeline, citation check, PDF generation, chatbot). Default
   for any route that touches the audit DB via Drizzle/postgres-js, calls
   external AI APIs with long timeouts, or runs >10s. Billed by warm
   container Memory time.
2. **Vercel Edge** — Vercel Edge Functions (V8 isolate). Anonymous-public,
   high-volume, no TCP. Talks to Postgres via supabase-js HTTPS. Must
   export `runtime = 'edge'` from the route file. Billed per invocation.

Rules enforced by CI:

- A route in the **Vercel Edge** section MUST export `runtime = 'edge'`.
- A route in the **Vercel Fluid** section MUST NOT export
  `runtime = 'edge'`.
- A route not in any section fails CI with "unclassified route".

> **CI wiring**: this geo repo does not yet have a `.github/workflows/`
> entry that runs `npm run check:runtime-policy`. Until one is added the
> check is a manual gate — run it locally before PR review. Adding the
> workflow file is the natural follow-up.

---

## Vercel Fluid (Node.js)

Long-running, DB-touching, AI-API-heavy. Default class.

| Path | Justification |
|---|---|
| `app/api/audit/route.ts` | Audit creation; writes geo_sites + kicks pipeline |
| `app/api/audit/[id]/route.ts` | Audit status read; full row payload |
| `app/api/audit/[id]/commerce-report/route.ts` | `maxDuration = 300`; AI report gen |
| `app/api/audit/[id]/intelligence/route.ts` | `maxDuration = 60`; AI synthesis |
| `app/api/audit/[id]/semantic/route.ts` | Semantic search over audit data |
| `app/api/audit/[id]/sov/route.ts` | `maxDuration = 60`; SOV calc |
| `app/api/audit/[id]/sov-query/route.ts` | `maxDuration = 30`; SOV query |
| `app/api/audit/[id]/sov-complete/route.ts` | SOV finalize |
| `app/api/audit/[id]/technical/route.ts` | Technical audit aggregation |
| `app/api/audit/[id]/verify/route.ts` | Audit verification handshake |
| `app/api/audit-purchase/checkout/route.ts` | Stripe checkout session create |
| `app/api/audit-purchase/intake/route.ts` | Free-tier audit intake |
| `app/api/audit-purchase/status/route.ts` | Polled audit-purchase status |
| `app/api/auth/check/route.ts` | Session check; cookie read + DB |
| `app/api/auth/otp/send/route.ts` | OTP send; SendGrid + rate-limit DB |
| `app/api/auth/otp/verify/route.ts` | OTP verify; bcrypt + DB |
| `app/api/auth/proxy/[...path]/route.ts` | Auth proxy with cookie rewrite |
| `app/api/chatbot/route.ts` | `runtime = "nodejs"`; `maxDuration = 60`; LLM stream |
| `app/api/checkout/route.ts` | Stripe checkout session |
| `app/api/consent/route.ts` | Cookie-consent write |
| `app/api/cron/process-queue/route.ts` | `maxDuration = 30`; Vercel cron |
| `app/api/cron/recrawl/route.ts` | `maxDuration = 60`; Vercel cron |
| `app/api/csp-report/route.ts` | CSP violation report receiver; DB write |
| `app/api/integration-instructions/route.ts` | Customer integration HTML render |
| `app/api/oauth/token/route.ts` | OAuth token exchange; DB write |
| `app/api/pipeline/crawl-webhook/route.ts` | `maxDuration = 30`; Firecrawl callback |
| `app/api/pipeline/run/route.ts` | `maxDuration = 300`; pipeline kickoff |
| `app/api/pipeline/stage/route.ts` | `maxDuration = 800`; single-stage executor |
| `app/api/pricing/route.ts` | Pricing config read; touches DB for overrides |
| `app/api/report/[shareToken]/route.ts` | Shared report HTML; DB lookup |
| `app/api/serve/[slug]/business.json/route.ts` | Serve AI crawlers; DB read |
| `app/api/serve/[slug]/head/route.ts` | Serve <head> snippet; DB read |
| `app/api/serve/[slug]/llms-full.txt/route.ts` | Serve llms-full.txt; DB read |
| `app/api/serve/[slug]/llms.txt/route.ts` | Serve llms.txt; DB read |
| `app/api/serve/[slug]/schema.js/route.ts` | Serve schema injection JS; DB read |
| `app/api/serve/[slug]/schema.json/route.ts` | Serve schema JSON; DB read |
| `app/api/serve/[slug]/schema/[page]/route.ts` | Serve per-page schema; DB read |
| `app/api/serve/[slug]/urls.txt/route.ts` | Serve URL list; DB read |
| `app/api/sites/[id]/route.ts` | Site read/update; DB |
| `app/api/sites/[id]/auth/route.ts` | Site auth check; DB |
| `app/api/sites/[id]/citation-check/route.ts` | `runtime = "nodejs"`; `maxDuration = 600`; AI calls |
| `app/api/sites/[id]/citation-history/route.ts` | `runtime = "nodejs"`; history aggregation |
| `app/api/sites/[id]/citation-narrative/route.ts` | `runtime = "nodejs"`; `maxDuration = 30` |
| `app/api/sites/[id]/competitor-discovery/route.ts` | `runtime = "nodejs"`; `maxDuration = 120` |
| `app/api/sites/[id]/competitors/route.ts` | Competitors CRUD; DB |
| `app/api/sites/[id]/consent/route.ts` | `maxDuration = 30`; consent flow |
| `app/api/sites/[id]/download-report/route.ts` | Report download; DB + storage |
| `app/api/sites/[id]/fix-html-render/route.ts` | Fix HTML paste/render; jsdom + DB; Node-only (Edge has no jsdom) |
| `app/api/sites/[id]/info/route.ts` | Site info; DB |
| `app/api/sites/[id]/pdf-report/route.ts` | `maxDuration = 60`; chromium PDF render |
| `app/api/sites/[id]/regenerate/route.ts` | `maxDuration = 30`; pipeline retrigger |
| `app/api/sites/[id]/retry-failed/route.ts` | `maxDuration = 30`; retry orchestration |
| `app/api/sites/[id]/verify/route.ts` | `maxDuration = 30`; ownership verify |
| `app/api/sites/[id]/verify-connection/route.ts` | DNS / TXT verify; outbound DNS |
| `app/api/sites/[id]/verify-domain/route.ts` | Domain ownership verify; DB |
| `app/api/sites/[id]/[...pdfPath]/route.ts` | `maxDuration = 60`; PDF asset proxy |
| `app/api/sites/route.ts` | Sites collection list/create; DB |
| `app/api/teams/domains/route.ts` | Team domains CRUD; DB |
| `app/api/teams/domains/claim/route.ts` | Domain claim; DB |
| `app/api/teams/invite/route.ts` | Team invite; SendGrid + DB |
| `app/api/teams/me/route.ts` | Current team; DB |
| `app/api/teams/[teamId]/api-clients/route.ts` | API clients CRUD; DB |
| `app/api/teams/[teamId]/api-clients/[clientId]/route.ts` | Single API client CRUD |
| `app/api/v1/account/route.ts` | Public v1 account; DB |
| `app/api/v1/audit/route.ts` | Public v1 audit create; DB + pipeline |
| `app/api/v1/audit/[id]/route.ts` | Public v1 audit read; DB |
| `app/api/v1/audit/[id]/verify/route.ts` | Public v1 audit verify; DB |
| `app/api/v1/mcp/route.ts` | MCP endpoint; protocol handler |
| `app/api/v1/page_views/route.ts` | Public v1 page-view query; DB read |
| `app/api/webhooks/stripe/route.ts` | Stripe webhook; signature verify + DB |
| `app/api/admin/cleo/golden/route.ts` | Cleo golden-set admin write; admin auth + DB |
| `app/api/parts/auth/route.ts` | Parts intel auth; OTP send + DB |
| `app/api/parts/intel/route.ts` | Parts intel read; Neon DB via postgres-js (TCP) |

## Vercel Edge (V8 isolate)

Routes that must export `runtime = 'edge'`. Talk to Postgres via
`@/lib/supabase-edge` (supabase-js HTTPS). No TCP, no Buffer, no fs.

| Path | Justification |
|---|---|
| `app/api/t/collect/route.ts` | Anonymous-public beacon ingest; ~80 rpm sustained — billed per invocation on Edge instead of warm-container Memory time on Fluid |
| `app/api/t/[slug]/route.ts` | Anonymous-public schema/beacon emit; co-located with /t/collect for the same cost reason. Edge runtime injects x-vercel-ip-country/city/region-code headers natively, preserving 100% geo coverage |
