import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { latestAiSearchForBrand } from "@/lib/tracker-db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  return NextResponse.json({ aiSearch: await latestAiSearchForBrand(ctx.teamId, (await params).id) });
}
