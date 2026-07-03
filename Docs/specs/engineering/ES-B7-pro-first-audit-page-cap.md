# ES-B7 — Pro/credit-holder first-audit page-cap discrepancy

**Branch:** `fix/b7-pro-first-audit-page-cap`
**Base:** `89a0afc` (forked from `e2e-comprehensive-suite`)
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate, NO Playwright per-spec.

---

## a) Overview

Same Pro user (`an@flowblinq.com`), same domain (`nixon.com`), same team credit balance, two adjacent calls produce a **5× max-page discrepancy**:

| Route | URLs prioritized | URLs crawled |
|---|---|---|
| `POST /api/sites` (Pro fast-path) | 20 | 20 |
| `POST /api/sites/[id]/regenerate` | 100 | 77 |

Earlier observations on `walmart.com`, `codewithfabric.com`, `farpointhq.com` are consistent with the same pattern — first-audit silently capped at 20 while re-audit crawls up to 100.

This spec aligns the two routes' page-budget calculation so that identical team state produces identical `maxPages`.

---

## b) Root cause — SPEC-RIGOUR FINDING (corrects dispatch hypothesis)

The dispatch hypothesised: *"tierPages (likely 20 for Pro subscription quota)"*. **Verified WRONG.**

`lib/config.ts:50-55`:

```ts
SUBSCRIPTION_TIERS = {
  free:    { ..., pages: 20    },
  starter: { ..., pages: 1000  },
  growth:  { ..., pages: 5000  },
  pro:     { ..., pages: 10000 },
}
```

**Actual root cause** — `app/api/sites/route.ts:463-475` admits a team to the "Pro fast-path" whenever it has *EITHER* credits *OR* an active subscription:

```ts
const hasCredits = team.creditBalance > 0;
const hasSubscription = team.subscriptionTier !== "free" && team.subscriptionStatus === "active";
if (hasCredits || hasSubscription) { isPro = true; proTeam = team; }
```

A user on `subscriptionTier='free'` but with a positive `creditBalance` (e.g. signup-bonus credits, top-up purchaser) takes the Pro fast-path with `proTeam.subscriptionTier === 'free'`. At line 565-567:

```ts
const tier = proTeam.subscriptionTier as SubscriptionTier;     // 'free'
const tierPages = SUBSCRIPTION_TIERS[tier]?.pages ?? FREE_MAX_PAGES;  // 20
const requestedPages = Math.min(PAID_MAX_PAGES, tierPages);    // min(100, 20) = 20
```

`resolveCrawlBudget(team, 20)` then returns `subscriptionPages=0, creditPages=20, denied=false` (because the user has plenty of credits and asked for only 20). `maxPages = 0 + 20 = 20`. Pipeline crawls 20 pages.

Compare `app/api/sites/[id]/regenerate/route.ts:101`:

```ts
const maxPages = Math.min(team.creditBalance * PAGES_PER_CREDIT, PAID_MAX_PAGES);
```

— pure credit-balance calc, capped at 100. For a credit-only user with `creditBalance ≥ 10`, this yields 100. **Hence the 5× discrepancy.**

The discrepancy also exists in the opposite direction for an *active subscriber* (Starter/Growth/Pro): the fast-path uses `subscriptionPages + creditPages` (subscription quota), regenerate uses pure credit calc. Both yield ≤ 100 in practice, so the user-visible symptom is restricted to credit-only Free-tier users.

---

## c) Acceptance criteria

| ID | Criterion |
|---|---|
| **AC-B7-1** | For identical team state (`subscriptionTier`, `subscriptionStatus`, `monthlyPageAllowance`, `monthlyPagesUsed`, `creditBalance`) and identical domain, `POST /api/sites` (Pro fast-path) and `POST /api/sites/[id]/regenerate` MUST compute the same `maxPages` value. The two routes MUST share the budget-derivation helper (recommended: extend `resolveCrawlBudget` or extract a new `resolveFirstAuditMaxPages(team)` helper in `lib/services/page-accounting.ts` and call it from both sites). |
| **AC-B7-2** | For a Pro/Starter/Growth subscriber on `subscriptionStatus='active'` with `monthlyPagesUsed < monthlyPageAllowance`, `maxPages` honors the `PAID_MAX_PAGES = 100` cap (single-audit ceiling), even though `SUBSCRIPTION_TIERS.{starter,growth,pro}.pages` are 1000/5000/10000 respectively. The 1000/5000/10000 values represent monthly quotas, NOT per-audit caps. |
| **AC-B7-3** | For a `subscriptionTier='free'` user (no active sub) entering the Pro fast-path via the credits gate (`creditBalance > 0`), `maxPages = Math.min(creditBalance * PAGES_PER_CREDIT, PAID_MAX_PAGES)` — matching regenerate route line 101 verbatim. **No regression** for true free-tier users without credits (they are blocked by `isPro=false` and never reach the fast-path; unchanged free-audit-limit gate at line 482-486 stays intact). |
| **AC-B7-4** | Edge: Pro/Starter/Growth subscriber with `creditBalance=0` and remaining subscription pages → `maxPages = min(monthlyPageAllowance - monthlyPagesUsed, PAID_MAX_PAGES)` (uses subscription pages, capped at 100). Same edge for regenerate: regenerate route currently 402s when `creditBalance < 1`. **SpecMaster note:** regenerate route's `creditBalance < 1` 402 gate at line 104-113 should be relaxed to also accept active-subscription users with subscription pages remaining (parity with first-audit). If ScriptDev opts to defer the regenerate-route 402-relaxation to a separate spec, AC-B7-4 narrows to the first-audit side only and a follow-up TS is filed. Default: in-scope. |

