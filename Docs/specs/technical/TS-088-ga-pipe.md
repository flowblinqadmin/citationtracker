# TS-088 — `ga-pipe` customer-distributable analytics forwarder

**Status:** DRAFT (authored 2026-04-21 by Shastri on branch `api/pageviews-read`).
**Author anchor:** Aditya + Shastri pairing session.
**Supersedes:** none.
**Related:** TS-087 (server-side `/api/v1/page_views` this pipe consumes), ES-088 (sibling engineering spec).
**Code location:** `geo/api-clients/cpp/` (inside `geo` monorepo, excluded from Next.js build / Vercel deploy via `.vercelignore` + CI path filter).

## 1. Problem

Marketing-agency customers trust Google Analytics. Our proxy-served traffic is currently invisible to their GA dashboard because our asset fetches are server-side events that never fire the customer's client-side GA tag. Customers churn or distrust our numbers when their GA says zero visitors for a page that our dashboard shows traffic on.

We need a way to forward flowblinq-logged proxied traffic into the customer's GA4 property (or any analytics destination they pick: Plausible, Matomo, custom webhook). The forwarder must be:

1. **Customer-distributable** — one binary they download and run on their infra; no per-customer build; no platform secrets leaked
2. **Sink-pluggable** — GA4 today, anything else tomorrow, without rebuilding the binary
3. **Backfill-capable** — pull last 72h on first install (GA4 MP hard ceiling)
4. **Resumable** — survives restart without duplicating events or losing ground
5. **Rate-limit-safe** — respects flowblinq's 120 req/hr cap AND GA4 MP's per-property limits

## 2. Hypothesis

A single C++ binary that polls flowblinq's `/api/v1/page_views` (TS-087), transforms each row through a YAML-declared template, and POSTs to a configurable sink endpoint — with durable cursor state and respectful backoff — can serve every current and foreseeable analytics-forwarding need without per-customer builds, without server-side sink knowledge, and without exposing platform credentials.

## 3. Objective

Define **one** customer-distributable binary `ga-pipe` that:

1. Reads config from a customer-owned `pipe.yaml` (flowblinq creds, domain, sink template path, state file path, polling interval)
2. Authenticates to flowblinq via OAuth2 client-credentials flow, auto-refreshes JWT before expiry
3. Polls `GET /api/v1/page_views?domain=<D>&cursor=<C>&limit=1000` at a configurable interval, paginating via `has_more` until caught up, then idling at the configured interval
4. For each row, applies the YAML sink template to produce a sink-specific HTTP request (method, URL, headers, body)
5. POSTs to the sink; on 2xx, advances cursor; on retriable error, backs off; on non-retriable error, logs and skips (with a configurable dead-letter path)
6. Persists cursor + counters to local state file after every successful sink write; resumes from state on restart
7. Handles SIGTERM/SIGINT gracefully — drains in-flight work, flushes state, exits 0

Non-goals: dashboard UI, aggregation/batching beyond sink-batch limits, multi-domain per-pipe (one pipe = one domain; customers run multiple instances for multiple domains), write-back to flowblinq.

## 4. Method

### 4.1 Architecture (thread model)

Two worker threads + main thread:

```
┌─ main thread ─ signal handling, config load, thread orchestration, shutdown
│
├─ reader thread ─ flowblinq poll → bounded queue
│    loop:
│      resp := flowblinq.get(domain, cursor, limit=1000)
│      for row in resp.rows: queue.push_blocking(row)   // blocks if queue full
│      cursor := resp.next_cursor
│      if not resp.has_more: sleep(poll_interval)
│      else: continue immediately (paginate burst)
│
└─ writer thread ─ queue → sink
     loop:
       row := queue.pop_blocking()                      // blocks if queue empty
       req := template.render(row, sink_config)
       resp := sink.post(req)
       if resp.ok: state.advance(row.id, row.viewed_at); state.persist()
       elif resp.retriable: backoff_and_retry(row)      // exp backoff, max N
       else: deadletter.append(row); state.advance(row.id, row.viewed_at)
```

**Queue:** bounded (default 1000 slots), `std::mutex` + two `std::condition_variable` (not_full, not_empty), block-on-full / block-on-empty. Single-producer single-consumer; MPMC is overkill for one poll source and one sink.

