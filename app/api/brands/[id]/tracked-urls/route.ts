import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTeamContext } from "@/lib/team";
import {
  listTrackedUrls,
  getTrackedUrlStats,
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
  const urls = await listTrackedUrls(ctx.teamId, clientId);
  // getBrand inside listTrackedUrls returns [] for cross-team/unknown brands, so
  // an empty list is ambiguous. Re-check via stats only when there are URLs; an
  // empty brand simply returns { urls: [] } (the editor renders the empty state).
  const stats = urls.length > 0 ? await getTrackedUrlStats(ctx.teamId, clientId) : {};
  return NextResponse.json({
    urls: urls.map((u) => ({
      ...u,
      stats: stats[u.id] ?? { exactCount: 0, domainCount: 0, platforms: [], lastCitedAt: null },
    })),
  });
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
  const stats = result.urls.length > 0 ? await getTrackedUrlStats(ctx.teamId, clientId) : {};
  return NextResponse.json({
    urls: result.urls.map((u) => ({
      ...u,
      stats: stats[u.id] ?? { exactCount: 0, domainCount: 0, platforms: [], lastCitedAt: null },
    })),
    rejected: result.rejected,
  });
}
