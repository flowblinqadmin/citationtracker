import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, teamDomains, creditTransactions } from "@/lib/db/schema";
import { eq, sql, gte, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { slugify } from "@/lib/utils";
import { enqueueStage } from "@/lib/qstash";
import { effectiveCrawlLimit, bulkCreditsRequired, activeSubscriptionRemaining } from "@/lib/config";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";

// Private/internal IP ranges — SSRF protection (mirrors app/api/sites/route.ts)
const PRIVATE_RANGES = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[::ffff:/i,
  /^\[f[cd]/i,
  /^\[fe80/i,
];

// Only DB ops + one QStash publish — 30s is plenty
export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/sites/[id]/retry-failed
 *
 * Retries URLs that failed (were blocked or unreachable) in a previous bulk audit.
 * Creates a new bulk audit record for the given URLs, charges credits, and starts the pipeline.
 *
 * Body: { urls?: string[] }
 *   - Omit `urls` to retry ALL failed URLs from the original audit.
 *   - Provide a subset of URLs to retry only those.
 *
 * Auth: Bearer <accessToken> or ?token=<accessToken>
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const token =
      req.headers.get("authorization")?.replace("Bearer ", "") ??
      req.nextUrl.searchParams.get("token");

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [site] = await db.select().from(geoSites).where(eq(geoSites.id, id));

    if (!site || site.accessToken !== token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (site.auditMode !== "bulk") {
      return NextResponse.json({ error: "Retry only available for bulk audits." }, { status: 400 });
    }

    if (!site.teamId) {
      return NextResponse.json({ error: "Credits required for bulk retry." }, { status: 402 });
    }

    // ES-B9 AC-B9-3: running-state guard mirrors regenerate/route.ts:71-79.
    // Don't accept a retry while the parent's pipeline is still in flight —
    // the user's intent ("retry the failed half") only makes sense after the
    // pipeline reaches a terminal state.
    const RUNNING_STATES = new Set([
      "queued",
      "discovery",
      "crawling",
      "processing",
      "researching",
      "analyzing",
      "generating",
      "assembling",
    ]);
    if (RUNNING_STATES.has(site.pipelineStatus ?? "")) {
      return NextResponse.json({ error: "Pipeline already running" }, { status: 409 });
    }

    // ES-B9 AC-B9-1: state-machine expansion. Candidate URL precedence:
    //   1. Explicit body.urls (caller-supplied subset — overrides regardless of state).
    //   2. crawlData.failedUrls (post-merge-crawl partial / complete with failures).
    //   3. site.bulkUrls — originally-submitted CSV set (status='failed' no
    //      merge-crawl: pipeline failed before failedUrls was populated).
    const crawlDataRaw = site.crawlData as { failedUrls?: string[] } | null;
    const failedFromCrawl = crawlDataRaw?.failedUrls ?? [];
    const originalUrlSet = (site.bulkUrls as string[] | null) ?? [];

    let body: { urls?: string[] } = {};
    try {
      body = (await req.json()) as { urls?: string[] };
    } catch {
      // empty body is fine
    }

    let candidateUrls: string[];
    if (Array.isArray(body.urls) && body.urls.length > 0) {
      candidateUrls = body.urls.filter((u) => typeof u === "string" && u.startsWith("http"));
    } else if (failedFromCrawl.length > 0) {
      candidateUrls = failedFromCrawl;
    } else if (site.pipelineStatus === "failed" && originalUrlSet.length > 0) {
      // ES-B9 AC-B9-1 fallback: pre-merge-crawl failure → retry the full
      // originally-submitted CSV (the bulk audit never produced a
      // failedUrls list to subtract from).
      candidateUrls = originalUrlSet;
    } else {
      candidateUrls = [];
    }

    // SSRF validation — reject any URL pointing at a private/internal host
    const ssrfBlocked: string[] = [];
    const urlsToRetry: string[] = [];
    for (const u of candidateUrls) {
      let hostname: string;
      try {
        hostname = new URL(u).hostname;
      } catch {
        ssrfBlocked.push(u);
        continue;
      }
      if (PRIVATE_RANGES.some((r) => r.test(hostname))) {
        ssrfBlocked.push(u);
      } else {
        urlsToRetry.push(u);
      }
    }

    if (ssrfBlocked.length > 0) {
      return NextResponse.json(
        { error: `${ssrfBlocked.length} invalid URL(s) rejected. All URLs must be valid public HTTP/HTTPS addresses.` },
        { status: 400 }
      );
    }

    if (urlsToRetry.length === 0) {
      return NextResponse.json({ error: "No failed URLs to retry." }, { status: 400 });
    }

    // ES-B9 §credit AC-B9-10 — γ free-retry policy (Aditya-ratified at
    // f9b387cc).
    //
    // When the parent site reached pipelineStatus='failed' (pre-merge-crawl
    // failure: pipeline died before a successful crawl was produced), the
    // user is NOT charged for the retry — we own the failure. A
    // 'bulk_retry_failed_free' ledger row is still written for audit trail,
    // with creditsChanged=0 and parentSiteId pointing back at the failed
    // origin. crawlLimit is the URL count (no balance gating).
    //
    // For pipelineStatus='complete' with crawlData.failedUrls (post-merge-
    // crawl partial), the existing α (re-charge) semantics stand: deduct
    // bulkCreditsRequired credits, write a 'bulk_crawl_reserve' ledger
    // row. The user paid for and received a partial crawl; they pay again
    // to retry the failed subset.
    const isFreeRetry = site.pipelineStatus === "failed";

    // Credit check
    const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
    if (!team) {
      return NextResponse.json({ error: "Team not found." }, { status: 404 });
    }

    // Bulk re-audit budget. Active subscribers fund pages from their remaining
    // monthly allowance first (credits top up beyond that); without this a Pro
    // subscriber with creditBalance=0 was silently capped at BULK_FREE_PAGES=10
    // (BUG-001 / FIND-SILENTFAILURE-012).
    const subscriptionState = {
      monthlyPageAllowance: team.monthlyPageAllowance,
      monthlyPagesUsed: team.monthlyPagesUsed,
      subscriptionTier: team.subscriptionTier,
      subscriptionStatus: team.subscriptionStatus,
    };

    const crawlLimitVal = isFreeRetry
      ? urlsToRetry.length
      : effectiveCrawlLimit(urlsToRetry.length, team.creditBalance, subscriptionState);

    // Decompose the budget: subscription-funded pages meter monthlyPagesUsed and
    // only the credit-funded remainder is charged in credits (mirrors the
    // subscription-vs-credit accounting in regenerate/route.ts). For a free
    // retry or a non-subscriber both reduce to the legacy credit-only path.
    const subscriptionPagesUsed = isFreeRetry
      ? 0
      : Math.min(crawlLimitVal, activeSubscriptionRemaining(subscriptionState));
    const creditFundedPages = crawlLimitVal - subscriptionPagesUsed;
    const reservedCredits = isFreeRetry ? 0 : bulkCreditsRequired(creditFundedPages);

    if (crawlLimitVal === 0) {
      return NextResponse.json(
        { error: "Insufficient credits. Please top up before retrying." },
        { status: 402 }
      );
    }

    // ES-B10 AC-B10-3: UPDATE-in-place. Same siteId; bump currentRunNumber;
    // currentRunKind='retry-failed'; retrySubsetUrls = urlsToRetry; rotate
    // access token; stash prior scorecard into previousRunSnapshot.
    const domain = site.domain;
    const now = new Date();
    const newAccessToken = nanoid(32);
    const newRunNumber = (site.currentRunNumber ?? 1) + 1;
    const balanceBefore = team.creditBalance;
    const balanceAfter = team.creditBalance - reservedCredits;
    // B10.1: stash prior crawlData (pages, failedUrls, creditLimitedUrls) so
    // handleMergeCrawl can MERGE retry results back into the parent set
    // instead of replacing it. Without this, the retry-failed run loses every
    // page that was successful in the prior run.
    const stashedSnapshot = site.geoScorecard
      ? {
          geoScorecard: site.geoScorecard,
          crawlData: site.crawlData,
          completedAt: site.lastCrawlAt ?? now,
        }
      : (site.previousRunSnapshot ?? null);

    await db.transaction(async (tx) => {
      if (isFreeRetry) {
        // γ free-retry: no balance mutation. Ledger row carries
        // creditsChanged=0 + parent_site_id for audit-trail provenance.
        await tx.insert(creditTransactions).values({
          id: nanoid(),
          teamId: site.teamId!,
          siteId: id,
          parentSiteId: id,
          type: "bulk_retry_failed_free",
          pagesConsumed: crawlLimitVal,
          creditsChanged: 0,
          balanceBefore,
          balanceAfter: balanceBefore,
          createdAt: now,
        });
      } else {
        // Meter subscription-funded pages against the monthly allowance.
        if (subscriptionPagesUsed > 0) {
          await tx.update(teams)
            .set({
              monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${subscriptionPagesUsed}`,
              updatedAt: now,
            })
            .where(eq(teams.id, site.teamId!));
        }

        // Charge credits only for the credit-funded remainder (0 when the
        // re-audit is fully covered by the subscription allowance).
        if (reservedCredits > 0) {
          await tx.update(teams)
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
        }
      }

      await tx
        .update(geoSites)
        .set({
          accessToken: newAccessToken,
          tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
          tokenRotatedAt: now,
          pipelineStatus: "queued",
          pipelineError: null,
          currentRunNumber: newRunNumber,
          currentRunKind: "retry-failed",
          retrySubsetUrls: urlsToRetry as unknown as Record<string, unknown>,
          previousRunSnapshot: stashedSnapshot as unknown as Record<string, unknown>,
          // Reset run-result fields. baselineScorecard preserved.
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
      event: "bulk_retry_in_place",
      siteId: id,
      teamId: site.teamId,
      urlCount: urlsToRetry.length,
      crawlLimit: crawlLimitVal,
      reservedCredits,
      runNumber: newRunNumber,
    }));

    await enqueueStage({ siteId: id, domain, stage: "crawl-fanout", runNumber: newRunNumber });

    return NextResponse.json(
      { success: true, siteId: id, accessToken: newAccessToken, domain, urlCount: urlsToRetry.length, runNumber: newRunNumber, runKind: "retry-failed" },
      { status: 202 }
    );
  } catch (err) {
    console.error("POST /api/sites/[id]/retry-failed error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
