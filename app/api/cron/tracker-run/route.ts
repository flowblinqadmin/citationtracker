// Tracker scheduler — hourly ticker (ported from geo's /api/cron/tracker-run,
// scoped to TEAM orgs). Three jobs:
//   A. New runs    — active team clients whose next_run_at is due → create the
//                    run, advance next_run_at, enqueue our worker. PCG's
//                    clients are NEVER picked up (their prompts would execute
//                    on our provider keys).
//   B. Recovery    — team runs stuck 'running'/'pending' beyond the stale
//                    window (dead worker / failed enqueue) → re-enqueue from
//                    cursor. QStash retries=0, so this is the only retry path.
//   C. Retention   — delete response bodies older than 12 months. GLOBAL by
//                    design: this service owns the shared table's hygiene once
//                    geo's tracker cron is deleted.
//
// Runs at :45 (vercel.json); geo's cron runs at :30 until Phase C removes it.
// The overlap is safe: createScheduledRun is idempotent per (client, period)
// and the runner's donePairs map converges double execution.
//
// Billing: scheduled runs are debited post-hoc by /api/cron/reconcile — this
// route never touches credits.
import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/cron-auth";
import {
  listDueTeamClients,
  advanceClientNextRun,
  listStaleTeamRuns,
  purgeOldResponses,
  markRunCompleteIfPending,
} from "@/lib/tracker-db";
import { createScheduledRun, currentPeriod } from "@/lib/engine/run-create";
import { enqueueTrackerJob } from "@/lib/engine/enqueue";
import { TRACKER_STALE_RUN_HOURS, TRACKER_RETENTION_MONTHS } from "@/lib/config";

export const maxDuration = 60;

const DUE_LIMIT = 5;        // new clients started per tick
const RECOVERY_LIMIT = 5;   // stale runs recovered per tick

export async function GET(req: NextRequest) {
  const denied = assertCronAuth(req);
  if (denied) return denied;

  const now = new Date();
  const result = { started: 0, recovered: 0, purgedResponses: 0, errors: [] as string[] };

  // ── A. New runs for due team clients ─────────────────────────────────────
  const dueClients = await listDueTeamClients(now, DUE_LIMIT);

  for (const client of dueClients) {
    // Advance next_run_at FIRST (by the client's cadence) so a failure does not
    // re-pick the client every tick; stale-run recovery (job B) handles enqueue
    // failures.
    await advanceClientNextRun(client.id, client.runFrequency, now);

    try {
      const { run, promptVersions } = await createScheduledRun(client.id, client.orgId, currentPeriod(now));
      if (promptVersions.length === 0) {
        // Nothing to run this period. createScheduledRun already inserted the
        // row — settle it complete so stale recovery never executes it later
        // (unbilled) and it doesn't block the brand's manual runs.
        await markRunCompleteIfPending(run.id);
        continue;
      }
      if (run.status === "pending" || run.status === "failed") {
        await enqueueTrackerJob({ runId: run.id, clientId: client.id, cursor: run.cursor ?? 0 });
        result.started++;
      }
    } catch (err) {
      result.errors.push(`start ${client.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── B. Recover stale team runs (dead worker / failed enqueue) ────────────
  const staleCutoff = new Date(now.getTime() - TRACKER_STALE_RUN_HOURS * 3_600_000);
  const staleRuns = await listStaleTeamRuns(staleCutoff, RECOVERY_LIMIT);

  for (const run of staleRuns) {
    try {
      await enqueueTrackerJob({ runId: run.id, clientId: run.clientId, cursor: run.cursor ?? 0 });
      result.recovered++;
    } catch (err) {
      result.errors.push(`recover ${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── C. 12-month response-body retention (global) ─────────────────────────
  const retentionCutoff = new Date(now);
  retentionCutoff.setUTCMonth(retentionCutoff.getUTCMonth() - TRACKER_RETENTION_MONTHS);
  result.purgedResponses = await purgeOldResponses(retentionCutoff);

  return NextResponse.json(result);
}
