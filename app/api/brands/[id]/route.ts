import { NextRequest, NextResponse } from "next/server";
import { getTeamContext } from "@/lib/team";
import { getBrand, updateBrand, deleteBrand } from "@/lib/tracker-db";
import { brandInputSchema } from "../brand-schema";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const brand = await getBrand(ctx.teamId, (await params).id);
  if (!brand) return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  return NextResponse.json({ brand });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const parsed = brandInputSchema.partial().safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const brand = await updateBrand(ctx.teamId, (await params).id, parsed.data);
  if (!brand) return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  return NextResponse.json({ brand });
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const deleted = await deleteBrand(ctx.teamId, (await params).id);
  if (!deleted) return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
