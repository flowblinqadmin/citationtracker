import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, teamDomains, creditTransactions } from "@/lib/db/schema";
import { eq, sql, and, gte } from "drizzle-orm";
import { enqueueStage } from "@/lib/qstash";
import { nanoid } from "nanoid";
import { slugify } from "@/lib/utils";
import { PAGES_PER_CREDIT, PAID_MAX_PAGES, FREE_MAX_PAGES, bulkCreditsRequired, effectiveCrawlLimit } from "@/lib/config";
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

// With QStash, regenerate only does DB ops + one QStash publish — 30s is plenty.
export const maxDuration = 30;

// ES-090 §b.2 step 4 CRIT-1 — private patch builder for token rotation.
// Returns a fresh { accessToken, tokenExpiresAt, tokenRotatedAt } tuple.
// Not exported — HP-227 Track B: RM asserts patch shape via dbMock.update
// spy instead of importing this helper, which would leak a test-only
// export into the production bundle.
function buildRegeneratePatch(): {
  accessToken: string;
  tokenExpiresAt: Date;
  tokenRotatedAt: Date;
} {
  const now = new Date();
  return {
    accessToken: nanoid(32),
    tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    tokenRotatedAt: now,
  };
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const token =
      req.headers.get("authorization")?.replace("Bearer ", "") ??
      new URL(req.url).searchParams.get("token");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [site] = await db.select().from(geoSites).where(eq(geoSites.id, id));

    if (!site || site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ES-090 §b.2 CRIT-1: HP-197 — NULL tokenExpiresAt treated as expired.
    if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
      return NextResponse.json(
        { error: "Unauthorized", code: "TOKEN_EXPIRED" },
        { status: 401 },
      );
    }

    // Block if already running or queued
    const running = [
      "queued",
      "discovery",
      "crawling",
      "processing",
      "researching",
      "analyzing",
      "generating",
      "assembling",
    ];
    if (running.includes(site.pipelineStatus ?? "")) {
      return NextResponse.json(
        { error: "Pipeline already running" },
        { status: 409 }
      );
    }

    const now = new Date();

    // ── ES-B9.2 AC-B9.2-1 — bulk-aware regenerate ─────────────────────────
    // For bulk audits, regenerate runs a FULL re-audit using site.bulkUrls
    // (the originally-submitted CSV set). Distinct from /retry-failed which
    // retries only the failed/credit-limited subset; ES-B9 §d.1 matrix.
    // Spawns a new geoSites row + retains parent_site_id reference, charges
    // bulkCreditsRequired against the team, and re-enqueues crawl-fanout
    // (NOT discover — the URL set is already known).
    if (site.auditMode === "bulk") {
      const originalUrlSet = (site.bulkUrls as string[] | null) ?? [];
      if (!Array.isArray(originalUrlSet) || originalUrlSet.length === 0) {
        return NextResponse.json(
          { error: "Original URL list missing — please re-upload via the landing page" },
          { status: 400 },
        );
      }

      if (!site.teamId) {
        return NextResponse.json(
          { error: "Pro account required for bulk regenerate." },
          { status: 402 },
        );
      }

      const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
      if (!team) {
        return NextResponse.json({ error: "Team not found" }, { status: 404 });
      }

      const crawlLimitVal = effectiveCrawlLimit(originalUrlSet.length, team.creditBalance);
      const reservedCredits = bulkCreditsRequired(crawlLimitVal);
      if (crawlLimitVal === 0) {
        return NextResponse.json(
          { error: "Insufficient credits. Please top up before re-running this bulk audit." },
          { status: 402 },
        );
      }

      // ES-B10 AC-B10-2: UPDATE-in-place. Same siteId; bump currentRunNumber;
      // set currentRunKind='regenerate'; rotate access token; stash the prior
      // run's scorecard into previousRunSnapshot for delta UI; reset
      // per-run result fields; preserve baselineScorecard.
      const newAccessToken = nanoid(32);
      const newRunNumber = (site.currentRunNumber ?? 1) + 1;
      const balanceBefore = team.creditBalance;
      const balanceAfter = team.creditBalance - reservedCredits;
      const stashedSnapshot = site.geoScorecard
        ? { geoScorecard: site.geoScorecard, completedAt: site.lastCrawlAt ?? now }
        : (site.previousRunSnapshot ?? null);

      await db.transaction(async (tx) => {
        await tx
          .update(teams)
          .set({ creditBalance: sql`${teams.creditBalance} - ${reservedCredits}` })
          .where(and(eq(teams.id, site.teamId!), gte(teams.creditBalance, reservedCredits)));

        await tx.insert(creditTransactions).values({
          id: nanoid(),
          teamId: site.teamId!,
          siteId: id,
          type: "bulk_crawl_reserve",
          pagesConsumed: crawlLimitVal,
          creditsChanged: -reservedCredits,
          balanceBefore,
          balanceAfter,
          createdAt: now,
        });

        await tx
          .update(geoSites)
          .set({
            accessToken: newAccessToken,
            tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
            tokenRotatedAt: now,
            pipelineStatus: "queued",
            pipelineError: null,
            currentRunNumber: newRunNumber,
            currentRunKind: "regenerate",
            retrySubsetUrls: null,
            previousRunSnapshot: stashedSnapshot as unknown as Record<string, unknown>,
            // Reset run-result fields; preserve baselineScorecard.
            geoScorecard: null,
            crawlData: null,
            researchData: null,
            crawlLimit: crawlLimitVal,
            creditsReserved: reservedCredits,
            updatedAt: now,
          })
          .where(eq(geoSites.id, id));
      });

      console.log(JSON.stringify({
        event: "bulk_regenerate_in_place",
        siteId: id,
        teamId: site.teamId,
        urlCount: originalUrlSet.length,
        crawlLimit: crawlLimitVal,
        reservedCredits,
        runNumber: newRunNumber,
      }));

      try {
        await enqueueStage({ siteId: id, domain: site.domain, stage: "crawl-fanout", runNumber: newRunNumber });
      } catch (enqueueErr) {
        console.error("enqueueStage failed for bulk regenerate:", enqueueErr);
        return NextResponse.json(
          { error: "Failed to start re-audit. Please try again." },
          { status: 503 },
        );
      }

      return NextResponse.json(
        {
          success: true,
          siteId: id,
          accessToken: newAccessToken,
          domain: site.domain,
          urlCount: originalUrlSet.length,
          runNumber: newRunNumber,
          runKind: "regenerate",
        },
        { status: 202 },
      );
    }

    // --- Team path: credit-based ---
    if (site.teamId) {
      const [team] = await db
        .select()
        .from(teams)
        .where(eq(teams.id, site.teamId));

      if (!team) {
        return NextResponse.json({ error: "Team not found" }, { status: 404 });
      }

      // ES-B7: shared resolveFirstAuditMaxPages helper — same calc as the
      // /api/sites first-audit fast-path. Active subscribers w/ subscription
      // headroom can now re-audit on subscription pages even with
      // creditBalance=0; credit-only callers continue to use the
      // creditBalance × PAGES_PER_CREDIT calc capped at PAID_MAX_PAGES.
      const budget = resolveFirstAuditMaxPages({
        monthlyPageAllowance: team.monthlyPageAllowance,
        monthlyPagesUsed: team.monthlyPagesUsed,
        creditBalance: team.creditBalance,
        subscriptionTier: team.subscriptionTier,
        subscriptionStatus: team.subscriptionStatus,
      });
      const maxPages = budget.maxPages;
      const creditsToReserve = budget.creditsToReserve;

      if (budget.denied || maxPages === 0) {
        return NextResponse.json(
          {
            error: "Insufficient credits",
            creditsRequired: 1,
            creditsAvailable: team.creditBalance,
          },
          { status: 402 }
        );
      }

      // Use snapshot balance for ledger display — the SQL expression update
      // below is atomic so the actual deduction is always correct.
      const balanceBefore = team.creditBalance;
      const balanceAfter = team.creditBalance - creditsToReserve;

      // ES-090 §b.2 step 4 CRIT-1: rotate the accessToken on every regenerate —
      // new 32-char nanoid, reset expiry to now+90d, record tokenRotatedAt.
      const rotationPatch = buildRegeneratePatch();

      await db.transaction(async (tx) => {
        await tx
          .update(geoSites)
          .set({
            ...rotationPatch,
            pipelineStatus: "discovery",
            pipelineError: null,
            creditsReserved: creditsToReserve,
            // NEW-P-01: record subscription pages reserved for reconciliation at assemble.
            subscriptionPagesReserved: budget.subscriptionPages > 0 ? budget.subscriptionPages : 0,
            updatedAt: now,
          })
          .where(eq(geoSites.id, id));

        // ES-B7: deduct from subscription quota when budget is sourced
        // from the active subscription's monthly allowance.
        if (budget.source === "subscription" && budget.subscriptionPages > 0) {
          await tx
            .update(teams)
            .set({
              monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${budget.subscriptionPages}`,
              updatedAt: now,
            })
            .where(eq(teams.id, site.teamId!));
        }

        if (creditsToReserve > 0) {
          await tx
            .update(teams)
            .set({
              creditBalance: sql`${teams.creditBalance} - ${creditsToReserve}`,
              updatedAt: now,
            })
            .where(eq(teams.id, site.teamId!));

          await tx.insert(creditTransactions).values({
            id: nanoid(),
            teamId: site.teamId!,
            siteId: id,
            type: "crawl_reserve",
            pagesConsumed: maxPages,
            creditsChanged: -creditsToReserve,
            balanceBefore,
            balanceAfter,
            createdAt: now,
          });
        }
      });

      try {
        await enqueueStage({ siteId: id, domain: site.domain, stage: "discover", maxPages });
      } catch (enqueueErr) {
        console.error("enqueueStage failed, rolling back DB state:", enqueueErr);
        await db.transaction(async (tx) => {
          await tx
            .update(geoSites)
            .set({
              accessToken: site.accessToken,
              tokenExpiresAt: site.tokenExpiresAt,
              tokenRotatedAt: site.tokenRotatedAt,
              pipelineStatus: site.pipelineStatus,
              pipelineError: null,
              creditsReserved: 0,
              // NEW-P-01: clear the reservation on rollback so a fresh attempt starts clean.
              subscriptionPagesReserved: 0,
              updatedAt: now,
            })
            .where(eq(geoSites.id, id));

          // ES-B7: roll back subscription-pages bump on subscription-paid path.
          if (budget.source === "subscription" && budget.subscriptionPages > 0) {
            await tx
              .update(teams)
              .set({
                monthlyPagesUsed: sql`${teams.monthlyPagesUsed} - ${budget.subscriptionPages}`,
                updatedAt: now,
              })
              .where(eq(teams.id, site.teamId!));
          }

          if (creditsToReserve > 0) {
            await tx
              .update(teams)
              .set({
                creditBalance: sql`${teams.creditBalance} + ${creditsToReserve}`,
                updatedAt: now,
              })
              .where(eq(teams.id, site.teamId!));

            await tx.insert(creditTransactions).values({
              id: nanoid(),
              teamId: site.teamId!,
              siteId: id,
              type: "crawl_reserve_reversal",
              pagesConsumed: 0,
              creditsChanged: creditsToReserve,
              balanceBefore: balanceAfter,
              balanceAfter: balanceBefore,
              createdAt: now,
            });
          }
        });

        return NextResponse.json(
          { error: "Failed to start pipeline. Credits have been refunded. Please try again." },
          { status: 503 }
        );
      }

      return NextResponse.json(
        {
          success: true,
          message: "Re-crawl started. Check status at GET /api/sites/" + id,
          accessToken: rotationPatch.accessToken,
          creditsReserved: creditsToReserve,
          maxPages,
          creditsRemaining: balanceAfter,
        },
        { status: 202 }
      );
    }

    // --- Anonymous free path: allow 1 run if not already completed ---
    if (site.pipelineStatus === "complete") {
      return NextResponse.json(
        {
          error:
            "Free audit already complete. Purchase credits to run again.",
          upgradeUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com"}/pricing`,
        },
        { status: 402 }
      );
    }

    // ES-090 §b.2 step 4 CRIT-1: rotate accessToken on free-path regenerate too.
    const freeRotationPatch = buildRegeneratePatch();
    await db
      .update(geoSites)
      .set({
        ...freeRotationPatch,
        pipelineStatus: "discovery",
        pipelineError: null,
        updatedAt: now,
      })
      .where(eq(geoSites.id, id));

    try {
      await enqueueStage({ siteId: id, domain: site.domain, stage: "discover", maxPages: FREE_MAX_PAGES });
    } catch (enqueueErr) {
      console.error("enqueueStage failed (free path), rolling back:", enqueueErr);
      await db
        .update(geoSites)
        .set({
          accessToken: site.accessToken,
          tokenExpiresAt: site.tokenExpiresAt,
          tokenRotatedAt: site.tokenRotatedAt,
          pipelineStatus: site.pipelineStatus,
          pipelineError: null,
          updatedAt: now,
        })
        .where(eq(geoSites.id, id));

      return NextResponse.json(
        { error: "Failed to start pipeline. Please try again." },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        success: true,
        message: "Re-crawl started. Check status at GET /api/sites/" + id,
        accessToken: freeRotationPatch.accessToken,
      },
      { status: 202 }
    );
  } catch (err) {
    console.error("POST /api/sites/[id]/regenerate error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
