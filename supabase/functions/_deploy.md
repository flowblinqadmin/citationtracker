# Deploying the beacon Edge Functions

> **Do not deploy from a Claude agent.** Deploy is a production action and
> is gated by Adithya (or whoever owns the Supabase production project).
> This file is the runbook for that human-driven action.

## Schema prerequisites

These functions write to `geo_page_views`, `geo_crawl_logs`, and `rate_limits`
and read from `geo_sites`. The geo project manages schema via **`drizzle-kit
push`** (no tracked SQL migration files; the canonical schema lives in
`lib/db/schema.ts`).

Production already has these tables — the existing Vercel beacon route writes
to them today, so no schema work is required on prod for this PR. Before the
first deploy, however, run:

```bash
# Production (Supabase project)
DATABASE_URL=<prod-pooled-url> DATABASE_URL_DIRECT=<prod-direct-url> npm run db:push
```

…and confirm the diff is empty (or limited to additive columns you intend).
Particularly verify `geo_page_views.ip_hash` exists — if it doesn't, the
beacon insert will fail with `column "ip_hash" of relation "geo_page_views"
does not exist`. (The column was added in `lib/db/schema.ts` for ES-090
§b.1 COMP-2; confirm it has been pushed.)

For local development of these functions, the same flow applies:

```bash
supabase start
npm run db:push:local
```

## Pre-deploy audit

Before pushing either function to production, confirm the project's
secret store contains the required keys and nothing it shouldn't.

```bash
supabase secrets list --project-ref <ref>
```

### Required (must be present)

| Secret | Source | Set by | Rotation |
|---|---|---|---|
| `SUPABASE_DB_URL` | Auto-injected by Supabase as a reserved default secret. Read by `_shared/db.ts` via `Deno.env.get`. | Supabase platform | On db password rotation only |
| `IP_HASH_SECRET` | Generated locally: `openssl rand -hex 32`. Store backup in 1Password vault `flowblinq/edge-functions`. | Adithya at deploy time | Annual; rotation invalidates prior pseudonymization by design |
| `PUBLIC_COLLECT_URL` | `https://<ref>.supabase.co/functions/v1/track-collect` — or the Cloudflare-fronted custom domain if using the CF path (see Geo enrichment policy below). | Adithya at deploy time | Only on project-ref / domain change |
| `GEO_SAMPLE_RATE` | **MUST be `1.0`** for production. The 0.1 default in `_shared/geo-enrich.ts` is a free-tier fit for local dev only — production must enrich every row to preserve the country/city/region columns at 100% fidelity. | Adithya at deploy time | Never (1.0 is locked) |

### Geo enrichment policy (REQUIRED before PR2 client flip)

The Supabase Edge runtime does not inject Vercel/CF edge headers, so every row's `country`/`city`/`region` columns depend on either an external API call (ipinfo) or a proxy that injects headers (Cloudflare). At 100% sample rate we must pick one of two paths. Picking neither = `country`/`city`/`region` columns go NULL on every row.

| Path | Coverage | Cost | What to do |
|---|---|---|---|
| **Cloudflare in front of Supabase** (recommended) | Country: 100% free via `cf-ipcountry`. City/region: requires CF Pro plan ($25/mo). | $0–$25/mo | Add CNAME `track.flowblinq.com → mkwjqntnlmogwjqxezqw.supabase.co` in Cloudflare DNS, orange-cloud proxy on. Set `PUBLIC_COLLECT_URL=https://track.flowblinq.com/functions/v1/track-collect`. The handler already reads `cf-ipcountry` as its first preference; no code change needed. |
| **ipinfo.io paid plan** | Country + city + region: 100% via API | ~$249/mo Standard (unlimited) at our volume; Basic $99/mo covers 250k lookups | Set `IPINFO_TOKEN` to the paid token (NOT the free tier — would hit 50k cap in days). Set `GEO_SAMPLE_RATE=1.0`. |

`IPINFO_TOKEN` is still **optional** if you go the Cloudflare route; the handler falls back to null geo for whatever cf-* headers aren't present.

### Must NOT be in scope for these two functions

| Secret | Why |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. The beacons use `SUPABASE_DB_URL` (pooled, low-privilege). Confirmed (2026-05-11) that Supabase auto-injects this key as a **reserved default secret to every Edge Function** — there is no per-function opt-out. Mitigation: source-level discipline (CI grep guard added in commit b3030da; runtime warn-on-presence in `_shared/db.ts` confirmed firing locally). Supabase is migrating away from this key (deprecated in favor of `SUPABASE_SECRET_KEYS` via JWT Signing Keys) — re-audit when that lands. |
| `STRIPE_SECRET_KEY`, `SENDGRID_API_KEY`, etc. | Unrelated; not used here. Confirm they don't pollute the function's env. |

