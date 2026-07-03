import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { listBrands, createBrand } from "@/lib/tracker-db";
import { brandInputSchema } from "./brand-schema";

export async function GET() {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  return NextResponse.json({ brands: await listBrands(ctx.teamId) });
}

export async function POST(req: NextRequest) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const parsed = brandInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const brand = await createBrand(ctx.teamId, ctx.teamName, parsed.data);
  return NextResponse.json({ brand }, { status: 201 });
}
