# ES-021: Flowblinq API Client + Integration Test Suite

**Status:** Draft
**Author:** SpecMaster (2-specmaster)
**Date:** 2026-03-03
**Source TS:** TS-021-api-client-integration-tests.md
**Priority:** P1
**Downstream:** ReviewMaster → ScriptDev

---

## a) Overview

Two deliverables:

1. **`FlowblinqClient`** — a typed TypeScript client for `/api/v1/*`. Lives in `geo/lib/flowblinq-client/`. Zero external dependencies (native `fetch` only). Reference implementation for all future consumers.

2. **Integration test suite** — uses `FlowblinqClient` against the live Vercel production URL. 31 test cases across 5 test files. Hermetic: setup provisions test credentials, teardown removes all test data.

**Source technical spec:** TS-021-api-client-integration-tests.md

**Current implementation state:**
- ES-019 public API routes are live. Unit tests exist but only against mocks.
- `geo/lib/flowblinq-client/` does not exist yet.
- `geo/tests/integration/api-client/` does not exist yet.
- `geo/tests/integration/bulk-csv-qa/` exists as the pattern reference.
- `geo/vitest.integration.config.ts` exists (bulk-csv-qa) — a separate `vitest.api-client.config.ts` is needed.
- `tsconfig.json` `@/*` path alias already resolves `lib/flowblinq-client` correctly — **no tsconfig change needed**.

---

## b) Implementation Requirements

### New Dependencies

None. Client uses only native `fetch` (Node 18+, all modern runtimes). Test suite uses only `vitest` (already installed) and `@supabase/supabase-js` (already installed).

### New Environment Variables (test only)

Add to `geo/.env.test` (alongside existing bulk-csv-qa vars):

```env
# API client integration tests
TEST_CLIENT_ID=<provisioned in setup, override for manual runs>
TEST_CLIENT_SECRET=<provisioned in setup, override for manual runs>
TEST_TEAM_ID=<existing test team with known credit balance>
```

Existing vars that are reused:
```env
TEST_BASE_URL=https://geo.flowblinq.com        # already in .env.test
TEST_SUPABASE_URL=<existing>                    # already in .env.test
TEST_SUPABASE_SERVICE_KEY=<existing>            # already in .env.test (was TEST_SUPABASE_SERVICE_KEY)
```

Add to `geo/tests/integration/api-client/.env.test.example` (see section below).

---

### New File: `geo/lib/flowblinq-client/errors.ts`

```typescript
/**
 * Error thrown by FlowblinqClient when the API returns a non-2xx response
 * or when internal client errors occur (token refresh failure, timeout).
 */
export class FlowblinqApiError extends Error {
  /** HTTP status code (or 0 for network/client errors) */
  readonly status: number
  /**
   * Machine-readable error code from API response body.
   * Common values: 'invalid_client', 'client_revoked', 'insufficient_scope',
   * 'free_tier_exhausted', 'rate_limit_exceeded', 'not_found', 'auth_failed',
   * 'poll_timeout', 'pipeline_failed'
   */
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'FlowblinqApiError'
    this.status = status
    this.code = code
  }
}
```

---

### New File: `geo/lib/flowblinq-client/types.ts`

