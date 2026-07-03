/** Pricing and tier configuration — single source of truth */

// Crawl limits
export const FREE_MAX_PAGES = 20;
export const PAID_MAX_PAGES = 100;

// Credit system
export const SIGNUP_BONUS_CREDITS = 20;
export const CREDITS_PER_PACK = 100;
export const CREDITS_PRICE_CENTS = 1000;      // $10.00
export const CREDITS_PRICE_USD = 10;
export const PAGES_PER_CREDIT = 10;            // 1 credit = 10 pages (10cr per 100 pages)

// Free tier limits
export const FREE_REGENERATIONS = 0;           // free tier: initial run only, no re-runs
export const FREE_AUDIT_LIMIT = 2;             // max free audits (distinct domains) per email

// Bulk CSV audit
export const BULK_MAX_URLS = 500;             // matches ABSOLUTE_MAX_PAGES — must stay in sync
export const BULK_CREDIT_PRICE_INR = 20;      // 1 credit = 20 INR (~$0.20)
export const ABSOLUTE_MAX_PAGES = 500;        // hard system ceiling per #77
export const BULK_FREE_PAGES = 10;            // pages any Pro user gets even with 0 credits

// Crawl fan-out pipeline (TS-023)
export const CRAWL_MAX_CHUNKS = 10;                           // max concurrent Firecrawl batch jobs
export const POLL_CHUNK_INTERVAL_S = 15;                      // seconds between poll-chunk retries
export const POLL_CHUNK_CIRCUIT_BREAKER_MS = 20 * 60 * 1000; // 20 min hard limit per chunk

// AI Visibility citation check (ES-024)
//
// NOTE (BUG-010 / TS-079): citation checks are gated by the shared CREDIT POOL
// only — each check deducts a flat credit cost (see the citation-check route).
// There is NO per-tier monthly citation allowance, usage table, or overage path;
// the TS-079 monthly-allowance model is unimplemented. Documented here as the
// single source of truth for the credit-pool reality until/unless that model is
// built (which would require a usage table + per-tier allowance config).
export const CITATION_CHECK_BATCH_SIZE = 20;    // parallel (prompt × provider) pairs per batch
export const CITATION_CHECK_BATCH_DELAY_MS = 100; // ms between batches

/** Credits required for a given URL count */
export function bulkCreditsRequired(urlCount: number): number {
  return Math.ceil(urlCount / PAGES_PER_CREDIT);
}

/**
 * Subscription state needed to fund a bulk re-audit from the monthly allowance.
 * Kept structural (a projection, not the DB row type) so any caller can build it.
 */
export interface SubscriptionBudgetState {
  monthlyPageAllowance: number;
  monthlyPagesUsed: number;
  subscriptionTier: string;
  subscriptionStatus: string;
}

/**
 * Remaining monthly subscription pages for an ACTIVE paid subscriber; 0 for
 * free-tier / inactive / non-subscriber state. This is the page budget that can
 * fund a bulk re-audit before any credits are spent.
 */
export function activeSubscriptionRemaining(sub: SubscriptionBudgetState): number {
  const isActive = sub.subscriptionTier !== "free" && sub.subscriptionStatus === "active";
  return isActive ? Math.max(0, sub.monthlyPageAllowance - sub.monthlyPagesUsed) : 0;
}

/**
 * Effective crawl limit for a bulk audit / re-audit.
 *
 * Active subscribers fund the run from their remaining monthly allowance first,
 * with credits topping up beyond that — and with NO implicit BULK_FREE_PAGES
 * floor: an active subscriber who has exhausted both allowance and credits
 * resolves to 0 (the caller returns 402) instead of being silently capped at
 * 10 pages (BUG-001 / FIND-SILENTFAILURE-012).
 *
 * Credit-only / non-subscriber callers keep the legacy floor: at least
 * BULK_FREE_PAGES even with 0 credits. The `subscription` arg is OPTIONAL and
 * backward-compatible — callers that omit it get the original credit-only calc.
 */
