import { FlowblinqApiError } from './errors'
import type {
  FlowblinqClientConfig,
  SubmitAuditOptions,
  AuditSubmitResponse,
  GetAuditOptions,
  AuditResponse,
  GeoScorecard,
  PollOptions,
  AccountResponse,
  McpManifest,
  TokenCache,
} from './types'

const DEFAULT_BASE_URL = 'https://geo.flowblinq.com'
const DEFAULT_TIMEOUT_MS = 30_000
const TOKEN_EXPIRY_BUFFER_MS = 60_000   // refresh if < 60s remaining
const DEFAULT_POLL_INTERVAL_MS = 5_000
const DEFAULT_POLL_TIMEOUT_MS = 300_000

/**
 * Official TypeScript client for the Flowblinq GEO API.
 *
 * Uses OAuth 2.0 client_credentials for authentication. Tokens are cached
 * in memory and refreshed automatically when within 60s of expiry.
 *
 * @example
 * ```typescript
 * const client = new FlowblinqClient({
 *   clientId: process.env.FLOWBLINQ_CLIENT_ID!,
 *   clientSecret: process.env.FLOWBLINQ_CLIENT_SECRET!,
 * })
 * const { auditId } = await client.submitAudit({ url: 'https://example.com' })
 * const result = await client.pollAudit(auditId)
 * console.log(`Score: ${result.overallScore}`)
 * ```
 */
export class FlowblinqClient {
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private tokenCache: TokenCache | null = null

  /**
   * Creates a new FlowblinqClient instance.
   *
   * @param config - Client configuration including credentials and optional overrides.
   * @throws {Error} If clientId or clientSecret are missing.
   */
  constructor(config: FlowblinqClientConfig) {
    if (!config.clientId) throw new Error('FlowblinqClient: clientId is required')
    if (!config.clientSecret) throw new Error('FlowblinqClient: clientSecret is required')
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

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

  /**
   * Executes a fetch with timeout. The timeout fires via a competing setTimeout
   * so it works correctly even when the underlying fetch mock never rejects on
   * abort (e.g. in Vitest fake-timer environments).
   * @throws {FlowblinqApiError} code='timeout' if request exceeds timeoutMs
   */
  private rawFetch(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController()
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort()
        reject(new FlowblinqApiError(
          `Request timed out after ${this.timeoutMs}ms: ${path}`,
          0,
          'timeout'
        ))
      }, this.timeoutMs)

      fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal })
        .then(res => { clearTimeout(timer); resolve(res) })
        .catch(err => {
          clearTimeout(timer)
          if ((err as Error).name === 'AbortError') {
            reject(new FlowblinqApiError(
              `Request timed out after ${this.timeoutMs}ms: ${path}`,
              0,
              'timeout'
            ))
          } else {
            reject(err)
          }
        })
    })
  }

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

  /**
   * Submit a URL for GEO analysis.
   *
   * @param options.url - The URL to audit. Must be a valid https:// URL.
   * @returns Promise resolving to audit submission details including auditId.
   * @throws {FlowblinqApiError} status=402 if free tier exhausted for this domain.
   * @throws {FlowblinqApiError} status=400 if URL is invalid.
   *
   * @example
   * ```typescript
   * const result = await client.submitAudit({ url: 'https://example.com' })
   * console.log(result.auditId) // 'site_abc123'
   * ```
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
   * ```typescript
   * const audit = await client.getAudit('site_abc123')
   * if (audit.status === 'complete') {
   *   console.log(audit.overallScore) // 72
   * }
   * ```
   */
  async getAudit(auditId: string, options?: GetAuditOptions): Promise<AuditResponse> {
    const query = options?.format === 'mcp' ? '?format=mcp' : ''
    const res = await this.authedFetch(`/api/v1/audit/${auditId}${query}`)
    const raw = await this.handleApiResponse<Record<string, unknown>>(res)
    return this.mapAuditResponse(raw)
  }

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
   * ```typescript
   * const result = await client.pollAudit(auditId, {
   *   onProgress: (r) => console.log(`Status: ${r.status}`),
   * })
   * console.log(result.overallScore)
   * ```
   */
  pollAudit(auditId: string, options?: PollOptions): Promise<AuditResponse> {
    const intervalMs = options?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS
    const timeoutMs = options?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs

    const promise = new Promise<AuditResponse>((resolve, reject) => {
      const tick = async () => {
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
          } else if (Date.now() >= deadline) {
            reject(new FlowblinqApiError(
              `pollAudit timed out after ${timeoutMs}ms for auditId=${auditId}`,
              0,
              'poll_timeout'
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
    // Pre-register a no-op catch so Node.js never emits unhandledRejection while
    // the caller's handler is being set up (e.g. in fake-timer test environments).
    // Callers that attach their own .catch() or use await still receive the rejection.
    void promise.catch(() => {})
    return promise
  }

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
   * ```typescript
   * // After user applies optimizations:
   * const run2 = await client.verifyAudit(auditId)
   * const result = await client.pollAudit(run2.auditId)
   * ```
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

  /**
   * Retrieve team credit balance and API usage summary.
   *
   * @returns Promise resolving to account details.
   *
   * @example
   * ```typescript
   * const account = await client.getAccount()
   * if (account.creditBalance === 0) {
   *   console.log('Buy more credits:', account.creditsPurchaseUrl)
   * }
   * ```
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

  /**
   * Retrieve the MCP server manifest. No authentication required.
   * The manifest describes available tools and OAuth configuration
   * for MCP-compatible AI agents (Claude, Cursor, etc.).
   *
   * @returns Promise resolving to the MCP server manifest.
   *
   * @example
   * ```typescript
   * const manifest = await client.getMcpManifest()
   * console.log(manifest.tools.map(t => t.name))
   * // ['run_audit', 'get_audit', 'verify_optimization', 'get_account']
   * ```
   */
  getMcpManifest(): Promise<McpManifest> {
    const p = (async () => {
      const res = await this.rawFetch('/api/v1/mcp')
      const raw = await this.handleApiResponse<Record<string, unknown>>(res)
      return {
        protocol: raw['protocol'] as string,
        version: raw['version'] as string,
        auth: raw['auth'] as McpManifest['auth'],
        tools: raw['tools'] as McpManifest['tools'],
      }
    })()
    // Pre-register a no-op catch so Node.js never emits unhandledRejection while
    // the caller's handler is being set up (e.g. in fake-timer test environments).
    void p.catch(() => {})
    return p
  }
}
