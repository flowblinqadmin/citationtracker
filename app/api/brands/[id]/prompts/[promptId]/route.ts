import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTeamContext } from "@/lib/team";
import { updatePromptText, archivePrompt, MAX_PROMPT_LENGTH } from "@/lib/tracker-db";

const patchSchema = z.object({ text: z.string().min(1).max(MAX_PROMPT_LENGTH) });

type Ctx = { params: Promise<{ id: string; promptId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const { id, promptId } = await params;
  try {
    const updated = await updatePromptText(ctx.teamId, id, promptId, parsed.data.text);
    if (!updated) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
    return NextResponse.json({ version: updated.version });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update prompt";
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const { id, promptId } = await params;
  const archived = await archivePrompt(ctx.teamId, id, promptId);
  if (!archived) return NextResponse.json({ error: "Prompt not found" }, { status: 404 });
  return NextResponse.json({ archived: true });
}
