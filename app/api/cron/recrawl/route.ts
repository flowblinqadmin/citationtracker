import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, creditTransactions } from "@/lib/db/schema";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { enqueueStage } from "@/lib/qstash";
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";
import {
  SUBSCRIPTION_TIERS,
  CRAWL_FREQUENCIES,
  clampFrequencyToTier,
  type SubscriptionTier,
  type CrawlFrequency,
} from "@/lib/config";
import { sendLowCreditsEmail } from "@/lib/email";
import { assertCronAuth } from "@/lib/cron-auth";

export const maxDuration = 60;

/** Narrow an untrusted DB string to the CrawlFrequency union. */
function isCrawlFrequency(value: string): value is CrawlFrequency {
  return (CRAWL_FREQUENCIES as readonly string[]).includes(value);
}

/** Compute next crawl timestamp based on frequency */
function computeNextCrawlAt(frequency: CrawlFrequency, from: Date = new Date()): Date {
  const next = new Date(from);
  switch (frequency) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setDate(next.getDate() + 30);
      break;
    case "manual":
      next.setFullYear(next.getFullYear() + 100); // effectively never
      break;
  }
  return next;
}

export async function GET(req: NextRequest) {
  try {
    // C3: see lib/cron-auth.ts — module-load assertion + constant-time compare.
    const denied = assertCronAuth(req);
    if (denied) return denied;

    const now = new Date();

    // Query sites due for recrawl that have a non-manual frequency and a team
    const sitesWithTeams = await db
      .select({
        siteId: geoSites.id,
        domain: geoSites.domain,
        ownerEmail: geoSites.ownerEmail,
        crawlFrequency: geoSites.crawlFrequency,
        teamId: geoSites.teamId,
        // Team subscription fields
        subscriptionTier: teams.subscriptionTier,
        subscriptionStatus: teams.subscriptionStatus,
        monthlyPageAllowance: teams.monthlyPageAllowance,
        monthlyPagesUsed: teams.monthlyPagesUsed,
        creditBalance: teams.creditBalance,
      })
      .from(geoSites)
      .innerJoin(teams, eq(geoSites.teamId, teams.id))
      .where(
        and(
          eq(geoSites.pipelineStatus, "complete"),
          ne(geoSites.crawlFrequency, "manual"),
          lt(geoSites.nextCrawlAt, now)
        )
      )
      .limit(10);

    if (sitesWithTeams.length === 0) {
      return NextResponse.json({ processed: 0, message: "No sites due for recrawl" });
    }

    let processed = 0;
    let errors = 0;
    const skipped: string[] = [];

    for (const row of sitesWithTeams) {
      // Check subscription is active
      if (row.subscriptionStatus !== "active") {
        skipped.push(`${row.domain}: subscription not active (${row.subscriptionStatus})`);
        continue;
      }

      // Determine tier config
      const tier = row.subscriptionTier as SubscriptionTier;
      const tierConfig = SUBSCRIPTION_TIERS[tier];
      if (!tierConfig) {
        skipped.push(`${row.domain}: unknown tier "${tier}"`);
        continue;
      }

      // Validate the stored frequency against the union before using it as a
      // ranking key — a corrupt/legacy DB value must not silently bypass the
      // per-tier ceiling (which would burn a recrawl). Mirror the unknown-tier
      // guard above: park the site and skip.
      if (!isCrawlFrequency(row.crawlFrequency)) {
        skipped.push(`${row.domain}: unknown crawlFrequency "${row.crawlFrequency}"`);
        await db.update(geoSites)
          .set({ nextCrawlAt: computeNextCrawlAt("manual", now), updatedAt: now })
          .where(eq(geoSites.id, row.siteId));
        continue;
      }

      // Per-tier frequency ceiling: a site must not recrawl more often than the
      // plan allows. Clamp the site's cadence down to the tier maximum. We do NOT
      // mutate the stored crawlFrequency so the original preference is restored
      // automatically if the team later upgrades to a tier that permits it.
      const effectiveFreq = clampFrequencyToTier(tier, row.crawlFrequency);
      if (effectiveFreq === "manual") {
        // Tier does not permit scheduled recrawls at all (e.g. free). Park the
        // site so it stops re-triggering every tick without clearing the user's
        // stored preference.
        skipped.push(`${row.domain}: tier "${tier}" does not allow scheduled recrawl`);
        await db.update(geoSites)
          .set({ nextCrawlAt: computeNextCrawlAt("manual", now), updatedAt: now })
          .where(eq(geoSites.id, row.siteId));
        continue;
      }

      // Page budget for the recrawl, derived from the tier's per-audit cap via the
      // shared resolver (ES-B7) — the single source of truth used by first audits
      // and re-audits. This replaces the old hardcoded min(tier.pages, 100), which
      // capped Pro/Growth recrawls at 100 pages regardless of plan.
      const budget = resolveFirstAuditMaxPages({
        monthlyPageAllowance: row.monthlyPageAllowance,
        monthlyPagesUsed: row.monthlyPagesUsed,
        creditBalance: row.creditBalance,
        subscriptionTier: row.subscriptionTier,
        subscriptionStatus: row.subscriptionStatus,
      });

      if (budget.denied) {
        skipped.push(`${row.domain}: page budget exceeded`);
        // Push nextCrawlAt forward (by the tier-clamped cadence) to avoid
        // re-checking every cron tick.
        await db.update(geoSites)
          .set({
            nextCrawlAt: computeNextCrawlAt(effectiveFreq, now),
            updatedAt: now,
          })
          .where(eq(geoSites.id, row.siteId));

        // Surface the budget denial to the user instead of only logging it —
        // a scheduled recrawl that silently never runs is the failure mode this
        // fix targets. Best-effort: sendLowCreditsEmail swallows its own errors.
        if (row.ownerEmail) {
          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
          void sendLowCreditsEmail(row.ownerEmail, {
            creditsRemaining: row.creditBalance,
            topUpUrl: `${appBase}/pricing`,
          }).catch((e) => console.warn("[recrawl] low credits email failed:", e));
        }
        continue;
      }

      const pagesToCrawl = budget.maxPages;
      const subscriptionPages = budget.subscriptionPages;
      const creditsToDeduct = budget.creditsToReserve;
      // Credit-funded portion of this recrawl (0 when fully subscription-funded).
      const creditPages = pagesToCrawl - subscriptionPages;
      // Ledger row id is captured so the kickoff-failure path can reverse it.
      let ledgerId: string | null = null;

      // Reserve the budget atomically: debit subscription pages + overflow
      // credits, write the ledger row, and flip the site into discovery in a
      // single transaction. If ANY of these writes throws, the whole reservation
      // rolls back — no allowance is silently burned and the site stays
      // "complete", so the next cron tick can retry cleanly.
      // GEO-007: the `recrawl_reserve` ledger type mirrors the single-audit
      // `crawl_reserve` shape (sites/route.ts) but is distinct so scheduled
      // re-audits are auditable.
      try {
        await db.transaction(async (tx) => {
          await tx.update(teams)
            .set({
              monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${subscriptionPages}`,
              updatedAt: now,
            })
            .where(eq(teams.id, row.teamId!));

          if (creditsToDeduct > 0) {
            await tx.update(teams)
              .set({
                creditBalance: sql`${teams.creditBalance} - ${creditsToDeduct}`,
              })
              .where(eq(teams.id, row.teamId!));

            ledgerId = nanoid();
            await tx.insert(creditTransactions).values({
              id: ledgerId,
              teamId: row.teamId!,
              siteId: row.siteId,
              type: "recrawl_reserve",
              pagesConsumed: creditPages,
              creditsChanged: -creditsToDeduct,
              balanceBefore: row.creditBalance,
              balanceAfter: row.creditBalance - creditsToDeduct,
              createdAt: now,
            });
          }

          await tx.update(geoSites)
            .set({
              pipelineStatus: "discovery",
              pipelineError: null,
              nextCrawlAt: computeNextCrawlAt(effectiveFreq, now),
              lastCrawlAt: now,
              updatedAt: now,
            })
            .where(eq(geoSites.id, row.siteId));
        });
      } catch (err) {
        // Reservation rolled back by the DB — nothing was burned. Report loudly
        // and move on rather than 500-ing the whole batch.
        const message = err instanceof Error ? err.message : String(err);
        console.error("[recrawl] reservation transaction failed for site", row.siteId, ":", message);
        errors++;
        skipped.push(`${row.domain}: recrawl reservation failed`);
        continue;
      }

      // Durable kickoff: enqueue the discover stage synchronously via QStash.
      // The old after(() => startCrawl(...)) never executed on Vercel (the
      // function froze after the response), so the allowance was burned but the
      // crawl never ran. Enqueue in-band and reverse the reservation on failure.
      try {
        await enqueueStage({
          siteId: row.siteId,
          domain: row.domain,
          stage: "discover",
          maxPages: pagesToCrawl,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[recrawl] enqueue failed for site", row.siteId, ":", message);

        // Compensating transaction: reverse the committed reservation (restore
        // pages + credits, delete the ledger row) and mark the site failed so it
        // is not left stuck in "discovery" with no running pipeline.
        try {
          await db.transaction(async (tx) => {
            await tx.update(teams)
              .set({
                monthlyPagesUsed: sql`${teams.monthlyPagesUsed} - ${subscriptionPages}`,
                updatedAt: now,
              })
              .where(eq(teams.id, row.teamId!));

            if (creditsToDeduct > 0) {
              await tx.update(teams)
                .set({
                  creditBalance: sql`${teams.creditBalance} + ${creditsToDeduct}`,
                })
                .where(eq(teams.id, row.teamId!));
              if (ledgerId) {
                await tx.delete(creditTransactions).where(eq(creditTransactions.id, ledgerId));
              }
            }

            await tx.update(geoSites)
              .set({
                pipelineStatus: "failed",
                pipelineError: `Recrawl kickoff failed: ${message}`,
                updatedAt: now,
              })
              .where(eq(geoSites.id, row.siteId));
          });
        } catch (rollbackErr) {
          // Rollback itself failed → the reservation is committed but no crawl
          // ran. This is a real inconsistency; surface it loudly for operators
          // rather than swallowing it.
          console.error(
            "[recrawl] CRITICAL: reservation rollback failed for site",
            row.siteId,
            ":",
            rollbackErr,
          );
        }

        errors++;
        skipped.push(`${row.domain}: recrawl kickoff failed, reservation reversed`);
        continue;
      }

      processed++;
    }

    return NextResponse.json({
      processed,
      skipped: skipped.length,
      errors,
      details: skipped.length > 0 ? skipped : undefined,
    });
  } catch (err) {
    console.error("GET /api/cron/recrawl error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
