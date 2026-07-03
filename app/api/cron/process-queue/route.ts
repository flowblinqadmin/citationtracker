import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, consentRecords, teams } from "@/lib/db/schema";
import { and, asc, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { enqueueStage, PipelineStage } from "@/lib/qstash";
import { FREE_MAX_PAGES } from "@/lib/config";
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";
import { assertCronAuth } from "@/lib/cron-auth";

// Safety-net only: detects stale in-progress sites and re-enqueues the correct stage,
// AND restarts eligible pending sites whose initial enqueue never landed.
// With QStash, each stage runs in its own Vercel invocation — no serial processing here.
export const maxDuration = 30;

// Per-tick rescue cap. Both queries are ordered oldest-first (updatedAt ASC) so
// the backlog tail is drained across successive ticks rather than starved by a
// LIFO window. We warn when a tick saturates the cap so a growing backlog is
// visible rather than silently truncated.
const STALE_BATCH_LIMIT = 100;

const IN_PROGRESS_STATUSES = [
  "discovery",
  "crawling",
  "extracting", // ES-053: tree extraction stage
  "researching",
  "analyzing",
  "generating",
  "assembling",
] as const;

type InProgressStatus = (typeof IN_PROGRESS_STATUSES)[number];

// The subset of pipeline stages the safety-net re-enqueues. It deliberately
// excludes the multi-field StagePayload variants (poll-chunk / generate-chunk)
// that no in-progress status maps to, so a re-enqueue payload of the shape
// `{ siteId, domain, stage }` (plus maxPages for discover) stays assignable to
// slot 2's discriminated StagePayload without a cast.
type ReenqueueStage =
  | "discover"
  | "crawl-fanout"
  | "extract-trees"
  | "research"
  | "analyze"
  | "generate-fanout"
  | "assemble";

const STATUS_TO_STAGE: Record<InProgressStatus, ReenqueueStage> = {
  discovery: "discover",
  crawling: "crawl-fanout",
  extracting: "extract-trees", // ES-053: re-enqueue tree extraction
  researching: "research",
  analyzing: "analyze",
  generating: "generate-fanout",
  assembling: "assemble",
};

// Resolve the discover page budget for a re-enqueued / restarted site. Mirrors
// the consent route (and the pending-restart loop below): honor crawlLimit first
// (intake writes crawlLimit:250 for paid audits), else consult the FULL
// subscription allowance — not just creditBalance, since subscription-funded
// sites have creditBalance 0 but a paid monthly page allowance — and fall back
// to FREE_MAX_PAGES so the audit still runs at the free cap rather than not at all.
async function resolveRestartMaxPages(site: {
  teamId: string | null;
  crawlLimit: number | null;
}): Promise<number> {
  if (site.crawlLimit) return site.crawlLimit;
  if (!site.teamId) return FREE_MAX_PAGES;

  const [team] = await db
    .select({
      monthlyPageAllowance: teams.monthlyPageAllowance,
      monthlyPagesUsed: teams.monthlyPagesUsed,
      creditBalance: teams.creditBalance,
      subscriptionTier: teams.subscriptionTier,
      subscriptionStatus: teams.subscriptionStatus,
    })
    .from(teams)
    .where(eq(teams.id, site.teamId));
  if (!team) return FREE_MAX_PAGES;

  const resolved = resolveFirstAuditMaxPages({
    monthlyPageAllowance: team.monthlyPageAllowance,
    monthlyPagesUsed: team.monthlyPagesUsed,
    creditBalance: team.creditBalance,
    subscriptionTier: team.subscriptionTier,
    subscriptionStatus: team.subscriptionStatus,
  });
  // 0 = denied (no allowance, no credits) → keep the free default.
  return resolved.maxPages > 0 ? resolved.maxPages : FREE_MAX_PAGES;
}

export async function GET(req: NextRequest) {
  try {
    // C3: CRON_SECRET presence/length is enforced at module load by
    // lib/cron-auth.ts; this call only verifies the caller-supplied token.
    const denied = assertCronAuth(req);
    if (denied) return denied;

    // Sites stale for >15 min in any in-progress status
    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);

    const staleSites = await db
      .select({
        id: geoSites.id,
        domain: geoSites.domain,
        pipelineStatus: geoSites.pipelineStatus,
        auditMode: geoSites.auditMode,
        teamId: geoSites.teamId,
        crawlLimit: geoSites.crawlLimit,
        // NEW-AI-01: include currentRunNumber so every re-enqueued stage carries
        // a runNumber and is subject to the idempotency guard in POST(). Without
        // it, the guard treats the message as "no idempotency requested" and
        // re-runs analyze/generate-fanout/etc. against stale in-progress rows,
        // potentially resetting generated state or double-firing chunks.
        currentRunNumber: geoSites.currentRunNumber,
      })
      .from(geoSites)
      .where(
        and(
          inArray(geoSites.pipelineStatus, [...IN_PROGRESS_STATUSES]),
          lt(geoSites.updatedAt, staleThreshold),
        )
      )
      .orderBy(asc(geoSites.updatedAt)) // oldest first → backlog tail is rescued
      .limit(STALE_BATCH_LIMIT);

    if (staleSites.length === STALE_BATCH_LIMIT) {
      console.warn(
        `[process-queue] stale in-progress queue saturated the ${STALE_BATCH_LIMIT}-row cap — backlog likely exceeds one tick`
      );
    }

    let requeued = 0;
    let errors = 0;

    for (const site of staleSites) {
      const status = site.pipelineStatus as InProgressStatus;
      const stage = STATUS_TO_STAGE[status];
      if (!stage) continue;

      try {
        // discover REQUIRES a page budget (slot 2's discriminated StagePayload);
        // omitting it previously fell back to a silent 20-page crawl. Every other
        // re-enqueued stage derives its working set from persisted state and
        // carries only the base fields.
        //
        // NEW-AI-01: pass the site's current runNumber on every re-enqueue so the
        // stage handler's idempotency guard (POST() runNumber check) fires. Without
        // it, runNumber is undefined and the guard is bypassed — analyze /
        // generate-fanout can reset state and double-fire chunks on re-entry.
        const runNumber = site.currentRunNumber ?? undefined;
        if (stage === "discover") {
          const maxPages = await resolveRestartMaxPages(site);
          await enqueueStage({ siteId: site.id, domain: site.domain, stage, maxPages, runNumber });
        } else {
          await enqueueStage({ siteId: site.id, domain: site.domain, stage, runNumber });
        }
        requeued++;
        console.warn(
          `[process-queue] Re-enqueued stage=${stage} for stale site ${site.id} (was ${status})`
        );
      } catch (err) {
        console.error(`[process-queue] Failed to re-enqueue site ${site.id}:`, err);
        errors++;
      }
    }

    // Pending sites whose initial discover-enqueue never landed.
    // Eligibility: emailVerified=true (past OTP gate), teamId set (page accounting wired up),
    // a consentRecords row exists for the owner email (TOS/EULA accepted — same gate as
    // app/api/sites/[id]/consent/route.ts:72-86), and stale by the same 15-min threshold.
    // Sites that fail any of these are intentionally parked (awaiting OTP / consent / payment)
    // and must NOT be auto-started.
    const pendingSites = await db
      .selectDistinct({
        id: geoSites.id,
        domain: geoSites.domain,
        teamId: geoSites.teamId,
        crawlLimit: geoSites.crawlLimit,
        // Must be in the SELECT list: Postgres rejects `SELECT DISTINCT ... ORDER BY col`
        // when `col` isn't projected (error 42P10). Omitting this 500'd the cron every
        // tick on prod (PR #192). The loop below ignores this field — it's ORDER BY fodder.
        updatedAt: geoSites.updatedAt,
      })
      .from(geoSites)
      .innerJoin(consentRecords, eq(consentRecords.email, geoSites.ownerEmail))
      .where(
        and(
          eq(geoSites.pipelineStatus, "pending"),
          eq(geoSites.emailVerified, true),
          isNotNull(geoSites.teamId),
          lt(geoSites.updatedAt, staleThreshold),
        )
      )
      .orderBy(asc(geoSites.updatedAt)) // oldest first → backlog tail is rescued
      .limit(STALE_BATCH_LIMIT);

    if (pendingSites.length === STALE_BATCH_LIMIT) {
      console.warn(
        `[process-queue] pending-restart queue saturated the ${STALE_BATCH_LIMIT}-row cap — backlog likely exceeds one tick`
      );
    }

    let restarted = 0;

    for (const site of pendingSites) {
      try {
        // Same budget resolution as the stale-discover re-enqueue above
        // (and consent/route.ts): crawlLimit → full subscription allowance →
        // FREE_MAX_PAGES.
        const maxPages = await resolveRestartMaxPages(site);

        // CAS so two concurrent cron ticks can't double-start the same site.
        const updated = await db
          .update(geoSites)
          .set({
            pipelineStatus: "discovery",
            pipelineError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(geoSites.id, site.id),
              eq(geoSites.pipelineStatus, "pending"),
            )
          )
          .returning({ id: geoSites.id });

        if (updated.length === 0) continue; // another tick won the race

        await enqueueStage({
          siteId: site.id,
          domain: site.domain,
          stage: "discover",
          maxPages,
        });
        restarted++;
        console.warn(
          `[process-queue] Restarted pending site ${site.id} (maxPages=${maxPages})`
        );
      } catch (err) {
        console.error(`[process-queue] Failed to restart pending site ${site.id}:`, err);
        errors++;
      }
    }

    return NextResponse.json({
      checked: staleSites.length + pendingSites.length,
      requeued,
      restarted,
      errors,
    });
  } catch (err) {
    console.error("GET /api/cron/process-queue error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
