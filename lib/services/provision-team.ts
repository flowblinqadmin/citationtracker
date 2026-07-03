import { db } from "@/lib/db";
import { teams, teamMembers, teamDomains, geoSites, creditTransactions } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { SIGNUP_BONUS_CREDITS } from "@/lib/config";

/**
 * Typed provisioning failure reason (FIX-016). Lets callers (the Stripe webhook
 * and the verify route) alert specifically and decide whether to return 500 for
 * an idempotent retry, instead of collapsing every failure into a generic
 * boolean.
 *   - user_not_found: could not create or locate the Supabase auth user.
 *   - team_failed:    team creation / membership write failed.
 *   - link_failed:    orphan-site linking failed.
 */
export type ProvisionFailureReason = "user_not_found" | "link_failed" | "team_failed";

/** Carries a {@link ProvisionFailureReason} so callers can branch on it. */
export class ProvisionError extends Error {
  constructor(
    public readonly reason: ProvisionFailureReason,
    message?: string,
    options?: { cause?: unknown },
  ) {
    super(message ?? reason, options);
    this.name = "ProvisionError";
  }
}

interface ProvisionOptions {
  /** Skip signup bonus credits (e.g. free OTP verify users get pages, not credits) */
  skipBonus?: boolean;
}

interface ProvisionResult {
  teamId: string;
  isNewTeam: boolean;
}

/**
 * Idempotently link every orphan site (ownerEmail match, teamId IS NULL) to the
 * team. FIX-016: this runs on EVERY ensureTeamForUser call — not gated behind
 * the team-exists early return — so a site created after team provisioning, or
 * a prior partial link failure, self-heals on the next login. The per-site
 * (geoSites update + teamDomains insert) pairs run inside one transaction, so a
 * mid-loop failure rolls back and the affected sites stay orphan (re-linked next
 * time) rather than stranded half-linked. The orphan SELECT itself is outside
 * the transaction so the no-orphans common case touches no transaction at all
 * (keeping callers that don't provision a tx mock — e.g. the OAuth callback —
 * working).
 */
async function linkOrphanSites(
  teamId: string,
  userId: string,
  userEmail: string,
): Promise<void> {
  if (!userEmail) return;

  const orphanSites = await db
    .select()
    .from(geoSites)
    .where(and(eq(geoSites.ownerEmail, userEmail), isNull(geoSites.teamId)));

  if (orphanSites.length === 0) return;

  try {
    await db.transaction(async (tx) => {
      for (const site of orphanSites) {
        await tx
          .update(geoSites)
          .set({ teamId, userId })
          .where(eq(geoSites.id, site.id));

        await tx.insert(teamDomains).values({
          id: nanoid(),
          teamId,
          siteId: site.id,
          domain: site.domain,
          addedByUserId: userId,
          createdAt: new Date(),
        });
      }
    });
  } catch (err) {
    if (err instanceof ProvisionError) throw err;
    throw new ProvisionError(
      "link_failed",
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  }
}

/**
 * Ensures a Supabase user has a team, membership, and (optionally) signup bonus.
 * Idempotent — safe to call from both OTP verify and OAuth callback.
 *
 * Handles three cases:
 * 1. User already has a team membership → no-op (but still re-links orphans)
 * 2. User has a pending invite (email match) → accept invite (+ link orphans)
 * 3. First login → create team + owner membership + link orphan sites
 *    - OAuth callback: skipBonus=false → gets SIGNUP_BONUS_CREDITS
 *    - OTP verify: skipBonus=true → 0 credits (free users get FREE_MAX_PAGES only)
 *
 * FIX-016: orphan-site linking now runs on ALL three paths (not just first
 * login) and inside a transaction, so partial failures self-heal on the next
 * call. Link-specific failures surface as ProvisionError("link_failed"); other
 * DB errors propagate raw so the verify route's billable-flow guard (FIX-015)
 * and the "propagate, don't silence" contract still hold.
 */
export async function ensureTeamForUser(userId: string, email: string, options?: ProvisionOptions): Promise<ProvisionResult> {
  const userEmail = email.toLowerCase();

  // 1. Already has a team?
  const [existingMember] = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));

  if (existingMember) {
    // Re-run linking so orphans created since (or a prior partial failure) heal.
    await linkOrphanSites(existingMember.teamId, userId, userEmail);
    return { teamId: existingMember.teamId, isNewTeam: false };
  }

  // 2. Pending invite by email?
  const [pendingInvite] = userEmail
    ? await db.select().from(teamMembers).where(and(
        eq(teamMembers.email, userEmail),
        isNull(teamMembers.userId),
        isNull(teamMembers.inviteAcceptedAt)
      ))
    : [];

  if (pendingInvite) {
    await db
      .update(teamMembers)
      .set({ userId, inviteAcceptedAt: new Date() })
      .where(eq(teamMembers.id, pendingInvite.id));
    await linkOrphanSites(pendingInvite.teamId, userId, userEmail);
    return { teamId: pendingInvite.teamId, isNewTeam: false };
  }

  // 3. First login — create everything
  const teamId = nanoid();
  const teamName = userEmail.split("@")[0] || "My Team";
  const grantBonus = !options?.skipBonus;
  const initialCredits = grantBonus ? SIGNUP_BONUS_CREDITS : 0;

  await db.insert(teams).values({
    id: teamId,
    name: teamName,
    ownerUserId: userId,
    creditBalance: initialCredits,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await db.insert(teamMembers).values({
    id: nanoid(),
    teamId,
    userId,
    email: userEmail,
    role: "owner",
    createdAt: new Date(),
  });

  if (grantBonus) {
    await db.insert(creditTransactions).values({
      id: nanoid(),
      teamId,
      type: "signup_bonus",
      pagesConsumed: 0,
      creditsChanged: SIGNUP_BONUS_CREDITS,
      balanceBefore: 0,
      balanceAfter: SIGNUP_BONUS_CREDITS,
      createdAt: new Date(),
    });
  }

  // Auto-link orphan sites (idempotent + transactional — see linkOrphanSites).
  await linkOrphanSites(teamId, userId, userEmail);

  return { teamId, isNewTeam: true };
}