**Why block-on-full (not drop):** correctness > throughput for analytics forwarding. Customer expects every event delivered, not the newest. Backpressure propagates to the reader, which then slows its poll rate — natural flow control without any explicit mechanism.

### 4.1.1 Response-shape validation (defensive circuit-breaker on the reader)

Flowblinq's response JSON is validated against the expected schema before any row hits the queue:

- Required top-level keys: `domain`, `slug_resolved`, `served_ts`, `rows` (array), `has_more` (bool), `next_cursor` (string-or-null).
- Per-row required keys: `id`, `page_url`, `viewed_at`; optional but typed: `referrer`, `visitor_id`, `user_agent`, `ip`, `country`, `screen_width`.

Policy on validation failure:

- Log `reader.malformed_response` with a reason code (`missing_key`, `bad_type`, `bad_json`, etc.) and the response body truncated to 256 bytes.
- Increment `consecutive_malformed_responses` counter (session-only, in-memory; see below).
- Skip the page (do NOT queue any of its rows); continue to next poll.
- **Any successful (validated) response resets the counter to 0.**
- If the counter reaches the threshold (default **10**), the pipe:
  1. Prints a human-readable diagnostic to stderr: `"Received 10 consecutive malformed responses from flowblinq; shutting down. Likely causes: API version mismatch, upstream outage, or wrong base_url in pipe.yaml."`
  2. Initiates graceful shutdown (queue drain, state flush).
  3. Exits with **exit code 3** (new; existing: 0 ok, 1 force-close, 2 state-corrupt).

Rationale: consecutive (not cumulative) — a transient network issue shouldn't permanently poison a customer install; but 10 consecutive broken responses means something is structurally wrong and silently discarding is worse than halting.

### 4.2 Rate-limit defenses (three layers)

Per earlier ratified design:

1. **Pipe-side pacing on `has_more`:** reader only sleeps when `has_more=false`. If the server is behind, reader paginates continuously. If server is ahead, reader waits `poll_interval`. This keeps the pipe in lock-step with ingestion, not ahead of it.
2. **API-side rate limit:** 120 req/hr per `client_id` enforced by flowblinq (TS-087 §4). At `limit=1000` rows/call, that's 120k rows/hr ceiling — more than any single-domain customer we have today.
3. **Cursor-based pagination:** deterministic ordering guarantees that a reader that restarts mid-burst doesn't re-deliver rows already written to sink (state tracks `(viewed_at, id)` cursor, advanced only after sink 2xx).

### 4.3 Config (`pipe.yaml`)

```yaml
# Customer-editable; never commit client_secret to source control
flowblinq:
  base_url: https://geo.flowblinq.com
  client_id: <from flowblinq admin UI>
  client_secret: <from flowblinq admin UI>  # can be sourced via env var
  domain: www.mysite.com
  poll_interval_seconds: 60      # idle polling cadence; ignored during has_more bursts

reader:
  malformed_response_threshold: 10   # consecutive malformed flowblinq responses → graceful shutdown (exit 3)

sink:
  template_path: sinks/ga4.yaml  # pluggable; ships with ga4.yaml + webhook.yaml defaults
  secrets:                         # sink-specific values exposed to template as top-level Inja vars
    measurement_id: G-XXXXXXXXXX   # GA4 Measurement ID
    api_secret: ${GA4_API_SECRET}  # ${ENV_VAR} substitution supported

state:
  path: ${XDG_STATE_HOME:-$HOME/.local/state}/ga-pipe/state.json
  deadletter_path: ${XDG_STATE_HOME:-$HOME/.local/state}/ga-pipe/deadletter.ndjson

queue:
  capacity: 1000

logging:
  level: info                    # trace|debug|info|warn|error
  format: json                   # human|json
```

### 4.4 Sink templates (YAML, Inja-rendered)

A sink template declares how to turn one `geo_page_views` row into one HTTP request. Mustache-compatible via Inja. Shipped templates:

**`sinks/ga4.yaml` (GA4 Measurement Protocol v2):**

