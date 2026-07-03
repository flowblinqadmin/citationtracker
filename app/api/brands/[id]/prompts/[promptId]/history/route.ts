import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { listPromptHistory } from "@/lib/tracker-db";

type Ctx = { params: Promise<{ id: string; promptId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const { id, promptId } = await params;
  return NextResponse.json({ history: await listPromptHistory(ctx.teamId, id, promptId) });
}
