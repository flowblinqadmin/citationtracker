import { NextRequest, NextResponse } from "next/server";
import { runPipelineHealthChecks } from "@/lib/services/pipeline-health";
import { assertCronAuth } from "@/lib/cron-auth";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // C3: see lib/cron-auth.ts — module-load assertion + constant-time compare.
  const denied = assertCronAuth(req);
  if (denied) return denied;

  try {
    const result = await runPipelineHealthChecks();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[cron/pipeline-health] failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
