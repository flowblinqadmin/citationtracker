import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTeamContext } from "@/lib/team";
import { listPrompts, createPrompt, MAX_PROMPT_LENGTH } from "@/lib/tracker-db";

const promptInputSchema = z.object({
  name: z.string().min(1).max(100),
  category: z.enum(["brand", "category", "competitor", "topic", "claim"]),
  text: z.string().min(1).max(MAX_PROMPT_LENGTH),
});

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  return NextResponse.json({ prompts: await listPrompts(ctx.teamId, (await params).id) });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const parsed = promptInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  try {
    const prompt = await createPrompt(ctx.teamId, (await params).id, parsed.data);
    return NextResponse.json({ prompt }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create prompt";
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
