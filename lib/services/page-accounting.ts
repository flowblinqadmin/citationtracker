import { PAGES_PER_CREDIT, PAID_MAX_PAGES, ABSOLUTE_MAX_PAGES, bulkCreditsRequired, SUBSCRIPTION_TIERS, type SubscriptionTier } from "@/lib/config";

interface TeamBudgetInput {
  monthlyPageAllowance: number;
  monthlyPagesUsed: number;
  creditBalance: number;
}

interface CrawlBudget {
  subscriptionPages: number;
  creditPages: number;
  /** Credits needed to cover all overflow — may exceed creditBalance when denied=true */
  creditsRequired: number;
  /** Safe amount to actually deduct — always ≤ creditBalance */
  creditsToDeduct: number;
  denied: boolean;
}

/**
 * Resolve how many pages a team can crawl given their subscription allowance and credit balance.
 * Subscription pages are consumed first, then credits fill the gap.
 */
export function resolveCrawlBudget(
  team: TeamBudgetInput,
  requestedPages: number,
): CrawlBudget {
  const subscriptionRemaining = Math.max(0, team.monthlyPageAllowance - team.monthlyPagesUsed);
  const subscriptionPages = Math.min(requestedPages, subscriptionRemaining);
  const pagesStillNeeded = requestedPages - subscriptionPages;

  const affordableFromCredits = team.creditBalance * PAGES_PER_CREDIT;
  const creditPages = Math.min(pagesStillNeeded, affordableFromCredits);

  // creditsRequired = what you'd need to cover all overflow (may exceed balance)
  const creditsRequired = pagesStillNeeded > 0 ? Math.ceil(pagesStillNeeded / PAGES_PER_CREDIT) : 0;
  // creditsToDeduct = safe amount to deduct — always ≤ creditBalance
  const creditsToDeduct = Math.min(creditsRequired, team.creditBalance);
  // denied = can't fulfill the full request
  const denied = requestedPages > 0 && subscriptionPages + creditPages < requestedPages;

  return { subscriptionPages, creditPages, creditsRequired, creditsToDeduct, denied };
}

// ── ES-B7 ─────────────────────────────────────────────────────────────────
// First-audit / re-audit max-pages calc shared between
// `app/api/sites/route.ts` Pro fast-path and
// `app/api/sites/[id]/regenerate/route.ts`. Single source of truth so both
// routes produce identical maxPages for identical team state.
//
// Contract (per ES-B7 §c AC-B7-1..AC-B7-4):
//   - Active subscriber with subscription headroom → min(remaining, tier cap),
//     where the per-audit cap is the plan tier's maxAuditPages
//     (starter 100, growth 500, pro null = uncapped/bounded only by the
//     remaining monthly allowance).
//   - Else (credit-only / no active sub) → min(creditBalance × PAGES_PER_CREDIT,
//     PAID_MAX_PAGES).
//   - maxPages=0 means denied: caller returns 402.

export interface FirstAuditTeamInput {
  monthlyPageAllowance: number;
  monthlyPagesUsed: number;
  creditBalance: number;
  subscriptionTier: string;
  subscriptionStatus: string;
}

export interface FirstAuditMaxPages {
  maxPages: number;
  /** Subscription pages consumed by this audit (caller increments monthlyPagesUsed by this). */
  subscriptionPages: number;
  /** Credits to deduct (and to use as the crawl_reserve ledger amount). */
  creditsToReserve: number;
  /** Source of the budget: 'subscription' | 'credits' | 'denied'. */
  source: "subscription" | "credits" | "denied";
  denied: boolean;
}

export function resolveFirstAuditMaxPages(team: FirstAuditTeamInput): FirstAuditMaxPages {
  const DENIED: FirstAuditMaxPages = {
    maxPages: 0,
    subscriptionPages: 0,
    creditsToReserve: 0,
    source: "denied",
    denied: true,
  };

  const subscriptionRemaining = Math.max(
    0,
    team.monthlyPageAllowance - team.monthlyPagesUsed,
  );
  const isActiveSubscriber =
    team.subscriptionTier !== "free" && team.subscriptionStatus === "active";

  // Resolved once: distinguishes a known tier's null maxAuditPages (Pro =
  // uncapped) from an unknown tier (undefined). FIX-018 (slot 4) will type
  // subscriptionTier as SubscriptionTier and let us drop this `as` cast.
  const tier = SUBSCRIPTION_TIERS[team.subscriptionTier as SubscriptionTier] as
    | (typeof SUBSCRIPTION_TIERS)[SubscriptionTier]
    | undefined;

  // FIX-008 / FIND-SILENTFAILURE-015: an "active" subscription that does not map
  // to a known PAID tier is a provisioning contradiction — a free tier carrying
  // an active status, or a corrupt/unknown tier string, means the webhook tier
  // entitlement was never applied. Deny + alert so it surfaces, rather than
  // silently capping the paid audit at the free / PAID_MAX_PAGES default (which
  // hid the misprovision and under-delivered the paid audit).
  if (team.subscriptionStatus === "active" && (team.subscriptionTier === "free" || !tier)) {
    console.error(
      JSON.stringify({
        event: "page_budget_provisioning_contradiction",
        subscriptionTier: team.subscriptionTier,
        subscriptionStatus: team.subscriptionStatus,
        reason: team.subscriptionTier === "free" ? "free_tier_active_status" : "unknown_active_tier",
      }),
    );
    return DENIED;
  }

  if (isActiveSubscriber && subscriptionRemaining > 0) {
    // Per-audit page cap gated by the plan tier's maxAuditPages:
    // starter 100, growth 500, pro null = uncapped (bounded only by the
    // remaining monthly allowance). `tier` is guaranteed defined here — the
    // contradiction guard above denied any active free/unknown tier.
    const tierCap: number | null = tier ? tier.maxAuditPages : PAID_MAX_PAGES;
    const maxPages = tierCap === null ? subscriptionRemaining : Math.min(subscriptionRemaining, tierCap);
    return {
      maxPages,
      subscriptionPages: maxPages,
      creditsToReserve: 0,
      source: "subscription",
      denied: false,
    };
  }

  // Credit-pool / pay-as-you-go funding model. BUG-001/003 (FIX-008): the
  // production subscription-signup model funds audits from the credit pool with
  // monthlyPageAllowance=0, so an active Pro lands HERE, not in the subscription
  // branch. It must be capped by the active TIER's per-audit limit — NOT the
  // flat PAID_MAX_PAGES=100 that capped Pro at 100 regardless of its 10000-page
  // tier. maxAuditPages=null (Pro = uncapped) is bounded by the hard system
  // ceiling ABSOLUTE_MAX_PAGES. A non-subscriber stays capped at PAID_MAX_PAGES.
  const creditCap =
    isActiveSubscriber && tier
      ? tier.maxAuditPages === null
        ? ABSOLUTE_MAX_PAGES
        : Math.min(tier.maxAuditPages, ABSOLUTE_MAX_PAGES)
      : PAID_MAX_PAGES;
  const fromCredits = Math.min(team.creditBalance * PAGES_PER_CREDIT, creditCap);
  if (fromCredits <= 0) {
    return DENIED;
  }
  return {
    maxPages: fromCredits,
    subscriptionPages: 0,
    creditsToReserve: bulkCreditsRequired(fromCredits),
    source: "credits",
    denied: false,
  };
}
