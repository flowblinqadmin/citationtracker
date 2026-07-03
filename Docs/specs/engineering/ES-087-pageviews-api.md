# ES-087 — `/api/v1/page_views` engineering spec

**Status:** DRAFT (authored 2026-04-21 by Shastri, companion to TS-087).
**TS anchor:** `docs/specs/technical/TS-087-pageviews-api.md`.
**Scope:** server-side only. Pipe (TS-01-ga-pipe / ES-01-ga-pipe) is separate.

## 1. Module layout

New + touched files on branch `api/pageviews-read`:

```
app/api/v1/page_views/route.ts          [NEW] — endpoint handler
lib/db/migrations/NNNN_api_client_blocking.sql  [NEW] — adds api_clients.consecutive_bad_requests + blocked_at
lib/db/schema.ts                        [EDIT] — add consecutiveBadRequests + blockedAt columns to apiClients
app/api/teams/[teamId]/api-clients/route.ts:78   [EDIT] — add "pageviews:read" to allowedScopes
app/api/v1/mcp/route.ts                 [EDIT] — register scope in MCP discovery map
lib/cursor.ts                           [NEW] — encodeCursor/decodeCursor compound (viewed_at,id)
lib/rate-limit.ts                       [EDIT if needed] — expose per-client-id bucket getter
tests/unit/cursor.test.ts               [NEW] — cursor round-trip + malformed rejection
tests/unit/pageviews-handler.test.ts    [NEW] — handler-level UTs, mocked DB
tests/integration/pageviews-api.test.ts [NEW] — ITs covering TS success criteria 1-12
```

No DB migration. No new tables.

## 2. Request lifecycle (sequence)

```
┌── client sends GET /api/v1/page_views?domain=X&limit=500&cursor=…
│
├─ [1] Bearer presence check (no Authorization → 401 missing_token)
│
├─ [2] Auth middleware (verifyApiToken — stateless, jose HMAC verify)
│     extract Bearer → verify JWT sig + exp
│     on ERR_JWT_EXPIRED → 401 token_expired
│     on any other failure → 401 malformed_token
│
├─ [3] Rate-limit middleware (key = JWT's verified sub = client_id)
│     check bucket; on empty → 429 + Retry-After
│     (runs AFTER verify so the key is trustworthy — see §5)
│
├─ [4] Fetch api_clients row for revocation + block gate
│     if row missing or api_client.revokedAt → 401 client_revoked
│     if api_client.blockedAt  IS NOT NULL → 401 client_blocked
│
├─ [3] Scope check (requireScope)
│     if "pageviews:read" ∉ token.scopes → 403 insufficient_scope
│
├─ [4] Domain → slug resolution
│     SELECT slug FROM geo_sites
│     WHERE team_id = $1 AND domain = $2 LIMIT 1
│     if no row → 404 domain_not_found
│
├─ [5] Window seed (cursor vs since)
│     if cursor present AND since present → 400 conflicting_params
│     if cursor present → decodeCursor(cursor) → (since_ts, since_id)
│     else if since present → parseRFC3339(since) → (since_ts, '')
│                              on parse error → 400 bad_since
│     else → (now - 72h, '')      -- default: align to GA4 MP backfill ceiling
│     on cursor decode error → 400 bad_cursor
│
├─ [6] Page-view query
│     SELECT … FROM geo_page_views
│     WHERE slug = $1
│       AND bot_name = 'visitor'
│       AND (page_url LIKE 'https://' || $2 || '%' OR page_url LIKE 'http://' || $2 || '%')
│       AND (viewed_at, id) > ($3, $4)
│     ORDER BY viewed_at ASC, id ASC
│     LIMIT ($5 + 1)    -- fetch one extra to compute has_more
│
├─ [6.5] Bad-request / success counter update (single SQL round trip, see §3 Q3)
│     on 400-class response:
│       UPDATE api_clients SET consecutive_bad_requests = consecutive_bad_requests + 1,
│                              blocked_at = CASE WHEN consecutive_bad_requests + 1 > 20
│                                                THEN NOW() ELSE blocked_at END
│       WHERE id = <token.api_client_row_id>
│       RETURNING consecutive_bad_requests, blocked_at
│     on 2xx response:
│       UPDATE api_clients SET consecutive_bad_requests = 0
│       WHERE id = <token.api_client_row_id> AND consecutive_bad_requests > 0
│
├─ [7] Response assembly
│     rows := query_rows[0..limit]
│     has_more := len(query_rows) > limit
│     next_cursor := has_more ? encodeCursor(last.viewed_at, last.id) : null
│     JSON.stringify({domain, slug_resolved, served_ts, rows, has_more, next_cursor})
│
└─ 200 OK
```

