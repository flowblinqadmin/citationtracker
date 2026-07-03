// Billing reconciliation — the guarantee that every run gets billed.
//
// Geo's cron creates + executes scheduled runs without credit knowledge, and
// its stale-run recovery can revive runs we already refunded. Hourly sweep of
// this service's runs (team-orgs only, never PCG's):
//   uncharged & not failed  → post-hoc debit (may go negative — blocks manual runs)
//   charged & failed        → refund
//   refunded & completed    → re-debit (revival)
// Every op is exactly-once via the ledger's unique (site_id, type) reference.
import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/cron-auth";
import { listTeamRuns } from "@/lib/tracker-db";
import { citationRunCredits, debitForRun, refundForRun, redebitForRun } from "@/lib/credits";
import { db } from "@/lib/db";
import { creditTransactions } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const denied = assertCronAuth(req);
  if (denied) return denied;

  const teamRuns = await listTeamRuns();
  if (teamRuns.length === 0) {
    return NextResponse.json({ ok: true, runs: 0, debited: 0, refunded: 0, redebited: 0, skipped: 0 });
  }

  const ledger = await db
    .select({ siteId: creditTransactions.siteId, type: creditTransactions.type, creditsChanged: creditTransactions.creditsChanged })
    .from(creditTransactions)
    .where(inArray(creditTransactions.siteId, teamRuns.map((r) => r.run.id)));
  const byRun = new Map<string, Map<string, number>>();
  for (const row of ledger) {
    if (!row.siteId) continue;
    if (!byRun.has(row.siteId)) byRun.set(row.siteId, new Map());
    byRun.get(row.siteId)!.set(row.type, row.creditsChanged);
  }

  let debited = 0, refunded = 0, redebited = 0, skipped = 0;

  for (const { run, teamId } of teamRuns) {
    const ops = byRun.get(run.id) ?? new Map<string, number>();
    const hasDebit = ops.has("citation_run");
    const hasRefund = ops.has("citation_run_refund");
    const hasRedebit = ops.has("citation_redebit");

    if (!hasDebit && run.status !== "failed") {
      if (!run.promptsTotal) { skipped++; continue; } // can't price without a prompt count
      // Scoped runs bill for their platform subset; malformed scope prices as full.
      const scoped = run.scope?.platforms?.length;
      const credits = citationRunCredits(run.promptsTotal, scoped && scoped <= 3 ? scoped : 3);
      const r = await debitForRun(teamId, run.id, credits, { allowNegative: true });
      if (r.applied) debited++;
      continue;
    }

    if (hasDebit && !hasRefund && run.status === "failed") {
      const credits = -(ops.get("citation_run") ?? 0);
      const r = await refundForRun(teamId, run.id, credits);
      if (r.applied) refunded++;
      continue;
    }

    if (hasRefund && !hasRedebit && run.status === "complete") {
      const credits = ops.get("citation_run_refund") ?? 0;
      const r = await redebitForRun(teamId, run.id, credits);
      if (r.applied) redebited++;
    }
  }

  console.log(`[reconcile] runs=${teamRuns.length} debited=${debited} refunded=${refunded} redebited=${redebited} skipped=${skipped}`);
  return NextResponse.json({ ok: true, runs: teamRuns.length, debited, refunded, redebited, skipped });
}
