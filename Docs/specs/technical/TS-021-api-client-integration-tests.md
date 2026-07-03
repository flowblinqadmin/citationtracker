# TS-021: Flowblinq API Client + Integration Test Suite

**Status:** Draft
**Author:** CoFounder
**Date:** 2026-03-03
**Downstream:** SpecMaster → ReviewMaster → ScriptDev
**Priority:** P1 — validates production API before WordPress plugin distribution

---

## Context

The public API (ES-019) is live on Vercel but has only been validated with unit tests
against mocks. Before distributing the WordPress plugin or any other consumer, we need
confidence that the real OAuth flow, audit pipeline trigger, free-tier gate, and MCP
manifest all work end-to-end against the production environment.

This TS specifies two things:

1. **`FlowblinqClient`** — a typed TypeScript API client library that wraps `/api/v1/*`.
   Lives in `geo/lib/flowblinq-client/`. Built to be extracted into an npm package later
   with zero architectural changes. Well documented throughout.

2. **Integration test suite** — uses `FlowblinqClient` to run the full API flow against
   the live Vercel deployment. Catches real production issues that unit tests cannot.

The client is the reference implementation. Every future plugin (WordPress, Shopify,
Webflow) or SDK wraps or ports this logic.

---

## Guiding Principles

- **Typed end-to-end.** Every request and response has a TypeScript interface. No `any`.
- **Self-documenting.** JSDoc on every public method and type. A developer reading the
  source should never need to open the API docs.
- **Fail loudly.** Errors surface as typed `FlowblinqApiError` with `status`, `code`,
  and `message`. No swallowed exceptions.
- **Stateless token management.** Client handles token acquisition and refresh internally.
  Caller never touches JWTs.
- **No runtime dependencies.** Uses native `fetch` (available in Node 18+ and all modern
  runtimes). Zero external deps in the client itself.

---

## Client: `FlowblinqClient`

### Location

```
geo/lib/flowblinq-client/
├── index.ts          # Public exports only
├── client.ts         # FlowblinqClient class
├── types.ts          # All request/response interfaces
├── errors.ts         # FlowblinqApiError
└── README.md         # Quickstart + full API reference
```

### Instantiation

```typescript
import { FlowblinqClient } from '@/lib/flowblinq-client'

const client = new FlowblinqClient({
  clientId: 'fq_live_abc123',
  clientSecret: 'sk_abc...',
  baseUrl: 'https://geo.flowblinq.com',  // optional, defaults to production
})
```

### Constructor options (`FlowblinqClientConfig`)

```typescript
interface FlowblinqClientConfig {
  /** OAuth client_id issued from the Flowblinq dashboard */
  clientId: string
  /** OAuth client_secret issued from the Flowblinq dashboard */
  clientSecret: string
  /**
   * Base URL of the Flowblinq API.
   * Defaults to 'https://geo.flowblinq.com'.
   * Override for staging or local development.
   */
  baseUrl?: string
  /**
   * Request timeout in milliseconds.
   * Defaults to 30000 (30s). Audit polling may need a higher value.
   */
  timeoutMs?: number
}
```

### Methods

#### `client.submitAudit(options)`

Submit a URL for GEO analysis.

```typescript
submitAudit(options: SubmitAuditOptions): Promise<AuditSubmitResponse>

interface SubmitAuditOptions {
  /** The URL to audit. Must be a valid https:// URL. */
  url: string
}

interface AuditSubmitResponse {
  auditId: string
  status: 'pending'
  freeTier: boolean
  freeRunNumber: 1 | 2
  estimatedCompletionSeconds: number
}
```

#### `client.getAudit(auditId, options?)`

Poll audit status and retrieve results.

```typescript
getAudit(auditId: string, options?: GetAuditOptions): Promise<AuditResponse>

interface GetAuditOptions {
  /** Return MCP-formatted tool_result instead of standard JSON */
  format?: 'mcp'
}

interface AuditResponse {
  auditId: string
  domain: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  overallScore: number | null
  freeRunNumber: 1 | 2
  scorecard: GeoScorecard | null
  recommendations: string[]
  executiveSummary: string | null
  files: {
    llmsTxtUrl: string | null
    businessJsonUrl: string | null
    schemaJsonUrl: string | null
  }
  createdAt: string
  completedAt: string | null
}
```

#### `client.pollAudit(auditId, options?)`

Convenience wrapper — polls `getAudit` at an interval until status is `complete` or
`failed`, then resolves.