```yaml
name: ga4
secrets:
  measurement_id: { env: GA4_MEASUREMENT_ID }
  api_secret:     { env: GA4_API_SECRET }

request:
  method: POST
  url: https://www.google-analytics.com/mp/collect?measurement_id={{ measurement_id }}&api_secret={{ api_secret }}
  headers:
    Content-Type: application/json
  body_json:
    client_id: "{{ row.visitor_id | default('anon-' + row.id) }}"
    timestamp_micros: "{{ row.viewed_at | rfc3339_to_micros }}"
    events:
      - name: page_view
        params:
          page_location: "{{ row.page_url | truncate(100) }}"
          page_referrer: "{{ row.referrer | default('') | truncate(100) }}"
          country: "{{ row.country | default('') }}"
          screen_resolution: "{{ row.screen_width | default(0) }}"

# Sink-side guardrails enforced before POST
constraints:
  max_events_per_request: 25        # GA4 MP hard limit
  max_params_per_event: 25          # GA4 MP hard limit
  max_param_value_bytes: 100        # GA4 MP hard limit
  max_body_bytes: 131072            # 130 KB
  retriable_status_codes: [408, 429, 500, 502, 503, 504]
  non_retriable_status_codes: [400, 401, 403, 404, 422]
  retry_policy:
    max_attempts: 5
    initial_backoff_ms: 500
    max_backoff_ms: 30000
    jitter: true
```

**`sinks/webhook.yaml` (generic POST webhook):**

```yaml
name: webhook
secrets:
  signing_secret: { env: WEBHOOK_SIGNING_SECRET }

request:
  method: POST
  url: "{{ env.WEBHOOK_URL }}"
  headers:
    Content-Type: application/json
    X-Flowblinq-Signature: "{{ body_json | hmac_sha256(signing_secret) }}"
  body_json:
    id: "{{ row.id }}"
    domain: "{{ env.FLOWBLINQ_DOMAIN }}"
    event: page_view
    url: "{{ row.page_url }}"
    referrer: "{{ row.referrer }}"
    visitor_id: "{{ row.visitor_id }}"
    ts: "{{ row.viewed_at }}"
```

Filters available: `default`, `truncate`, `rfc3339_to_micros`, `url_encode`, `json_escape`, `hmac_sha256`, `int`, `env`.

### 4.5 State file (`state.json`)

```json
{
  "schema_version": 1,
  "cursor": {"viewed_at": "2026-04-21T15:29:45.123Z", "id": "nano-xyz"},
  "served_count_total": 12843,
  "deadletter_count_total": 3,
  "last_successful_sink_ts": "2026-04-21T15:30:01.411Z",
  "last_error": null
}
```

Atomic write via temp file + rename. Read on startup; if absent, cursor defaults to unset → API defaults to `now - 72h`.

### 4.6 GA4 MP specifics

- Endpoint: `https://www.google-analytics.com/mp/collect` (production) and `/debug/mp/collect` (validation, not used at runtime).
- Required per-request: `measurement_id`, `api_secret` as query string.
- Required per-event: `name`, `params`.
- `timestamp_micros` at the request top level overrides the server-side ingestion time for up to 72h backfill; events older than 72h are accepted but invisible in reports.
- `client_id` is required; empty or missing creates a "ghost user." Default to `visitor_id` when present, else `anon-<row.id>`.
- `validation_behavior`: template defaults to `RELAXED` (warnings surface in `/debug/mp/collect` if customer ever wants to inspect); `ENFORCE_RECOMMENDATIONS` is available as a config flag but not default (too noisy for pass-through forwarding).

## 5. Success criteria

Pre-stated. No moving goalposts.

