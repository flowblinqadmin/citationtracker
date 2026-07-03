// Post-payment account provisioning shared by unauthenticated, payment-first
// checkout flows (currently: subscription-signup; mirrors the inline logic the
// $10 audit-purchase webhook branch already runs).
//
// Given the email that actually paid, this idempotently:
//   1. creates (or finds) a confirmed Supabase auth user,
//   2. provisions a team for that user (0 signup bonus — they paid),
//   3. generates a magic link so the buyer can sign in passwordlessly.
//
// On failure it returns { succeeded:false, reason } with a typed
// ProvisionFailureReason (FIX-016) so the caller can alert specifically and
// decide whether to return 500 to Stripe for an idempotent retry vs skip side
// effects. It NEVER throws — a webhook must not 500 a paid session on an
// unhandled exception; the typed reason carries the failure instead.

import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { ensureTeamForUser, ProvisionError, type ProvisionFailureReason } from "@/lib/services/provision-team";

export interface ProvisionFromCheckoutResult {
  succeeded: boolean;
  /** Typed failure reason (FIX-016) — set on every succeeded === false result.
   * Optional only because it is absent on the success path. Callers branch on
   * this to alert + decide whether to 500 for an idempotent retry. */
  reason?: ProvisionFailureReason;
  supaUserId?: string;
  teamId?: string;
  /** Supabase magic-link action URL (for the confirmation email). NEVER log this. */
  magicLink?: string | null;
}

const MAGIC_LINK_TTL_MS = 60 * 60 * 1000; // Supabase default

export const magicLinkExpiresAt = (link: string | null | undefined) =>
  link ? new Date(Date.now() + MAGIC_LINK_TTL_MS) : null;

/**
 * Idempotently create/find the Supabase user for `email`, provision their team,
 * and mint a magic link. `redirectTo` is where the magic link lands after sign-in.
 */
export async function provisionUserAndTeamFromEmail(
  email: string,
  opts?: { redirectTo?: string },
): Promise<ProvisionFromCheckoutResult> {
  const customerEmail = (email ?? "").trim().toLowerCase();
  if (!customerEmail) return { succeeded: false, reason: "user_not_found" };

  try {
    const supaAdmin = getSupabaseAdmin();
    // No admin client (missing service-role config, or test/build): we cannot
    // create or locate the Supabase user, so classify as user_not_found rather
    // than returning a reasonless failure the caller can't act on.
    if (!supaAdmin) return { succeeded: false, reason: "user_not_found" };

    // ── 1. Create (or find) the Supabase user ────────────────────────────────
    let supaUserId: string | undefined;
    const { data: createData, error: createErr } = await supaAdmin.auth.admin.createUser({
      email: customerEmail,
      email_confirm: true,
    });

    if (createErr) {
      const msg = createErr.message ?? "";
      const alreadyRegistered =
        msg.includes("already been registered") ||
        msg.includes("already has been registered") ||
        msg.includes("already registered");
      if (!alreadyRegistered) {
        throw new Error(`createUser failed: ${msg}`);
      }
      // Collision: paginate listUsers to find the existing user (default page is
      // 1000 — without pagination a >1000-user project silently misses matches).
      const PAGE_SIZE = 1000;
      const MAX_PAGES = 100;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { data: listData } = await supaAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
        const users = listData?.users ?? [];
        const match = users.find(
          (u) => typeof u.email === "string" && u.email.toLowerCase() === customerEmail,
        );
        if (match) {
          supaUserId = match.id;
          break;
        }
        const pagination = listData as { nextPage?: number | null } | undefined;
        if (users.length < PAGE_SIZE || pagination?.nextPage == null) break;
      }
      if (!supaUserId) {
        console.warn("[provision-from-checkout] createUser collision but listUsers found no match");
      }
    } else {
      supaUserId = createData.user.id;
    }

    // ── 2. Magic link ────────────────────────────────────────────────────────
    const appBase = process.env.NEXT_PUBLIC_APP_URL ?? "https://geo.flowblinq.com";
    const redirectTo = opts?.redirectTo ?? `${appBase}/dashboard?welcome=1`;
    const { data: linkData, error: linkErr } = await supaAdmin.auth.admin.generateLink({
      type: "magiclink",
      email: customerEmail,
      options: { redirectTo },
    });
    if (linkErr) {
      console.warn(
        `[provision-from-checkout] generateLink failed (continuing with supaUserId=${supaUserId ?? "undefined"}): ${linkErr.message}`,
      );
    }
    if (!supaUserId && linkData?.user?.id) {
      supaUserId = linkData.user.id;
    }
    const magicLink = linkData?.properties?.action_link ?? null;

    if (!supaUserId) return { succeeded: false, reason: "user_not_found", magicLink };

    // ── 3. Team (skipBonus: they paid — no free signup credits) ───────────────
    const { teamId } = await ensureTeamForUser(supaUserId, customerEmail, { skipBonus: true });
    if (!teamId) return { succeeded: false, reason: "team_failed", supaUserId, magicLink };

    return { succeeded: true, supaUserId, teamId, magicLink };
  } catch (err) {
    // ensureTeamForUser throws ProvisionError("link_failed") for orphan-site
    // linking failures; any other thrown error is classified team_failed.
    const reason: ProvisionFailureReason =
      err instanceof ProvisionError ? err.reason : "team_failed";
    console.error("[provision-from-checkout] provisioning failed:", err);
    return { succeeded: false, reason };
  }
}
