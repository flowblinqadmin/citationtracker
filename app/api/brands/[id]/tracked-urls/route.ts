import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTeamContext } from "@/lib/team";
import {
  listTrackedUrlsWithStats,
  replaceTrackedUrls,
  MAX_TRACKED_URLS,
} from "@/lib/tracker-db";

type Ctx = { params: Promise<{ id: string }> };

// Each entry is a raw URL string the user typed — normalized (and validated)
// server-side by tracker-db. Cap matches MAX_TRACKED_URLS; per-entry length is
// bounded so a pathological input can't blow up the normalizer.
const putSchema = z.object({
  urls: z.array(z.string().max(2048)).max(MAX_TRACKED_URLS),
});

/** Tracked URLs joined with their live citation stats. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const clientId = (await params).id;
  // One list fetch + stats in a single call (listTrackedUrls returns [] for
  // cross-team/unknown brands, so a foreign brand simply yields { urls: [] } and
  // the editor renders the empty state).
  const urls = await listTrackedUrlsWithStats(ctx.teamId, clientId);
  return NextResponse.json({ urls });
}

/** Full-replace the brand's tracked URLs. Returns the new list + rejected inputs. */
export async function PUT(req: NextRequest, { params }: Ctx) {
  const ctx = await getTeamContext();
  if (!ctx) return NextResponse.json({ error: "No team for this user" }, { status: 401 });
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const clientId = (await params).id;
  const result = await replaceTrackedUrls(ctx.teamId, clientId, parsed.data.urls);
  if (!result) return NextResponse.json({ error: "Brand not found" }, { status: 404 });
  // Re-list with stats in one call so the saved URLs come back with their live
  // citation numbers (single list fetch + stats, not list-then-separate-stats).
  const urls = await listTrackedUrlsWithStats(ctx.teamId, clientId);
  return NextResponse.json({ urls, rejected: result.rejected });
}