## 3. Exact SQL

**Q1 — domain lookup (prepared):**

```sql
SELECT slug
FROM geo_sites
WHERE team_id = $1 AND domain = $2
LIMIT 1;
```

Index required: `geo_sites (team_id, domain)`. Verify via `EXPLAIN`; add CREATE INDEX in a separate migration if missing (out of scope for this PR — but flag in review).

**Q3 — bad-request counter increment + auto-block (prepared, atomic):**

```sql
UPDATE api_clients
SET consecutive_bad_requests = consecutive_bad_requests + 1,
    blocked_at = CASE
                   WHEN consecutive_bad_requests + 1 > 20 AND blocked_at IS NULL
                     THEN NOW()
                   ELSE blocked_at
                 END
WHERE id = $1
RETURNING consecutive_bad_requests, blocked_at;
```

Single round trip; atomic under postgres MVCC. Caller observes the new counter + block state in the returned row and emits the `client_blocked` log event when `blocked_at` flips from NULL to non-NULL in the same update.

**Q4 — success counter reset (prepared, conditional):**

```sql
UPDATE api_clients
SET consecutive_bad_requests = 0
WHERE id = $1 AND consecutive_bad_requests > 0;
```

Guarded by `consecutive_bad_requests > 0` so the common hot path (already at 0) short-circuits without a write.

**Q2 — page-views window (prepared):**

```sql
SELECT id, page_url, referrer, visitor_id, user_agent, bot_name, ip, country, screen_width, viewed_at
FROM geo_page_views
WHERE slug = $1
  AND (viewed_at, id) > ($2::timestamp, $3::text)
ORDER BY viewed_at ASC, id ASC
LIMIT $4;
```

Bind values are now just `(resolved_slug, since_ts, since_id, limit+1)` — the `$2 = domain` bind is gone because the host-match OR-clause is gone.

No server-side `bot_name` filter — all classes returned with `bot_name` exposed. No host-match filter — slug is the binding. See TS-087 §4 "Host-match anti-spoof" decision note.

Index required: `geo_page_views (slug, viewed_at, id)` (composite). The migration at `lib/db/migrations/20260421-pageviews-api-blocking.sql` creates `geo_page_views_slug_bot_viewed_id_idx` on `(slug, bot_name, viewed_at, id)` — with the bot filter gone, the `bot_name` column in that index is no longer part of any WHERE predicate, but it's still useful for internal dashboards that may filter by class. Keep it.

**Bind values per call:**
- `$1 = resolved_slug` (string)
- `$2 = domain` (string, as supplied by client post-validation)
- `$3 = since_ts` — resolved by precedence: `cursor.viewed_at` > `since` param > `now - 72h` default
- `$4 = since_id` — `cursor.id` if cursor present, else `''`
- `$5 = limit + 1` (fetch N+1 to detect `has_more` cheaply). `limit` default = 1000, range [1, 1000]; out-of-range → 400 `bad_limit`.

## 4. Cursor encoding (`lib/cursor.ts`)

