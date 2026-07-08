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
// ── Transition ownership (GEO_TRACKER_LIVE) ──────────────────────────────────
// While geo's own tracker cron is still deployed (its :30 tick has NO org
// filter, so it also schedules AND recovers our team_ runs, executing them on
// GEO's provider keys), running scheduling + recovery here too is NOT
// data-idempotent-safe for SPEND: two crons recovering the same stale run to
// two different workers each call every provider before the DB conflict is
// detected — real double-spend. So jobs A + B run ONLY when we explicitly own
// scheduling (GEO_TRACKER_LIVE="false"). Until then geo remains the sole
// scheduler/recoverer (status quo). The retention purge (C) is idempotent and
// always runs. Phase C flips GEO_TRACKER_LIVE=false in the SAME change that
// deletes geo's cron — never a window where both or neither schedule.
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

/** True only once geo's tracker cron is gone (Phase C sets GEO_TRACKER_LIVE=false). */
function ceOwnsScheduling(): boolean {
  return process.env.GEO_TRACKER_LIVE === "false";
}

export async function GET(req: NextRequest) {
  const denied = assertCronAuth(req);
  if (denied) return denied;

  const now = new Date();
  const result = { started: 0, recovered: 0, purgedResponses: 0, errors: [] as string[] };

  // ── C. 12-month response-body retention (global, idempotent — always run) ──
  const retentionCutoff = new Date(now);
  retentionCutoff.setUTCMonth(retentionCutoff.getUTCMonth() - TRACKER_RETENTION_MONTHS);
  result.purgedResponses = await purgeOldResponses(retentionCutoff);

  // Scheduling + recovery belong to geo's still-live cron until Phase C.
  if (!ceOwnsScheduling()) {
    return NextResponse.json({ ...result, scheduling: "geo-owned" });
  }

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

  return NextResponse.json(result);
}