---

## d) Test strategy

### d.1 Vitest UTs — `lib/services/__tests__/page-accounting.test.ts` (extend existing file)

| ID | Scenario | Input | Expected `maxPages` |
|---|---|---|---|
| **U-B7-1** | Free tier, no credits | `tier=free, sub=inactive, allowance=0, used=0, balance=0` | N/A — should not enter fast-path; helper returns `0` and route returns 402/free-flow |
| **U-B7-2** | Credit-only "Pro" (free tier with credits) | `tier=free, sub=inactive, allowance=0, used=0, balance=15` | **100** (= min(15×10, 100)) — was 20 pre-fix |
| **U-B7-3** | Credit-only edge: balance < 10 | `tier=free, sub=inactive, allowance=0, used=0, balance=3` | **30** (= min(3×10, 100)) |
| **U-B7-4** | Pro subscriber w/ headroom | `tier=pro, sub=active, allowance=10000, used=500, balance=20` | **100** (= min(allowance-used=9500, PAID_MAX_PAGES=100)) |
| **U-B7-5** | Pro subscriber, allowance exhausted, has credits | `tier=pro, sub=active, allowance=10000, used=10000, balance=20` | **100** (falls through to credits: min(20×10, 100)) |
| **U-B7-6** | Pro subscriber, allowance exhausted, no credits | `tier=pro, sub=active, allowance=10000, used=10000, balance=0` | **0** (denied — both routes should 402) |
| **U-B7-7** | Starter subscriber w/ headroom | `tier=starter, sub=active, allowance=1000, used=0, balance=0` | **100** (PAID_MAX_PAGES cap) |
| **U-B7-8** | Growth subscriber w/ headroom | `tier=growth, sub=active, allowance=5000, used=4900, balance=0` | **100** (min(remaining=100, PAID_MAX_PAGES=100)) |

All 8 cases call the **same** shared helper invoked by both routes. AC-B7-1 enforces this — direct grep test asserting the helper symbol appears in both `app/api/sites/route.ts` and `app/api/sites/[id]/regenerate/route.ts`.

### d.2 Vitest IT — `app/api/sites/__tests__/route.first-audit-cap.it.test.ts` (new file)

Sets up identical team fixture, then drives both routes back-to-back and asserts `maxPages` parity:

| ID | Scenario | Assertion |
|---|---|---|
| **IT-B7-1** | Credit-only Pro (regression case) | Insert team with `subscriptionTier='free', subscriptionStatus='inactive', creditBalance=15`. POST `/api/sites` (Pro fast-path) for `nixon-test.com`. Assert `enqueueStage` mock received `maxPages=100`. Then POST `/api/sites/[siteId]/regenerate`. Assert `enqueueStage` second call also received `maxPages=100`. |
| **IT-B7-2** | Active Pro subscriber | Insert team with `subscriptionTier='pro', subscriptionStatus='active', monthlyPageAllowance=10000, monthlyPagesUsed=0, creditBalance=20`. Both routes → `maxPages=100`. |
| **IT-B7-3** | True free user — no fast-path | Insert team with `subscriptionTier='free', subscriptionStatus='inactive', creditBalance=0`. POST `/api/sites` MUST NOT enter Pro fast-path; flow falls through to OTP path (no pipeline enqueue). Regenerate MUST 402. |

### d.3 Verification gate

Per pivot `waves-1to6-cd-pivot-2026-04-26`:

- `vitest run` → all 8 UTs + 3 ITs GREEN.
- Docker CI GREEN.
- **NO Playwright** per-spec — first-audit page-cap parity is fully unit-and-integration testable.

---

## e) Out of scope

- Regenerate route's `creditBalance < 1` 402 → 200-with-subscription-pages relaxation: in-scope per AC-B7-4 default; ScriptDev may defer with follow-up TS.
- Bulk audit page accounting (`effectiveCrawlLimit`, `BULK_FREE_PAGES=10`): unchanged.
- Subscription-quota deduction semantics (when does `monthlyPagesUsed` increment): unchanged — both routes' deduction logic stays as-is, only the *requested-pages computation* is unified.
- UI surface — no client-side change; the symptom is server-side max-pages selection.

---

## f) HolePoker pre-review checklist

- [ ] Confirm `SUBSCRIPTION_TIERS.pro.pages=10000` is correct (not 20 as dispatch hypothesised).
- [ ] Confirm shared-helper extraction satisfies AC-B7-1's grep test (same symbol in both files).
- [ ] Confirm AC-B7-3 calc `min(balance × 10, 100)` matches regenerate route line 101 verbatim.
- [ ] Confirm AC-B7-4 default scope (regenerate-route 402 relaxation in-scope) vs deferred — ScriptDev's call.
- [ ] Confirm 0 product-code edits in this spec (design-only per dispatch §hard_constraints).
