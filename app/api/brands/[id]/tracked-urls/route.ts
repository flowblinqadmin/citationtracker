import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getTeamContext } from "@/lib/team";
import {
  listTrackedUrlsWithStats,
  replaceTrackedUrls,
  trackedUrlStatsFor,
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

/** Postgres error code, wherever the postgres.js driver nests it on the thrown error. */
function pgCode(err: unknown): string | undefined {
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; cause?: { code?: unknown } };
    if (typeof e.code === "string") return e.code;
    if (e.cause && typeof e.cause === "object" && typeof e.cause.code === "string") return e.cause.code;
  }
  return undefined;
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

  try {
    // Single source of truth: the write echoes exactly what IT committed (read
    // inside its own tx), so no separate re-read can substitute a racing request's
    // state into the response.
    const result = await replaceTrackedUrls(ctx.teamId, clientId, parsed.data.urls);
    if (!result) return NextResponse.json({ error: "Brand not found" }, { status: 404 });

    // Attach live citation stats to THE list we just wrote. This read is
    // post-commit and purely decorative: if it fails, the save already stuck, so
    // never 500 it — return zeroed stats and let the next GET heal the numbers.
    let statsById: Record<string, Awaited<ReturnType<typeof trackedUrlStatsFor>>[string]> = {};
    try {
      statsById = await trackedUrlStatsFor(clientId, result.urls);
    } catch (statsErr) {
      console.error("tracked-urls PUT: stats read failed (save committed)", statsErr);
    }
    const urls = result.urls.map((u) => ({
      ...u,
      stats: statsById[u.id] ?? { exactCount: 0, domainCount: 0, platforms: [], lastCitedAt: null },
    }));
    return NextResponse.json({ urls, rejected: result.rejected });
  } catch (err) {
    const code = pgCode(err);
    // A concurrent overlapping save that raced past serialization (belt-and-
    // suspenders — the FOR UPDATE lock normally prevents this): ask for a retry.
    if (code === "23505") {
      return NextResponse.json({ error: "Save conflicted with another update — please retry" }, { status: 409 });
    }
    // FK violation — the brand was deleted out from under the save.
    if (code === "23503") {
      return NextResponse.json({ error: "Brand not found" }, { status: 404 });
    }
    // The 50-URL cap check throws a plain Error — surface its message as a 400.
    if (err instanceof Error && err.message.includes(String(MAX_TRACKED_URLS))) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("tracked-urls PUT failed", err);
    return NextResponse.json({ error: "Could not save tracked URLs" }, { status: 500 });
  }
}
