# TS-079 — Pricing Migration ($99/$249/$499 + Stripe Metered Overage + Existing-Customer Migration)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-07
**Priority:** P0 — customer-visible change, requires comms and staged rollout
**Scope:** GEO app (`config.ts`, pricing page, upgrade modal, Stripe integration, credit display, migration script) + V0-Website pricing-client
**Depends on:** TS-077 (measured cost must be validated before overage formula is locked), TS-078 (response caching must be deployed before cost measurements are final)
**Supersedes:** TS-076 pricing overhaul (same subject, but TS-076's credit-pool model is replaced here with a sub + metered-overage model)

---

## 1. What

Migrate the GEO product from the current credit-pool pricing to a subscription-tier model with metered overage:

| Tier | Base / month | Sites | Free citation checks / month | Overage / check |
|------|-------------|-------|------------------------------|-----------------|
| Free | $0 | 1 | 1 lifetime | — (no overage) |
| **Starter** | **$99** | 5 | **50** | **$1.60** |
| **Growth** | **$249** | 10 | **80** | **$1.60** |
| **Pro** | **$499** | 20 | **200** | **$1.60** |

**Overage formula:** `overage = measured_variable_cost × 1.5`, recalibrated quarterly as costs fall. The current $1.60/check is derived from the TS-077 + TS-078 warm-path cost target of ~$1.06/check × 1.5 = $1.59, rounded to $1.60.

**Free allowances** are derived from `(base_sub_price) − (platform_margin) − (estimated_audit_budget)` with a floor of 50 checks on Starter. Allowances refresh monthly; unused checks do NOT roll over.

**Billing intervals:**
- **Monthly** on all paid tiers
- **Quarterly** (10% discount) on Starter and Growth only
- **Annual** (20% discount) on Pro only — matches TS-076's intended structure

**Existing customers** on the legacy credit-pool model are migrated via a comms-driven process with opt-in selection (see §8).

## 2. Why

### 2.1 The current credit-pool model is unprofitable and opaque

Per `citation-check-cost-audit.tex`:
- Legacy credit pool prices credits at $0.0173 (Pro) to $0.10 (pack), meaning a 5-credit citation check generates $0.087–$0.500 of revenue
- Measured variable cost per citation check (current in-LLM tools) is $2.55–$4.86
- Every check loses money at every tier. Pricing must change.

### 2.2 TS-077 gives us a cost floor we can actually price against

Once preemptive injection + OpenRouter + prompt caching land, per-check cost drops to ~$1.06 warm path, ~$0.58 with response caching. At that cost:
- A fixed sub + metered overage model yields positive unit economics
- A multiplier of 1.5× on variable cost gives ~33% gross margin after LLM spend
- Remaining margin covers platform costs, support, development

### 2.3 Customers actually understand "50 checks included, $1.60 per extra"

The legacy pool model required users to do credit math ("5 credits × 50 checks = 250, plus my audit is 10 credits, plus..."). The new model is legible at a glance: *"Starter gives me 50 checks a month for $99, extras are $1.60 each."*

### 2.4 Aditya's explicit direction from the cost audit session (2026-04-07)

> *"The subscription pricing stays at — $99 starter, 249$ growth, 499$ pro. Lets call them exactly what they are. [...] the pricing solution is to look at our cost, multiply it by 1.5x and then arrive at dollar value pricing for overage. We adjust our costing there."*

This spec implements that decision.

## 3. Scope

### 3.1 In scope

- `lib/config.ts` — new `SUBSCRIPTION_TIERS` shape with tier-level free allowances, overage rates, billing intervals
- `lib/config.ts` — retain `ACTION_CREDITS.shareOfVoice = 5` as legacy display only (see §5.3)
- `app/api/stripe/webhooks/route.ts` — handle metered usage reporting for overage
- New Stripe product + prices via Stripe CLI or dashboard: three subscription products (Starter, Growth, Pro), each with monthly + quarterly/annual SKUs, plus a metered "Citation Check Overage" product
- `app/api/sites/[id]/citation-check/route.ts` — check allowance before running; if over, record metered usage to Stripe
- New table: `citation_check_usage` — tracks allowance consumption per month per team
- New endpoint: `GET /api/billing/usage` — returns current month's usage, remaining allowance, projected overage
- New UI: usage meter in site dashboard header
- New UI: overage confirmation modal when a check would exceed the free allowance
- `V0-Website/src/components/pricing-client.tsx` — rewrite from JSON fetched from `GET /api/pricing`
- `app/api/pricing/route.ts` — public endpoint, returns current tier config, used by V0-Website
- `components/UpgradeModal.tsx` — rewrite to show tier features from config
- `components/PricingToggle.tsx` — rewrite from config with Monthly/Quarterly/Annual toggle
- `components/SitePageClient.tsx` — replace credit badges with usage indicators
- `components/RowActions.tsx` — remove credit tooltips, add "1 check" tooltip on citation check action
- Migration script: `scripts/migrate-existing-customers.ts` — see §8
- Customer comms: email templates + in-app banner

### 3.2 Out of scope

- **Complete removal of the credits system.** Credits remain in the data model as a legacy concept; new customers simply don't see them. Ripping credits out of every code path is a separate cleanup spec after the migration bakes.
- **Changing the audit pipeline's cost model.** Audits continue to consume 10 credits per 100 pages under the legacy action. TS-080 will cost-audit the audit pipeline; any resulting cost-model changes are that spec's scope.
- **New tiers beyond Starter/Growth/Pro/Free.** Enterprise tier is out of scope until we have customer demand. Agency tier (multi-tenant) is out of scope until we have at least 3 agencies asking.
- **Stripe payment method UX changes.** Existing payment method collection flow stays as-is.
- **Annual and quarterly pre-pay upfront discounts beyond the flat 10% / 20%** — Aditya to confirm if we need more discount tiers before shipping.

## 4. Pricing model details

### 4.1 Tier structure (final values)

```typescript
// lib/config.ts
export const SUBSCRIPTION_TIERS = {
  free: {
    id: "free",
    name: "Free",
    baseMonthlyCents: 0,
    sites: 1,
    citationChecksPerMonth: 0,       // 1 lifetime, tracked differently
    lifetimeCitationChecks: 1,
    overageUsd: 0,                    // no overage — hard gate
    intervals: ["monthly"],            // free only
    features: [
      "1 site",
      "1 lifetime citation check",
      "Basic audit score",
      "Upgrade anytime",
    ],
  },
  starter: {
    id: "starter",
    name: "Starter",
    baseMonthlyCents: 9900,
    baseQuarterlyCents: 26730,        // 10% off: 99 × 3 × 0.9
    sites: 5,
    citationChecksPerMonth: 50,
    overageUsd: 1.60,
    intervals: ["monthly", "quarterly"],
    features: [
      "5 sites",
      "50 citation checks / month",
      "Full audit pipeline",
      "Weekly scheduled checks",
      "$1.60 per additional check",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    baseMonthlyCents: 24900,
    baseQuarterlyCents: 67230,        // 10% off: 249 × 3 × 0.9
    sites: 10,
    citationChecksPerMonth: 80,
    overageUsd: 1.60,
    intervals: ["monthly", "quarterly"],
    features: [
      "10 sites",
      "80 citation checks / month",
      "Full audit pipeline",
      "Weekly scheduled checks",
      "Priority support",
      "$1.60 per additional check",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    baseMonthlyCents: 49900,
    baseAnnualCents: 479040,           // 20% off: 499 × 12 × 0.8
    sites: 20,
    citationChecksPerMonth: 200,
    overageUsd: 1.60,
    intervals: ["monthly", "annual"],
    features: [
      "20 sites",
      "200 citation checks / month",
      "Full audit pipeline",
      "Daily scheduled checks",
      "Priority support",
      "Competitor benchmarking",
      "API access",
      "$1.60 per additional check",
    ],
  },
} as const;

export const OVERAGE_FORMULA_MULTIPLIER = 1.5;
// Recalibrated quarterly as measured cost falls.
// Current: $1.06 warm-path × 1.5 = $1.59 → rounded to $1.60

export const USAGE_RESET_DAY_OF_MONTH = 1;  // allowances reset on the 1st
```

### 4.2 Legacy credit display

The `ACTION_CREDITS` constant remains in `config.ts` for one reason: existing customer accounts still show a "credits remaining" balance in the UI. Rather than delete that field (which would confuse migrating users), we:

- Keep `ACTION_CREDITS.shareOfVoice = 5` as legacy metadata
- Display "N/A (Starter/Growth/Pro plan)" next to the credit balance for migrated users
- Only show a real credit count for legacy users on the old pool model during the migration window
- After the 90-day migration window closes, credits are hidden from the UI entirely (separate cleanup spec)

### 4.3 Usage tracking

New table:

```sql
-- Migration: T226-citation-check-usage
CREATE TABLE citation_check_usage (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  check_id     uuid NOT NULL,                  -- idempotency key from the check request
  checked_at   timestamptz NOT NULL DEFAULT now(),
  billing_month date NOT NULL,                 -- first of month, e.g. 2026-04-01
  was_overage  boolean NOT NULL DEFAULT false, -- true if this check exceeded allowance
  overage_cents integer NOT NULL DEFAULT 0,    -- dollar amount billed (0 if within allowance)
  stripe_usage_record_id text,                 -- populated after reporting to Stripe
  UNIQUE (check_id)
);

CREATE INDEX idx_citation_check_usage_team_month
  ON citation_check_usage (team_id, billing_month);

CREATE INDEX idx_citation_check_usage_unreported
  ON citation_check_usage (billing_month, stripe_usage_record_id)
  WHERE stripe_usage_record_id IS NULL AND was_overage = true;
```

The partial index on unreported overages drives the Stripe usage reporter cron.

### 4.4 Allowance check logic

```typescript
// lib/services/citation-check-gate.ts
export async function checkAllowanceAndReserve(teamId: string, siteId: string): Promise<{
  allowed: boolean;
  reason?: "over_allowance" | "free_tier_exhausted" | "subscription_inactive";
  remainingAllowance: number;
  willBeOverage: boolean;
  overageCents: number;
  checkId: string;
}> {
  const team = await getTeamWithSubscription(teamId);
  const tier = SUBSCRIPTION_TIERS[team.subscriptionTier];
  const billingMonth = firstOfCurrentMonth();

  // Free tier: lifetime gate
  if (tier.id === "free") {
    const lifetimeUsed = await countLifetimeCitationChecks(teamId);
    if (lifetimeUsed >= tier.lifetimeCitationChecks) {
      return { allowed: false, reason: "free_tier_exhausted", remainingAllowance: 0, willBeOverage: false, overageCents: 0, checkId: "" };
    }
  }

  // Paid tiers: monthly allowance + overage
  const usedThisMonth = await countCitationChecksThisMonth(teamId, billingMonth);
  const remaining = tier.citationChecksPerMonth - usedThisMonth;
  const willBeOverage = remaining <= 0;

  // Subscription must be active to incur overage
  if (willBeOverage && team.subscriptionStatus !== "active") {
    return { allowed: false, reason: "subscription_inactive", remainingAllowance: 0, willBeOverage: true, overageCents: Math.round(tier.overageUsd * 100), checkId: "" };
  }

  // Reserve the check — creates the row with was_overage flag, no Stripe report yet
  const checkId = crypto.randomUUID();
  await reserveCheck({ teamId, siteId, checkId, billingMonth, wasOverage: willBeOverage, overageCents: willBeOverage ? Math.round(tier.overageUsd * 100) : 0 });

  return {
    allowed: true,
    remainingAllowance: Math.max(0, remaining - 1),
    willBeOverage,
    overageCents: willBeOverage ? Math.round(tier.overageUsd * 100) : 0,
    checkId,
  };
}
```

The check route calls this before running the citation check. On success, it passes the `checkId` through to `runCitationCheck()`; on failure (any LLM error), the reserved row is marked `failed` and not counted against the allowance.

### 4.5 Stripe metered reporting

A cron runs every 6 hours (`0 */6 * * *`) that:

1. Reads rows from `citation_check_usage` where `was_overage = true AND stripe_usage_record_id IS NULL`
2. Groups by team → subscription → counts
3. Reports usage to the metered overage subscription item via Stripe's `subscription_items.create_usage_record`
4. Records the returned `usage_record.id` back to the DB row

This decouples user-facing latency from Stripe latency. A check completes immediately; its billing impact shows up on the next invoice.

## 5. UI changes

### 5.1 Pricing page (V0-Website + GEO app)

Three-tier layout (Free, Starter, Growth, Pro), with a billing-interval toggle at the top. Toggle options: Monthly / Quarterly / Annual. Per-tier the toggle shows:
- Starter: Monthly / Quarterly only (Annual greyed out or hidden)
- Growth: Monthly / Quarterly only
- Pro: Monthly / Annual only (Quarterly greyed out or hidden)

Feature lists come from `SUBSCRIPTION_TIERS[tier].features` verbatim — no hardcoding.

### 5.2 Dashboard header usage meter

New component: `UsageMeter` in the top header bar, shows:
- `{used} / {total} citation checks this month`
- Progress bar, red at >90%
- "Out of checks" state at 100%, with "Next check: +$1.60" warning

On click, opens a detail sheet with per-site breakdown.

### 5.3 Overage confirmation modal

When a user initiates a citation check that would exceed their allowance:

```
You've used all 50 citation checks on your Starter plan this month.

Running this check will add $1.60 to your next invoice.
You've run 2 overage checks so far this month (total: $3.20).

[ Cancel ]   [ Run anyway — $1.60 ]
```

The modal is dismissible and remembers the user's "don't ask again this session" preference. Confirmed overages are recorded to `citation_check_usage.was_overage = true`.

### 5.4 Upgrade modal

Existing `UpgradeModal.tsx` is rewritten to:
- Pull tier data from `/api/pricing`
- Show "you'll save $X/month by upgrading to {tier} instead of paying overage"
- Pre-select the next-tier-up when triggered from an overage event

### 5.5 Row actions on site table

Remove the "costs 5 credits" tooltip from citation check buttons. Replace with:
- Within allowance: "1 check — 47 remaining"
- At allowance limit: "$1.60 overage"

## 6. Stripe configuration

Three subscription products, each with multiple prices:

```
Product: Flowblinq Starter
  Price: starter_monthly_usd      — $99/mo, recurring month
  Price: starter_quarterly_usd    — $267/qtr, recurring every 3 months

Product: Flowblinq Growth
  Price: growth_monthly_usd       — $249/mo, recurring month
  Price: growth_quarterly_usd     — $672/qtr, recurring every 3 months

Product: Flowblinq Pro
  Price: pro_monthly_usd          — $499/mo, recurring month
  Price: pro_annual_usd           — $4,790/yr, recurring year

Product: Citation Check Overage
  Price: citation_overage_metered — $1.60 per unit, metered, aggregated per month
```

Every subscription has TWO items: the base tier item + the metered overage item. Usage reporting targets the metered item's subscription_item_id.

Stripe product creation is a manual one-time ops task, performed by the person deploying this spec. The resulting price IDs are stored in `lib/config.ts` as environment-specific constants (different in staging vs. production).

## 7. Migration strategy for existing customers

### 7.1 Inventory first

Before communicating anything, run `scripts/audit-existing-customers.ts` to produce a snapshot of:

- Every paying customer, their current tier, their credit balance, their monthly credit consumption average over the last 90 days
- Classification into cohorts:
  - **Cohort A:** Heavy users (>50 checks/month) — will likely need Growth or Pro under the new plan
  - **Cohort B:** Light users (<50 checks/month) — Starter is cheaper than their current spend
  - **Cohort C:** Dormant (<5 checks/month over last 60 days) — Free tier or churn risk
  - **Cohort D:** Credit-pack buyers (no sub) — require a different conversion path
- Customers whose current tier spend exceeds their proposed new tier spend ("winners")
- Customers whose current tier spend is below their proposed new tier spend ("losers")

### 7.2 Comms sequence

Day -14: Email to all paying customers announcing the pricing change, effective date, and the migration tool.

Day -14 through Day 0: Migration tool available in-app. Each customer sees a personalized panel:
- "Under the new pricing, you'd be on {recommended tier} at ${x}/mo"
- "Your current plan cost: ${y}/mo. Difference: +${delta} or -${delta}"
- Three actions: *Accept recommendation*, *Choose different tier*, *Grandfather on legacy plan for 90 days*

Day 0: New pricing goes live for all new signups. Existing customers stay on legacy pricing by default for 90 days.

Day 0 through Day 90: Grandfathered customers can migrate at any time via the in-app tool. Customers who proactively migrate get a one-time 20% discount on their first month.

Day 90: All remaining grandfathered customers are force-migrated to the recommended tier, with a 14-day notice email.

### 7.3 Credit balance handling

Legacy credit balances are converted via this formula:

```
new_tier_credit_value = (credit_balance × blended_credit_price) / citation_check_price
converted_free_checks = floor(new_tier_credit_value)
```

Where:
- `blended_credit_price` = the price per credit the customer was paying (starter $0.0692, growth $0.0334, pro $0.0173, pack $0.10)
- `citation_check_price` = $1.60 (the overage rate)

So a Growth customer with 500 unused credits gets `(500 × $0.0334) / $1.60 = 10 bonus citation checks` added to their first month's allowance under the new plan. This caps at 200 bonus checks total.

Customers with active Credit Packs (one-time purchase) are refunded pro-rata if they choose to downgrade during migration.

### 7.4 Subscription-to-subscription transition

Stripe's subscription update API handles the mid-cycle transition:
- `prorate: true` — Stripe credits the unused portion of the old sub to the new sub
- `proration_behavior: "create_prorations"` — surfaces the credit on the next invoice
- Upgrade (e.g., Starter → Growth): takes effect immediately, proration on next invoice
- Downgrade (e.g., Growth → Starter): takes effect at end of current billing cycle to avoid clawback awkwardness

## 8. Rollout plan

### 8.1 Phase 1 — Build + stage (before migration window opens)

1. Ship `SUBSCRIPTION_TIERS` config + `citation_check_usage` DDL + allowance gate in staging
2. Create Stripe test products (use Stripe's test mode) with the same shape
3. Ship new pricing page + upgrade modal + usage meter in staging behind feature flag
4. Internal dogfooding: 5 staff accounts go through the migration flow end-to-end
5. Fix any UX friction; produce the migration-comms copy

### 8.2 Phase 2 — Comms + tool launch

1. Send Day -14 email to all paying customers
2. Deploy the in-app migration tool (feature-flagged on for legacy customers only)
3. Monitor migration acceptance rate daily; target 30% proactive acceptance in the first week

### 8.3 Phase 3 — New-customer cutover

1. On Day 0, deploy new Stripe products in production
2. Update `GET /api/pricing` to return the new tiers
3. Flip the pricing page to the new layout
4. New signups see new pricing; legacy customers see grandfather notice banner
5. Monitor: signup conversion rate (target: no regression > 10% from baseline)

### 8.4 Phase 4 — Grandfather expiry

1. On Day 76: final-notice email to remaining grandfathered customers
2. On Day 90: automatic migration of remaining customers to their recommended tier
3. Monitor churn in Day 90–120 window; if churn exceeds 5% of the force-migrated cohort, extend grandfather window by 30 days and re-evaluate

### 8.5 Phase 5 — Cleanup

1. Remove legacy credit-pool code paths from the pricing check layer
2. Remove credit display from UI (separate follow-up spec, not this one)
3. Archive TS-076 as "superseded by TS-079"

## 9. Acceptance criteria

### 9.1 Functional

- ✅ New tier structure visible on pricing page (both GEO app and V0-Website)
- ✅ New customers can sign up for Starter/Growth/Pro via Stripe checkout
- ✅ Allowance gate correctly blocks or permits checks based on `citation_check_usage` rollup
- ✅ Overage checks reach Stripe as metered usage and appear on the next invoice
- ✅ Usage meter in dashboard header updates live after each citation check
- ✅ Overage confirmation modal displays before the check runs (not after)
- ✅ Migration tool produces correct per-customer recommendation
- ✅ Grandfather window correctly preserves legacy pricing for 90 days

### 9.2 Economic

- ✅ Per-check gross margin (revenue vs. variable cost) ≥ 30% at Pro tier on day 1
- ✅ Per-check gross margin ≥ 40% at Pro tier after caching bedding in (measured Day +30)
- ✅ Legacy customer migration does not decrease MRR by more than 10% in Month 1
- ✅ New customer ACV (Annual Contract Value) ≥ $1,500 blended (reasonable at $99/$249/$499 mix)

### 9.3 Customer experience

- ✅ Migration email open rate ≥ 40% (benchmark from prior comms)
- ✅ In-app migration tool completion rate ≥ 30% in first 14 days
- ✅ Support tickets related to pricing change ≤ 20% of all tickets in week 1
- ✅ Churn in the first 30 days post-launch ≤ 5% above baseline

## 10. Risks

### 10.1 Measured cost is higher than TS-077 target

**Risk:** TS-077 ships and measured cost is $1.40/check instead of $1.06. Overage formula 1.5× yields $2.10, not $1.60. Pricing needs to be revised post-launch.

**Likelihood:** Medium. Analytical estimates have wide error bars.

**Mitigation:**
1. **Hard gate:** Do not ship TS-079 until TS-077 + TS-078 have been in production for 7 days with measured per-check cost data from `llm_call_log`
2. If measured cost is >$1.10, revise the overage rate to $1.80 before launch (still round, still memorable)
3. If measured cost is >$1.30, escalate to Aditya — may need to bump the base tier prices or free allowance counts

### 10.2 Churn from price-sensitive customers

**Risk:** Customers who were paying $50/month effectively (via a smaller credit pack) now face a minimum $99 Starter, feel priced out, and churn.

**Likelihood:** Real. Will hit some portion of Cohort C (dormant users).

**Mitigation:**
1. Free tier (1 lifetime check, 1 site) gives them a landing pad
2. Migration tool explicitly shows: "Based on your usage, Free tier is right for you — keep your 1 site, no charges"
3. Accept the churn from users who were losing us money anyway

### 10.3 Overage shock

**Risk:** A Starter customer runs 200 checks in a month, gets hit with $240 in overage, and disputes the charge.

**Likelihood:** Low with the confirmation modal; high without it.

**Mitigation:**
1. **Mandatory confirmation modal** on first overage of the month — not dismissible
2. Hard cap at $1,000/mo overage per customer; checks beyond that require contacting support (protects against runaway scripts)
3. Weekly "you're approaching your allowance" email at 80% utilization
4. Dashboard usage meter is prominent

### 10.4 Stripe metered billing complexity

**Risk:** Stripe usage reporting races with billing cycles, producing off-by-one invoice bugs.

**Likelihood:** Medium. Metered billing has known footguns around timing.

**Mitigation:**
1. Report usage within 6 hours of the check running (well before month-end cutoff)
2. Use idempotency keys on all `create_usage_record` calls (checkId doubles as this)
3. Reconcile monthly: compare `citation_check_usage.was_overage = true` count against Stripe's reported usage per team
4. Alert on any discrepancy via Slack `#ops`

### 10.5 Legacy credit balance conversion is unfair to heavy buyers

**Risk:** A customer bought a 1,000-credit pack at $0.10/credit ($100). Under the conversion formula, they get `(1000 × $0.10) / $1.60 = 62 bonus checks`. They feel cheated because "I paid $100 for those credits and now I only get $100 of checks back, but I was expecting to use them for audits too."

**Likelihood:** Real for a small number of pack buyers.

**Mitigation:**
1. Offer two conversion paths: (a) convert to bonus checks under the formula, or (b) refund unused credit value pro-rata to their payment method
2. Make the choice explicit in the migration tool
3. Cap refund claims at 180 days from original purchase (standard consumer protection window)

### 10.6 Recommendation engine mis-recommends tiers

**Risk:** A seasonal user (e.g., agency that runs big reports in Q4) is recommended Starter based on their 90-day average, but actually needs Pro in December.

**Likelihood:** Medium for edge cases.

**Mitigation:**
1. Recommendation uses max(90-day avg, last month usage) × 1.2 safety margin
2. Always show the user the projected cost under each tier, let them pick
3. Allow costless upgrade at any time post-migration

## 11. Open questions for Aditya

1. **Free tier — retain or reduce?** The cost audit handoff flagged: "Keep current `freeAllowances: { audits: 2, sov: 1 }` as marketing loss-leader, or reduce to 1-lifetime?" This spec assumes **1 lifetime citation check + 1 site**. Confirm.
2. **Quarterly vs annual labeling.** Current mockup: Starter/Growth have Monthly+Quarterly, Pro has Monthly+Annual. Is this intentional or should Pro also have Quarterly? Default: as above.
3. **Grandfather window length.** Current: 90 days. Longer (120 days) is gentler but delays MRR lift. Shorter (60 days) is more aggressive. Default: 90 days.
4. **Refund policy for credit packs.** Current: refund unused portion pro-rata at migration if customer chooses. Alternative: only convert to bonus checks, no refunds. Default: offer the choice.
5. **Force-migration vs. force-churn on Day 90.** Current: automatically move non-respondents to recommended tier. Alternative: cancel their subscription and move them to Free. Default: migrate, because churn is worse.
6. **Annual/quarterly upfront discount amounts.** Current: 10% quarterly, 20% annual (matches TS-076). Confirm.
7. **Price-cap on single customer overage?** Current: $1,000/mo hard cap. Confirm or adjust.
8. **Agency tier.** This spec is silent on multi-tenant/agency pricing. If you want to add it before launch, flag now; otherwise deferred.

## 12. References

- `geo/docs/citation-check-cost-audit.tex` — the cost audit session that produced these pricing decisions
- Session handoff: `memory/session_citation_audit_2026_04_07.md` §Final decisions
- TS-076 — the superseded pricing overhaul
- TS-077 — cost architecture (must ship and be measured before this)
- TS-078 — response caching (must ship before final overage rate is locked)
- Stripe metered billing docs: https://docs.stripe.com/billing/subscriptions/usage-based
- Stripe subscription proration: https://docs.stripe.com/billing/subscriptions/prorations
