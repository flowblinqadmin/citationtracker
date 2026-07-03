# API Client Integration Tests

End-to-end integration tests for `FlowblinqClient` against the live Vercel deployment.
31 tests across 5 files. All tests use real HTTP — no mocks.

---

## 1. Prerequisites

- **Node 18+** — native `fetch` required
- **`.env.test` filled in** — copy `.env.test.example` to `geo/.env.test` and populate all required values
- **Supabase service role key** — needed for credential provisioning, teardown, and some test setup (E-5, E-6, mcp.test.ts lookup)
- **Network access to Vercel** — tests run against the live production URL by default
- **Free tier available on TEST_TEAM_ID** — audit-flow tests (F-1/F-3) and free-tier tests (T-2) each submit one audit. Ensure the test team has free quota or credits.

---

## 2. How to Run

### Full suite

```bash
# From geo/
npm run test:integration:api
```

### Single file

```bash
# From geo/
npx vitest run --config vitest.api-client.config.ts tests/integration/api-client/auth.test.ts
```

### Skip credential provisioning (manual run)

Set `TEST_CLIENT_ID` and `TEST_CLIENT_SECRET` in `.env.test`. Setup will use them directly without creating a new DB row.

---

## 3. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TEST_BASE_URL` | Yes | Vercel deployment URL, no trailing slash. E.g. `https://geo.flowblinq.com` |
| `TEST_SUPABASE_URL` | Yes | Supabase project URL. Found in Supabase dashboard → Settings → API. |
| `TEST_SUPABASE_SERVICE_KEY` | Yes | Supabase service role key (bypasses RLS). Keep secret. |
| `TEST_TEAM_ID` | Yes | UUID of the test team in Supabase. Must be a real team with API access. |
| `TEST_AUDIT_DOMAIN` | Recommended | Real scrapeable URL for audit-flow tests. Default: `https://example.com`. |
| `TEST_FREE_TIER_DOMAIN` | Recommended | Separate real domain for free-tier tests. Prevents collision with TEST_AUDIT_DOMAIN. Falls back to TEST_AUDIT_DOMAIN if unset. |
| `TEST_AUDIT_DOMAIN_FALLBACK` | Optional | Fallback domain if the F-3 pipeline run fails. |
| `TEST_CLIENT_ID` | Optional | Manual override: skip DB provisioning and use this clientId. |
| `TEST_CLIENT_SECRET` | Optional | Manual override: plaintext secret for TEST_CLIENT_ID. |

---

## 4. Test Map

| File | IDs | Description | Approx. Duration |
|------|-----|-------------|-----------------|
| `auth.test.ts` | A-1 to A-8 | OAuth token endpoint, JWT validation, rate limiting | 2–3 min (A-8 rate limit burst) |
| `audit-flow.test.ts` | F-1 to F-7 | Full audit lifecycle: submit → poll → validate result | 3–5 min (pipeline) |
| `errors.test.ts` | E-1 to E-6 | FlowblinqApiError mapping for all error conditions | 5–8 min (E-2 run2 poll) |
| `free-tier.test.ts` | T-1 to T-5 | Free tier gating, two-run cycle, domain scoping | 6–10 min (two pipeline runs) |
| `mcp.test.ts` | M-1 to M-5 | MCP manifest shape, MCP-formatted audit response | < 30 sec |
| **Total** | 31 tests | | **~20–25 min** |

**Execution order** (alphabetical): auth → audit-flow → errors → free-tier → mcp

---

## 5. Teardown Guarantee

`setup.ts` registers a global `teardown()` function that runs after all test files complete:

1. **`geo_sites` rows**: deletes all rows where `api_client_id = provisioned clientId`
2. **`api_clients` row**: deletes the provisioned credential row (only if `provisioned=true`)

### Verify cleanup manually

```sql
-- In Supabase SQL editor:
SELECT * FROM api_clients WHERE name LIKE 'integration-test-%';
SELECT * FROM geo_sites WHERE api_client_id LIKE 'test_%';
```

If rows remain after a test run, run teardown manually:
```bash
# Or just re-run the suite — setup.ts will clean up stale rows on next teardown
```

### A-8 cleanup

The A-8 rate-limit test provisions its own isolated credential and deletes it in its own `afterAll`. Same for E-4. These are separate from the main credential.

---

## 6. Troubleshooting

### Cold start timeout (setup warm-up fails)

Symptom: `setup` takes >30s, first test fails with timeout.

Fix: Run the suite again. The warm-up GET to `/api/v1/mcp` in setup prevents cold starts on subsequent tests.

### Rate limit bleed-over (unexpected 429)

Symptom: Tests other than A-8 or E-4 fail with 429.

Cause: A-8 or E-4 used the shared credential (should not happen — both use isolated credentials).

Fix: Wait 60 seconds, then re-run. Rate limits reset after the window expires. Verify A-8 and E-4 use isolated client IDs (they should).

### F-3 / T-2 timeout (pipeline too slow)

Symptom: `pollAudit timed out after 300000ms`.

Cause: The audit pipeline is running slowly (Firecrawl backlog, cold start, or the domain takes long to scrape).

Fix 1: Re-run the suite (F-3 has a retry on a fallback domain).
Fix 2: Set `TEST_AUDIT_DOMAIN_FALLBACK` to a faster domain.
Fix 3: Increase `timeoutMs` in the pollAudit call if the pipeline is consistently slow.

### E-2 / T-3 gets 409 instead of 402

Symptom: `submitAudit` returns 409 (audit_exists) instead of 402 (free_tier_exhausted).

Cause: run2 did not complete before T-3 submitted the domain. This can happen if the pipeline is slow and T-2's run2 poll timed out.

Fix: Re-run free-tier.test.ts individually after waiting for the pipeline to complete.

### E-5 / E-6 Supabase insert fails (unknown columns)

Symptom: `[E-5] Supabase update failed` or `[E-6] Supabase insert failed`.

Cause: Column names in the `geo_sites` table differ from the test's assumptions.

Fix: Check the actual `geo_sites` schema in Supabase and update the column names in `errors.test.ts`.

### M-3/M-4/M-5 skipped ("no completed audit found")

Symptom: M-3/M-4/M-5 print `Skipping — no completed audit found`.

Cause: `audit-flow.test.ts` did not run first (or F-3 failed), so no completed `geo_site` row exists for this credential.

Fix: Run the full suite (all 5 files together) rather than running `mcp.test.ts` in isolation.
