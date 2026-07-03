// The calculator + credit ledger for citation runs.
//
// Pricing: flat 1 credit per prompt per run (see lib/pricing.ts) — simple,
// predictable, and above worst-case provider cost with margin.
//
// Ledger: every op writes geo's credit_transactions with siteId = runId and a
// citation-specific type. A partial unique index on (site_id, type) for those
// types (this repo's one migration) makes each op exactly-once per run — the
// insert is the idempotency gate, and it shares a transaction with the balance
// update, so a duplicate call rolls back its debit.
import { db } from "@/lib/db";
import { teams, creditTransactions, type CitationLedgerType } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export {
  MODEL_COST_ESTIMATES,
  CITATION_EXEC_MARGIN,
  CREDIT_USD,
  CREDITS_PER_PROMPT,
  citationRunCredits,
} from "@/lib/pricing";

export interface LedgerResult {
  applied: boolean;
  reason?: "already_applied" | "insufficient_credits";
  balance?: number;
}

const UNIQUE_VIOLATION = "23505";

/** Drizzle wraps driver errors — walk the cause chain for the pg error code. */
function isUniqueViolation(err: unknown): boolean {
  for (let e = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: string }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

/**
 * Apply one exactly-once ledger operation for a run: adjust the team balance
 * and append the ledger row in a single transaction. The partial unique index
 * on (site_id, type) rejects duplicates — including concurrent ones, whose
 * balance update rolls back with the failed insert.
 */
async function applyRunLedgerOp(
  teamId: string,
  runId: string,
  delta: number, // negative = debit
  type: CitationLedgerType,
  requireFunds: boolean,
): Promise<LedgerResult> {
  try {
    return await db.transaction(async (tx) => {
      // Fast-path duplicate check so a re-issued op reports already_applied
      // even when the balance guard would also fail. The unique index (not
      // this select) is what makes concurrent duplicates safe.
      const [existing] = await tx
        .select({ id: creditTransactions.id })
        .from(creditTransactions)
        .where(sql`${creditTransactions.siteId} = ${runId} AND ${creditTransactions.type} = ${type}`)
        .limit(1);
      if (existing) {
        return { applied: false, reason: "already_applied" as const };
      }

      const updated = await tx
        .update(teams)
        .set({ creditBalance: sql`${teams.creditBalance} + ${delta}`, updatedAt: new Date() })
        .where(
          requireFunds
            ? sql`${teams.id} = ${teamId} AND ${teams.creditBalance} >= ${-delta}`
            : eq(teams.id, teamId),
        )
        .returning({ balanceAfter: teams.creditBalance });

      if (updated.length === 0) {
        const [team] = await tx
          .select({ balance: teams.creditBalance })
          .from(teams)
          .where(eq(teams.id, teamId));
        return { applied: false, reason: "insufficient_credits" as const, balance: team?.balance };
      }

      const balanceAfter = updated[0].balanceAfter;
      await tx.insert(creditTransactions).values({
        id: `ctx_${nanoid()}`,
        teamId,
        siteId: runId,
        type,
        description: `Citation run ${runId}`,
        creditsChanged: delta,
        balanceBefore: balanceAfter - delta,
        balanceAfter,
      });

      return { applied: true, balance: balanceAfter };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { applied: false, reason: "already_applied" };
    }
    throw err;
  }
}

/**
 * Charge a run. `allowNegative` is for post-hoc reconciliation of scheduled
 * runs geo's cron already executed — the balance may go below zero, which
 * blocks further manual runs until top-up.
 */
export function debitForRun(
  teamId: string,
  runId: string,
  credits: number,
  opts: { allowNegative?: boolean } = {},
): Promise<LedgerResult> {
  return applyRunLedgerOp(teamId, runId, -credits, "citation_run", !opts.allowNegative);
}

/** Refund a failed run — exactly once. */
export function refundForRun(teamId: string, runId: string, credits: number): Promise<LedgerResult> {
  return applyRunLedgerOp(teamId, runId, credits, "citation_run_refund", false);
}

/** Re-charge a refunded run that geo's stale-run recovery revived and completed. */
export function redebitForRun(teamId: string, runId: string, credits: number): Promise<LedgerResult> {
  return applyRunLedgerOp(teamId, runId, -credits, "citation_redebit", false);
}
