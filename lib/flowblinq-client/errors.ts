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
