import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { geoSites, teams, teamMembers, teamDomains, creditTransactions, consentRecords } from "@/lib/db/schema";
import { eq, and, sql, gte, or, lt, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { verifyCode } from "@/lib/email";
import { checkOtpLock, incrementOtpAttempt, clearOtpAttempts } from "@/lib/rate-limit";
import { enqueueStage } from "@/lib/qstash";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ensureTeamForUser } from "@/lib/services/provision-team";
import { resolveFirstAuditMaxPages } from "@/lib/services/page-accounting";
import { generateExchangeCode } from "@/lib/services/exchange-code";
import { TOKEN_TTL_MS } from "@/lib/constants/token-ttl";
import {
  FREE_MAX_PAGES,
  ABSOLUTE_MAX_PAGES,
  PAGES_PER_CREDIT,
  BULK_FREE_PAGES,
  bulkCreditsRequired,
  CURRENT_TOS_VERSION,
  CURRENT_EULA_VERSION,
} from "@/lib/config";

/** Check if a user has accepted the current TOS + EULA versions */
async function hasConsent(userId: string): Promise<boolean> {
  const [record] = await db.select({ id: consentRecords.id })
    .from(consentRecords)
    .where(and(
      eq(consentRecords.userId, userId),
      eq(consentRecords.tosVersion, CURRENT_TOS_VERSION),
      eq(consentRecords.eulaVersion, CURRENT_EULA_VERSION),
    ));
  return !!record;
}

// With QStash, verify only does DB ops + one QStash publish — 30s is plenty.
export const maxDuration = 30;

// ES-090 §b.2 CRIT-1 — private patch builder. Called by every verify
// write site that rotates a fresh accessToken (3 sites today). Not
// exported — HP-227 Track B: RM asserts patch shape via dbMock.update
// spy instead of importing this helper, which would leak a test-only
// export into the production bundle.
function buildVerifyTokenPatch(): { tokenExpiresAt: Date; tokenRotatedAt: Date } {
  const now = new Date();
  return {
    tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
    tokenRotatedAt: now,
  };
}

// HP-224 + HP-236: re-login rotation for expired tokens. Returns either
// the site's existing accessToken (if still valid) or a freshly rotated
// token (if expired or NULL).
//
// HP-236: atomic conditional UPDATE with RETURNING. First concurrent
// caller's UPDATE matches (WHERE expired) → writes + returns new token.
// Second concurrent caller's UPDATE affects 0 rows (WHERE no longer true
// after first commit) → falls through to re-SELECT and returns the
// winner's token. Eliminates the read-then-write race where both callers
// could see stale `site.tokenExpiresAt` and each rotate, trashing the
// first rotation's token.
async function rotateIfExpired(site: { id: string; accessToken: string | null; tokenExpiresAt: Date | null }): Promise<string> {
  // Fast-path: caller's read already shows a valid expiry. No DB work.
  // Under contention this still loses to HP-236 atomic path, but a concurrent
  // non-rotating re-login doesn't need the atomic guard.
  if (site.tokenExpiresAt && site.tokenExpiresAt >= new Date()) {
    return site.accessToken ?? "";
  }

  const newAccessToken = nanoid(32);
  const now = new Date();
  const [rotated] = await db.update(geoSites)
    .set({
      accessToken: newAccessToken,
      tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
      tokenRotatedAt: now,
    })
    .where(and(
      eq(geoSites.id, site.id),
      or(
        isNull(geoSites.tokenExpiresAt),
        lt(geoSites.tokenExpiresAt, now),
      ),
    ))
    .returning({ accessToken: geoSites.accessToken });

  if (rotated) return rotated.accessToken ?? newAccessToken;

  // Race: another concurrent call rotated first. Re-SELECT the winner's token.
  const [current] = await db.select({ accessToken: geoSites.accessToken })
    .from(geoSites)
    .where(eq(geoSites.id, site.id));
  return current?.accessToken ?? "";
}

