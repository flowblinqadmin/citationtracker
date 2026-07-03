// Entitlement / abuse guard for /api/audit/[id]/* commerce-audit routes.
//
// C2 audit fix (2026-05-27): the seven /api/audit/[id]/* POST routes
// checked only `report.email_verified` before triggering Firecrawl + LLM
// work. This helper centralizes the entitlement boundary:
//
//   1. assertAuditAccess(id) — loads the report, enforces email_verified.
//      Cheap (one DB read). Does NOT consume rate-limit budget.
//   2. consumeAuditCostBudget(id, bucket, limit) — per-audit-ID rate limit.
//      Caller invokes this ONLY before doing the expensive Firecrawl/LLM
//      work, AFTER checking any cached-data short-circuit.
//
// Why split: the previous combined helper charged the rate-limit counter
// on every call, including cached-response polls. A paying customer
// refreshing their report 5× within an hour would 429 themselves.
// (Adversarial review caught this 2026-05-27.)
//
// Callers MUST use both helpers before invoking any billable service in
// lib/services/commerce/*.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditReports, type AuditReport } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/rate-limit";

// Per-audit-ID limit. 5 expensive operations / hour / audit_id matches the
// natural cadence of a customer reviewing their report: one initial trigger
// + a few retries, never thousands.
//
// Use a tighter limit (sov-query, etc.) at the call site if needed.
const DEFAULT_RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export type AccessGrant = { ok: true; report: AuditReport };
export type AccessDenied = { ok: false; response: NextResponse };
export type AccessResult = AccessGrant | AccessDenied;

/**
 * Loads the audit report and enforces email_verified. Cheap; does NOT
 * consume the per-audit cost budget. Call this first on every audit route,
 * then check any cached-data short-circuit, then call consumeAuditCostBudget
 * only when about to do real work.
 */
export async function assertAuditAccess(id: string): Promise<AccessResult> {
  const [report] = await db
    .select()
    .from(auditReports)
    .where(eq(auditReports.id, id))
    .limit(1);

  if (!report) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Audit not found" }, { status: 404 }),
    };
  }

  if (!report.email_verified) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Email not verified" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, report };
}

/**
 * Per-audit-ID rate limit. Caps the cost of any single leaked audit_id.
 * Call AFTER cached-data short-circuits and only when real work will run.
 * Returns null on success, or a 429 NextResponse to forward.
 *
 * @param bucket per-route bucket suffix so a noisy intelligence call
 *               doesn't lock out sov-query
 * @param limit  per-window cap; override for high-frequency routes like
 *               sov-query (one LLM call per query, called many times → 60/hr)
 */
export async function consumeAuditCostBudget(
  id: string,
  bucket: string = "default",
  limit: number = DEFAULT_RATE_LIMIT,
): Promise<NextResponse | null> {
  const rl = await checkRateLimit(
    `audit-cost:${id}:${bucket}`,
    limit,
    RATE_WINDOW_MS,
  );
  if (!rl.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((rl.resetAt - Date.now()) / 1000));
    return NextResponse.json(
      { error: "Too Many Requests" },
      { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
    );
  }
  return null;
}

// ── Back-compat shim ───────────────────────────────────────────────────────
//
// Old name preserved for any caller that doesn't need the cache short-circuit.
// The semantics are identical to assertAuditAccess + consumeAuditCostBudget
// fused, which is what the old helper did. New code should prefer the split
// primitives so cached responses don't consume the budget.

export interface EntitlementOptions {
  bucket?: string;
  limit?: number;
}

export type EntitlementGrant = { ok: true; report: AuditReport };
export type EntitlementDenied = { ok: false; response: NextResponse };
export type EntitlementResult = EntitlementGrant | EntitlementDenied;

export async function assertAuditEntitlement(
  id: string,
  opts: EntitlementOptions = {},
): Promise<EntitlementResult> {
  const access = await assertAuditAccess(id);
  if (!access.ok) return access;
  const limited = await consumeAuditCostBudget(id, opts.bucket, opts.limit);
  if (limited) return { ok: false, response: limited };
  return { ok: true, report: access.report };
}