If `SUPABASE_SERVICE_ROLE_KEY` shows up in `supabase secrets list`, do NOT
proceed. Escalate to Adithya — Supabase project-level secret scoping is the
hard part; we may need to coordinate with other functions that legitimately
need the service-role key.

### Audit completed 2026-05-11 (project ref `mkwjqntnlmogwjqxezqw`)

Performed via browser inspection of the project dashboard's Edge Function
Secrets page. Findings:

- **Custom secrets defined:** 0. All four required/optional custom secrets
  (`IP_HASH_SECRET`, `PUBLIC_COLLECT_URL`, `IPINFO_TOKEN`, `GEO_SAMPLE_RATE`)
  must be added via the Supabase dashboard or `supabase secrets set` before
  deploying the beacon functions.
- **`SUPABASE_SERVICE_ROLE_KEY`:** Auto-injected by Supabase platform as a
  reserved default secret to every Edge Function. No per-function scoping
  option exists in the current product. Mitigation stands at source level
  (CI grep + runtime warn).
- **`SUPABASE_DB_URL`:** Auto-injected per project as a reserved default.
  No manual setup needed; our function reads it via `Deno.env.get`.
- **Vercel ↔ Supabase native integration:** Not active on this project
  (confirmed via `vercel.com/<team>/geo/stores` — Supabase databases show
  "Connect" buttons, none are connected). Vercel env vars don't auto-flow
  to Supabase functions and vice-versa.

Pre-deploy checklist for Adithya:
1. Dashboard → Edge Functions → Secrets → Add: `IP_HASH_SECRET` (output of
   `openssl rand -hex 32`; back up to 1Password `flowblinq/edge-functions`)
2. Add: `PUBLIC_COLLECT_URL` = `https://mkwjqntnlmogwjqxezqw.supabase.co/functions/v1/track-collect`
3. Add: `IPINFO_TOKEN` (free tier from ipinfo.io)
4. Optional: `GEO_SAMPLE_RATE` (default 0.1)

## Deploy command

After the audit passes, deploy each function:

```bash
supabase functions deploy track-collect --project-ref <ref> --no-verify-jwt
supabase functions deploy track-slug --project-ref <ref> --no-verify-jwt
```

`--no-verify-jwt` is REQUIRED because the beacons are intentionally
public (anonymous visitors fire them from any browser). `verify_jwt =
false` is also pinned in `supabase/config.toml` for both functions.
Together they prevent Supabase's default JWT gate from 401-ing every
beacon request.

## Post-deploy smoke test

```bash
# track-collect happy path → expect 204
curl -i -X POST "https://<ref>.supabase.co/functions/v1/track-collect" \
  -H "Content-Type: application/json" \
  -H "x-forwarded-for: 1.2.3.4" \
  -d '{"s":"smoke","u":"https://example.com/"}'

# track-slug human path → expect 200 + JS body containing the
# PUBLIC_COLLECT_URL value (NOT geo.flowblinq.com/api/t/collect)
curl -i "https://<ref>.supabase.co/functions/v1/track-slug/smoke" \
  -H "User-Agent: Mozilla/5.0"

# track-slug malicious UA → expect 403
curl -i "https://<ref>.supabase.co/functions/v1/track-slug/smoke" \
  -H "User-Agent: sqlmap/1.6.5"
```

Then run the verify harness from your laptop against production:

```bash
SUPABASE_FUNCTIONS_URL="https://<ref>.supabase.co/functions/v1" \
  supabase/functions/_verify/run-all.sh
```

## Client traffic flip

Deploy does NOT flip clients. After the smoke tests pass:

1. Coordinate with Manipal / Buzzfeed / White Stripes to add
   `<ref>.supabase.co` to their CSP `connect-src` (see plan PR1.5).
2. Open the tracker-loader update PR (PR2) so the loader posts to the
   Supabase domain. Vercel `/api/t/*` routes stay alive for 30 days as
   a fallback / overlap window.
3. Watch Vercel Fluid + Function Invocations metrics drop within 24h
   of the loader flip.

## Rollback

The tracker loader is the only client-side switch.

```bash
# 1. Revert the loader PR to point clients back at Vercel
# 2. The Vercel routes /api/t/collect and /api/t/[slug] are still live —
#    they kept running through the migration.
# 3. Supabase functions stay deployed but idle. No cost when idle.
```

If a rollback is needed AFTER PR3 (Vercel routes deleted), the rollback is
a redeploy of those routes — but that should not happen because PR3 only
ships once telemetry confirms the migration is stable.