// HP-240 + HP-244 — timing-equalization helper.
//
// Called before EVERY 401 return path in `assertOtpGate` (except the
// wrong-OTP path, which already does `incrementOtpAttempt` — its own
// equal-cost UPDATE). Without this, paths that fail on the pure-read
// branches (locked, no-OTP, expired-OTP) would complete in 1 SELECT,
// while the wrong-OTP path does 1 SELECT + 1 UPDATE. The latency delta
// leaks whether an OTP is pending, whether it's expired, and whether
// the site is locked out — all of which should be indistinguishable
// to an attacker holding only a siteId.
//
// HP-244 residual (accepted per CoFounder msg 1-cofounder:53 option b):
// if the siteId does not exist, this UPDATE affects 0 rows and returns
// faster than the "real row + 1 row affected" case. This is a residual
// enumeration primitive — but the attacker must already hold a real
// siteId to even compare against the bogus-siteId latency, so the game
// is already lost at the point this distinction matters. Not worth
// adding a dummy-SELECT fallback for the 0-row case.
async function timingEqualize(siteId: string): Promise<void> {
  // Drizzle requires at least one column in `.set()`. Re-assigning the
  // primary key to itself is a no-op write that issues the same UPDATE
  // round-trip as incrementOtpAttempt.
  await db.update(geoSites).set({ id: siteId }).where(eq(geoSites.id, siteId));
}

