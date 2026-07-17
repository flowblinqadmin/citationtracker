import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { listRunsWithStats } from "@/lib/tracker-db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const runs = await listRunsWithStats(ctx.teamId, (await params).id);
  // Never leak the raw failure text (it can be a full Postgres statement with
  // internal ids/model names). Keep it server-side for debugging and expose
  // only the `failed` status; the client renders a friendly card off that.
  const safeRuns = runs.map(({ error, ...run }) => {
    if (error) console.error(`[runs] run ${run.id} failed:`, error);
    return run;
  });
  return NextResponse.json({ runs: safeRuns });
}
