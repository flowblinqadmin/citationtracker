import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { listRunResponses } from "@/lib/tracker-db";

type Ctx = { params: Promise<{ id: string; runId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const { id, runId } = await params;
  return NextResponse.json({ responses: await listRunResponses(ctx.teamId, id, runId) });
}
