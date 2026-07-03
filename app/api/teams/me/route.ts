import { NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { citationRunCredits } from "@/lib/credits";

export async function GET() {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  return NextResponse.json({
    teamId: ctx.teamId,
    teamName: ctx.teamName,
    creditBalance: ctx.creditBalance,
    creditsPerPrompt: citationRunCredits(1),
  });
}
