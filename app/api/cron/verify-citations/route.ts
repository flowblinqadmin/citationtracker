// Hourly hallucination guard — fetch + classify every cited URL.
//
// AI platforms cite pages that are dead or never mention the brand. This
// sweep takes unchecked team-org citations (never PCG's), fetches each URL
// through the SSRF-guarded verifier, and records a permanent verdict the UI
// badges/filters by. Bounded batch per pass; verdicts are exactly-once
// (first insert wins), so re-sweeps are no-ops.
import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/cron-auth";
import { listUncheckedTeamCitations, recordCitationChecks, type CitationCheckInput } from "@/lib/tracker-db";
import { verifyCitationUrl } from "@/lib/citation-verify";

export const maxDuration = 300;

const BATCH = 15; // crawler escalations can take ~40s each — stay inside maxDuration
const CONCURRENCY = 5;

export async function GET(req: NextRequest) {
  const denied = assertCronAuth(req);
  if (denied) return denied;

  const unchecked = await listUncheckedTeamCitations(BATCH);
  const checks: CitationCheckInput[] = [];

  for (let i = 0; i < unchecked.length; i += CONCURRENCY) {
    const slice = unchecked.slice(i, i + CONCURRENCY);
    const verdicts = await Promise.all(slice.map((c) => verifyCitationUrl(c.url, c.keywords)));
    slice.forEach((c, j) => {
      checks.push({
        citationId: c.citationId,
        runId: c.runId,
        clientId: c.clientId,
        url: c.url,
        status: verdicts[j].status,
        httpStatus: verdicts[j].httpStatus,
        brandMatched: verdicts[j].brandMatched,
        via: verdicts[j].via,
      });
    });
  }

  await recordCitationChecks(checks);

  const tally = checks.reduce<Record<string, number>>((acc, c) => {
    acc[c.status] = (acc[c.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[verify-citations] checked=${checks.length} ${JSON.stringify(tally)}`);
  return NextResponse.json({ ok: true, checked: checks.length, remaining: unchecked.length === BATCH, ...tally });
}
