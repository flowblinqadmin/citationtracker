# TS-087 — `/api/v1/page_views` read-only API

**Status:** DRAFT (authored 2026-04-21 by Shastri on branch `api/pageviews-read`).
**Author anchor:** Aditya + Shastri pairing session.
**Supersedes:** none.
**Related:** ES-087 (engineering spec, this TS's sibling), TS-088-ga-pipe (customer-side consumer).

## 1. Problem

Flowblinq serves proxy assets (`/api/t/<slug>`) embedded in customer sites. When a visitor hits a customer page, the browser fetches our asset — which is logged as a `geo_page_views` row. Customer pages often have Google Analytics tags, but those tags either don't fire at all (when our proxy serves the page) or fire separately from our logging (and our traffic is invisible to their GA dashboard).

Marketing-agency customers trust GA. They distrust any analytics that doesn't show in GA. We need a way to forward proxied traffic into the customer's GA4 property (or any other analytics service the customer picks).

The cleanest architecture puts the forwarding logic in a customer-distributable C++ binary (see TS-088-ga-pipe) that reads filtered page-view data from flowblinq via a scoped HTTP API. THIS spec defines that read API.

## 2. Hypothesis

A scope-gated JSON endpoint exposing filtered `geo_page_views` rows, authenticated via the existing OAuth2 client-credentials flow, enables external pipelines to relay proxied traffic into any analytics service (GA4, Plausible, Matomo, custom webhook) without requiring per-customer binary builds, without exposing platform secrets, and with team-level data isolation.

## 3. Objective

Define **one** JSON endpoint `GET /api/v1/page_views` that:

1. Authenticates via existing JWT flow (reuses `lib/api-auth.ts` — no new auth primitives)
2. Gates access via a new `pageviews:read` scope added to the existing scope allowlist
3. Resolves customer-supplied `domain` to internal `slug` via team ownership (prevents cross-customer reads)
4. Returns filtered page-view rows with cursor-based pagination
5. Survives burst requests via per-client rate limiting (120 req/hr per `client_id`)

Non-goals: dashboard UI, write path, backfill >72h, mutation semantics.

## 4. Method

**Auth:** reuse existing OAuth2 client-credentials flow at `/api/oauth/token`. Client posts `client_id + client_secret + grant_type=client_credentials` → receives 1h JWT with embedded scopes. Subsequent API calls use `Authorization: Bearer <jwt>`. Endpoint validates via `verifyApiToken` + `requireScope("pageviews:read")`. No new auth code.

**Scope:** add `"pageviews:read"` to the `allowedScopes` array at `app/api/teams/[teamId]/api-clients/route.ts:78`. Add description to the MCP discovery map at `app/api/v1/mcp/route.ts`. No DB migration — `api_clients.scopes` is already `text[]`.

**Domain → slug resolution:** server joins `geo_sites` on `team_id = token.team_id AND domain = <query param>`. If no match: 404 `{"error": "domain_not_found"}`. If match: use the resolved `slug` for downstream query. Prevents a team from reading another team's data even if they guess the domain.

**Filters applied at query time:**
- `slug = <resolved_slug>` — the **only** filter. A row exists under a given slug because the tracker was served for that slug; the slug is the binding.

**Bot-class filtering — deliberately NOT applied server-side.** Flowblinq's product differentiator vs. native GA4 is visibility into LLM / bot traffic. Filtering `bot_name` here would silently drop the very signal customers pay for. The API returns every row (visitor, googlebot, chatgpt-user, gptbot, claudebot, perplexitybot, unknown, etc.) with the `bot_name` field exposed in each row. Consumers (pipe sink templates, dashboards) decide per-bot-class routing downstream.

**Host-match anti-spoof — NOT applied server-side (design decision 2026-04-21).** Earlier drafts filtered by `page_url LIKE 'https://<domain>%'` to prevent a malicious site from embedding the tracker with someone else's slug and polluting their analytics. Dropped because (1) the threat is low-impact — attacker gains nothing beyond polluted analytics, and (2) the filter trips every customer whose bare domain redirects to `www.` (most of them). If anti-spoof becomes required later, put it at ingestion time (`/api/t/<slug>` handler validates `Referer`) — never store a polluted row in the first place. Current threat model: slug-based reads return every row stored under that slug.

**Pagination:** cursor-based, `(viewed_at, id)` compound cursor for deterministic ordering. Query:
```sql
WHERE (viewed_at, id) > (<since_ts>, <since_id>)
ORDER BY viewed_at ASC, id ASC
LIMIT <limit>
```
On last page: `has_more = false`. Otherwise: `next_cursor = base64({last_viewed_at, last_id})`.

**Bootstrap / re-pull (`since` param):** optional `since=<RFC3339 UTC>` lets callers seed the window without a prior cursor — first-time onboarding, operator-driven re-pull, or recovery after cursor-state loss. Rules:

- `since` and `cursor` are **mutually exclusive**. Both present → 400 `conflicting_params`.
- Neither present → default `since = now - 72h`. Rationale: GA4 Measurement Protocol rejects events older than 72h, so pulling further back wastes bandwidth by default.
- `since` is a one-shot seed. Subsequent pages within the same pagination chain use the server-issued cursor, never `since`.

**Default `limit`:** 1000. Range [1, 1000].

**Rate limit:** per-`client_id` token bucket via existing `lib/rate-limit.ts`. 120 req/hr. On exhaustion: 429 with `Retry-After: <seconds_to_next_refill>`.

**Consecutive-bad-request blocking (defensive circuit-breaker):** client integrations that repeatedly send malformed requests signal either a broken integration or probing. Policy:

- **Bad request** = any 400-class response this endpoint emits: `missing_domain`, `bad_cursor`, `bad_since`, `bad_limit`, `conflicting_params`, `malformed_token`. 401 `token_expired`/`client_revoked` and 403 `insufficient_scope` do NOT count (they're auth/perm concerns, not input-shape concerns). 429 / 404 / 500 don't count.
- **Counter:** per-`client_id`, **consecutive**. Stored in `api_clients.consecutive_bad_requests INT DEFAULT 0`. Any successful (2xx) response resets to 0.
- **Threshold:** 20. On the 21st consecutive bad request, set `api_clients.blocked_at = NOW()`.
- **Block surface:** subsequent requests from a blocked client — even well-formed ones — return 401 `client_blocked`. Distinct from `client_revoked` (manual revocation); `blocked_at` is auto-set by the counter, `revoked_at` is set via the admin UI.
- **Unblock:** manual SQL / admin path — `UPDATE api_clients SET blocked_at = NULL, consecutive_bad_requests = 0 WHERE client_id = ?`. Auto-unblock TTL deferred to a later release.

**Response shape:**
```json
{
  "domain": "www.mysite.com",
  "slug_resolved": "mysite-com-xxxxxx",
  "served_ts": "2026-04-21T15:30:00.000Z",
  "rows": [
    {
      "id": "nanoid-string",
      "page_url": "https://www.mysite.com/path",
      "referrer": "https://google.com/",
      "visitor_id": "geovid-string-or-null",
      "user_agent": "Mozilla/5.0...",
      "bot_name": "visitor",
      "ip": "1.2.3.4",
      "country": "IN",
      "screen_width": 412,
      "viewed_at": "2026-04-21T15:29:45.123Z"
    }
  ],
  "has_more": true,
  "next_cursor": "base64-encoded-cursor"
}
```

## 5. Success criteria

Pre-stated. No moving goalposts.

| # | Case | Expected |
|---|---|---|
| 1 | Valid token, `pageviews:read` scope, owned domain | 200 + rows, p95 server-side query < 200ms |
| 2 | Valid token, owned domain, scope missing | 403 `{"error":"insufficient_scope"}` |
| 3 | Valid token, domain not owned by token's team | 404 `{"error":"domain_not_found"}` |
| 4 | No token / malformed bearer | 401 `{"error":"missing_token"}` |
| 5 | Expired JWT | 401 `{"error":"token_expired"}` |
| 6 | Revoked `api_client` | 401 `{"error":"client_revoked"}` (re-check on each request despite JWT TTL) |
| 7 | 121st request within 1 hour for `client_id` | 429 `{"error":"rate_limit_exceeded"}` + `Retry-After` header |
| 8 | Cursor pagination determinism | Same cursor → same next page across 100 repeated calls |
| 9 | Cross-team isolation (red team) | Team A token + Team B's domain → 404, never 200 |
| 10 | All bot classes returned | Seeded rows with `bot_name ∈ {visitor, googlebot, chatgpt-user, gptbot, unknown}` ALL appear in response, each with its `bot_name` field exposed. No server-side class filtering. |
| 11 | No host-match filter (dropped 2026-04-21) | All rows under the slug are returned regardless of `page_url` host. Customers relying on bare vs www domain in `geo_sites.domain` get the same data. |
| 12 | Empty result | 200 with `rows: []` and `has_more: false` |
| 13 | `since` + `cursor` both present | 400 `conflicting_params` |
| 14 | Neither `since` nor `cursor` | 200 with rows from `now-72h` onwards only (rows older than 72h absent even if present in DB) |
| 15 | Malformed `since` (not RFC3339) | 400 `bad_since` |
| 16 | 21st consecutive bad request for a `client_id` | 401 `client_blocked`; `api_clients.blocked_at` set. Subsequent valid requests also 401 `client_blocked` until manual unblock. |
| 17 | Any 2xx interspersed in a bad-request run | `consecutive_bad_requests` resets to 0; block not triggered by subsequent bad requests below threshold. |

## 6. Out of scope

- Dashboard UI scope-picker update (deferrable; team admins can add `pageviews:read` via existing `POST /api/teams/[teamId]/api-clients` route until UI lands)
- Write endpoint / ingestion (this is READ-ONLY; ingest stays on `/api/t/<slug>` + `/api/t/collect`)
- Cross-team or admin-scope reads (intentional: one team = one slice)
- Backfill beyond 72h — default `since` is capped at `now-72h` (aligned with GA4 MP hard limit); callers can pass an older `since`, but rows outside the 72h window at the sink side will be dropped by GA4
- Webhook/SSE push (TS-088-ga-pipe defers these; polling is MVP primitive)

## 7. Dependencies + risks

**Dependencies:** existing `api_clients`, `geo_sites`, `geo_page_views` tables; `lib/api-auth.ts`; `lib/rate-limit.ts`. **One new migration** adds two columns to `api_clients`: `consecutive_bad_requests INT NOT NULL DEFAULT 0` and `blocked_at TIMESTAMPTZ NULL`.

**Risks:**

| Risk | Mitigation |
|---|---|
| Cross-team data leak via missing team_id filter | Integration test #9 asserts isolation; code review checklist |
| N+1 query on `geo_sites` lookup | Single JOIN or prepared statement; benchmark at 100 TPS |
| High-volume customer exhausts 120 req/hr quota during catch-up | Default limit 1000 rows/call × 120 calls/hr = 120k rows/hr headroom. With bot traffic now included (vs. earlier `visitor`-only spec), expect ~2-3× row volume per domain. Still fits comfortably; revisit only if a customer sustains >120k events/hr. |
| Rate-limit infra (`lib/rate-limit.ts`) is in-memory per-pod | Pods are few on Vercel; acceptable MVP. Upstash Redis backing is a later hardening (same pattern as beacon collector). |

## 8. Stakeholders

- **Shastri** (spec author): drafts TS + ES, authors tests, implements endpoint
- **Aditya** (ratifier): reviews TS + ES, approves merge
- **HolePoker** (adversarial): reviews rule 1+2 compliance + red-team cross-team tests post-merge-if-invoked

## 9. Implementation order

1. Ratify TS (this doc) → TS-087 READY
2. Write ES-087 with exact SQL, error codes, response shape finalization
3. Author UTs + ITs covering all 12 success criteria
4. Implement endpoint until all tests pass
5. Push `api/pageviews-read` branch; PR review; merge to `main`

---
