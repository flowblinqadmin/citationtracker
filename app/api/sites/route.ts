import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teamMembers, teams, teamDomains, creditTransactions, reAuditActions } from "@/lib/db/schema";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";
import { randomUUID } from "crypto";
import { eq, and, gte, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { normalizeDomain, slugify, normalizeUrl } from "@/lib/utils";
import { generateVerificationCode, hashCode, sendVerificationEmail, sendLowCreditsEmail, sendInternalSignupAlert } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { enqueueStage } from "@/lib/qstash";
import { BULK_MAX_URLS, FREE_AUDIT_LIMIT, FREE_MAX_PAGES, PAGES_PER_CREDIT, bulkCreditsRequired, SUBSCRIPTION_TIERS, type SubscriptionTier } from "@/lib/config";
import { resolveCrawlBudget, resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";
import { getClientIp } from "@/lib/client-ip";
import { createClient } from "@/lib/supabase/server";
import { canonicalizeEmail } from "@/lib/email-canonical";
// sync to geo_site_view handled by Postgres trigger — no application sync needed
//
// C1 (2026-05-27 audit): this route is listed in middleware.NEEDS_SUPABASE_SESSION,
// so any client-supplied x-user-email / x-user-id / x-supabase-token / x-token-exp
// headers are stripped by lib/supabase/middleware.ts before this handler runs.
// When a valid Supabase session cookie is present, those headers are
// re-stamped from the verified JWT. The Pro-fast-path checks below therefore
// read trust-stamped values, not attacker input. Do not bypass middleware.
//
// Auth identity is resolved once via resolveAuthedIdentity() below: header
// first, then a signature-verified server-side getUser() fallback for the
// case where a valid session cookie is present but the header didn't get
// stamped. The fallback is verified (not an unverified JWT decode), so it
// does not reopen the spoofing vector the C1 hardening closed.

// Private/internal IP ranges — used for SSRF protection in both bulk and single paths.
const PRIVATE_RANGES = [
  /^localhost$/i,
  /^127\./,                              // loopback
  /^10\./,                               // RFC-1918
  /^192\.168\./,                         // RFC-1918
  /^172\.(1[6-9]|2\d|3[01])\./,         // RFC-1918
  /^169\.254\./,                         // link-local / cloud metadata (169.254.169.254)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
  /^0\./,                                // 0.0.0.0/8
  /^\[::1\]$/,                           // IPv6 loopback (URL() wraps in brackets)
  /^\[::ffff:/i,                         // IPv4-mapped IPv6
  /^\[f[cd]/i,                           // IPv6 ULA fc00::/7
  /^\[fe80/i,                            // IPv6 link-local
];

/** If the email already has a team, link the site to it (idempotent). */
async function linkSiteToTeam(siteId: string, domain: string, email: string): Promise<void> {
  try {
    const [member] = await db.select().from(teamMembers).where(eq(teamMembers.email, email));
    if (!member?.teamId) return;
    const [site] = await db.select({ teamId: geoSites.teamId }).from(geoSites).where(eq(geoSites.id, siteId));
    if (site?.teamId === member.teamId) return; // already linked — nothing to do
    await db.update(geoSites).set({ teamId: member.teamId }).where(eq(geoSites.id, siteId));
    await db.insert(teamDomains).values({
      id: nanoid(), teamId: member.teamId, siteId, domain, createdAt: new Date(),
    });
    console.warn(`[sites] Auto-linked ${domain} to team ${member.teamId} for ${email}`);
  } catch (err) {
    console.error("[sites] linkSiteToTeam failed (non-fatal):", err);
  }
}

/**
 * Per-tier distinct-site cap (FIX-013, addresses BUG-009).
 *
 * The `sites` field on each tier is added by FIX-011 (slot 3, lib/config.ts).
 * Cross-slot dependency by INTERFACE only: until FIX-011 lands in the
 * integrated tree, `tier.sites` reads as undefined and `tierSiteCap` returns
 * null, so the cap is not enforced and `countTeamSites` is never queried. This
 * consumes FIX-011's contract without duplicating its values or editing
 * lib/config.ts (keeps slot 5 / slot 3 file-disjoint).
 */
function tierSiteCap(subscriptionTier: string): number | null {
  const tier = SUBSCRIPTION_TIERS[subscriptionTier as SubscriptionTier] as
    | { sites?: number }
    | undefined;
  return typeof tier?.sites === "number" ? tier.sites : null;
}

/** Count distinct domains already owned by a team — the per-tier site cap basis. */
async function countTeamSites(teamId: string): Promise<number> {
  const rows = await db
    .selectDistinct({ domain: geoSites.domain })
    .from(geoSites)
    .where(eq(geoSites.teamId, teamId));
  return rows.length;
}

/**
 * Resolves the authenticated identity for this request.
 *
 * Primary: x-user-email / x-user-id headers, which middleware
 * (NEEDS_SUPABASE_SESSION) stamps from the verified cookie session and
 * strips from client input — trustworthy here.
 *
 * Fallback: when the headers are absent but a Supabase auth cookie is
 * present (e.g. the session refreshed mid-flight, or the request reached the
 * handler without a re-stamp), verify the cookie session server-side via
 * auth.getUser(). This is a SIGNATURE-VERIFIED check, not an unverified JWT
 * decode, so it preserves the C1 anti-spoofing posture. It exists so a
 * logged-in, entitled user never falls into the OTP dead-end when the
 * forwarded header doesn't propagate.
 *
 * The getUser() round-trip only fires when an `sb-…auth-token` cookie is
 * present, so anonymous audit submissions (the public funnel) skip it.
 */
async function resolveAuthedIdentity(
  req: NextRequest,
): Promise<{ email: string | null; userId: string | null }> {
  const headerEmail = req.headers.get("x-user-email")?.toLowerCase().trim() || null;
  const headerUserId = req.headers.get("x-user-id")?.trim() || null;
  if (headerEmail) return { email: headerEmail, userId: headerUserId };

  const cookies = typeof req.cookies?.getAll === "function" ? req.cookies.getAll() : [];
  const hasAuthCookie = cookies.some((c) => c.name.startsWith("sb-") && c.name.includes("auth-token"));
  if (!hasAuthCookie) return { email: null, userId: headerUserId };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) return { email: null, userId: headerUserId };
    return {
      email: data.user.email?.toLowerCase().trim() ?? null,
      userId: data.user.id ?? headerUserId,
    };
  } catch {
    return { email: null, userId: headerUserId };
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);

    const body = await req.json() as { url?: string; email?: string; bulkUrls?: unknown[] };
    const { url, email, bulkUrls } = body;

    // Resolve the logged-in identity once (header, then verified getUser
    // fallback). Used by every OTP-skip fast-path below so a valid session
    // reliably auto-verifies instead of dead-ending at OTP.
    const { email: authEmail, userId: authUserId } = await resolveAuthedIdentity(req);

    // ── Bulk audit flow — credit-gated, skip IP rate limit ──
    if (bulkUrls !== undefined) {
      if (!email) {
        return NextResponse.json({ error: "Email is required" }, { status: 400 });
      }
      if (!Array.isArray(bulkUrls) || bulkUrls.length === 0 || bulkUrls.length > BULK_MAX_URLS) {
        return NextResponse.json(
          { error: `Bulk audit accepts 1 to ${BULK_MAX_URLS} URLs.` },
          { status: 400 }
        );
      }

      // SSRF validation on each URL
      const invalidUrls: string[] = [];
      const validNormalizedUrls: string[] = [];
      for (const u of bulkUrls) {
        if (typeof u !== "string") { invalidUrls.push(String(u)); continue; }
        const normalized = normalizeUrl(u);
        if (!normalized) { invalidUrls.push(u); continue; }
        const parsed = new URL(normalized); // safe — normalizeUrl guarantees parseable
        if (PRIVATE_RANGES.some((r) => r.test(parsed.hostname))) {
          invalidUrls.push(u);
          continue;
        }
        validNormalizedUrls.push(normalized);
      }
      if (invalidUrls.length > 0) {
        return NextResponse.json(
          { error: `${invalidUrls.length} invalid URL(s) in CSV. All URLs must be valid HTTP/HTTPS addresses.` },
          { status: 400 }
        );
      }

      const uniqueUrls = [...new Set(validNormalizedUrls)];
      const emailLower = (email as string).toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
        return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
      }

      // Credit check: lookup team via email
      const [member] = await db.select().from(teamMembers).where(eq(teamMembers.email, emailLower));
      if (!member) {
        return NextResponse.json(
          { error: "Bulk audit requires a Pro account with sufficient credits." },
          { status: 402 }
        );
      }
      // Pro team required — credits are optional. effectiveCrawlLimit applies a free
      // floor (BULK_FREE_PAGES) so users with 0 credits still get a partial crawl.
      const [team] = await db.select().from(teams).where(eq(teams.id, member.teamId));
      if (!team) {
        return NextResponse.json(
          { error: "Bulk audit requires a Pro account." },
          { status: 402 }
        );
      }

      // Group URLs by domain — one geoSite record per domain
      const urlsByDomain = new Map<string, string[]>();
      for (const u of uniqueUrls) {
        const hostname = new URL(u).hostname.replace(/^www\./, "");
        const existing = urlsByDomain.get(hostname) ?? [];
        existing.push(u);
        urlsByDomain.set(hostname, existing);
      }

      const domainList = [...urlsByDomain.keys()];
      const now = new Date();
      const batchId = nanoid();
      const primarySiteId = nanoid();

      // Pro fast-path: authenticated user with matching email — skip OTP, deduct credits, start pipeline
      const skipOtp = !!(authEmail && authEmail === emailLower && team.creditBalance > 0);

      if (skipOtp) {
        // FIX-013 (BUG-009): enforce the per-tier distinct-site cap before
        // creating new bulk audit sites. Inert until FIX-011 adds tier.sites.
        const bulkSiteCap = tierSiteCap(team.subscriptionTier);
        if (bulkSiteCap !== null) {
          const usedSites = await countTeamSites(member.teamId);
          if (usedSites + domainList.length > bulkSiteCap) {
            return NextResponse.json(
              {
                error: `Your plan is limited to ${bulkSiteCap} sites. Upgrade for more.`,
                upgradeRequired: true,
                sitesUsed: usedSites,
                siteCap: bulkSiteCap,
              },
              { status: 402 },
            );
          }
        }

        const totalUrls = uniqueUrls.length;
        const creditsNeeded = bulkCreditsRequired(totalUrls);
        const creditsToDeduct = Math.min(creditsNeeded, team.creditBalance);

        const rows = domainList.map((domain, i) => {
          const siteId = i === 0 ? primarySiteId : nanoid();
          const urls = urlsByDomain.get(domain)!;
          return {
            id: siteId,
            domain,
            slug: `${slugify(domain)}-${siteId.slice(0, 6)}`,
            ownerEmail: emailLower,
            ownerEmailCanonical: canonicalizeEmail(emailLower),
            teamId: member.teamId,
            auditMode: "bulk" as const,
            bulkUrls: urls as unknown as Record<string, unknown>,
            bulkUrlCount: urls.length,
            emailVerified: true,
            pipelineStatus: "discovery",
            paymentStatus: "pending",
            verifyToken: `flowblinq-verify-${siteId}`,
            accessToken: nanoid(32),
            // H3 (2026-05-27 audit): download-report + pdf-report enforce
            // tokenExpiresAt; stamp here so bulk-fast-path doesn't 401.
            tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
            creditsReserved: i === 0 ? creditsToDeduct : 0,
            batchId,
            shareToken: nanoid(24),
            createdAt: now,
            updatedAt: now,
          };
        });

        await db.transaction(async (tx) => {
          await tx.insert(geoSites).values(rows);

          await tx.update(teams)
            .set({ creditBalance: sql`${teams.creditBalance} - ${creditsToDeduct}`, updatedAt: now })
            .where(eq(teams.id, member.teamId));

          await tx.insert(creditTransactions).values({
            id: nanoid(),
            teamId: member.teamId,
            siteId: primarySiteId,
            type: "crawl_reserve",
            pagesConsumed: totalUrls,
            creditsChanged: -creditsToDeduct,
            balanceBefore: team.creditBalance,
            balanceAfter: team.creditBalance - creditsToDeduct,
            createdAt: now,
          });
        });

        // Low credits warning (< 5 credits remaining = < 25 pages)
        const balanceAfterDeduct = team.creditBalance - creditsToDeduct;
        if (balanceAfterDeduct > 0 && balanceAfterDeduct < 5 && authEmail) {
          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
          sendLowCreditsEmail(authEmail, {
            creditsRemaining: balanceAfterDeduct,
            topUpUrl: `${appBase}/pricing`,
          }).catch((e) => console.warn("[sites] low credits email failed:", e));
        }

        // Link all domains to team + enqueue pipelines
        for (const row of rows) {
          await db.insert(teamDomains).values({
            id: nanoid(), teamId: member.teamId, siteId: row.id, domain: row.domain, createdAt: now,
          }).catch(() => {});

          const domainUrls = urlsByDomain.get(row.domain)!;
          // ES-B10 AC-B10-1: bulk-init enqueues crawl-fanout directly. The
          // URL set is already known (CSV-supplied); skip discover.
          await enqueueStage({ siteId: row.id, domain: row.domain, stage: "crawl-fanout", maxPages: domainUrls.length });
        }

        const isMultiDomain = domainList.length > 1;
        console.log(JSON.stringify({
          event: "bulk_pro_fast_path",
          primarySiteId,
          batchId,
          domains: domainList,
          totalUrlCount: totalUrls,
          creditsDeducted: creditsToDeduct,
          teamId: member.teamId,
        }));

        return NextResponse.json(
          {
            id: primarySiteId,
            accessToken: rows[0].accessToken,
            ...(isMultiDomain ? { ids: rows.map((r) => r.id), domains: domainList } : {}),
            message: "Bulk audit started.",
            skipVerify: true,
          },
          { status: 201 }
        );
      }

      // Non-Pro or unauthenticated: verification flow
      const code = generateVerificationCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

      const rows = domainList.map((domain, i) => {
        const siteId = i === 0 ? primarySiteId : nanoid();
        const urls = urlsByDomain.get(domain)!;
        return {
          id: siteId,
          domain,
          slug: `${slugify(domain)}-${siteId.slice(0, 6)}`,
          ownerEmail: emailLower,
          ownerEmailCanonical: canonicalizeEmail(emailLower),
          teamId: member.teamId,
          auditMode: "bulk" as const,
          bulkUrls: urls as unknown as Record<string, unknown>,
          bulkUrlCount: urls.length,
          emailVerified: false,
          verificationCode: codeHash,
          codeExpiresAt: expiresAt,
          pipelineStatus: "pending",
          paymentStatus: "pending",
          verifyToken: `flowblinq-verify-${siteId}`,
          batchId,
          createdAt: now,
          updatedAt: now,
        };
      });

      await db.insert(geoSites).values(rows);

      // Always send one email — for multi-domain, the code verifies all at once on the verify step
      await sendVerificationEmail(emailLower, code, domainList[0]);
      sendInternalSignupAlert({
        customerEmail: emailLower,
        domain: domainList.join(", "),
        siteId: primarySiteId,
        source: domainList.length > 1 ? "bulk-multi" : "bulk",
      });

      const isMultiDomain = domainList.length > 1;
      console.log(JSON.stringify({
        event: isMultiDomain ? "multi_domain_bulk_submit" : "bulk_submit",
        primarySiteId,
        batchId,
        domains: domainList,
        totalUrlCount: uniqueUrls.length,
        teamId: member.teamId,
      }));

      return NextResponse.json(
        {
          id: primarySiteId,
          ...(isMultiDomain ? { ids: rows.map((r) => r.id), domains: domainList } : {}),
          message: "Verification code sent.",
        },
        { status: 201 }
      );
    }

    if (!url || !email) {
      return NextResponse.json({ error: "URL and email are required" }, { status: 400 });
    }

    // Strict URL validation — must be http/https and not a private/internal host
    const normalizedUrl = normalizeUrl(url);
    if (!normalizedUrl) {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    const parsedUrl = new URL(normalizedUrl); // safe — normalizeUrl guarantees parseable
    if (PRIVATE_RANGES.some((r) => r.test(parsedUrl.hostname))) {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    const emailLower = email.toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }
    const domain = normalizeDomain(normalizedUrl);

    // ── ES-090 §b.5 CRIT-4: single-audit rate-limit (per-IP) ─────────
    // HP-232: placed AFTER body validation so malformed-body 400s don't
    // consume the caller's IP bucket. Inserted after the bulk branch
    // returns (bulk path is credit-gated, not IP-gated — U25).
    // Key: `sites_create:<ip>`, 10 requests / 60s. Unknown IPs share
    // the "unknown" bucket (spec-accepted per U26).
    const rl = await checkRateLimit(`sites_create:${ip}`, 10, 60_000);
    if (!rl.allowed) {
      const retryAfterMs = Math.max(0, rl.resetAt - Date.now());
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      return NextResponse.json(
        { error: "Too Many Requests", retryAfterMs },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
      );
    }

    // Check if already exists for this email+domain combo
    const [existing] = await db
      .select()
      .from(geoSites)
      .where(and(eq(geoSites.domain, domain), eq(geoSites.ownerEmail, emailLower)));

    if (existing) {
      // Always try to link to team — catches paid users returning to an old free-tier site
      await linkSiteToTeam(existing.id, domain, emailLower);

      // Resend verification if not verified yet
      if (!existing.emailVerified) {
        const code = generateVerificationCode();
        const codeHash = hashCode(code);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await db.update(geoSites)
          .set({ verificationCode: codeHash, codeExpiresAt: expiresAt, updatedAt: new Date() })
          .where(eq(geoSites.id, existing.id));
        await sendVerificationEmail(emailLower, code, domain);
        return NextResponse.json({ id: existing.id, message: "Verification code resent" }, { status: 200 });
      }
      // Complete — Wave 2 B3 Option (a): Pro session auto-pass + regenerate.
      if (existing.pipelineStatus === "complete") {
        if (existing.emailVerified) {
          // ES-wave-2 §B3 — Pro re-audit gate. Five hardening ACs gate the
          // auto-pass path; any miss falls through to OTP (no 401/403
          // short-circuit), preserving legitimate-user recovery.
          const jwtUserId = authUserId;

          // AC-B3-1 + AC-B3-2: auto-pass requires email match + JWT user-id +
          // team membership. JWT failure (missing/malformed) → fall through.
          let canAutoPass = false;
          if (authEmail && authEmail === emailLower && jwtUserId && existing.teamId) {
            try {
              const [membership] = await db
                .select()
                .from(teamMembers)
                .where(and(eq(teamMembers.userId, jwtUserId), eq(teamMembers.teamId, existing.teamId)));
              canAutoPass = !!membership;
            } catch (err) {
              console.warn("[re-audit] AC-B3-1 team-membership check failed; falling through to OTP:", err);
            }
          }

          if (canAutoPass && existing.teamId) {
            // AC-B3-5: per-team re-audit rate limit (10/hour). The team is
            // the cost-bearing entity, so the ceiling is per-team rather
            // than per-user — prevents a malicious actor from burning
            // through team-budget by rotating compromised users.
            const reAuditRl = await checkRateLimit(`re_audit_team:${existing.teamId}`, 10, 60 * 60 * 1000);
            if (!reAuditRl.allowed) {
              const retryAfterSec = Math.max(1, Math.ceil((reAuditRl.resetAt - Date.now()) / 1000));
              return NextResponse.json(
                { error: "Re-audit rate limit exceeded for this team", resetAt: reAuditRl.resetAt },
                { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
              );
            }

            // FIX-013: resolve the re-audit budget through the canonical
            // resolveFirstAuditMaxPages and RESERVE it, instead of hardcoding
            // PAID_MAX_PAGES (100) with no charge. The old path crawled 100
            // pages on every Pro-session re-audit without debiting any
            // credit/subscription page — a free paid re-audit + a budget that
            // ignored the team's tier allowance.
            const [reAuditTeam] = await db
              .select()
              .from(teams)
              .where(eq(teams.id, existing.teamId));
            if (!reAuditTeam) {
              return NextResponse.json({ error: "Team not found" }, { status: 404 });
            }

            const reAuditBudget = resolveFirstAuditMaxPages({
              monthlyPageAllowance: reAuditTeam.monthlyPageAllowance,
              monthlyPagesUsed: reAuditTeam.monthlyPagesUsed,
              creditBalance: reAuditTeam.creditBalance,
              subscriptionTier: reAuditTeam.subscriptionTier,
              subscriptionStatus: reAuditTeam.subscriptionStatus,
            });
            // Re-audit is a paid action (FREE_REGENERATIONS=0): deny when the
            // team has neither subscription headroom nor credits.
            if (reAuditBudget.denied || reAuditBudget.maxPages === 0) {
              return NextResponse.json(
                {
                  error: "Insufficient credits",
                  creditsRequired: 1,
                  creditsAvailable: reAuditTeam.creditBalance,
                  upgradeRequired: true,
                },
                { status: 402 },
              );
            }

            // Rotate token + reset pipeline (mirrors buildRegeneratePatch at
            // app/api/sites/[id]/regenerate/route.ts:18-25 — kept inline so
            // this route doesn't import a non-exported helper).
            const now = new Date();
            const newAccessToken = nanoid(32);
            const reAuditBalanceBefore = reAuditTeam.creditBalance;
            const reAuditBalanceAfter = reAuditTeam.creditBalance - reAuditBudget.creditsToReserve;

            // FIX-014: reserve credits FIRST inside the transaction with a
            // rows-affected guard. The gte-guarded UPDATE can match 0 rows under
            // a concurrent debit; throwing then rolls back the whole tx (no
            // token rotation, no ledger row, no subscription-page bump) so we
            // never charge/reserve credits that were already spent elsewhere.
            let reserveRaceLost = false;
            try {
              await db.transaction(async (tx) => {
                // Credit overflow reserved (credit-pool model).
                if (reAuditBudget.creditsToReserve > 0) {
                  const reserved = await tx
                    .update(teams)
                    .set({
                      creditBalance: sql`${teams.creditBalance} - ${reAuditBudget.creditsToReserve}`,
                      updatedAt: now,
                    })
                    .where(and(eq(teams.id, existing.teamId!), gte(teams.creditBalance, reAuditBudget.creditsToReserve)))
                    .returning({ id: teams.id });
                  if (reserved.length === 0) {
                    reserveRaceLost = true;
                    throw new Error("reserve_race_lost"); // rolls back the tx
                  }

                  await tx.insert(creditTransactions).values({
                    id: nanoid(),
                    teamId: existing.teamId!,
                    siteId: existing.id,
                    type: "crawl_reserve",
                    pagesConsumed: reAuditBudget.maxPages,
                    creditsChanged: -reAuditBudget.creditsToReserve,
                    balanceBefore: reAuditBalanceBefore,
                    balanceAfter: reAuditBalanceAfter,
                    createdAt: now,
                  });
                }

                // Subscription-funded pages consume the monthly allowance.
                if (reAuditBudget.source === "subscription" && reAuditBudget.subscriptionPages > 0) {
                  await tx
                    .update(teams)
                    .set({
                      monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${reAuditBudget.subscriptionPages}`,
                      updatedAt: now,
                    })
                    .where(eq(teams.id, existing.teamId!));
                }

                await tx
                  .update(geoSites)
                  .set({
                    accessToken: newAccessToken,
                    tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
                    tokenRotatedAt: now,
                    pipelineStatus: "pending",
                    pipelineError: null,
                    creditsReserved: reAuditBudget.creditsToReserve,
                    // NEW-P-01: record subscription pages reserved for reconciliation at assemble.
                    subscriptionPagesReserved: reAuditBudget.subscriptionPages > 0 ? reAuditBudget.subscriptionPages : 0,
                    updatedAt: now,
                  })
                  .where(eq(geoSites.id, existing.id));
              });
            } catch (reserveErr) {
              if (reserveRaceLost) {
                return NextResponse.json(
                  {
                    error: "Insufficient credits",
                    creditsRequired: reAuditBudget.creditsToReserve,
                    creditsAvailable: reAuditTeam.creditBalance,
                    upgradeRequired: true,
                  },
                  { status: 402 },
                );
              }
              throw reserveErr; // unexpected — bubble to the outer 500 handler
            }

            // AC-B3-3: audit log every successful re-audit. Insert before
            // enqueue so a transient QStash failure still leaves a trail.
            await db.insert(reAuditActions).values({
              id: randomUUID(),
              actorUserId: jwtUserId,
              actorEmail: emailLower,
              siteId: existing.id,
              teamId: existing.teamId,
              mechanism: "pro_session",
              createdAt: now,
            });

            // Trigger pipeline restart with the resolved (reserved) budget.
            await enqueueStage({
              siteId: existing.id,
              domain,
              stage: "discover",
              maxPages: reAuditBudget.maxPages,
            });

            return NextResponse.json(
              {
                id: existing.id,
                accessToken: newAccessToken,
                message: "Re-audit started",
                skipVerify: true,
                restarted: true,
              },
              { status: 200 },
            );
          }
          // AC-B3-1/2 miss → fall through to OTP path below (no 401/403).
          // Unauthenticated or different user: send OTP to re-verify ownership
          const reCode = generateVerificationCode();
          const reHash = hashCode(reCode);
          const reExpires = new Date(Date.now() + 15 * 60 * 1000);
          await db.update(geoSites)
            .set({ verificationCode: reHash, codeExpiresAt: reExpires, updatedAt: new Date() })
            .where(eq(geoSites.id, existing.id));
          await sendVerificationEmail(emailLower, reCode, domain);
          return NextResponse.json({ id: existing.id, message: "Check your email for verification code" }, { status: 200 });
        }
        const code = generateVerificationCode();
        const codeHash = hashCode(code);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await db.update(geoSites)
          .set({ verificationCode: codeHash, codeExpiresAt: expiresAt, updatedAt: new Date() })
          .where(eq(geoSites.id, existing.id));
        await sendVerificationEmail(emailLower, code, domain);
        return NextResponse.json({ id: existing.id, message: "Check your email for verification code" }, { status: 200 });
      }
      // Failed — reset and re-run
      if (existing.pipelineStatus === "failed") {
        const code = generateVerificationCode();
        const codeHash = hashCode(code);
        const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
        await db.update(geoSites)
          .set({
            verificationCode: codeHash,
            codeExpiresAt: expiresAt,
            emailVerified: false,
            pipelineStatus: "pending",
            pipelineError: null,
            updatedAt: new Date(),
          })
          .where(eq(geoSites.id, existing.id));
        await sendVerificationEmail(emailLower, code, domain);
        return NextResponse.json({ id: existing.id, message: "Check your email for verification code" }, { status: 200 });
      }
      // In-progress — return existing id
      return NextResponse.json({ id: existing.id, message: "Profile already being processed" }, { status: 200 });
    }

    // Free audit limit: cap distinct domains per email (subscribers + credit holders bypass)
    let isPro = false;
    let proTeam: { id: string; creditBalance: number; subscriptionTier: string; subscriptionStatus: string; monthlyPageAllowance: number; monthlyPagesUsed: number } | null = null;
    const [member] = await db.select().from(teamMembers).where(eq(teamMembers.email, emailLower));
    if (member) {
      const [team] = await db.select().from(teams).where(eq(teams.id, member.teamId));
      if (team) {
        const hasCredits = team.creditBalance > 0;
        const hasSubscription = team.subscriptionTier !== "free" && team.subscriptionStatus === "active";
        if (hasCredits || hasSubscription) {
          isPro = true;
          proTeam = team;
        }
      }
    }

    // Authenticated Pro/subscriber user? Skip OTP — start pipeline immediately.
    const skipOtp = !!(authEmail && authEmail === emailLower && proTeam && (proTeam.creditBalance > 0 || (proTeam.subscriptionTier !== "free" && proTeam.subscriptionStatus === "active")));
    if (!isPro) {
      // NEW-A-02: count by canonical email (indexed equality) to block Gmail
      // dot/plus alias bypass. canonicalizeEmail("u.ser+promo@gmail.com") ===
      // canonicalizeEmail("user@gmail.com") → same canonical → same count.
      // Non-Gmail providers are only lowercased (distinct dots/plus preserved).
      const canonicalEmail = canonicalizeEmail(emailLower);
      const existingSites = await db
        .select({ id: geoSites.id })
        .from(geoSites)
        .where(eq(geoSites.ownerEmailCanonical, canonicalEmail));
      if (existingSites.length >= FREE_AUDIT_LIMIT) {
        return NextResponse.json(
          {
            error: `Free accounts are limited to ${FREE_AUDIT_LIMIT} audits. Upgrade to Pro for unlimited audits.`,
            upgradeRequired: true,
          },
          { status: 402 }
        );
      }
    }

    // Check if another user already has a completed audit for this domain — serve cached results
    const [completedForDomain] = await db
      .select()
      .from(geoSites)
      .where(and(eq(geoSites.domain, domain), eq(geoSites.pipelineStatus, "complete")));

    const id = nanoid();
    const slug = `${slugify(domain)}-${id.slice(0, 6)}`;
    const code = generateVerificationCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    if (completedForDomain) {
      const accessToken = skipOtp ? nanoid(32) : undefined;
      // Pre-populate with existing results — no pipeline needed
      await db.insert(geoSites).values({
        id,
        domain,
        slug,
        ownerEmail: emailLower,
        ownerEmailCanonical: canonicalizeEmail(emailLower),
        emailVerified: !!skipOtp,
        ...(skipOtp ? {} : { verificationCode: codeHash, codeExpiresAt: expiresAt }),
        pipelineStatus: "complete",
        paymentStatus: "pending",
        crawlCount: completedForDomain.crawlCount,
        manualRunsThisMonth: 0,
        verifyToken: `flowblinq-verify-${id}`,
        // H3 (2026-05-27 audit): tokenExpiresAt must accompany accessToken.
        ...(accessToken
          ? {
              accessToken,
              tokenExpiresAt: new Date(Date.now() + TOKEN_TTL_MS),
            }
          : {}),
        ...(skipOtp && member ? { teamId: member.teamId } : {}),
        // Copy all generated assets from the existing run
        geoScorecard: completedForDomain.geoScorecard,
        executiveSummary: completedForDomain.executiveSummary,
        recommendations: completedForDomain.recommendations,
        generatedLlmsTxt: completedForDomain.generatedLlmsTxt,
        generatedLlmsFullTxt: completedForDomain.generatedLlmsFullTxt,
        generatedBusinessJson: completedForDomain.generatedBusinessJson,
        generatedSchemaBlocks: completedForDomain.generatedSchemaBlocks,
        crawlData: completedForDomain.crawlData,
        discoveryData: completedForDomain.discoveryData,
        platformDetected: completedForDomain.platformDetected,
        lastCrawlAt: completedForDomain.lastCrawlAt,
        shareToken: nanoid(24),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      if (skipOtp) {
        if (member) {
          await db.insert(teamDomains).values({
            id: nanoid(), teamId: member.teamId, siteId: id, domain, createdAt: new Date(),
          }).catch(() => {});
        }
        console.warn(`[sites] Pro fast-path: served cached results for ${domain} to ${emailLower}`);
        return NextResponse.json({ id, accessToken, message: "Cached results ready.", skipVerify: true }, { status: 201 });
      }

      await sendVerificationEmail(emailLower, code, domain);
      sendInternalSignupAlert({ customerEmail: emailLower, domain, siteId: id, source: "single-cached" });
      await linkSiteToTeam(id, domain, emailLower);
      console.warn(`[sites] Served cached results for ${domain} to new user ${emailLower}`);
      return NextResponse.json({ id, message: "Check your email for verification code" }, { status: 201 });
    }

    if (skipOtp && proTeam) {
      // Pro/subscriber fast-path: create site, use subscription budget + credits, start pipeline — no OTP needed
      const accessToken = nanoid(32);

      // FIX-013 (BUG-009): enforce the per-tier distinct-site cap before
      // creating a new audit site. Inert until FIX-011 adds tier.sites.
      const singleSiteCap = tierSiteCap(proTeam.subscriptionTier);
      if (singleSiteCap !== null) {
        const usedSites = await countTeamSites(member!.teamId);
        if (usedSites >= singleSiteCap) {
          return NextResponse.json(
            {
              error: `Your plan is limited to ${singleSiteCap} sites. Upgrade for more.`,
              upgradeRequired: true,
              sitesUsed: usedSites,
              siteCap: singleSiteCap,
            },
            { status: 402 },
          );
        }
      }

      // ES-B7: shared resolveFirstAuditMaxPages helper produces the same
      // maxPages as /api/sites/[id]/regenerate for identical team state.
      // The previous path piped SUBSCRIPTION_TIERS[tier].pages (20 for
      // credit-only Free-tier users) through resolveCrawlBudget and silently
      // capped first-audit at 20 pages while re-audit crawled 100 — a 5×
      // degradation visible to credit-holding free-tier users.
      const budget = resolveFirstAuditMaxPages({
        monthlyPageAllowance: proTeam.monthlyPageAllowance,
        monthlyPagesUsed: proTeam.monthlyPagesUsed,
        creditBalance: proTeam.creditBalance,
        subscriptionTier: proTeam.subscriptionTier,
        subscriptionStatus: proTeam.subscriptionStatus,
      });
      const maxPages = budget.maxPages;
      const creditsToReserve = budget.creditsToReserve;

      // ES-B7 AC-B7-4: denied means no subscription headroom AND no credits.
      if (budget.denied || maxPages === 0) {
        return NextResponse.json(
          {
            error: "Insufficient credits",
            creditsRequired: 1,
            creditsAvailable: proTeam.creditBalance,
          },
          { status: 402 },
        );
      }

      const now = new Date();

      await db.transaction(async (tx) => {
        await tx.insert(geoSites).values({
          id,
          domain,
          slug,
          ownerEmail: emailLower,
          ownerEmailCanonical: canonicalizeEmail(emailLower),
          emailVerified: true,
          pipelineStatus: "discovery",
          paymentStatus: "pending",
          crawlCount: 0,
          manualRunsThisMonth: 0,
          verifyToken: `flowblinq-verify-${id}`,
          accessToken,
          // H3 (2026-05-27 audit): tokenExpiresAt accompanies accessToken
          // on Pro fast-path single-audit so download/PDF gates don't 401.
          tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
          teamId: member!.teamId,
          creditsReserved: creditsToReserve,
          // NEW-P-01: record subscription pages reserved so assemble can reconcile
          // unused pages back to monthlyPagesUsed on under-crawl.
          subscriptionPagesReserved: budget.subscriptionPages > 0 ? budget.subscriptionPages : 0,
          shareToken: nanoid(24),
          createdAt: now,
          updatedAt: now,
        });

        // Deduct subscription pages used
        if (!budget.denied && budget.subscriptionPages > 0) {
          await tx.update(teams)
            .set({
              monthlyPagesUsed: sql`${teams.monthlyPagesUsed} + ${budget.subscriptionPages}`,
              updatedAt: now,
            })
            .where(eq(teams.id, member!.teamId));
        }

        // Deduct credits for overflow
        if (creditsToReserve > 0) {
          await tx.update(teams)
            .set({ creditBalance: sql`${teams.creditBalance} - ${creditsToReserve}`, updatedAt: now })
            .where(eq(teams.id, member!.teamId));

          await tx.insert(creditTransactions).values({
            id: nanoid(),
            teamId: member!.teamId,
            siteId: id,
            type: "crawl_reserve",
            pagesConsumed: maxPages,
            creditsChanged: -creditsToReserve,
            balanceBefore: proTeam.creditBalance,
            balanceAfter: proTeam.creditBalance - creditsToReserve,
            createdAt: now,
          });
        }
      });

      await db.insert(teamDomains).values({
        id: nanoid(), teamId: member!.teamId, siteId: id, domain, createdAt: new Date(),
      }).catch(() => {}); // ignore duplicate

      // Low credits warning for single-site path
      if (creditsToReserve > 0) {
        const balAfter = proTeam.creditBalance - creditsToReserve;
        if (balAfter > 0 && balAfter < 5 && authEmail) {
          const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
          sendLowCreditsEmail(authEmail, {
            creditsRemaining: balAfter,
            topUpUrl: `${appBase}/pricing`,
          }).catch((e) => console.warn("[sites] low credits email failed:", e));
        }
      }

      await enqueueStage({ siteId: id, domain, stage: "discover", maxPages });
      console.warn(`[sites] Pro fast-path: ${domain} for ${emailLower} — pipeline started, ${creditsToReserve} credits reserved, ${budget.subscriptionPages} subscription pages used`);

      return NextResponse.json({
        id,
        accessToken,
        message: "Audit started — redirecting to results.",
        skipVerify: true,
      }, { status: 201 });
    }

    // No existing data — create fresh record, send OTP
    await db.insert(geoSites).values({
      id,
      domain,
      slug,
      ownerEmail: emailLower,
      ownerEmailCanonical: canonicalizeEmail(emailLower),
      emailVerified: false,
      verificationCode: codeHash,
      codeExpiresAt: expiresAt,
      pipelineStatus: "pending",
      paymentStatus: "pending",
      crawlCount: 0,
      manualRunsThisMonth: 0,
      verifyToken: `flowblinq-verify-${id}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await sendVerificationEmail(emailLower, code, domain);
    sendInternalSignupAlert({ customerEmail: emailLower, domain, siteId: id, source: "single" });
    await linkSiteToTeam(id, domain, emailLower);

    return NextResponse.json({ id, message: "Check your email for verification code" }, { status: 201 });
  } catch (err) {
    console.error("POST /api/sites error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
