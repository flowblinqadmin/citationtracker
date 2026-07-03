# ES-090 Load Tests (LT1-LT6)

Phase A delivery — ReviewMaster, 2026-04-15.

## Run

```bash
# Set base URL + auth before running
export BASE_URL=https://geo-staging.flowblinq.com
export TEST_SITE_ID=...        # seeded long-lived site for citation-check tests
export TEST_SITE_TOKEN=...     # accessToken matching TEST_SITE_ID
export TEST_BULK_IP=203.0.113.50

# Each scenario individually
k6 run lt1-citation-check.js
k6 run lt2-sites-post.js
k6 run lt3-reextract-counter.js
k6 run lt4-otp-flood.js
k6 run lt5-health.js
k6 run lt6-verify-flow.js
```

## Scenario → AC

| LT | AC | What it asserts |
|---|---|---|
| LT1 | AC-4 | citation-check rate-limit defence (≥98% 429, ≤1 credit deduction) |
| LT2 | AC-5 | sites-POST IP rate-limit (≤10 pass per 60s window) |
| LT3 | AC-11 | cluster-safe counter (Redis key never > 3) |
| LT4 | AC-9 | OTP lockout under flood (≤5 successful increments) |
| LT5 | AC-14 | /api/health stability (p99 < 50ms, 0% error) |
| LT6 | AC-10 | verify flow latency post-MED-4 (no body-leak, p95 ≤ baseline+50ms) |

## Success bar

- Each scenario passes without cascading failure on `/api/health` parallel probe.
- p50 / p95 / p99 latency tables logged in the PR description.
- No scenario consumes >30% Postgres connections; no Supabase rate-limit hits.
