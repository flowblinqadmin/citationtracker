// Hourly AI Search sweep — Google AI Overview visibility per prompt.
//
// Chat APIs can't see the AI-search surface. Each active team-org prompt is
// run as a Google query through Firecrawl (renders the SERP); the AI Overview
// block is parsed for presence, brand mention, and cited sources. Prompts are
// re-checked daily; failed scrapes record nothing and retry next pass.
import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/cron-auth";
import { listStaleAiSearchPrompts, recordAiSearchSnapshots, type AiSearchSnapshotInput } from "@/lib/tracker-db";
import { checkAiSearch } from "@/lib/ai-search";

export const maxDuration = 300;

const BATCH = 6; // SERP scrapes take ~10-40s each
const CONCURRENCY = 3;

export async function GET(req: NextRequest) {
  const denied = assertCronAuth(req);
  if (denied) return denied;

  const stale = await listStaleAiSearchPrompts(BATCH);
  const snaps: AiSearchSnapshotInput[] = [];
  let failed = 0;

  for (let i = 0; i < stale.length; i += CONCURRENCY) {
    const slice = stale.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((p) => checkAiSearch(p.query, p.keywords)));
    slice.forEach((p, j) => {
      const r = results[j];
      if (r === null) {
        failed++;
        return;
      }
      snaps.push({
        promptId: p.promptId,
        clientId: p.clientId,
        query: p.query,
        present: r.present,
        brandMentioned: r.brandMentioned,
        overviewText: r.text,
        citedUrls: r.citations,
      });
    });
  }

  await recordAiSearchSnapshots(snaps);
  console.log(`[ai-search] checked=${snaps.length} failed=${failed} remaining=${stale.length === BATCH}`);
  return NextResponse.json({ ok: true, checked: snaps.length, failed, remaining: stale.length === BATCH });
}
