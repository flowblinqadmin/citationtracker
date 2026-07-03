import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, consentRecords, creditTransactions } from "@/lib/db/schema";
import { eq, and, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { generateExchangeCode } from "@/lib/services/exchange-code";
import { enqueueStage } from "@/lib/qstash";
import {
  CURRENT_TOS_VERSION,
  CURRENT_EULA_VERSION,
  FREE_MAX_PAGES,
} from "@/lib/config";
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";

export const maxDuration = 30;

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await req.json() as { tosAccepted?: boolean };

    if (!body.tosAccepted) {
      return NextResponse.json({ error: "TOS acceptance required" }, { status: 400 });
    }

    const [site] = await db.select().from(geoSites).where(eq(geoSites.id, id));
    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }

    // Verify the caller holds the site's access token (prevents unauthorized consent on behalf of others)
    const authHeader = req.headers.get("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!bearerToken || bearerToken !== site.accessToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (!site.emailVerified) {
      return NextResponse.json({ error: "Email not verified" }, { status: 400 });
    }
    if (!site.userId) {
      return NextResponse.json({ error: "User identity not established" }, { status: 400 });
    }

    // Record consent (idempotent via unique index)
    const fwdFor = req.headers.get("x-forwarded-for");
    const ipAddress = fwdFor
      ? (fwdFor.split(",")[0] ?? "").trim()
      : req.headers.get("x-real-ip") ?? "unknown";
    const userAgent = req.headers.get("user-agent") ?? "unknown";

    await db.insert(consentRecords).values({
      id: nanoid(),
      userId: site.userId,
      email: site.ownerEmail,
      tosVersion: CURRENT_TOS_VERSION,
      eulaVersion: CURRENT_EULA_VERSION,
      acceptedAt: new Date(),
      ipAddress,
      userAgent,
      createdAt: new Date(),
    }).onConflictDoNothing();

    // Start the pipeline if it was gated on consent (status still "pending")
    const hasCachedResults = site.pipelineStatus === "complete" && site.geoScorecard != null;
    if (!hasCachedResults && site.pipelineStatus === "pending" && site.auditMode !== "bulk") {
      // FIX-013: resolve the consent-gated audit budget through the canonical
      // resolveFirstAuditMaxPages (same resolver as verify single-audit + the
      // /api/sites Pro fast-path) and RESERVE credits/subscription pages here —
      // this is where the pipeline actually starts for consent-gated audits.
      // Previously it computed maxPages from creditBalance but never reserved,
      // so a consent-gated paid audit crawled N pages without charging credits.
      // A team with no budget (free tier / 0 credits) keeps FREE_MAX_PAGES, so a
      // resolver "denied" is NOT a 402 — free OTP audits still run at 20 pages.
      let maxPages = FREE_MAX_PAGES;
      if (site.teamId) {
        const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));
        if (team) {
          const budget = resolveFirstAuditMaxPages({
            monthlyPageAllowance: team.monthlyPageAllowance,
            monthlyPagesUsed: team.monthlyPagesUsed,
            creditBalance: team.creditBalance,
            subscriptionTier: team.subscriptionTier,
            subscriptionStatus: team.subscriptionStatus,
          });
          if (!budget.denied && budget.maxPages > 0) {
            maxPages = budget.maxPages;
            const balanceBefore = team.creditBalance;
            const balanceAfter = team.creditBalance - budget.creditsToReserve;
            // Subscription-funded pages consume the monthly allowance.
            if (budget.source === "subscription" && budget.subscriptionPages > 0) {
              await db.update(teams)
                .set({
                  monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${budget.subscriptionPages}`,
                  updatedAt: new Date(),
                })
                .where(eq(teams.id, site.teamId));
            }
            // Credit overflow reserved (credit-pool model).
            if (budget.creditsToReserve > 0) {
              // FIX-014: rows-affected guard (deductCredits TOCTOU pattern). The
              // gte-guarded UPDATE can match 0 rows under a concurrent debit;
              // only write the ledger row + stamp creditsReserved when the
              // deduction actually applied, else reconciliation would refund
              // credits that were never charged.
              const reserved = await db.update(teams)
                .set({ creditBalance: sql`${teams.creditBalance} - ${budget.creditsToReserve}` })
                .where(and(eq(teams.id, site.teamId), gte(teams.creditBalance, budget.creditsToReserve)))
                .returning({ id: teams.id });
              if (reserved.length === 0) {
                return NextResponse.json(
                  {
                    error: "Insufficient credits",
                    creditsRequired: budget.creditsToReserve,
                    creditsAvailable: team.creditBalance,
                  },
                  { status: 402 },
                );
              }
              await db.insert(creditTransactions).values({
                id: nanoid(),
                teamId: site.teamId,
                siteId: id,
                type: "single_crawl_reserve",
                pagesConsumed: maxPages,
                creditsChanged: -budget.creditsToReserve,
                balanceBefore,
                balanceAfter,
                createdAt: new Date(),
              });
              await db.update(geoSites)
                .set({ creditsReserved: budget.creditsToReserve, updatedAt: new Date() })
                .where(eq(geoSites.id, id));
            }
          }
        }
      }

      await db.update(geoSites)
        .set({ pipelineStatus: "discovery", updatedAt: new Date() })
        .where(eq(geoSites.id, id));

      await enqueueStage({ siteId: id, domain: site.domain, stage: "discover", maxPages });
    }

    // Generate exchange code for session handoff
    let exchangeCode: string | undefined;
    const admin = getSupabaseAdmin();
    if (admin && site.ownerEmail && process.env.API_JWT_SECRET) {
      try {
        const { data: linkData } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email: site.ownerEmail,
        });
        const hashedToken = linkData?.properties?.hashed_token;
        if (hashedToken) {
          const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
          const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
          if (supabaseUrl && anonKey) {
            const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: anonKey,
                Authorization: `Bearer ${anonKey}`,
              },
              body: JSON.stringify({ token_hash: hashedToken, type: "magiclink" }),
            });
            if (verifyRes.ok) {
              const session = await verifyRes.json() as { access_token?: string; refresh_token?: string };
              if (session.access_token && session.refresh_token) {
                exchangeCode = await generateExchangeCode({
                  accessToken: session.access_token,
                  refreshToken: session.refresh_token,
                  redirect: `/sites/${id}`,
                  siteToken: site.accessToken ?? "",
                  siteId: id,
                });
              }
            }
          }
        }
      } catch (err) {
        console.error("[Consent] Exchange code error:", err);
      }
    }

    return NextResponse.json({
      success: true,
      siteId: id,
      accessToken: site.accessToken,
      ...(exchangeCode ? { exchangeCode } : {}),
    }, { status: 200 });
  } catch (err) {
    console.error("POST /api/sites/[id]/consent error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
