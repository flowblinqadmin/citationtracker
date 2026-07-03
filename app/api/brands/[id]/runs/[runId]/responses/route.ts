import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { listRunResponses, getRunTopSources, listRunCitationChecks } from "@/lib/tracker-db";

type Ctx = { params: Promise<{ id: string; runId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const { id, runId } = await params;
  const [responses, topSources, sourceChecks] = await Promise.all([
    listRunResponses(ctx.teamId, id, runId),
    getRunTopSources(ctx.teamId, id, runId),
    listRunCitationChecks(ctx.teamId, id, runId),
  ]);
  return NextResponse.json({ responses, topSources, sourceChecks });
}