| # | Case | Expected |
|---|---|---|
| 1 | Fresh install, no state file | First poll uses API default `since=now-72h`; rows flow to sink |
| 2 | Restart after N rows delivered | Resume from state cursor; zero duplicates to sink |
| 3 | Sink returns 500 | Exponential backoff up to `max_attempts`; row NOT advanced in state until success or deadletter |
| 4 | Sink returns 400 (non-retriable) | Row appended to deadletter.ndjson; cursor advances; pipe continues |
| 5 | Flowblinq returns 429 | Reader honors `Retry-After`; writer continues draining queue |
| 6 | Flowblinq returns 401 (token expired) | Auto-refresh JWT via OAuth2; retry same call; no data loss |
| 7 | GA4 MP > 130KB body | Template's constraint kicks in before POST; row written to deadletter with `oversize` tag |
| 8 | SIGTERM received mid-burst | Drain queue, flush state, exit 0 within 30s |
| 9 | Cursor determinism across pipe restarts | Stop after N rows; restart; no duplicate + no gap |
| 10 | Sink template swap (GA4 → webhook) | Same row data, different HTTP request emitted; no code change |
| 11 | 72h backfill boundary | Rows with `viewed_at < now-72h` delivered to GA4 sink but GA4 silently drops them (documented, not a pipe bug) |
| 12 | Multiple pipe instances (same customer, two domains) | Each uses its own state file + config; no cross-contamination |
| 13 | 10 consecutive malformed flowblinq responses | Pipe logs each; at 10th, prints diagnostic to stderr; drains queue; exits with code 3 |
| 14 | 9 malformed responses then 1 valid | Counter resets to 0; subsequent malformed does NOT immediately trigger shutdown |

## 6. Out of scope

- Dashboard UI for customers to view pipe status (they read the state file / logs directly; MVP)
- Sink templates for platforms other than GA4 and generic webhook (Plausible, Matomo, Segment → future templates, pluggable without binary rebuild)
- Multi-domain per-pipe process (one domain per process; customers can run multiple)
- Aggregation / deduplication within the pipe (pass-through only)
- TLS client certs (Bearer JWT only)
- Windows binary for v1 (linux + mac only; Windows adds signing/notarization overhead)

## 7. Dependencies + risks

**Dependencies:**
- `libcurl` (HTTP)
- `nlohmann/json` (JSON parse/serialize)
- `yaml-cpp` (config + sink templates)
- `inja` (template rendering, header-only, mustache-compat)
- `Catch2` (unit + integration test runner)
- `CMake` 3.22+; C++17.

**Risks:**

| Risk | Mitigation |
|---|---|
| Sink accepts row, state not yet persisted, pipe crashes → duplicate on restart | State persist is synchronous (fsync) after every sink ack; cost is ~1ms/row which is fine at 100/s. |
| Reader outruns writer, queue blocks forever on a stuck sink | Writer has retry budget; after `max_attempts`, row deadletters and pipe continues. Blocked indefinitely only if sink is 100% down; operator-visible via stalled `last_successful_sink_ts`. |
| Customer's GA4 secret leaks via log line | Sink config secrets are marked `secret: true`; redacted in all log output by `logger::redact`. Unit test asserts no secret appears in log stream. |
| Clock skew between pipe host and flowblinq | Cursor is server-issued `(viewed_at, id)`; pipe never trusts its local clock for sequencing. Only user-visible field using pipe clock is log timestamps. |
| Customer runs ancient glibc (2011 server) | Static-link glibc or provide docker image alternative; document minimum glibc version in README. |
| Binary reverse-engineered to extract platform secrets | No platform secrets in binary. Only customer-owned `client_id` + `client_secret` (from flowblinq admin UI) live in config; those are customer's to protect. |

## 8. Stakeholders

- **Shastri** (spec author): drafts TS + ES, authors tests, implements binary
- **Aditya** (ratifier): reviews TS + ES, approves merge, owns customer-release decision
- **HolePoker** (adversarial): reviews rule 1+2 compliance + sink-template injection surface + state file poisoning

## 9. Implementation order

1. Ratify TS (this doc) → TS-088 READY
2. Write ES-088 with thread diagrams, queue invariants, state-file transaction semantics, template rendering details, error taxonomy
3. Scaffold `api-clients/cpp/` CMake project with build-green skeleton
4. Author UTs: cursor math, queue behavior under backpressure, template rendering, state file atomic-write, retry backoff
5. Author ITs: mocked flowblinq API + mocked GA4 + Manipal CSV replay to dry-run
6. Implement in the order: config → auth/JWT → reader → queue → template engine → writer → state → signals → main
7. End-to-end dry-run against mock flowblinq + mock GA4
8. End-to-end live-run against real flowblinq preview + Aditya's test GA4 property
9. First customer pilot: Manipal domain (245k rows, already in our corpus)

---