```typescript
export interface Cursor { viewed_at: string; id: string; }

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

export function decodeCursor(s: string): Cursor {
  const parsed = JSON.parse(Buffer.from(s, "base64url").toString("utf-8"));
  if (typeof parsed.viewed_at !== "string" || typeof parsed.id !== "string") {
    throw new Error("bad_cursor");
  }
  // validate ISO-8601 timestamp shape; reject anything else
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/.test(parsed.viewed_at)) {
    throw new Error("bad_cursor");
  }
  return { viewed_at: parsed.viewed_at, id: parsed.id };
}
```

Base64url used (not plain base64) so cursors survive URL query params without `%`-encoding.

Deterministic: same `(viewed_at, id)` → byte-identical cursor (stable JSON key order via explicit construction). Satisfies TS success criterion #8.

## 5. Auth flow details

**JWT payload shape (existing, unchanged):**

```typescript
interface ApiTokenPayload {
  client_id: string;    // api_clients.client_id
  team_id: string;      // api_clients.team_id
  scopes: string[];     // api_clients.scopes (snapshot at token issue)
  iat: number; exp: number;
}
```

**Verification chain in `verifyApiToken` (existing at `lib/api-auth.ts`):**
1. Verify signature against JWT secret.
2. Check `exp > now` → else throw `{status: 401, message: "token_expired"}`.
3. Fetch `api_clients` row by `client_id`. If `revokedAt != null` → throw `{status: 401, message: "client_revoked"}`.

**Scope check (existing helper):**
```typescript
requireScope(token.scopes, "pageviews:read");
```
Throws `{status: 403, message: "insufficient_scope"}` on miss.

**Rate-limit key extraction — ordering constraint (corrected 2026-04-21 during implementation):**
Rate-limit runs AFTER JWT verify. The bucket key is `token.sub` (`client_id`) which is only trustworthy post-signature-verification. Verifying first prevents an attacker from forging unsigned JWTs carrying a victim's `client_id` claim to drain that victim's 120/hr quota — a peek-without-verify approach (earlier draft of this ES) was subtly broken for exactly this reason. JWT verify is CPU-bound (jose HMAC) and does not touch the DB, so the cost of verifying a flood of bad tokens is still small relative to a DB-backed rate-limit upsert.

## 6. Error code table

| HTTP | `error` | Trigger | Retriable? |
|---|---|---|---|
| 400 | `missing_domain` | `domain` query param absent | no |
| 400 | `bad_cursor` | cursor decode fails schema | no |
| 400 | `bad_since` | `since` param not RFC3339 UTC | no |
| 400 | `conflicting_params` | both `since` and `cursor` supplied | no |
| 400 | `bad_limit` | `limit` outside [1, 1000] | no |
| 401 | `missing_token` | Authorization header absent or non-Bearer | no |
| 401 | `malformed_token` | JWT has <3 segments / bad base64 | no |
| 401 | `token_expired` | exp < now | yes (after refresh via `/api/oauth/token`) |
| 401 | `client_revoked` | `api_clients.revokedAt IS NOT NULL` | no |
| 401 | `client_blocked` | `api_clients.blockedAt IS NOT NULL` (auto-set after 20 consecutive bad requests) | no (manual unblock only) |
| 403 | `insufficient_scope` | `pageviews:read` ∉ token.scopes | no |
| 404 | `domain_not_found` | no `geo_sites` row matching `(team_id, domain)` | no |
| 429 | `rate_limit_exceeded` | bucket empty | yes (after `Retry-After`) |
| 500 | `internal_error` | unhandled DB / runtime | yes (exponential backoff) |

Response body shape for all errors:
```json
{"error": "<code>", "message": "<human-readable>"}
```

## 7. Rate-limit details

**Bucket config:**
- capacity: 120
- refill: 120 tokens/hour, continuous (2 tokens/minute)
- key: `pageviews:${client_id}`
- backend: `lib/rate-limit.ts` in-memory Map (existing pattern)

