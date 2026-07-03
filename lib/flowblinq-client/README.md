# FlowblinqClient — TypeScript API Client

Official TypeScript client for the [Flowblinq GEO API](https://geo.flowblinq.com). Zero external dependencies — uses native `fetch` (Node 18+, all modern runtimes).

---

## 1. Quickstart

```typescript
import { FlowblinqClient } from '@/lib/flowblinq-client'

const client = new FlowblinqClient({
  clientId: process.env.FLOWBLINQ_CLIENT_ID!,
  clientSecret: process.env.FLOWBLINQ_CLIENT_SECRET!,
})

// Submit a URL for GEO analysis
const { auditId } = await client.submitAudit({ url: 'https://example.com' })
console.log('Audit started:', auditId)

// Poll until the pipeline completes (~2–5 min)
const result = await client.pollAudit(auditId, {
  onProgress: (r) => console.log(`Status: ${r.status}`),
})

console.log(`Overall score: ${result.overallScore}/100`)
console.log(`llms.txt: ${result.files.llmsTxtUrl}`)
```

Credentials are issued from the Flowblinq dashboard under **Settings → API Access**.

---

## 2. Full Method Reference

### `new FlowblinqClient(config)`

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `clientId` | `string` | Yes | — | OAuth client_id from dashboard |
| `clientSecret` | `string` | Yes | — | OAuth client_secret from dashboard |
| `baseUrl` | `string` | No | `https://geo.flowblinq.com` | API base URL |
| `timeoutMs` | `number` | No | `30000` | Per-request timeout in ms |

Throws `Error` immediately if `clientId` or `clientSecret` are missing.

---

### `submitAudit(options): Promise<AuditSubmitResponse>`

Submit a URL for GEO analysis. Returns immediately with an `auditId` — the pipeline runs asynchronously.

| Parameter | Type | Description |
|-----------|------|-------------|
| `options.url` | `string` | The URL to audit (must be `https://`) |

**Returns:** `AuditSubmitResponse`

| Field | Type | Description |
|-------|------|-------------|
| `auditId` | `string` | Use this to poll or retrieve results |
| `status` | `'pending'` | Always `pending` on submit |
| `freeTier` | `boolean` | Whether this domain is using the free tier |
| `freeRunNumber` | `1 \| 2` | Which free run this is |
| `estimatedCompletionSeconds` | `number` | Estimated pipeline duration |

```typescript
const { auditId, freeRunNumber } = await client.submitAudit({
  url: 'https://acme.com',
})
console.log(`Run ${freeRunNumber} started: ${auditId}`)
```

**Throws:** `FlowblinqApiError` with `status=402` if free tier is exhausted for this domain.

---

### `getAudit(auditId, options?): Promise<AuditResponse>`

Retrieve the current status and results of an audit. Does not wait — returns immediately with current state.

| Parameter | Type | Description |
|-----------|------|-------------|
| `auditId` | `string` | Audit ID from `submitAudit()` |
| `options.format` | `'mcp'` | Optional: return MCP tool_result format |

**Returns:** `AuditResponse`

| Field | Type | Description |
|-------|------|-------------|
| `auditId` | `string` | Audit identifier |
| `domain` | `string` | Domain being audited |
| `status` | `'pending' \| 'running' \| 'complete' \| 'failed'` | Pipeline state |
| `overallScore` | `number \| null` | 0–100, null until complete |
| `freeRunNumber` | `1 \| 2` | Which free run |
| `scorecard` | `GeoScorecard \| null` | Pillar scores, null until complete |
| `recommendations` | `string[]` | Actionable recommendations |
| `executiveSummary` | `string \| null` | Narrative summary |
| `files.llmsTxtUrl` | `string \| null` | URL to generated llms.txt |
| `files.businessJsonUrl` | `string \| null` | URL to business.json |
| `files.schemaJsonUrl` | `string \| null` | URL to schema.json (backward compat). Prefer the tracking pixel — see Integration below. |
| `createdAt` | `string` | ISO timestamp |
| `completedAt` | `string \| null` | ISO timestamp, null until complete |

```typescript
const audit = await client.getAudit('site_abc123')
if (audit.status === 'complete') {
  console.log(`Score: ${audit.overallScore}`)
}
```

---

### `pollAudit(auditId, options?): Promise<AuditResponse>`

Poll until the audit is complete or failed. Uses recursive `setTimeout` (see section 4).

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `auditId` | `string` | — | Audit ID to poll |
| `options.intervalMs` | `number` | `5000` | Polling interval in ms |
| `options.timeoutMs` | `number` | `300000` | Max wait time in ms (5 min) |
| `options.onProgress` | `(r: AuditResponse) => void` | — | Called after each poll |

**Throws:** `FlowblinqApiError` with `code='poll_timeout'` if `timeoutMs` is exceeded.
**Throws:** `FlowblinqApiError` with `code='pipeline_failed'` if the audit fails.

```typescript
const result = await client.pollAudit(auditId, {
  intervalMs: 10_000,
  timeoutMs: 600_000,
  onProgress: ({ status, overallScore }) =>
    console.log(status, overallScore ?? '…'),
})
```

---

### `verifyAudit(auditId): Promise<AuditSubmitResponse>`

Trigger the post-optimization second run (free tier run 2). Call after the user has applied the optimization assets from run 1.

| Parameter | Type | Description |
|-----------|------|-------------|
| `auditId` | `string` | Audit ID from the completed first run |

**Returns:** `AuditSubmitResponse` with `freeRunNumber=2`.

```typescript
// After user uploads llms.txt and schema markup:
const run2 = await client.verifyAudit(firstRunAuditId)
const verified = await client.pollAudit(run2.auditId)
console.log(`Before: ${firstResult.overallScore} → After: ${verified.overallScore}`)
```

---

### `getAccount(): Promise<AccountResponse>`

Retrieve team credit balance and API usage summary.

**Returns:** `AccountResponse`

| Field | Type | Description |
|-------|------|-------------|
| `teamId` | `string` | Team identifier |
| `creditBalance` | `number` | Remaining credits |
| `freeOptimizationDomains` | `number` | Domains using free tier |
| `creditsPurchaseUrl` | `string` | URL to purchase more credits |

```typescript
const { creditBalance, creditsPurchaseUrl } = await client.getAccount()
if (creditBalance === 0) {
  console.log('Out of credits:', creditsPurchaseUrl)
}
```

---

### `getMcpManifest(): Promise<McpManifest>`

Retrieve the MCP server manifest. **No authentication required** — this is a public endpoint.

```typescript
const manifest = await client.getMcpManifest()
console.log(manifest.tools.map(t => t.name))
// ['run_audit', 'get_audit', 'verify_optimization', 'get_account']
```

---

## 3. Error Handling Guide

All errors are instances of `FlowblinqApiError` which extends `Error`.

```typescript
import { FlowblinqClient, FlowblinqApiError } from '@/lib/flowblinq-client'

try {
  await client.submitAudit({ url: 'https://example.com' })
} catch (err) {
  if (err instanceof FlowblinqApiError) {
    console.error(`[${err.code}] ${err.message} (HTTP ${err.status})`)
  }
}
```

| Code | HTTP Status | Trigger | Recommended Action |
|------|-------------|---------|-------------------|
| `auth_failed` | 401 | Token acquisition failed (bad credentials or network) | Check `clientId` / `clientSecret` |
| `invalid_client` | 401 | Client ID not found in DB | Verify credentials are correct |
| `client_revoked` | 401 | API key was revoked in dashboard | Generate a new key |
| `insufficient_scope` | 403 | JWT missing required scope for endpoint | Regenerate key with correct scopes |
| `free_tier_exhausted` | 402 | Both free runs used for this domain | Use `creditsPurchaseUrl` to top up |
| `rate_limit_exceeded` | 429 | Too many token requests (>10/min) | Back off 60s and retry |
| `not_found` | 404 | `auditId` does not exist or belongs to another team | Check the ID |
| `pipeline_failed` | 500 | Audit pipeline encountered an error | Retry `submitAudit()` on same URL |
| `poll_timeout` | 0 | `pollAudit()` exceeded `timeoutMs` | Increase `timeoutMs` or retry later |
| `timeout` | 0 | Individual HTTP request exceeded `timeoutMs` | Retry or increase client `timeoutMs` |
| `api_error` | varies | Unclassified API error | Log `err.status` + `err.message` for diagnosis |

---

## 4. Polling Pattern

### Why `setInterval` is avoided

`setInterval` fires on a fixed schedule regardless of whether the previous request completed. If a `getAudit()` call takes longer than `intervalMs` (e.g. slow DB or cold Vercel start), a second concurrent poll fires before the first resolves, creating overlapping requests.

`setTimeout` (recursive) only schedules the next poll **after** the previous one completes — safe for any response latency.

### Option A: Convenience `pollAudit()` with `onProgress`

```typescript
const result = await client.pollAudit(auditId, {
  intervalMs: 5_000,
  timeoutMs: 300_000,
  onProgress: ({ status }) => process.stdout.write(`\r${status}...`),
})
console.log(`\nDone! Score: ${result.overallScore}`)
```

### Option B: Manual poll loop using `getAudit()` + `setTimeout`

```typescript
async function waitForAudit(client: FlowblinqClient, auditId: string): Promise<AuditResponse> {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      const audit = await client.getAudit(auditId)
      if (audit.status === 'complete') return resolve(audit)
      if (audit.status === 'failed') return reject(new Error('Audit failed'))
      setTimeout(poll, 5_000)  // schedule AFTER response received
    }
    setTimeout(poll, 5_000)
  })
}
```

---

## 5. Free Tier Explanation

Every Flowblinq GEO account gets **two free runs per domain**:

| Run | `freeRunNumber` | Purpose |
|-----|----------------|---------|
| Run 1 (baseline) | `1` | Initial GEO audit — reveals score and generates optimization files |
| Run 2 (post-optimization) | `2` | Measures improvement after you apply Run 1's recommendations |

### When to call `verifyAudit()`

After Run 1 completes:
1. Download and deploy the generated `llms.txt`, `business.json`, and schema markup
2. Call `verifyAudit(run1AuditId)` to trigger Run 2
3. Poll Run 2 to completion — compare scores

### Full two-run workflow

```typescript
// Run 1: baseline
const { auditId: run1Id } = await client.submitAudit({ url: 'https://acme.com' })
const run1 = await client.pollAudit(run1Id)
console.log(`Baseline score: ${run1.overallScore}`)

// → Deploy run1.files.llmsTxtUrl content to https://acme.com/llms.txt
// → Add tracking pixel: <img src="https://geo.flowblinq.com/api/t/SLUG" width="1" height="1" alt="" style="position:absolute;opacity:0" />
// → (Optional) Add schema injection: <script src="https://geo.flowblinq.com/api/t/SLUG" async></script>

// Run 2: post-optimization
const { auditId: run2Id } = await client.verifyAudit(run1Id)
const run2 = await client.pollAudit(run2Id)
console.log(`Optimized score: ${run2.overallScore}`)
console.log(`Improvement: +${(run2.overallScore ?? 0) - (run1.overallScore ?? 0)} points`)
```

### `402 free_tier_exhausted`

If you call `submitAudit()` on the same domain after both runs are used, you receive a `402` error. Use `getAccount().creditsPurchaseUrl` to purchase additional credits.

---

## 6. Configuration Reference

All options are passed to the `FlowblinqClient` constructor.

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `clientId` | `string` | Yes | — | OAuth `client_id` from dashboard |
| `clientSecret` | `string` | Yes | — | OAuth `client_secret` from dashboard (store in env, never commit) |
| `baseUrl` | `string` | No | `https://geo.flowblinq.com` | Override for staging/local testing |
| `timeoutMs` | `number` | No | `30000` | Per-request HTTP timeout in ms. Does NOT apply to `pollAudit()` total time. |

### Staging override

```typescript
const client = new FlowblinqClient({
  clientId: process.env.FLOWBLINQ_CLIENT_ID!,
  clientSecret: process.env.FLOWBLINQ_CLIENT_SECRET!,
  baseUrl: 'https://geo-staging.flowblinq.com',  // override for non-production
})
```

### Aggressive timeout (CI/CD)

```typescript
const client = new FlowblinqClient({
  clientId: process.env.FLOWBLINQ_CLIENT_ID!,
  clientSecret: process.env.FLOWBLINQ_CLIENT_SECRET!,
  timeoutMs: 10_000,  // 10s per request — fail fast in CI
})
```

### Token caching

Tokens are cached in memory per-instance and refreshed automatically 60s before expiry. Tokens are **never persisted to disk**. If you need token sharing across processes, implement your own cache and call `verifyAudit()` / `getAudit()` with a pre-fetched token via a custom `baseUrl`.
