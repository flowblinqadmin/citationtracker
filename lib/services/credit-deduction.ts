import { db } from "@/lib/db";
import { teams, creditTransactions } from "@/lib/db/schema";
import { eq, sql, gte, and } from "drizzle-orm";
import { nanoid } from "nanoid";

/**
 * Deduct credits from a team's balance and record a ledger entry.
 * Returns { success, balanceAfter } or { success: false, error }.
 *
 * Uses an atomic SQL expression to prevent race conditions:
 *   UPDATE teams SET credit_balance = credit_balance - cost WHERE credit_balance >= cost
 */
export async function deductCredits(opts: {
  teamId: string;
  cost: number;
  type: string;      // ledger transaction type, e.g. "citation_check", "competitor_discovery"
  description: string;
  siteId?: string;
}): Promise<{ success: true; balanceBefore: number; balanceAfter: number } | { success: false; error: string }> {
  const { teamId, cost, type, description, siteId } = opts;

  if (cost <= 0) return { success: true, balanceBefore: 0, balanceAfter: 0 };

  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) return { success: false, error: "Team not found" };
  if (team.creditBalance < cost) return { success: false, error: "insufficient_credits" };

  const balanceBefore = team.creditBalance;
  const balanceAfter = team.creditBalance - cost;

  // FIND-025: guarded balance UPDATE + ledger INSERT now run in one
  // transaction, so a crash between them can't leave the balance debited with
  // no ledger row (or vice versa). The `description` column exists (see
  // 20260609-credit-tx-description.sql) and is persisted directly.
  //
  // Atomic deduction — only succeeds if balance still sufficient. The
  // .returning() clause is the TOCTOU guard: under concurrent requests
  // (e.g. user double-clicks Apply), the read at line 24 sees a stale
  // balance, both threads pass the < cost check, then both UPDATEs fire.
  // The WHERE gte makes only one UPDATE actually change the row — the
  // other gets 0 rows back. The loser inserts no ledger row (we return a
  // failure flag from inside the tx and branch after it commits).
  const outcome = await db.transaction(async (tx) => {
    const updated = await tx.update(teams)
      .set({ creditBalance: sql`${teams.creditBalance} - ${cost}` })
      .where(and(eq(teams.id, teamId), gte(teams.creditBalance, cost)))
      .returning({ id: teams.id });

    if (updated.length === 0) {
      // Concurrent deduction won the race; this attempt is rejected. No
      // ledger row is written.
      return { ok: false } as const;
    }

    await tx.insert(creditTransactions).values({
      id: nanoid(),
      teamId,
      creditsChanged: -cost,
      balanceBefore,
      balanceAfter,
      type,
      description,
      ...(siteId ? { siteId } : {}),
      createdAt: new Date(),
    });

    return { ok: true } as const;
  });

  if (!outcome.ok) {
    return { success: false, error: "insufficient_credits" };
  }

  return { success: true, balanceBefore, balanceAfter };
}