```typescript
pollAudit(auditId: string, options?: PollOptions): Promise<AuditResponse>

interface PollOptions {
  /** Poll interval in ms. Defaults to 5000. */
  intervalMs?: number
  /** Maximum total wait time in ms. Defaults to 300000 (5min). */
  timeoutMs?: number
  /** Called on each poll with the current response. Useful for progress UIs. */
  onProgress?: (response: AuditResponse) => void
}
```

#### `client.verifyAudit(auditId)`

Trigger the post-optimization second run.

```typescript
verifyAudit(auditId: string): Promise<AuditSubmitResponse>
```

#### `client.getAccount()`

Retrieve team credit balance and usage.

```typescript
getAccount(): Promise<AccountResponse>

interface AccountResponse {
  teamId: string
  creditBalance: number
  freeOptimizationDomains: number
  creditsPurchaseUrl: string
}
```

#### `client.getMcpManifest()`

Retrieve the MCP server manifest. No auth required.

```typescript
getMcpManifest(): Promise<McpManifest>
```

### Token management (internal)

- On first API call, client calls `POST /api/oauth/token` and caches the JWT + expiry.
- Before each subsequent call, client checks expiry. If token expires within 60s, it
  refreshes proactively.
- Token is stored in memory only — never persisted. Each `new FlowblinqClient()` starts
  fresh.
- If token refresh fails, throw `FlowblinqApiError` with `code: 'auth_failed'`.

### Error handling

```typescript
class FlowblinqApiError extends Error {
  /** HTTP status code */
  status: number
  /** Machine-readable error code from API (e.g. 'insufficient_credits', 'rate_limited') */
  code: string
  /** Human-readable message */
  message: string
}
```

Common cases callers must handle:
- `status: 401` — invalid or revoked credentials
- `status: 402` — free tier exhausted; check `creditsPurchaseUrl` on account
- `status: 429` — rate limited on token endpoint (>10 req/min)
- `status: 404` — audit ID not found
- `status: 503` — Flowblinq pipeline unavailable

### README (`lib/flowblinq-client/README.md`)

Must include:
1. **Quickstart** — from `new FlowblinqClient()` to a complete audit result in ~20 lines
2. **Full method reference** — parameters, return types, example output
3. **Error handling guide** — what each error code means and how to handle it
4. **Polling pattern** — both manual poll loop and `pollAudit()` convenience method
5. **Free tier explanation** — what `freeRunNumber` means, when to call `verifyAudit()`
6. **Configuration reference** — all `FlowblinqClientConfig` options with examples

---

## Integration Test Suite

### Location

```
geo/tests/integration/api-client/
├── setup.ts             # Provision test apiClient credential, teardown after suite
├── auth.test.ts         # OAuth token flow
├── audit-flow.test.ts   # Full submit → poll → complete flow
├── free-tier.test.ts    # Free tier gate: run 1, run 2 (verify), run 3 → 402
├── mcp.test.ts          # MCP manifest + MCP-formatted audit response
├── errors.test.ts       # 401, 402, 429 error shapes
└── README.md            # How to run, env vars needed, what each test covers
```

### Environment variables required

```env
TEST_BASE_URL=https://geo.flowblinq.com         # Live Vercel URL
TEST_CLIENT_ID=<provisioned for test suite>     # Created in setup.ts, deleted in teardown
TEST_CLIENT_SECRET=<provisioned for test suite> # Same
TEST_TEAM_ID=<team with known credit balance>   # Needed for free-tier assertions
SUPABASE_SERVICE_ROLE_KEY=<existing>            # For direct DB assertions (setup/teardown)
```

### `setup.ts` — test credential lifecycle

```
beforeAll:
  - Call POST /api/oauth/token with master test credential to confirm auth works
  - Insert a fresh apiClient row into DB directly (via Supabase service role)
  - Store clientId + clientSecret for suite use
  - Insert a fresh test geoSite for each test that needs one

afterAll:
  - Delete all test apiClient rows created during suite
  - Delete all test geoSite rows created during suite
```

This ensures the suite is hermetic — no leftover test data in production.

### Test cases

#### `auth.test.ts`

| ID | Description |
|----|-------------|
| A-1 | Valid client_id + secret → 200 + signed JWT |
| A-2 | Invalid client_secret → 401 |
| A-3 | Unknown client_id → 401 |
| A-4 | Revoked client (`revokedAt` set) → 401 |
| A-5 | JWT contains correct `team_id` and `scopes` claims |
| A-6 | Expired JWT (manipulated exp) → 401 on any v1 route |
| A-7 | Missing Authorization header → 401 on any v1 route |
| A-8 | >10 token requests/min → 429 |

#### `audit-flow.test.ts`

