import { NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { citationRunCredits } from "@/lib/credits";

export async function GET() {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  return NextResponse.json({
    teamId: ctx.teamId,
    teamName: ctx.teamName,
    email: ctx.email, // for the global header (identity from x-user-email); may be null
    creditBalance: ctx.creditBalance,
    creditsPerPrompt: citationRunCredits(1), // full run: 1 prompt × 3 models
  });
}
