// "Run now" — the credit-gated trigger for geo's tracker worker.
//
// Order matters: create the run row → debit (the unique ledger reference is
// the double-submit gate — the losing duplicate deletes its row) → publish to
// QStash, which calls geo's deployed /api/tracker/worker (executing here would
// block for up to 800s; QStash publish returns in <1s, exactly geo's own
// pattern). Publish failure → run failed + refund.
import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { createManualRunRow, deleteRunRow, markRunFailed } from "@/lib/tracker-db";
import { citationRunCredits, debitForRun, refundForRun } from "@/lib/credits";
import { checkRateLimit } from "@/lib/rate-limit";
import { getCronSecret } from "@/lib/cron-auth";
import { GEO_ORIGIN } from "@/lib/config";

const RUNS_PER_HOUR = 10; // per team — runs burn paid provider APIs on geo's keys

type Ctx = { params: Promise<{ id: string }> };

async function enqueueWorker(runId: string, clientId: string): Promise<void> {
  const workerUrl = `${GEO_ORIGIN}/api/tracker/worker`;
  const body = JSON.stringify({ runId, clientId, cursor: 0 });
  const qstashToken = process.env.QSTASH_TOKEN;

  if (qstashToken) {
    // QStash accounts are regional — QSTASH_URL (same var geo's SDK reads)
    // must point at the account's endpoint or publishes 404.
    const qstashBase = process.env.QSTASH_URL ?? "https://qstash.upstash.io";
    const res = await fetch(`${qstashBase}/v2/publish/${workerUrl}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        "Content-Type": "application/json",
        "Upstash-Retries": "0", // geo's cron is the retry path (its convention)
      },
      body,
    });
    if (!res.ok) throw new Error(`QStash publish failed: ${res.status}`);
    return;
  }

  // Local dev fallback: call the worker directly, fire-and-forget (it can run
  // for minutes; geo's LOCAL_PIPELINE does the same).
  void fetch(workerUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${getCronSecret()}`, "Content-Type": "application/json" },
    body,
  }).catch((err) => console.error(`[run] direct worker call failed for ${runId}:`, err));
}

export async function POST(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });

  const rate = await checkRateLimit(`cite-run:${ctx.teamId}`, RUNS_PER_HOUR, 60 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded — try again later" }, { status: 429 });
  }

  const created = await createManualRunRow(ctx.teamId, (await params).id);
  if (created.kind === "not_found") return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  if (created.kind === "no_prompts") {
    return NextResponse.json({ error: "Add at least one prompt before running." }, { status: 400 });
  }
  if (created.kind === "in_flight") {
    return NextResponse.json({ run: created.run, started: false, alreadyRunning: true });
  }

  const { run, promptCount } = created;
  const credits = citationRunCredits(promptCount);
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
    await enqueueWorker(run.id, run.clientId);
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