// HP-237 (SECURITY) + HP-239 (CRITICAL) — OTP precondition before any
// verify-route mutation. Run on BOTH fresh-verify and re-login branches
// (spec §b.2 line 197: "Do NOT inline a second copy").
//
// HP-239 ORDERING (spec-amended): the pre-HP-239 implementation called
// `checkAndIncrementOtpAttempt` FIRST — before verifying there was even a
// pending OTP. That incremented the counter on every unlocked call,
// including attacker POSTs with no prior OTP send. 5 POSTs from a leaked
// siteId → 15-min lockout of the real owner → DoS primitive with no OTP
// required. Fix: read-only lock check FIRST, increment ONLY on an actual
// wrong-code attempt.
//
// Steps (canonical, per HP-239 Aditya-approved):
//   1. `checkOtpLock` — READ ONLY. 401 if locked. Time-equalized via
//      `timingEqualize` so latency doesn't leak lock state (HP-240).
//   2. `site.verificationCode` present — no pending OTP → 401, no increment.
//   3. `site.codeExpiresAt > now` — expired OTP → 401, no increment.
//   4. `verifyCode()` — wrong code → `incrementOtpAttempt` (the only
//      writer) + 401.
//   5. `clearOtpAttempts` on success.
//
// All failures return 401 `{ error: "Invalid or expired code" }` — GENERIC
// per spec line 193. Distinguishing locked vs wrong-code vs expired in the
// response body lets an attacker probe for valid attack windows.
async function assertOtpGate(
  site: { id: string; verificationCode: string | null; codeExpiresAt: Date | null },
  code: string,
): Promise<NextResponse | null> {
  // 1. Lock check (read-only, no mutation).
  const lock = await checkOtpLock(site.id);
  if (!lock.allowed) {
    // HP-240: mirror the DB-write cost of the unlocked+wrong-OTP path so
    // locked-vs-unlocked response latency is indistinguishable.
    await timingEqualize(site.id);
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 401 });
  }

  // 2. Pending OTP must exist. HP-239: no increment here — attacker with
  // just a siteId cannot burn counter slots to lock out the real owner.
  // HP-244: timing-equalize so "no OTP pending" is indistinguishable from
  // the wrong-OTP + locked paths.
  if (!site.verificationCode) {
    await timingEqualize(site.id);
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 401 });
  }

  // 3. OTP must not be expired. HP-239: no increment.
  // HP-244: timing-equalize so "expired OTP" is indistinguishable.
  if (!site.codeExpiresAt || site.codeExpiresAt <= new Date()) {
    await timingEqualize(site.id);
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 401 });
  }

  // 4. Code must match. ONLY HERE do we increment the attempts counter —
  // the caller actually submitted a code attempt that failed to match.
  if (!verifyCode(code, site.verificationCode)) {
    await incrementOtpAttempt(site.id);
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 401 });
  }

  // 5. Success — reset counter for the next session.
  await clearOtpAttempts(site.id);
  return null;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: NextRequest, { params }: RouteContext) {
  try {
    const { id } = await params;
    const body = await req.json() as { code?: string; tosAccepted?: boolean };
    const { code, tosAccepted } = body;

    if (!code || code.length !== 6) {
      return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
    }

    const [site] = await db.select().from(geoSites).where(eq(geoSites.id, id));

    if (!site) {
      return NextResponse.json({ error: "Site not found" }, { status: 404 });
    }

    if (site.emailVerified) {
      // HP-237 SECURITY: re-login path is reachable with siteId alone (no
      // session, not CSRF-protected). Gate rotation behind OTP possession
      // before any mutation. Uses the shared `assertOtpGate` helper so the
      // 4-step precondition is identical to fresh-verify's.
      const otpFailure = await assertOtpGate(site, code);
      if (otpFailure) return otpFailure;

      // Check TOS consent for already-verified sites
      if (site.userId && !(await hasConsent(site.userId))) {
        if (tosAccepted) {
          const fwdFor = req.headers.get("x-forwarded-for");
          const ipAddress = fwdFor
            ? (fwdFor.split(",").slice(-1)[0] ?? "").trim()
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
          // Fall through to normal exchange code flow
        } else {
          // HP-224: rotate on expired/NULL tokenExpiresAt before returning.
          const tokenToReturn = await rotateIfExpired(site);
          return NextResponse.json({
            success: true,
            requiresConsent: true,
            siteId: id,
            accessToken: tokenToReturn,
          }, { status: 200 });
        }
      }

      // Already verified + consented — generate exchange code for cross-domain handoff
      // HP-224: rotate on expired/NULL tokenExpiresAt before computing exchange code.
      const reLoginAccessToken = await rotateIfExpired(site);
      let earlyExchangeCode: string | undefined;
      const earlyAdmin = getSupabaseAdmin();
      if (earlyAdmin && site.ownerEmail && process.env.API_JWT_SECRET) {
        try {
          const { data: linkData } = await earlyAdmin.auth.admin.generateLink({
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
                  earlyExchangeCode = await generateExchangeCode({
                    accessToken: session.access_token,
                    refreshToken: session.refresh_token,
                    redirect: `/sites/${id}`,
                    // HP-224: use rotated token (falls through to original
                    // if still valid). Prevents drift between cross-domain
                    // handoff and the token persisted on the row.
                    siteToken: reLoginAccessToken,
                    siteId: id,
                  });
                }
              }
            }
          }
        } catch (err) {
          console.error("[Verify] Early exchange code error:", err);
        }
      }
      return NextResponse.json({
        success: true,
        siteId: id,
        // HP-224: rotated-or-unchanged token from the re-login rotation check.
        accessToken: reLoginAccessToken,
        ...(earlyExchangeCode ? { exchangeCode: earlyExchangeCode } : {}),
      }, { status: 200 });
    }

    // HP-237: fresh-verify path uses the same 4-step OTP gate helper as
    // re-login — single source of truth for brute-force protection +
    // constant-time verify + generic 401 "Invalid or expired code" on fail.
    const otpFailure = await assertOtpGate(site, code);
    if (otpFailure) return otpFailure;

    // --- Sign user into Supabase (creates user + team if needed) ---
    let authOtp: string | undefined;
    const admin = getSupabaseAdmin();
    if (admin) {
      try {
        // Create Supabase auth user (no password — session via OTP token).
        // If user already exists, createUser returns an error — that's fine.
        let supaUserId: string | undefined;
        const { data: createData, error: createErr } = await admin.auth.admin.createUser({
          email: site.ownerEmail,
          email_confirm: true,
        });
        if (createErr) {
          if (!createErr.message?.includes("already been registered")) {
            console.error("[Verify] admin.createUser error:", createErr.message);
          }
          // User already exists or other error — generateLink below will
          // return the user object so we can extract their ID.
        } else {
          supaUserId = createData.user.id;
        }

        // Generate a magic link token, then exchange it server-side for session tokens.
        // This avoids routing the critical auth exchange through the client-side proxy,
        // which was silently failing (verifyOtp returns { error } without throwing).
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
          type: "magiclink",
          email: site.ownerEmail,
        });
        if (linkErr) {
          console.error("[Verify] generateLink error:", linkErr.message);
        } else {
          // Extract userId from generateLink response if createUser didn't give us one
          if (!supaUserId && linkData?.user?.id) {
            supaUserId = linkData.user.id;
          }

          // Exchange hashed_token for session tokens server-side (direct GoTrue call)
          const hashedToken = linkData?.properties?.hashed_token;
          if (hashedToken) {
            try {
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
                  const session = await verifyRes.json() as {
                    access_token?: string;
                    refresh_token?: string;
                  };
                  if (session.access_token && session.refresh_token) {
                    authOtp = JSON.stringify({
                      access_token: session.access_token,
                      refresh_token: session.refresh_token,
                    });
                  }
                } else {
                  console.error("[Verify] GoTrue verify failed:", verifyRes.status, await verifyRes.text().catch(() => ""));
                }
              }
            } catch (tokenErr) {
              console.error("[Verify] Token exchange error:", tokenErr);
            }
          }
        }

        // Provision team (idempotent) and link this site
        if (supaUserId) {
          const { teamId } = await ensureTeamForUser(supaUserId, site.ownerEmail, { skipBonus: true });
          if (!site.teamId) {
            await db.update(geoSites)
              .set({ teamId, userId: supaUserId, updatedAt: new Date() })
              .where(eq(geoSites.id, id));
            const [existingTd] = await db.select({ id: teamDomains.id }).from(teamDomains).where(eq(teamDomains.siteId, id));
            if (!existingTd) {
              await db.insert(teamDomains).values({
                id: nanoid(),
                teamId,
                siteId: id,
                domain: site.domain,
                addedByUserId: supaUserId,
              });
            }
            site.teamId = teamId;
            site.userId = supaUserId;
          } else if (!site.userId) {
            // Site has team but no userId (legacy rows) — backfill
            await db.update(geoSites)
              .set({ userId: supaUserId, updatedAt: new Date() })
              .where(eq(geoSites.id, id));
            site.userId = supaUserId;
          }
        }
      } catch (authErr) {
        // FIX-015: a real provisioning/linking error must NOT silently downgrade
        // a PAID audit to a free 20-page run. The admin client is present here
        // (this is not the test/build "no admin" path), so this is a genuine
        // failure. If the owner email maps to a paid team (credits or an active
        // subscription) but we failed to link the site to it (site.teamId still
        // null), fail loudly with 500 so the client retries — provisioning +
        // linking are idempotent, so the audit links and bills correctly on
        // retry instead of running free + orphaned from the dashboard.
        console.error("[Verify] Supabase auth setup error:", authErr);
        if (!site.teamId) {
          const [billingMember] = await db
            .select()
            .from(teamMembers)
            .where(eq(teamMembers.email, site.ownerEmail));
          if (billingMember) {
            const [billingTeam] = await db
              .select()
              .from(teams)
              .where(eq(teams.id, billingMember.teamId));
            const isBillable =
              !!billingTeam &&
              (billingTeam.creditBalance > 0 ||
                (billingTeam.subscriptionTier !== "free" &&
                  billingTeam.subscriptionStatus === "active"));
            if (isBillable) {
              return NextResponse.json(
                {
                  error: "Account setup failed. Please try again.",
                  retryable: true,
                },
                { status: 500 },
              );
            }
          }
        }
        // Free flow (or already linked) — non-fatal: the user can still see
        // results, just without a Supabase session on this attempt.
      }
    } else {
      // No admin client (tests/build) — fall back to legacy team linking
      if (!site.teamId) {
        const [member] = await db.select().from(teamMembers).where(eq(teamMembers.email, site.ownerEmail));
        if (member) {
          await db.update(geoSites)
            .set({ teamId: member.teamId, userId: member.userId, updatedAt: new Date() })
            .where(eq(geoSites.id, id));
          const [existingTd] = await db.select({ id: teamDomains.id }).from(teamDomains).where(eq(teamDomains.siteId, id));
          if (!existingTd) {
            await db.insert(teamDomains).values({
              id: nanoid(),
              teamId: member.teamId,
              siteId: id,
              domain: site.domain,
              addedByUserId: member.userId ?? null,
            });
          }
        }
      }
    }

    // Check TOS consent before proceeding with pipeline
    const effectiveUserId = site.userId;
    if (effectiveUserId && !(await hasConsent(effectiveUserId))) {
      // If tosAccepted was sent with the OTP, record consent inline
      if (tosAccepted) {
        const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          ?? req.headers.get("x-real-ip") ?? "unknown";
        const userAgent = req.headers.get("user-agent") ?? "unknown";
        await db.insert(consentRecords).values({
          id: nanoid(),
          userId: effectiveUserId,
          email: site.ownerEmail,
          tosVersion: CURRENT_TOS_VERSION,
          eulaVersion: CURRENT_EULA_VERSION,
          acceptedAt: new Date(),
          ipAddress,
          userAgent,
          createdAt: new Date(),
        }).onConflictDoNothing();
      } else {
        // No consent provided — gate the pipeline, return requiresConsent
        const consentAccessToken = nanoid(32);
        await db.update(geoSites)
          .set({
            emailVerified: true,
            verificationCode: null,
            codeExpiresAt: null,
            accessToken: consentAccessToken,
            // ES-090 §b.2 CRIT-1: new token → 90-day expiry window + rotation stamp.
            ...buildVerifyTokenPatch(),
            updatedAt: new Date(),
          })
          .where(eq(geoSites.id, id));

        return NextResponse.json({
          success: true,
          requiresConsent: true,
          siteId: id,
          accessToken: consentAccessToken,
          ...(authOtp ? { authOtp, email: site.ownerEmail } : {}),
        }, { status: 200 });
      }
    }

    const accessToken = nanoid(32);
    const tokenPatch = buildVerifyTokenPatch();

    const hasCachedResults = site.pipelineStatus === "complete" && site.geoScorecard != null;

    // Skip setting discovery status for cached results and bulk audits.
    // Bulk audits go directly to 'crawling' inside the credit transaction below.
    const statusPatch = hasCachedResults || site.auditMode === "bulk"
      ? {}
      : { pipelineStatus: "discovery" };

    // Bulk sites: skip the outer update entirely — the batch transaction below handles
    // emailVerified, verificationCode, accessToken, and pipelineStatus for all sites.
    // Running this update first would clear verificationCode before the batch query can
    // use it to find sibling domains, causing the batch query to return 0 rows.
    if (site.auditMode !== "bulk") {
      await db.update(geoSites)
        .set({
          emailVerified: true,
          verificationCode: null,
          codeExpiresAt: null,
          accessToken,
          // ES-090 §b.2 CRIT-1: new token → 90-day expiry window + rotation stamp.
          ...tokenPatch,
          ...statusPatch,
          updatedAt: new Date(),
        })
        .where(eq(geoSites.id, id));
    }

    if (!hasCachedResults) {
      const domain = site.domain;

      // --- Bulk audit branch ---
      if (site.auditMode === "bulk" && site.bulkUrls && site.teamId) {
        const [team] = await db.select().from(teams).where(eq(teams.id, site.teamId));

        if (!team) {
          return NextResponse.json({ error: "Team not found." }, { status: 404 });
        }

        // Find ALL sites in this upload batch — use batchId for a reliable lookup.
        // Falls back to [site] if batchId is null (legacy rows without batchId).
        const batchSites = site.batchId
          ? await db.select().from(geoSites).where(eq(geoSites.batchId, site.batchId))
          : [site];

        // Calculate per-site crawl limits, draining the running balance in sequence.
        // freeFloorRemaining is a batch-level pool (BULK_FREE_PAGES total), NOT per-site.
        // This prevents 500 sites × 10 free pages = 5000 free pages on a 0-credit account.
        let remainingBalance = team.creditBalance;
        let freeFloorRemaining = BULK_FREE_PAGES;
        const siteUpdates: Array<{
          siteId: string;
          domain: string;
          crawlLimit: number;
          credits: number;
          token: string;
        }> = [];

        for (const s of batchSites) {
          const sUrls = (s.bulkUrls as string[] | null) ?? [];
          const urlCount = sUrls.length;
          let crawlLimitVal: number;
          let siteCredits: number;

          if (remainingBalance > 0) {
            // Paid path: credits available — compute pages from credit balance
            crawlLimitVal = Math.min(urlCount, remainingBalance * PAGES_PER_CREDIT, ABSOLUTE_MAX_PAGES);
            if (crawlLimitVal === 0) continue;
            siteCredits = Math.min(bulkCreditsRequired(crawlLimitVal), remainingBalance);
            remainingBalance -= siteCredits;
          } else {
            // Free floor path: credits exhausted — consume from the batch-level free pool
            if (freeFloorRemaining <= 0) continue;
            crawlLimitVal = Math.min(urlCount, freeFloorRemaining, ABSOLUTE_MAX_PAGES);
            if (crawlLimitVal === 0) continue;
            siteCredits = 0;
            freeFloorRemaining -= crawlLimitVal;
          }

          siteUpdates.push({
            siteId: s.id,
            domain: s.domain,
            crawlLimit: crawlLimitVal,
            credits: siteCredits,
            token: nanoid(32),
          });
        }

        if (siteUpdates.length === 0) {
          return NextResponse.json(
            { error: "Insufficient credits. Please top up before verifying." },
            { status: 402 }
          );
        }

        const totalCreditsToDeduct = siteUpdates.reduce((sum, u) => sum + u.credits, 0);
        const initialBalance = team.creditBalance;
        const now = new Date();

        await db.transaction(async (tx) => {
          // Use a SQL expression so concurrent verify calls don't double-spend
          // (avoids the read-compute-write race when initialBalance was snapshotted
          // outside the transaction).
          await tx.update(teams)
            .set({ creditBalance: sql`${teams.creditBalance} - ${totalCreditsToDeduct}` })
            .where(eq(teams.id, site.teamId!));

          let ledgerBalance = initialBalance;
          for (const update of siteUpdates) {
            const balanceBefore = ledgerBalance;
            ledgerBalance -= update.credits;
            await tx.insert(creditTransactions).values({
              id: nanoid(),
              teamId: site.teamId!,
              siteId: update.siteId,
              type: "bulk_crawl_reserve",
              pagesConsumed: update.crawlLimit,
              creditsChanged: -update.credits,
              balanceBefore,
              balanceAfter: ledgerBalance,
              createdAt: now,
            });

            await tx.update(geoSites).set({
              emailVerified: true,
              verificationCode: null,
              codeExpiresAt: null,
              accessToken: update.token,
              // ES-090 §b.2 CRIT-1: new token → 90-day expiry window + rotation stamp.
              ...buildVerifyTokenPatch(),
              crawlLimit: update.crawlLimit,
              creditsReserved: update.credits,
              pipelineStatus: "crawling",
              updatedAt: now,
            }).where(and(eq(geoSites.id, update.siteId), eq(geoSites.emailVerified, false)));
          }
        });

        console.warn(JSON.stringify({
          event: "bulk_credit_reserved",
          primarySiteId: id,
          batchId: site.batchId,
          teamId: site.teamId,
          totalCreditsDeducted: totalCreditsToDeduct,
          sitesInBatch: siteUpdates.length,
          domains: siteUpdates.map((u) => u.domain),
        }));

        // Enqueue crawl for every site in the batch
        for (const update of siteUpdates) {
          await enqueueStage({ siteId: update.siteId, domain: update.domain, stage: "crawl-fanout" });
        }

        // Link every batch site to the team so they appear on the dashboard.
        await db.insert(teamDomains)
          .values(siteUpdates.map((update) => ({
            id: nanoid(),
            teamId: site.teamId!,
            siteId: update.siteId,
            domain: update.domain,
            addedByUserId: site.userId ?? null,
            createdAt: now,
          })))
          .onConflictDoNothing();

        const primaryToken = siteUpdates.find((u) => u.siteId === id)?.token ?? siteUpdates[0].token;
        const siblings = siteUpdates
          .filter((u) => u.siteId !== id)
          .map((u) => ({ siteId: u.siteId, domain: u.domain, accessToken: u.token }));

        return NextResponse.json(
          {
            success: true,
            siteId: id,
            accessToken: primaryToken,
            ...(siblings.length > 0 ? { siblings } : {}),
          },
          { status: 200 }
        );
      }

      // --- Single audit branch: resolve maxPages via the canonical resolver ---
      // FIX-013: route the single-audit budget through resolveFirstAuditMaxPages
      // (the same resolver the /api/sites Pro fast-path and regenerate use) so
      // every first-audit entry point yields identical maxPages for identical
      // team state. This replaces the open-coded `creditBalance × PAGES_PER_CREDIT`
      // capped at ABSOLUTE_MAX_PAGES (500) — which diverged from the resolver's
      // per-audit cap and ignored subscription allowance entirely.
      //
      // A team with no budget (free tier / 0 credits) keeps FREE_MAX_PAGES: free
      // OTP audits must still run at 20 pages, so a resolver "denied" here is NOT
      // a 402 (unlike the paid Pro fast-path, which the caller already gated on
      // credits/subscription before skipping OTP).
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
              // NEW-P-01: stamp the reserved subscription page count so assemble can
              // reconcile unused pages back to monthlyPagesUsed on under-crawl.
              await db.update(geoSites)
                .set({ subscriptionPagesReserved: budget.subscriptionPages, updatedAt: new Date() })
                .where(eq(geoSites.id, id));
            }
            // Credit overflow is reserved (credit-pool model).
            if (budget.creditsToReserve > 0) {
              // FIX-014: guard the reserve with a rows-affected check (the
              // deductCredits TOCTOU pattern). The gte-guarded UPDATE can match
              // 0 rows under a concurrent debit that drained the balance between
              // the SELECT above and this UPDATE. Without checking rows-affected
              // we'd insert a single_crawl_reserve ledger row + stamp
              // creditsReserved from the stale snapshot, so reconciliation would
              // later refund credits that were never actually charged.
              const reserved = await db.update(teams)
                .set({ creditBalance: sql`${teams.creditBalance} - ${budget.creditsToReserve}` })
                .where(and(eq(teams.id, site.teamId), gte(teams.creditBalance, budget.creditsToReserve)))
                .returning({ id: teams.id });
              if (reserved.length === 0) {
                // Concurrent debit won the race — the credits are gone. Do NOT
                // write the ledger row or stamp creditsReserved; tell the client.
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

      await enqueueStage({ siteId: id, domain, stage: "discover", maxPages });
    }

    // Generate a short-lived exchange code (JWT) for cross-domain handoff.
    let exchangeCode: string | undefined;
    if (authOtp && process.env.API_JWT_SECRET) {
      try {
        const tokens = JSON.parse(authOtp) as { access_token: string; refresh_token: string };
        exchangeCode = await generateExchangeCode({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          redirect: `/sites/${id}`,
          siteToken: accessToken,
          siteId: id,
        });
      } catch (exchangeErr) {
        console.error("[Verify] Exchange code generation error:", exchangeErr);
      }
    }

    return NextResponse.json({
      success: true,
      siteId: id,
      accessToken,
      ...(authOtp ? { authOtp, email: site.ownerEmail } : {}),
      ...(exchangeCode ? { exchangeCode } : {}),
    }, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    const name = err instanceof Error ? err.name : undefined;
    // Vercel's runtime-logs API truncates the legacy console.error JSON.
    // Surface the message + name in the response body so the browser
    // network tab is enough to diagnose without log access. The full
    // stack stays in console.error for Vercel logs / Sentry.
    console.error("[verify.error]", { message, name, stack });
    return NextResponse.json(
      { error: "Internal server error", detail: message, name },
      { status: 500 },
    );
  }
}
