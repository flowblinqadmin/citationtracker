/**
 * ES-B9 §c.3 AC-B9-7 — shared bulk-retry predicate.
 *
 * Both `app/sites/[id]/SitePageClient.tsx` (modern) and
 * `app/sites/[id]/ResultsDashboardLegacy.tsx` (legacy) gate the
 * "Retry failed URLs" affordance on this exact symbol so the two UIs stay
 * in lockstep — a grep guard UT pins both call sites.
 *
 * Returns true iff:
 *   - site.auditMode === 'bulk' (only bulk audits have a retry concept), AND
 *   - the user is not gated out (free tier / token-mismatched share view), AND
 *   - the pipeline is in a terminal state (NOT running), AND
 *   - there is something to retry: failed URLs in crawlData,
 *     credit-limited URLs, OR the parent reached pipelineStatus='failed'
 *     (pre-merge-crawl failure → retry the full originally-submitted set).
 */
export const RUNNING_PIPELINE_STATES: ReadonlySet<string> = new Set([
  "queued",
  "discovery",
  "crawling",
  "processing",
  "researching",
  "analyzing",
  "generating",
  "assembling",
]);

export interface BulkRetrySite {
  auditMode?: string | null;
  pipelineStatus?: string | null;
  failedUrls?: string[] | null;
  creditLimitedUrls?: string[] | null;
}

// ES-B9.2 AC-B9.2-5 — shared bulk-retry POST helper with optional
// optimistic-UI callback. Issues a POST to either /retry-failed or
// /regenerate based on `target` and fires `onSourceRowOptimisticUpdate`
// exactly once on a 2xx (201/202) response, never on a 4xx/5xx.
//
// Centralized here so DomainTableRow's Failed-button + RowActions' Rerun
// Audit icon + SitePageClient's bulk-retry button all share the same
// success-detection + URL-shape contract — preventing future drift like
// the regenerate vs retry-failed routing inconsistency this spec resolves.

export type BulkRetryTarget = "retry-failed" | "regenerate";

export interface BulkRetryRequest {
  siteId: string;
  accessToken: string;
  target: BulkRetryTarget;
  /** Optional URL subset (retry-failed only). Omit for full set. */
  urls?: string[];
  /**
   * Fires exactly once on a successful 2xx response. Callers use this to
   * flip optimistic-UI state (queued + spinner) without waiting for the
   * server-confirmed status to propagate.
   */
  onSourceRowOptimisticUpdate?: () => void;
}

export interface BulkRetryResponse {
  ok: boolean;
  status: number;
  /** New retry-spawned siteId returned by both /retry-failed and the
   *  /regenerate bulk-aware branch — null on non-2xx. */
  newSiteId: string | null;
  newAccessToken: string | null;
  /** Server-supplied error string on non-2xx, when JSON-parseable. */
  error: string | null;
}

export async function postBulkRetry(req: BulkRetryRequest): Promise<BulkRetryResponse> {
  const url =
    req.target === "retry-failed"
      ? `/api/sites/${req.siteId}/retry-failed`
      : `/api/sites/${req.siteId}/regenerate`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${req.accessToken}`,
      },
      body: req.urls ? JSON.stringify({ urls: req.urls }) : "{}",
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
      newSiteId: null,
      newAccessToken: null,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
  let data: { siteId?: string; accessToken?: string; error?: string } = {};
  try {
    data = await res.json();
  } catch {
    // non-JSON body
  }
  // Both /retry-failed (201) and /regenerate bulk-aware (202) are success
  // codes; treat 200 as success too for the single-mode regenerate path.
  const ok = res.ok && (res.status === 201 || res.status === 202 || res.status === 200);
  if (ok && req.onSourceRowOptimisticUpdate) {
    req.onSourceRowOptimisticUpdate();
  }
  return {
    ok,
    status: res.status,
    newSiteId: ok ? data.siteId ?? null : null,
    newAccessToken: ok ? data.accessToken ?? null : null,
    error: ok ? null : data.error ?? `Error ${res.status}`,
  };
}

export function canRetryBulk(site: BulkRetrySite | null | undefined, isGated: boolean): boolean {
  if (!site) return false;
  if (isGated) return false;
  if (site.auditMode !== "bulk") return false;
  if (RUNNING_PIPELINE_STATES.has(site.pipelineStatus ?? "")) return false;
  const failedCount = site.failedUrls?.length ?? 0;
  const creditLimitedCount = site.creditLimitedUrls?.length ?? 0;
  if (failedCount > 0) return true;
  if (creditLimitedCount > 0) return true;
  if (site.pipelineStatus === "failed") return true;
  return false;
}