**Retry-After computation:**
```typescript
const tokensShort = 1 - bucket.tokens;      // how many below threshold
const secsPerToken = 3600 / 120;            // 30
const retryAfter = Math.ceil(tokensShort * secsPerToken);
res.headers.set("Retry-After", String(retryAfter));
```

**Multi-pod note:** in-memory bucket is per-pod. In practice Vercel runs few concurrent pods for a single route; worst case: each pod grants its own 120/hr, so effective ceiling scales with pod count. Acceptable for MVP; document in release note. Upstash Redis backing is a future hardening (mirror the pattern already used for beacon collector rate-limit per §7 of TS-087).

## 8. Complexity analysis

**Per-request time:**
- Rate-limit check: O(1) hash lookup.
- JWT peek (base64 split) + verify (HMAC): O(|JWT|) ≈ O(1).
- `api_clients` fetch: O(1) (indexed PK).
- `geo_sites` fetch: O(log N_sites) (B-tree on team_id, domain).
- `geo_page_views` scan: O(log N_pv + limit) with composite index `(slug, viewed_at, id)`. Index seek to cursor position, then sequential read of `limit+1` rows.
- Cursor encode: O(1).
- JSON serialize: O(limit × row_size) ≈ O(limit).

Total: **O(log N + limit)** dominated by the final index seek + scan. With limit=500 and properly indexed tables, p95 server-side < 200ms (TS success criterion #1).

**Per-request space:**
- Prepared statement overhead: O(1).
- Row buffer: O(limit × avg_row_size). With limit=1000 and avg_row_size ≈ 600 bytes → ≤ 600 KB, fits in Vercel's 50 MB-ish response budget easily.
- No pagination state retained server-side; stateless.

## 9. Thread / concurrency safety

- Route handler is stateless. No shared mutable state in the handler body.
- `lib/rate-limit.ts` Map is protected by Node's single-threaded event loop; no explicit lock needed (all mutations happen in synchronous code paths between awaits).
- DB connection pool is shared; each request acquires + releases a connection. Pool size config in `lib/db/client.ts` (unchanged).
- No background jobs, no timers, no streams. Pure request/response.

## 10. Observability

**Primitive:** structured stdout logs, aggregated by Vercel (`vercel logs -p geo`). No separate metrics backend in this PR — counts/p95/rate of any field are computable post-hoc via `vercel logs … --json | jq`. Ratified with Aditya 2026-04-21.

**Log lines emitted per request:**
```typescript
logger.info("page_views.served", {
  client_id, team_id, domain, slug,
  rows_count, has_more,
  seed_mode: "cursor" | "since" | "default_72h",   // which seeded the window
  limit_requested, limit_effective,                 // for clipping detection
  query_ms, total_ms,
});
logger.warn("page_views.denied", {
  reason,                    // one of: insufficient_scope, domain_not_found, rate_limit_exceeded, conflicting_params, bad_since, bad_cursor, bad_limit, token_expired, client_revoked, missing_token, malformed_token, missing_domain
  client_id, team_id, domain,
});
logger.error("page_views.internal", { err, client_id });

// Emitted exactly once per client_id — when blocked_at flips NULL → non-NULL in Q3.
logger.warn("page_views.client_blocked", {
  client_id, team_id, consecutive_bad_requests: 21, triggering_reason,
});
```

**Post-hoc queries (no metrics backend required):**
- Request rate: `vercel logs -p geo --since 1h --json | jq 'select(.message=="page_views.served")' | wc -l`
- p95 latency: `… | jq '.total_ms' | sort -n | awk 'BEGIN{c=0}{a[c++]=$1}END{print a[int(c*0.95)]}'`
- Top rate-limited clients: `… | jq 'select(.reason=="rate_limit_exceeded") | .client_id' | sort | uniq -c | sort -rn`

**When to graduate to a real backend** (out of scope for this PR): if we add a second endpoint that needs metrics OR sustained >1M req/day makes log-grep impractical, revisit. Axiom is the cheapest Vercel-aligned option at that point.

## 11. Test plan

Maps 1:1 to TS-087 §5 success criteria. Detail in `tests/integration/pageviews-api.test.ts`:

| TS # | Test name | Fixtures |
|---|---|---|
| 1 | `returns_200_with_rows_and_cursor_for_valid_request` | team+client+scope+site+N rows |
| 2 | `returns_403_when_scope_missing` | token without `pageviews:read` |
| 3 | `returns_404_when_domain_owned_by_other_team` | two teams, cross-query |
| 4 | `returns_401_on_missing_bearer` | no Authorization header |
| 5 | `returns_401_on_expired_jwt` | token with `exp < now` |
| 6 | `returns_401_on_revoked_client` | `api_clients.revokedAt = NOW()` |
| 7 | `returns_429_on_121st_request` | 120 calls + 121st |
| 8 | `cursor_is_deterministic_across_calls` | same cursor → same next page ×100 |
| 9 | `cross_team_isolation_red_team` | team A token + team B domain |
| 10 | `all_bot_classes_returned_with_bot_name_field` | seed rows with `bot_name ∈ {visitor, googlebot, chatgpt-user, gptbot, unknown}` — assert ALL appear in response, each with its `bot_name` field populated |
| 11 | `host_mismatch_rows_absent_from_response` | seed with spoofed `page_url` |
| 12 | `empty_result_returns_200_has_more_false` | team+scope but no rows |
| 13 | `returns_400_conflicting_params_when_both_since_and_cursor` | valid token + both params supplied |
| 14 | `default_window_is_last_72h_when_no_seed` | seed rows at now-73h, now-30h, now-1h → only 30h+1h returned |
| 15 | `returns_400_bad_since_on_malformed_timestamp` | `since=not-a-date` |
| 16 | `twenty_one_consecutive_bad_requests_triggers_client_blocked` | fire 20 400s → 21st returns 401 client_blocked; next valid request also blocked |
| 17 | `interspersed_2xx_resets_consecutive_counter` | 15 bad + 1 good + 15 bad → NOT blocked (counter reset) |

All ITs run against a fresh postgres test DB (docker-compose managed) seeded per-test via `beforeEach` transactional rollback (existing pattern in `tests/integration/_setup.ts`).

Unit tests (`tests/unit/`):
- `cursor.test.ts` — encode/decode round trip, malformed base64, timestamp validation, injection rejection.
- `pageviews-handler.test.ts` — handler logic with mocked `db` + mocked auth (every branch: bad limit, bad cursor, missing domain, etc.).

## 12. Rollout

1. Open PR on `api/pageviews-read` → `main`.
2. CI must pass: UTs, ITs, type-check, lint.
3. HolePoker adversarial review (Rule 1 + Rule 2 + red-team scope isolation).
4. Merge. Vercel preview → prod auto-deploy.
5. Post-deploy smoke: `curl` with test-team client creds against a known-good domain; verify 200 + non-zero rows.
6. Register `pageviews:read` in production team admin UI (out of scope for this PR; manual team-setup via existing `POST /api/teams/[teamId]/api-clients` until UI lands).

## 13. Ratified decisions (formerly open questions)

All three open questions from the DRAFT were resolved with Aditya on 2026-04-21:

1. **Default `limit` = 1000** (range [1, 1000]). Gives 120k rows/hr headroom at the 120 req/hr rate limit.
2. **`since` param added** as a bootstrap/re-pull lever — mutually exclusive with `cursor`, default `now - 72h` if neither supplied (aligned with GA4 MP backfill ceiling). Semantics codified in §2 step 5 and §3 bind values.
3. **Observability via structured logs only** in this PR — no separate metrics backend. §10 lists the exact log fields + post-hoc `jq` queries. Revisit when a second consumer needs metrics or log-grep volume becomes impractical.

---
