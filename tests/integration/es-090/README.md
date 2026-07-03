# ES-090 Integration Tests (IT1-IT20)

Phase A delivery — ReviewMaster, 2026-04-15.

## Run

```bash
# All ES-090 ITs (requires SUPABASE_DATABASE_URL + UPSTASH_REDIS_REST_URL/TOKEN)
vitest run --config vitest.integration.config.ts tests/integration/es-090

# Individual files
vitest run --config vitest.integration.config.ts tests/integration/es-090/token-expiry.integration.test.ts
```

## Phase A status

All 20 tests are **deliberately RED**. They will turn GREEN once ScriptDev:

1. Lands the `tokenExpiresAt` / `tokenRotatedAt` schema migration (§b.1).
2. Wires the rate-limit + sanitize-html + cookie + exchange-code paths per §b.2-b.12.
3. Adds `/api/health`, `/api/account`, `lib/utils/ip-hash.ts`, `lib/concurrency/reextract-gate.ts`, `lib/config/assert-env.ts`, `app/api/account/route.ts`.
4. Adds Sentry instrumentation per §b.13.

## Test → AC map

| IT | AC | File |
|---|---|---|
| IT1, IT2 | AC-2 | token-expiry.integration.test.ts |
| IT3 | AC-3 | sanitize-html.integration.test.ts |
| IT4 | AC-4 | citation-check-ratelimit.integration.test.ts |
| IT5, IT6 | AC-5 | sites-post-ratelimit.integration.test.ts |
| IT7 | AC-9 | otp-race.integration.test.ts |
| IT8, IT20 | AC-10 | verify-cookies.integration.test.ts |
| IT9 | AC-11 | reextract-gate.integration.test.ts |
| IT10, IT17 | AC-12 | completion-email.integration.test.ts |
| IT11, IT12 | AC-14 | health.integration.test.ts |
| IT13 | AC-15 | account-delete.integration.test.ts |
| IT14 | AC-16 | ip-hash.integration.test.ts |
| IT15 | AC-6 | csp.integration.test.ts |
| IT16 | AC-8 | host-header.integration.test.ts |
| IT18, IT19 | AC-13 | sentry.integration.test.ts |
