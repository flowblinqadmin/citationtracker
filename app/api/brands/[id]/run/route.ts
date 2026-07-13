// "Run now" — the credit-gated trigger for the in-repo tracker worker.
//
// Order matters: create the run row → debit (the unique ledger reference is
// the double-submit gate — the losing duplicate deletes its row) → publish to
// QStash, which calls THIS service's /api/cron/tracker-worker (executing here
// would block for up to 800s; QStash publish returns in <1s). Publish failure
// → run failed + refund.
import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { createManualRunRow, deleteRunRow, markRunFailed } from "@/lib/tracker-db";
import { citationRunCredits, debitForRun, refundForRun } from "@/lib/credits";
import { checkRateLimit } from "@/lib/rate-limit";
import { GEO_ORIGIN } from "@/lib/config";
import { enqueueTrackerJob } from "@/lib/engine/enqueue";
import { runScopeSchema } from "@/app/api/brands/brand-schema";

const RUNS_PER_HOUR = 10; // per team — runs burn paid provider APIs

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });

  // Optional body narrows the run to specific prompts and/or platforms.
  const rawBody = await req.json().catch(() => ({}));
  const parsed = runScopeSchema.safeParse(rawBody ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid run scope" }, { status: 400 });
  }

  const rate = await checkRateLimit(`cite-run:${ctx.teamId}`, RUNS_PER_HOUR, 60 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });
  }

  const created = await createManualRunRow(ctx.teamId, (await params).id, parsed.data);
  if (created.kind === "not_found") return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  if (created.kind === "no_prompts") {
    return NextResponse.json({ error: "Add at least one prompt before running." }, { status: 400 });
  }
  if (created.kind === "invalid_scope") {
    return NextResponse.json({ error: created.message }, { status: 400 });
  }
  if (created.kind === "in_flight") {
    return NextResponse.json({ run: created.run, started: false, alreadyRunning: true });
  }

  const { run, promptCount } = created;
  // Price per prompt PER MODEL from the run's resolved platform scope
  // (createManualRunRow stored scope.platforms only when narrowing; NULL = the
  // full 4-model worklist). Reuse that resolution — never re-derive it.
  const credits = citationRunCredits(promptCount, run.scope?.platforms ?? undefined);
  const debit = await debitForRun(ctx.teamId, run.id, credits);
  if (!debit.applied) {
    await deleteRunRow(run.id);
    if (debit.reason === "insufficient_credits") {
      return NextResponse.json(
        {
          error: "insufficient_credits",
          required: credits,
          balance: debit.balance ?? 0,
          buyCreditsUrl: `${GEO_ORIGIN}/dashboard`,
        },
        { status: 402 },
      );
    }
    return NextResponse.json({ error: "Could not charge credits" }, { status: 500 });
  }

  try {
    await enqueueTrackerJob({ runId: run.id, clientId: run.clientId, cursor: 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markRunFailed(run.id, message);
    await refundForRun(ctx.teamId, run.id, credits);
    return NextResponse.json({ error: "Could not start the run — credits refunded" }, { status: 502 });
  }

  return NextResponse.json(
    { run, started: true, credits, balance: debit.balance },
    { status: 201 },
  );
}