export function effectiveCrawlLimit(
  csvUrlCount: number,
  creditBalance: number,
  subscription?: SubscriptionBudgetState,
): number {
  const fromCredits = creditBalance * PAGES_PER_CREDIT;
  const subscriptionRemaining = subscription ? activeSubscriptionRemaining(subscription) : 0;
  const isActiveSubscriber =
    !!subscription &&
    subscription.subscriptionTier !== "free" &&
    subscription.subscriptionStatus === "active";

  const affordable = isActiveSubscriber
    ? subscriptionRemaining + fromCredits
    : Math.max(fromCredits, BULK_FREE_PAGES);

  return Math.min(csvUrlCount, affordable, ABSOLUTE_MAX_PAGES);
}

// ── Subscription Tiers ──────────────────────────────────────────────────────

// `sites` = max number of distinct sites/domains an account on this tier may
// own (enforced at the site-creation boundary by FIX-013, slot 5; this config
// is the single source for that cap). `freeAllowances` was removed (BUG-011):
// it had zero runtime consumers — the real free-audit gate is FREE_AUDIT_LIMIT,
// and free SOV/competitor/download actions are gated by the binary free-vs-paid
// (has-credits) check, not a per-action quota.
export const SUBSCRIPTION_TIERS = {
  free:    { name: "Free",    price: 0,   credits: 0,     pages: 20,    maxFrequency: "manual"  as const, maxAuditPages: 20  as number | null, maxCompetitors: 3,  sites: 1  },
  starter: { name: "Starter", price: 99,  credits: 1500,  pages: 1000,  maxFrequency: "weekly"  as const, maxAuditPages: 100                  , maxCompetitors: 5,  sites: 5  },
  growth:  { name: "Growth",  price: 249, credits: 7500,  pages: 5000,  maxFrequency: "daily"   as const, maxAuditPages: 500                  , maxCompetitors: 10, sites: 10 },
  pro:     { name: "Pro",     price: 499, credits: 30000, pages: 10000, maxFrequency: "daily"   as const, maxAuditPages: null                 , maxCompetitors: 20, sites: 20 },
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;
export const CRAWL_FREQUENCIES = ["manual", "daily", "weekly", "monthly"] as const;
export type CrawlFrequency = (typeof CRAWL_FREQUENCIES)[number];

/**
 * Crawl frequencies ranked by how OFTEN they run (higher = more frequent).
 * `tier.maxFrequency` is the per-tier ceiling; a frequency is allowed iff its
 * rank <= the tier ceiling's rank. (CRAWL_FREQUENCIES above is a display list,
 * NOT a frequency ordering, so it cannot serve this comparison.) Consumed by the
 * recrawl cron clamp (FIX-023, slot 8) and the frequency PATCH validator
 * (FIX-022, slot 7) so tier.maxFrequency is no longer dead config (BUG-004).
 */
export const CRAWL_FREQUENCY_RANK: Record<CrawlFrequency, number> = {
  manual: 0,
  monthly: 1,
  weekly: 2,
  daily: 3,
};

/** True if `freq` is within the tier's maxFrequency ceiling. */
export function isFrequencyAllowedForTier(tier: SubscriptionTier, freq: CrawlFrequency): boolean {
  return CRAWL_FREQUENCY_RANK[freq] <= CRAWL_FREQUENCY_RANK[SUBSCRIPTION_TIERS[tier].maxFrequency];
}

/** Clamp `freq` down to the tier's maxFrequency ceiling when it exceeds it. */
export function clampFrequencyToTier(tier: SubscriptionTier, freq: CrawlFrequency): CrawlFrequency {
  return isFrequencyAllowedForTier(tier, freq) ? freq : SUBSCRIPTION_TIERS[tier].maxFrequency;
}

/** Crawl frequencies a tier may choose, ascending by intensity (manual → daily). */
export function allowedFrequenciesForTier(tier: SubscriptionTier): CrawlFrequency[] {
  return CRAWL_FREQUENCIES
    .filter((f) => isFrequencyAllowedForTier(tier, f))
    .sort((a, b) => CRAWL_FREQUENCY_RANK[a] - CRAWL_FREQUENCY_RANK[b]);
}

// ── Per-Action Credit Costs ─────────────────────────────────────────────────
export const ACTION_CREDITS = {
  geoAudit: 10,           // per 100 pages
  shareOfVoice: 5,
  aiChatSupport: 5,
  competitorMapping: 5,
  crawlNotification: 5,
  pdfDownload: 5,
  zipDownload: 5,
  fixHtmlRender: 5,   // Fix HTML tab paste-and-render (ux-expert-review Phase B, side-by-side view)
  weeklyOptimization: 10,
  sentimentAnalysis: 5,
  competitivePositioning: 5,
} as const;

// ── Billing ─────────────────────────────────────────────────────────────────
export type BillingInterval = "monthly" | "quarterly" | "annual";
export const BILLING_INTERVALS: readonly BillingInterval[] = ["monthly", "quarterly", "annual"];

/** Runtime guard: narrow an arbitrary string to a BillingInterval. */
export function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

/** Paid (non-free) subscription tiers. */
export type PaidTier = Exclude<SubscriptionTier, "free">;

export const QUARTERLY_DISCOUNT = 0.10; // 10% off for quarterly billing
export const ANNUAL_DISCOUNT = 0.20;    // 20% off for annual billing

/**
 * SINGLE SOURCE OF TRUTH for which billing intervals each paid tier is sold on.
 *
 * Everything that decides "can this tier be purchased on interval X" derives
 * from this map: UPFRONT_PRICES availability (below), the STRIPE_PRICE_IDS env
 * requirement (nonSellablePriceIdSlots + the reconciliation test in
 * config.test.ts), and the subscription-signup route's interval allowlist. A
 * Stripe price id configured for a (tier, interval) NOT listed here is dead
 * config.
 *
 * Intent: Starter/Growth sell monthly + quarterly (no annual). Pro sells
 * monthly + annual (no quarterly). Pro self-serve is sales-assisted ("Talk to
 * Us"), so the signup funnel additionally excludes Pro entirely (SIGNUP_PLANS).
 */
export const TIER_SELLABLE = {
  starter: ["monthly", "quarterly"],
  growth:  ["monthly", "quarterly"],
  pro:     ["monthly", "annual"],
} as const satisfies Record<PaidTier, readonly BillingInterval[]>;

/** True if `tier` can be purchased on `interval` per the single source of truth. */
export function isSellable(tier: PaidTier, interval: BillingInterval): boolean {
  return (TIER_SELLABLE[tier] as readonly BillingInterval[]).includes(interval);
}

// Upfront (prepaid multi-month) intervals: months covered + discount applied.
// Monthly is the base recurring price (SUBSCRIPTION_TIERS[tier].price), not an
// "upfront" interval, so it is not represented here.
const UPFRONT_MONTHS: Record<"quarterly" | "annual", number> = { quarterly: 3, annual: 12 };
const UPFRONT_DISCOUNT: Record<"quarterly" | "annual", number> = {
  quarterly: QUARTERLY_DISCOUNT,
  annual: ANNUAL_DISCOUNT,
};

function computeUpfrontPrice(tier: PaidTier, interval: "quarterly" | "annual"): number {
  return Math.round(
    (1 - UPFRONT_DISCOUNT[interval]) * UPFRONT_MONTHS[interval] * SUBSCRIPTION_TIERS[tier].price,
  );
}

/**
 * Upfront prices per paid tier, DERIVED from TIER_SELLABLE: each cell is the
 * computed prepaid price when that interval is sellable for the tier, else null
 * ("not purchasable"). No hand-written numbers, so no comment/value drift —
 * BUG-008 was a stale `// $4,792` comment beside an expression computing 4790.
 * Computed values: starter quarterly 267; growth quarterly 672; pro annual 4790.
 */
export const UPFRONT_PRICES: Record<PaidTier, { quarterly: number | null; annual: number | null }> =
  (Object.keys(TIER_SELLABLE) as PaidTier[]).reduce(
    (acc, tier) => {
      acc[tier] = {
        quarterly: isSellable(tier, "quarterly") ? computeUpfrontPrice(tier, "quarterly") : null,
        annual: isSellable(tier, "annual") ? computeUpfrontPrice(tier, "annual") : null,
      };
      return acc;
    },
    {} as Record<PaidTier, { quarterly: number | null; annual: number | null }>,
  );

export type UpfrontTier = keyof typeof UPFRONT_PRICES;

export const STRIPE_PRICE_IDS = {
  monthly: {
    starter: process.env.STRIPE_STARTER_PRICE_ID ?? "",
    growth:  process.env.STRIPE_GROWTH_PRICE_ID  ?? "",
    pro:     process.env.STRIPE_PRO_PRICE_ID     ?? "",
  },
  quarterly: {
    starter: process.env.STRIPE_STARTER_QUARTERLY_PRICE_ID ?? "",
    growth:  process.env.STRIPE_GROWTH_QUARTERLY_PRICE_ID  ?? "",
    pro:     process.env.STRIPE_PRO_QUARTERLY_PRICE_ID     ?? "",
  },
  annual: {
    starter: process.env.STRIPE_STARTER_ANNUAL_PRICE_ID ?? "",
    growth:  process.env.STRIPE_GROWTH_ANNUAL_PRICE_ID  ?? "",
    pro:     process.env.STRIPE_PRO_ANNUAL_PRICE_ID     ?? "",
  },
} as const;

/**
 * (tier, interval) pairs that HAVE a configured Stripe price id but are NOT
 * sellable per TIER_SELLABLE — i.e. dead env config. Empty in a healthy setup;
 * asserted by the reconciliation test in config.test.ts so a price id can never
 * be wired up without also declaring the interval sellable.
 */
export function nonSellablePriceIdSlots(): Array<{ tier: PaidTier; interval: BillingInterval }> {
  const offenders: Array<{ tier: PaidTier; interval: BillingInterval }> = [];
  for (const interval of BILLING_INTERVALS) {
    for (const tier of Object.keys(STRIPE_PRICE_IDS[interval]) as PaidTier[]) {
      if (STRIPE_PRICE_IDS[interval][tier] && !isSellable(tier, interval)) {
        offenders.push({ tier, interval });
      }
    }
  }
  return offenders;
}

/** Upfront price for a tier and billing interval. Returns null if not available. */
export function upfrontPrice(tier: PaidTier, interval: "quarterly" | "annual"): number | null {
  return UPFRONT_PRICES[tier][interval];
}

/** Annual price for a tier */
export function annualPrice(tier: PaidTier): number {
  const up = UPFRONT_PRICES[tier].annual;
  if (up !== null) return up;
  return Math.round(SUBSCRIPTION_TIERS[tier].price * 12 * (1 - ANNUAL_DISCOUNT));
}

/** Monthly equivalent when billed annually */
export function annualMonthlyPrice(tier: PaidTier): number {
  const yearly = annualPrice(tier);
  return Math.round(yearly / 12);
}

// ── Pricing Page Data (single source of truth for GEO + V0-Website) ─────────
export const PRICING_PLANS = [
  {
    key: "starter" as const,
    name: "Starter",
    tagline: "Up to 100 pages per audit",
    highlight: false,
    features: [
      "1,500 credits / month",
      "Up to 100 pages per audit",
      "Weekly crawls",
      "Share of voice",
      "Up to 5 competitors tracked",
      "AI chat support",
      "PDF & ZIP downloads",
      "Recommendations",
    ],
    cta: "Get Started",
    ctaHref: "/free-audit",
  },
  {
    key: "growth" as const,
    name: "Growth",
    tagline: "Up to 500 pages per audit",
    highlight: true,
    discountLabel: "52% more credits per dollar vs Starter",
    features: [
      "7,500 credits / month",
      "52% more credits per dollar vs Starter",
      "Up to 500 pages per audit",
      "Daily crawls",
      "Share of voice",
      "Up to 10 competitors tracked",
      "AI chat support",
      "PDF & ZIP downloads",
      "User access & team seats",
      "Bulk CSV upload",
      "Recommendations",
    ],
    cta: "Get Started",
    ctaHref: "/free-audit",
  },
  {
    key: "pro" as const,
    name: "Pro",
    tagline: "Unlimited pages per audit",
    highlight: false,
    discountLabel: "75% more credits per dollar vs Starter",
    features: [
      "30,000 credits / month",
      "75% more credits per dollar vs Starter",
      "Unlimited pages per audit",
      "Daily crawls",
      "Share of voice",
      "Up to 20 competitors tracked",
      "AI chat support",
      "PDF & ZIP downloads",
      "User access & team seats",
      "Bulk CSV upload",
      "Group membership",
      "Recommendations",
    ],
    cta: "Talk to Us",
    ctaHref: "/demo",
  },
] as const;

// ── TOS/EULA Consent Versions ────────────────────────────────────────────────
export const CURRENT_TOS_VERSION = "1.0-2026-04-02";
export const CURRENT_EULA_VERSION = "1.0-2026-04-02";

// Alpha tester domains — populated as testers connect
export const ALPHA_TESTER_DOMAINS: string[] = [
  // "example.com",
  // "happypathfire.com",
];