Define all public-facing TypeScript interfaces. No `any` permitted. Exact field names match API JSON response keys (camelCase — client maps from API's snake_case responses).

```typescript
// --- Config ---

export interface FlowblinqClientConfig {
  /** OAuth client_id issued from the Flowblinq dashboard */
  clientId: string
  /** OAuth client_secret issued from the Flowblinq dashboard */
  clientSecret: string
  /**
   * Base URL of the Flowblinq API.
   * @default 'https://geo.flowblinq.com'
   */
  baseUrl?: string
  /**
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeoutMs?: number
}

// --- Audit submit ---

export interface SubmitAuditOptions {
  /** The URL to audit. Must be a valid https:// URL. */
  url: string
}

export interface AuditSubmitResponse {
  auditId: string
  status: 'pending'
  freeTier: boolean
  freeRunNumber: 1 | 2
  estimatedCompletionSeconds: number
}

// --- Audit get ---

export interface GetAuditOptions {
  /** Return MCP-formatted tool_result instead of standard JSON */
  format?: 'mcp'
}

export interface GeoScorecard {
  overallScore: number
  pillars: Array<{
    pillar: string
    pillarName: string
    score: number
    findings: string
    recommendation: string
    priority: string
  }>
  topThreeImprovements: string[]
}

export interface AuditResponse {
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

// --- Poll options ---

export interface PollOptions {
  /**
   * How often to check audit status, in milliseconds.
   * @default 5000
   */
  intervalMs?: number
  /**
   * Maximum total wait time in milliseconds before rejecting with a timeout error.
   * @default 300000 (5 minutes)
   */
  timeoutMs?: number
  /**
   * Called after each poll with the current response.
   * Use for progress indicators in UIs.
   */
  onProgress?: (response: AuditResponse) => void
}

// --- Account ---

export interface AccountResponse {
  teamId: string
  creditBalance: number
  freeOptimizationDomains: number
  creditsPurchaseUrl: string
}

// --- MCP Manifest ---

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpManifest {
  protocol: string
  version: string
  auth: {
    type: string
    tokenUrl: string
    grantType: string
    scopes: string[]
  }
  tools: McpTool[]
}

// --- Internal token cache ---

export interface TokenCache {
  value: string
  expiresAt: number  // Unix timestamp ms
}
```

---

### New File: `geo/lib/flowblinq-client/client.ts`

Full implementation of `FlowblinqClient`. Below is the complete method contract. ScriptDev implements all methods as specified.

```typescript
import { FlowblinqApiError } from './errors'
import type {
  FlowblinqClientConfig, SubmitAuditOptions, AuditSubmitResponse,
  GetAuditOptions, AuditResponse, PollOptions, AccountResponse,
  McpManifest, TokenCache,
} from './types'

const DEFAULT_BASE_URL = 'https://geo.flowblinq.com'
const DEFAULT_TIMEOUT_MS = 30_000
const TOKEN_EXPIRY_BUFFER_MS = 60_000   // refresh if < 60s remaining
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_POLL_TIMEOUT_MS = 300_000

export class FlowblinqClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private tokenCache: TokenCache | null = null

  constructor(config: FlowblinqClientConfig) {
    // Validate required fields at construction time — fail loudly
    if (!config.clientId) throw new Error('FlowblinqClient: clientId is required')
    if (!config.clientSecret) throw new Error('FlowblinqClient: clientSecret is required')
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }
```

#### Private method: `ensureToken(): Promise<string>`

```typescript
  /**
   * Returns a valid access token, fetching or refreshing if necessary.
   * Token is cached in memory (instance-scoped, never persisted).
   * Refreshes proactively if token expires within TOKEN_EXPIRY_BUFFER_MS.
   * @throws {FlowblinqApiError} code='auth_failed' if token cannot be acquired
   */
  private async ensureToken(): Promise<string> {
    const now = Date.now()
    if (this.tokenCache && this.tokenCache.expiresAt - now > TOKEN_EXPIRY_BUFFER_MS) {
      return this.tokenCache.value
    }
    // Fetch a new token
    const res = await this.rawFetch('/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new FlowblinqApiError(
        body.error ?? 'Token acquisition failed',
        res.status,
        'auth_failed'
      )
    }
    const data = await res.json() as { access_token: string; expires_in: number }
    this.tokenCache = {
      value: data.access_token,
      expiresAt: now + data.expires_in * 1000,
    }
    return this.tokenCache.value
  }
```

#### Private method: `rawFetch(path, init): Promise<Response>`

```typescript
  /**
   * Executes a fetch with timeout via AbortController.
   * Does NOT inject auth headers — callers do that as needed.
   * @throws {FlowblinqApiError} code='timeout' if request exceeds timeoutMs
   */
  private async rawFetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new FlowblinqApiError(
          `Request timed out after ${this.timeoutMs}ms: ${path}`,
          0,
          'timeout'
        )
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
```

#### Private method: `authedFetch(path, init): Promise<Response>`

```typescript
  /**
   * Executes an authenticated fetch. Calls ensureToken() first.
   * Injects Authorization: Bearer header.
   */
  private async authedFetch(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.ensureToken()
    return this.rawFetch(path, {
      ...init,
      headers: {
        ...init?.headers,
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
  }
```

#### Private method: `handleApiResponse<T>(res): Promise<T>`

```typescript
  /**
   * Reads a Response and returns the parsed JSON body.
   * Throws FlowblinqApiError for non-2xx responses.
   * Maps API snake_case error fields to typed FlowblinqApiError.
   */
  private async handleApiResponse<T>(res: Response): Promise<T> {
    if (res.ok) {
      return res.json() as Promise<T>
    }
    const body = await res.json().catch(() => ({})) as {
      error?: string
      code?: string
      message?: string
    }
    throw new FlowblinqApiError(
      body.message ?? body.error ?? `API error ${res.status}`,
      res.status,
      body.code ?? body.error ?? 'api_error'
    )
  }
```

#### Private method: `mapAuditResponse(raw): AuditResponse`

```typescript
  /**
   * Maps API snake_case audit JSON to AuditResponse (camelCase).
   * Isolates all field name mapping in one place.
   */
  private mapAuditResponse(raw: Record<string, unknown>): AuditResponse {
    return {
      auditId: raw['audit_id'] as string,
      domain: raw['domain'] as string,
      status: raw['status'] as AuditResponse['status'],
      overallScore: (raw['overall_score'] as number | null) ?? null,
      freeRunNumber: (raw['free_run_number'] as 1 | 2) ?? 1,
      scorecard: (raw['scorecard'] as GeoScorecard | null) ?? null,
      recommendations: (raw['recommendations'] as string[]) ?? [],
      executiveSummary: (raw['executive_summary'] as string | null) ?? null,
      files: {
        llmsTxtUrl: (raw['files'] as { llms_txt_url?: string })?.llms_txt_url ?? null,
        businessJsonUrl: (raw['files'] as { business_json_url?: string })?.business_json_url ?? null,
        schemaJsonUrl: (raw['files'] as { schema_json_url?: string })?.schema_json_url ?? null,
      },
      createdAt: raw['created_at'] as string,
      completedAt: (raw['completed_at'] as string | null) ?? null,
    }
  }
```

#### Public method: `submitAudit(options)`

```typescript
  /**
   * Submit a URL for GEO analysis.
   *
   * @param options.url - The URL to audit. Must be a valid https:// URL.
   * @returns Promise resolving to audit submission details including auditId.
   * @throws {FlowblinqApiError} status=402 if free tier exhausted for this domain.
   * @throws {FlowblinqApiError} status=400 if URL is invalid.
   *
   * @example
   * const result = await client.submitAudit({ url: 'https://example.com' })
   * console.log(result.auditId) // 'site_abc123'
   */
  async submitAudit(options: SubmitAuditOptions): Promise<AuditSubmitResponse> {
    const res = await this.authedFetch('/api/v1/audit', {
      method: 'POST',
      body: JSON.stringify({ url: options.url }),
    })
    const raw = await this.handleApiResponse<Record<string, unknown>>(res)
    return {
      auditId: raw['audit_id'] as string,
      status: 'pending',
      freeTier: (raw['free_tier'] as boolean) ?? true,
      freeRunNumber: (raw['free_run_number'] as 1 | 2) ?? 1,
      estimatedCompletionSeconds: (raw['estimated_completion_seconds'] as number) ?? 120,
    }
  }
```

#### Public method: `getAudit(auditId, options?)`

```typescript
  /**
   * Retrieve audit status and results.
   *
   * @param auditId - The audit ID returned from submitAudit().
   * @param options.format - Pass 'mcp' to receive MCP tool_result format.
   * @returns Promise resolving to current audit state and results (when complete).
   * @throws {FlowblinqApiError} status=404 if auditId not found.
   * @throws {FlowblinqApiError} status=403 if audit belongs to a different team.
   *
   * @example
   * const audit = await client.getAudit('site_abc123')
   * if (audit.status === 'complete') {
   *   console.log(audit.overallScore) // 72
   * }
   */
  async getAudit(auditId: string, options?: GetAuditOptions): Promise<AuditResponse> {
    const query = options?.format === 'mcp' ? '?format=mcp' : ''
    const res = await this.authedFetch(`/api/v1/audit/${auditId}${query}`)
    const raw = await this.handleApiResponse<Record<string, unknown>>(res)
    return this.mapAuditResponse(raw)
  }
```

#### Public method: `pollAudit(auditId, options?)`

**Implementation pattern: recursive `setTimeout` (NOT `setInterval`).**

```typescript
  /**
   * Poll audit status until complete or failed. Resolves when pipeline finishes.
   *
   * Uses recursive setTimeout (not setInterval) to avoid overlapping requests
   * when API responses are slow.
   *
   * @param auditId - The audit ID to poll.
   * @param options.intervalMs - Poll interval in ms. @default 5000
   * @param options.timeoutMs - Max total wait time in ms. @default 300000 (5 min)
   * @param options.onProgress - Callback fired after each poll with current response.
   * @throws {FlowblinqApiError} code='poll_timeout' if timeoutMs exceeded.
   * @throws {FlowblinqApiError} code='pipeline_failed' if audit status is 'failed'.
   *
   * @example
   * const result = await client.pollAudit(auditId, {
   *   onProgress: (r) => console.log(`Status: ${r.status}`),
   * })
   * console.log(result.overallScore)
   */
  async pollAudit(auditId: string, options?: PollOptions): Promise<AuditResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const timeoutMs = options?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    return new Promise<AuditResponse>((resolve, reject) => {
      const tick = async () => {
        if (Date.now() > deadline) {
          reject(new FlowblinqApiError(
            `pollAudit timed out after ${timeoutMs}ms for auditId=${auditId}`,
            0,
            'poll_timeout'
          ))
          return
        }
        try {
          const response = await this.getAudit(auditId)
          options?.onProgress?.(response)
          if (response.status === 'complete') {
            resolve(response)
          } else if (response.status === 'failed') {
            reject(new FlowblinqApiError(
              `Audit pipeline failed for auditId=${auditId}`,
              500,
              'pipeline_failed'
            ))
          } else {
            setTimeout(tick, intervalMs)
          }
        } catch (err) {
          reject(err)
        }
      }
      setTimeout(tick, intervalMs)  // first poll after one interval (not immediately)
    })
  }
```

#### Public method: `verifyAudit(auditId)`

```typescript
  /**
   * Trigger the post-optimization second run (free tier run 2).
   * Call this after the user has applied the optimization assets from run 1.
   *
   * @param auditId - The audit ID from the completed first run.
   * @returns Promise resolving to the new audit submission (freeRunNumber=2).
   * @throws {FlowblinqApiError} status=400 if first run is not yet complete
   *   or second run was already triggered.
   *
   * @example
   * // After user applies optimizations:
   * const run2 = await client.verifyAudit(auditId)
   * const result = await client.pollAudit(run2.auditId)
   */
  async verifyAudit(auditId: string): Promise<AuditSubmitResponse> {
    const res = await this.authedFetch(`/api/v1/audit/${auditId}/verify`, {
      method: 'POST',
      body: '{}',
    })
    const raw = await this.handleApiResponse<Record<string, unknown>>(res)
    return {
      auditId: raw['audit_id'] as string,
      status: 'pending',
      freeTier: true,
      freeRunNumber: 2,
      estimatedCompletionSeconds: (raw['estimated_completion_seconds'] as number) ?? 120,
    }
  }
```

#### Public method: `getAccount()`

```typescript
  /**
   * Retrieve team credit balance and API usage summary.
   *
   * @returns Promise resolving to account details.
   *
   * @example
   * const account = await client.getAccount()
   * if (account.creditBalance === 0) {
   *   console.log('Buy more credits:', account.creditsPurchaseUrl)
   * }
   */
  async getAccount(): Promise<AccountResponse> {
    const res = await this.authedFetch('/api/v1/account')
    const raw = await this.handleApiResponse<Record<string, unknown>>(res)
    return {
      teamId: raw['team_id'] as string,
      creditBalance: raw['credit_balance'] as number,
      freeOptimizationDomains: raw['free_optimization_domains'] as number,
      creditsPurchaseUrl: raw['credits_purchase_url'] as string,
    }
  }
```

#### Public method: `getMcpManifest()`

```typescript
  /**
   * Retrieve the MCP server manifest. No authentication required.
   * The manifest describes available tools and OAuth configuration
   * for MCP-compatible AI agents (Claude, Cursor, etc.).
   *
   * @returns Promise resolving to the MCP server manifest.
   *
   * @example
   * const manifest = await client.getMcpManifest()
   * console.log(manifest.tools.map(t => t.name))
   * // ['run_audit', 'get_audit', 'verify_optimization', 'get_account']
   */
  async getMcpManifest(): Promise<McpManifest> {
    const res = await this.rawFetch('/api/v1/mcp')
    const raw = await this.handleApiResponse<Record<string, unknown>>(res)
    return {
      protocol: raw['protocol'] as string,
      version: raw['version'] as string,
      auth: raw['auth'] as McpManifest['auth'],
      tools: raw['tools'] as McpManifest['tools'],
    }
  }
}
```

---

### New File: `geo/lib/flowblinq-client/index.ts`

Public exports only — no implementation:

```typescript
export { FlowblinqClient } from './client'
export { FlowblinqApiError } from './errors'
export type {
  FlowblinqClientConfig,
  SubmitAuditOptions,
  AuditSubmitResponse,
  GetAuditOptions,
  AuditResponse,
  GeoScorecard,
  PollOptions,
  AccountResponse,
  McpManifest,
  McpTool,
} from './types'
```

---

### New File: `geo/lib/flowblinq-client/README.md`

Must contain exactly these 6 sections (ScriptDev writes content, spec describes required coverage):

**Section 1 — Quickstart**
Complete working example: `new FlowblinqClient()` → `submitAudit()` → `pollAudit()` → log score. ~20 lines. Copy-paste runnable with real env var names.

**Section 2 — Full method reference**
One subsection per public method. Each includes: TypeScript signature, parameter table, return type description, minimum one code example showing real usage pattern.

**Section 3 — Error handling guide**
Table of all `FlowblinqApiError` codes: `auth_failed`, `invalid_client`, `client_revoked`, `insufficient_scope`, `free_tier_exhausted`, `rate_limit_exceeded`, `not_found`, `pipeline_failed`, `poll_timeout`, `timeout`, `api_error`. What triggers each, what the caller should do.

**Section 4 — Polling pattern**
Show both: (a) manual poll loop using `getAudit()` + `setTimeout`, (b) convenience `pollAudit()` with `onProgress`. Explain why `setInterval` is avoided.

**Section 5 — Free tier explanation**
Explain `freeRunNumber` (1 = baseline, 2 = post-optimization). Explain when to call `verifyAudit()`. Explain what `402 free_tier_exhausted` means. Show the full two-run workflow in code.

**Section 6 — Configuration reference**
All `FlowblinqClientConfig` options with types, defaults, and examples. Include note on `baseUrl` override for staging.

---

### New File: `geo/vitest.api-client.config.ts`

Follows the existing `vitest.integration.config.ts` pattern:

```typescript
/**
 * Vitest config for API client integration tests.
 *
 * Usage:
 *   npm run test:integration:api
 *   # or directly:
 *   vitest run --config vitest.api-client.config.ts tests/integration/api-client
 *
 * Requires .env.test in geo/ root.
 * See tests/integration/api-client/.env.test.example
 */

import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 600_000,    // 10 min — audit pipeline can take 3-5 min
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },  // prevent parallel test file execution
    },
    globalSetup: ['./tests/integration/api-client/setup.ts'],
    // Load .env.test (same pattern as vitest.integration.config.ts)
    env: { /* same .env.test loading block as vitest.integration.config.ts */ },
    exclude: ['**/node_modules/**', '**/.claude/worktrees/**'],
    // Run auth last when rate-limit test (A-8) is present
    sequence: {
      // files run in alphabetical order by default — audit-flow, errors, free-tier, mcp, then auth
      // A-8 (rate limit) is isolated to auth.test.ts which runs last alphabetically
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
})
```

Note: `auth.test.ts` runs alphabetically first, but A-8 (rate-limit) must use an **isolated client instance** with a dedicated test credential separate from the main test client, per TS-021 risk mitigation. Specify this in the test file (see below).

---

### Update: `geo/package.json`

Add to `scripts`:
```json
"test:integration:api": "vitest run --config vitest.api-client.config.ts tests/integration/api-client"
```

---

### Update: `geo/tsconfig.json`

**No change needed.** The `@/*` path alias at `"./*"` already resolves `@/lib/flowblinq-client` to `geo/lib/flowblinq-client/index.ts`. The `tests/**` directory is excluded from tsc compilation (correct — integration tests use vitest's own TypeScript transform, not tsc).

---

### New File: `geo/tests/integration/api-client/setup.ts`

Global setup and teardown. Follows `bulk-csv-qa/setup/global-setup.ts` pattern.

```typescript
/**
 * Global setup for api-client integration tests.
 *
 * beforeAll:
 *   1. Validate env vars
 *   2. Warm up Vercel (cold start prevention)
 *   3. Provision a fresh apiClient row in DB via Supabase service role
 *   4. Export { clientId, clientSecret, teamId, baseUrl } to globalThis.__API_CLIENT_QA__
 *
 * afterAll:
 *   1. Delete all apiClient rows created during this suite (by test_ prefix on name)
 *   2. Delete all geoSite rows with apiClientId matching provisioned clientId
 *   3. Log cleanup summary
 */

// Required env vars:
const REQUIRED_ENV = [
  'TEST_BASE_URL',
  'TEST_SUPABASE_URL',
  'TEST_SUPABASE_SERVICE_KEY',
  'TEST_TEAM_ID',
]
// TEST_CLIENT_ID / TEST_CLIENT_SECRET: optional override — if set, skip DB provisioning
// and use the provided credentials directly (useful for manual runs)

// Provisioning logic:
//   - Use @supabase/supabase-js with SUPABASE_SERVICE_ROLE_KEY to insert into api_clients:
//     { id: nanoid(), teamId: TEST_TEAM_ID, clientId: 'test_' + nanoid(16),
//       clientSecretHash: bcrypt(secret, 12), name: 'integration-test-' + Date.now(),
//       scopes: ['audit:read', 'audit:write', 'account:read'], createdAt: new Date() }
//   - Store plaintext secret in memory (used to construct FlowblinqClient in tests)
//   - Store clientId and secret in globalThis.__API_CLIENT_QA__

// Warm-up call:
//   GET ${TEST_BASE_URL}/api/v1/mcp — no auth needed, warms the Vercel instance
//   Log response time. If > 10s, log warning about cold start.

// globalThis export:
declare global {
  var __API_CLIENT_QA__: {
    clientId: string
    clientSecret: string
    teamId: string
    baseUrl: string
    provisioned: boolean  // true if we created the cred, false if using override
  }
}
```

**Note on bcrypt in setup.ts:** Setup runs in Node.js (not edge), so `bcryptjs` can be imported directly. It's already a project dependency (added in ES-019).

---

### New File: `geo/tests/integration/api-client/auth.test.ts`

```typescript
/**
 * Auth integration tests — A-1 through A-8.
 * Tests the OAuth token endpoint and JWT validation on v1 routes.
 */
import { FlowblinqClient, FlowblinqApiError } from '@/lib/flowblinq-client'

// Uses globalThis.__API_CLIENT_QA__ from setup.ts

// A-8 uses a SEPARATE isolated client with a separate provisioned credential
// (created ad-hoc in beforeAll for this file, deleted in afterAll)
// Purpose: isolate the rate limit burst from the shared test credential
// so other test files don't see 429s.
```

Test implementations:

| ID | Implementation notes |
|----|---------------------|
| A-1 | `new FlowblinqClient(...)` → call `getAccount()` (forces token acquisition). Assert no error, check response shape. |
| A-2 | `new FlowblinqClient({ clientId, clientSecret: 'wrong' })` → call any v1 method. Assert `FlowblinqApiError` with `status=401`. |
| A-3 | `new FlowblinqClient({ clientId: 'nonexistent', clientSecret: '...' })` → call any v1 method. Assert `status=401`. |
| A-4 | Update `revokedAt` on provisioned client via service role → call any v1 method. Assert `status=401`, `code='client_revoked'` or similar. Restore `revokedAt=null` in test cleanup. |
| A-5 | After successful `getAccount()`, decode JWT from `client['tokenCache']?.value` (via type cast). Assert payload has `team_id`, `scopes` fields. Use `atob()` on the middle segment. |
| A-6 | Manually construct a request with `Authorization: Bearer <expired.jwt.here>` using `fetch` directly. Assert 401. |
| A-7 | `fetch('${baseUrl}/api/v1/account')` with no Authorization header. Assert 401. |
| A-8 | Use isolated rate-limit client. Fire 11 `POST /api/oauth/token` requests sequentially within 60s. Assert first 10 succeed (2xx), 11th returns 429. |

---

### New File: `geo/tests/integration/api-client/audit-flow.test.ts`

```typescript
/**
 * Full audit flow tests — F-1 through F-7.
 * Submits a real audit, polls until complete, validates result shape.
 *
 * F-3 (pollAudit completion) is the long test — up to 5 min.
 * It may be retried once per TS-021 risk mitigation.
 */
```

| ID | Implementation notes |
|----|---------------------|
| F-1 | `client.submitAudit({ url: 'https://example.com' })`. Assert response has `auditId` (non-empty string), `status='pending'`. |
| F-2 | Immediately `getAudit(auditId)`. Assert status is `'pending'` or `'running'` (not `'complete'` yet). |
| F-3 | `pollAudit(auditId, { timeoutMs: 300_000, onProgress: ... })`. Assert resolves with `status='complete'`. Retry wrapper: if fails, re-submit on fresh domain and retry once. |
| F-4 | On F-3 resolved result: assert `overallScore` is number between 0 and 100. Assert `scorecard.pillars` is non-empty array. |
| F-5 | On F-3 resolved result: assert `files.llmsTxtUrl` is non-null string starting with `https://`. |
| F-6 | `fetch(files.llmsTxtUrl)`. Assert status 200. Assert response body contains `# ` (valid llms.txt format). |
| F-7 | `client.getAccount()`. Assert `teamId` is string matching `TEST_TEAM_ID`. Assert `creditBalance` is a number ≥ 0. |

---

### New File: `geo/tests/integration/api-client/free-tier.test.ts`

```typescript
/**
 * Free tier gate tests — T-1 through T-5.
 * Uses a dedicated test domain per test to avoid state collisions.
 * All test geoSite rows are cleaned up in setup.ts teardown.
 */
```

| ID | Implementation notes |
|----|---------------------|
| T-1 | Submit audit on a fresh subdomain (e.g. `https://api-test-t1-<nanoid>.example.com`). Assert `freeRunNumber=1`, `freeTier=true`. (No actual pipeline runs — site won't resolve, but state machine step 1 still works.) |
| T-2 | Using the same auditId from T-1 — BUT first need pipeline to complete. Use a real domain that will resolve AND is the test team's fresh domain. Poll until complete, then `verifyAudit(auditId)`. Assert `freeRunNumber=2`. |
| T-3 | After T-2, attempt `submitAudit` on same domain again. Assert `FlowblinqApiError` with `status=402`. |
| T-4 | Assert the 402 error (from T-3 catch) or call `getAccount()` and assert `creditsPurchaseUrl` contains 'flowblinq.com/pricing'. |
| T-5 | `submitAudit` on a different domain (same client). Assert `freeRunNumber=1` — domain scoping confirmed. |

**Note for ScriptDev on T-1/T-2:** SSRF-blocked domains won't create pipeline runs. T-1 can use a fake domain to test the state machine. T-2 needs a real resolvable domain. Use a known-good test domain stored in env: `TEST_AUDIT_DOMAIN` (e.g. `https://example.com`).

---

### New File: `geo/tests/integration/api-client/mcp.test.ts`

| ID | Implementation notes |
|----|---------------------|
| M-1 | `client.getMcpManifest()`. Assert `protocol` is non-empty string, `version` is non-empty string. |
| M-2 | Assert `manifest.tools` has exactly 4 items. Assert each has `name`, `description`, `inputSchema` (non-empty object). Assert tool names include `run_audit`, `get_audit`, `verify_optimization`, `get_account`. |
| M-3 | `client.getAudit(completedAuditId, { format: 'mcp' })`. (Requires F-3 to have run or share its auditId.) Assert response has `type='tool_result'`, `content` is array. |
| M-4 | Assert `content` includes at least one item with `type='text'` containing a score summary string. |
| M-5 | Assert `content` includes at least one item with `type='resource'` with `resource.uri` starting with `https://`. |

---

### New File: `geo/tests/integration/api-client/errors.test.ts`

| ID | Implementation notes |
|----|---------------------|
| E-1 | Wrong secret → catch error. Assert `err instanceof FlowblinqApiError`. Assert `err.status === 401`. Assert `err.code` is a non-empty string. |
| E-2 | Free-tier-exhausted domain (from T-3 or dedicate a new one) → catch error. Assert `err.status === 402`. Assert `err.code` contains `'free_tier'` or `'insufficient_credits'`. |
| E-3 | `client.getAudit('nonexistent-id-12345')`. Assert `err.status === 404`. |
| E-4 | Rate-limit an isolated client (11 token requests, same pattern as A-8). Assert 429 error is caught as `FlowblinqApiError` with `status=429`. |
| E-5 | Provision a geoSite row directly with `pipelineStatus='failed'` via service role. `client.pollAudit(auditId, { intervalMs: 1000 })`. Assert rejects with `FlowblinqApiError`, `code='pipeline_failed'`. |
| E-6 | `client.pollAudit(pendingAuditId, { timeoutMs: 2000, intervalMs: 1000 })` on a newly submitted (not completed) audit. Wait 2s. Assert rejects with `FlowblinqApiError`, `code='poll_timeout'`. |

---

### New File: `geo/tests/integration/api-client/README.md`

Must include:
1. **Prerequisites** — Node 18+, filled `.env.test`, Supabase service role key, network access to Vercel
2. **How to run** — `npm run test:integration:api`, individual file run command
3. **Environment variables** — table of all required vars with description and where to find each
4. **Test map** — table: file → test IDs → description → approximate duration
5. **Teardown guarantee** — what setup.ts cleans up and how to verify manually via Supabase
6. **Troubleshooting** — cold start timeout (run again), rate limit (wait 60s), DB state collisions

---

### New File: `geo/tests/integration/api-client/.env.test.example`

```env
# API Client integration tests
# Copy to geo/.env.test and fill in values.

# Vercel deployment URL (no trailing slash)
TEST_BASE_URL=https://geo.flowblinq.com

# Supabase connection (same as bulk-csv-qa)
TEST_SUPABASE_URL=https://your-project.supabase.co
TEST_SUPABASE_SERVICE_KEY=your-service-role-key

# Test team ID (must exist in Supabase, must have access to API)
TEST_TEAM_ID=your-team-id

# Optional: override auto-provisioned credentials (useful for manual runs)
# If set, setup.ts skips DB provisioning and uses these directly.
# TEST_CLIENT_ID=fq_live_...
# TEST_CLIENT_SECRET=sk_...

# Optional: domain for audit flow tests that require a real pipeline run
# Must be a real domain that Firecrawl can scrape
TEST_AUDIT_DOMAIN=https://example.com
```

---

## c) Unit Test Plan

The `FlowblinqClient` class is a network client — it is covered by the **integration test suite** (31 tests) which is its primary validation.

For unit coverage of the non-network logic, one focused unit test file:

**Test file:** `geo/__tests__/flowblinq-client.test.ts`

Mock: global `fetch` via `vi.stubGlobal('fetch', ...)`

| ID | Scenario | Expected |
|----|----------|----------|
| C-1 | Constructor: missing `clientId` | throws Error |
| C-2 | Constructor: missing `clientSecret` | throws Error |
| C-3 | Token caching: `getAccount()` called twice | `fetch` for token called once |
| C-4 | Token refresh: cached token with `expiresAt` = now + 30s | re-fetches token before request |
| C-5 | Token fresh: cached token with `expiresAt` = now + 90s | reuses cached token |
| C-6 | `rawFetch` timeout: `fetch` hangs > `timeoutMs` | rejects with `FlowblinqApiError` code=`'timeout'` |
| C-7 | `handleApiResponse` on 401: body `{ error: 'invalid_client' }` | throws `FlowblinqApiError` status=401 |
| C-8 | `handleApiResponse` on 402 | throws `FlowblinqApiError` status=402 |
| C-9 | `pollAudit`: first poll returns `pending`, second returns `complete` | resolves after 2 polls |
| C-10 | `pollAudit`: first poll returns `failed` | rejects with code=`'pipeline_failed'` |
| C-11 | `pollAudit`: deadline exceeded | rejects with code=`'poll_timeout'` |
| C-12 | `mapAuditResponse`: snake_case API response maps to camelCase `AuditResponse` | all fields correct |
| C-13 | `FlowblinqApiError`: `instanceof Error` check passes | true |
| C-14 | `getMcpManifest`: calls `/api/v1/mcp` WITHOUT Authorization header | `fetch` called without Auth header |

Use `vi.useFakeTimers()` for C-9, C-10, C-11, C-6 to avoid real delays.

**Coverage target:** ≥90% line coverage on `lib/flowblinq-client/client.ts`, `errors.ts`, `types.ts`.

---

## d) Integration Test Plan

The integration test suite IS the integration test plan. 31 tests across 5 files:
- `auth.test.ts`: A-1 through A-8 (8 tests)
- `audit-flow.test.ts`: F-1 through F-7 (7 tests)
- `free-tier.test.ts`: T-1 through T-5 (5 tests)
- `mcp.test.ts`: M-1 through M-5 (5 tests)
- `errors.test.ts`: E-1 through E-6 (6 tests)

**Total:** 31 tests

**Execution:** `npm run test:integration:api` (runs against live production Vercel).

**Run environment:** Not in CI by default (network-dependent, uses production DB). Run manually before WordPress plugin distribution.

---

## e) Profiling Requirements

**What to measure:**
- `submitAudit()` → `pollAudit()` end-to-end duration: measure in F-3 via `Date.now()` before/after. Log to console.
- Token acquisition latency: log in `ensureToken()` when `LOG_LEVEL=debug` env is set.

**Expectations from integration tests:**
- Token acquisition: p50 ≤ 300ms (per ES-019 profiling spec)
- `submitAudit()` + pipeline + `pollAudit()` complete: p50 ≤ 180s for single-domain free-tier audit

**Client timeout defaults:**
- `timeoutMs: 30_000` for individual requests — this is per-request, not total pipeline time
- `pollAudit` default `timeoutMs: 300_000` — covers full pipeline duration

---

## f) Load Test Plan

Not in scope for this spec — the client is a library and integration test suite, not a production service. Load testing of the underlying API is handled by ES-019's load test spec.

---

## g) Logging & Instrumentation

No production logging (client is a library). Debug logging guidance for README:

```typescript
// Enable debug logging by setting an env var in your runtime:
// LOG_LEVEL=debug — logs token acquisition, request URLs, response times
// (implementation: check process.env.LOG_LEVEL === 'debug' before console.debug calls)
```

---

## h) Acceptance Criteria

- [ ] `FlowblinqClient` compiles with `tsc --noEmit` with zero errors (`strict: true`)
- [ ] No TypeScript `any` in `client.ts`, `types.ts`, or `errors.ts`
- [ ] Every public method and exported type has JSDoc
- [ ] `README.md` covers all 6 required sections; quickstart example is ≤20 lines and runnable
- [ ] Unit test file `__tests__/flowblinq-client.test.ts` passes (14 test cases)
- [ ] Coverage ≥90% on `lib/flowblinq-client/` files
- [ ] `npm run test:integration:api` runs all 31 integration tests against live Vercel
- [ ] All 31 integration tests pass on first run (no flake)
- [ ] F-3 (pollAudit completion) completes within 5 minutes
- [ ] `setup.ts` teardown removes all test data — verified via Supabase query after run
- [ ] `npm test` (unit test suite) is NOT affected — integration tests excluded via vitest.config.ts
- [ ] `test:integration:api` script added to `package.json`
- [ ] `.env.test.example` documents all required env vars

---

## Notes for ScriptDev

1. **`ensureToken()` is private** — never expose the token or the cache to callers. The client's contract is: callers provide credentials, client handles all auth internally.

2. **`pollAudit()` uses recursive setTimeout, not setInterval.** Reason: if a `getAudit()` call takes longer than `intervalMs` (e.g. slow DB query), `setInterval` would fire a second poll before the first resolves. `setTimeout` schedules the next poll only after the previous one completes.

3. **`mapAuditResponse()` isolates snake_case mapping.** The API returns `audit_id`, `overall_score`, etc. The client converts to `auditId`, `overallScore`. This means if the API changes field names, only `mapAuditResponse()` needs updating.

4. **Integration test isolation:** Each integration test that creates a geoSite should use a unique domain. Convention: `https://api-test-<testId>-<nanoid(8)>.example.com`. These domains are SSRF-safe (example.com is a real domain but won't run the pipeline since it's already cached or the test teardown removes the row).

5. **`vitest.api-client.config.ts` env loading:** Copy the `.env.test` loading block exactly from `vitest.integration.config.ts` — don't reinvent it.

6. **A-5 JWT inspection:** Decoding the JWT payload is done by base64-decoding the middle segment: `JSON.parse(atob(token.split('.')[1]))`. This works in Node.js without any JWT library. Only check that `team_id` and `scopes` fields are present — don't verify the signature in this test (that's covered by unit tests of `lib/api-auth.ts`).

7. **T-2 requires a real audit to complete.** Use `TEST_AUDIT_DOMAIN` env var (e.g. `https://example.com`). Accept that this test takes ~3 min. It's the only free-tier test that needs a real pipeline run.

8. **E-5 DB provisioning:** Insert a geoSite with `pipelineStatus='failed'` directly via Supabase service role (bypasses the API). This lets us test `pollAudit()` failure handling without waiting for the pipeline to fail.