| ID | Description |
|----|-------------|
| F-1 | POST /api/v1/audit → 200, auditId returned, status: pending |
| F-2 | GET /api/v1/audit/{id} immediately → status: pending or running |
| F-3 | pollAudit() resolves with status: complete within timeout |
| F-4 | Completed audit has overallScore (0–100), non-empty scorecard |
| F-5 | Completed audit has non-null llmsTxtUrl pointing to a live /api/serve/ URL |
| F-6 | GET /api/serve/ URL returns valid llms.txt content |
| F-7 | GET /api/v1/account → correct teamId, numeric creditBalance |

#### `free-tier.test.ts`

| ID | Description |
|----|-------------|
| T-1 | First audit on new domain: freeRunNumber=1, freeTier=true |
| T-2 | POST /api/v1/audit/{id}/verify → freeRunNumber=2 |
| T-3 | Third submission on same domain → 402 with creditsPurchaseUrl |
| T-4 | 402 response body contains valid creditsPurchaseUrl |
| T-5 | Different domain with same client → new free run allowed (domain-scoped) |

#### `mcp.test.ts`

| ID | Description |
|----|-------------|
| M-1 | GET /api/v1/mcp (no auth) → 200, valid protocol + version fields |
| M-2 | MCP manifest lists all 4 tools with non-empty inputSchema |
| M-3 | GET /api/v1/audit/{id}?format=mcp → type: tool_result, content array |
| M-4 | MCP audit response content includes text item with score summary |
| M-5 | MCP audit response content includes resource item with llmsTxtUrl |

#### `errors.test.ts`

| ID | Description |
|----|-------------|
| E-1 | FlowblinqApiError thrown on 401 with correct status + code |
| E-2 | FlowblinqApiError thrown on 402 with correct status + code |
| E-3 | FlowblinqApiError thrown on 404 (unknown auditId) |
| E-4 | FlowblinqApiError thrown on 429 with correct status + code |
| E-5 | pollAudit() rejects with FlowblinqApiError if audit fails |
| E-6 | pollAudit() rejects with timeout error if exceeded |

---

## Files to Create

| File | Purpose |
|------|---------|
| `geo/lib/flowblinq-client/index.ts` | Public exports |
| `geo/lib/flowblinq-client/client.ts` | FlowblinqClient class |
| `geo/lib/flowblinq-client/types.ts` | All TypeScript interfaces |
| `geo/lib/flowblinq-client/errors.ts` | FlowblinqApiError |
| `geo/lib/flowblinq-client/README.md` | Full client documentation |
| `geo/tests/integration/api-client/setup.ts` | Test credential lifecycle |
| `geo/tests/integration/api-client/auth.test.ts` | Auth tests (A-1–A-8) |
| `geo/tests/integration/api-client/audit-flow.test.ts` | Flow tests (F-1–F-7) |
| `geo/tests/integration/api-client/free-tier.test.ts` | Free tier gate (T-1–T-5) |
| `geo/tests/integration/api-client/mcp.test.ts` | MCP tests (M-1–M-5) |
| `geo/tests/integration/api-client/errors.test.ts` | Error shape tests (E-1–E-6) |
| `geo/tests/integration/api-client/README.md` | How to run, env vars, test map |

## Files to Modify

| File | Change |
|------|--------|
| `geo/tsconfig.json` | Confirm `lib/flowblinq-client` path alias resolves |
| `geo/package.json` | Add `test:integration:api` script pointing to this suite |

---

## Acceptance Criteria

1. `FlowblinqClient` compiles with zero TypeScript errors.
2. Every public method and type has JSDoc. `README.md` covers all 6 required sections.
3. All 31 integration test cases pass against the live Vercel production URL.
4. `setup.ts` teardown leaves no test data in production DB (verified via Supabase query).
5. `npm run test:integration:api` runs the full suite end-to-end in a single command.
6. A new developer can read `README.md` alone and make their first successful API call.

---

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Free-tier tests leave dirty data in prod | Medium | Hermetic setup/teardown via service role key |
| pollAudit() flakiness (real pipeline varies) | Medium | 5-min timeout, generous poll interval, test F-3 retried once |
| Rate limit tests (A-8) affect other tests | Low | Run rate limit tests last, isolated client instance |
| Vercel cold start delays first audit | Low | Warm-up request in setup.ts before suite begins |

---

## Out of Scope

- npm package extraction (follow-on — client is ready for it, just not published yet)
- Browser/CDN bundle (ESM build for browser use)
- WordPress PHP port of client logic (that's the plugin's internal concern)
- Mock server / offline test mode
