// --- Config ---

/** Configuration options for FlowblinqClient */
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

/** Options for submitting a new audit */
export interface SubmitAuditOptions {
  /** The URL to audit. Must be a valid https:// URL. */
  url: string
}

/** Response returned from submitAudit() */
export interface AuditSubmitResponse {
  auditId: string
  status: 'pending'
  freeTier: boolean
  freeRunNumber: 1 | 2
  estimatedCompletionSeconds: number
}

// --- Audit get ---

/** Options for retrieving an audit */
export interface GetAuditOptions {
  /** Return MCP-formatted tool_result instead of standard JSON */
  format?: 'mcp'
}

/** A single GEO scorecard pillar */
export interface GeoScorecardPillar {
  pillar: string
  pillarName: string
  score: number
  findings: string
  recommendation: string
  priority: string
}

/** GEO scorecard with per-pillar scores */
export interface GeoScorecard {
  overallScore: number
  pillars: GeoScorecardPillar[]
  topThreeImprovements: string[]
}

/** Full audit response with status and results */
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

/** Options for pollAudit() */
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

/** Account information and credit balance */
export interface AccountResponse {
  teamId: string
  creditBalance: number
  freeOptimizationDomains: number
  creditsPurchaseUrl: string
}

// --- MCP Manifest ---

/** A single MCP tool descriptor */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** MCP server manifest */
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

/** Internal token cache entry (not exported from index.ts) */
export interface TokenCache {
  value: string
  expiresAt: number  // Unix timestamp ms
}
