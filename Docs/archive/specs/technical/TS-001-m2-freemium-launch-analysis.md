# TS-001: M2 Freemium Launch — Gap Analysis & Critical Path

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** n/a (analysis/planning doc)  

---

**Agent:** 1-CoFounder
**Date:** 2026-02-26
**Source:** GitHub Milestone M2 (17 issues), codebase on branch `m3-supabase-implementation`

---

## CRITICAL FINDING: M2 Issues Are Partially Obsolete

The M2 issues (#35–#45) were written for a **site-level billing model** (`geo_sites.tier`, `geo_sites.credits`). However, the `m3-supabase-implementation` branch has already shipped a **team-level billing model**:

| M2 Issues Assumed | m3 Branch Actually Has |
|---|---|
| `geo_sites.tier` column | No tier column — not needed |
| `geo_sites.credits` column | `teams.creditBalance` (team-level) |
| Site-level credit deduction | Team-level credit deduction with `creditTransactions` audit log |
| Token-based auth (`accessToken`) | Supabase auth (JWT sessions, email OTP) |
| `/api/checkout` keyed by siteId+token | `/api/checkout` keyed by teamId+userId (Supabase session) |
| `/api/webhooks/stripe` updates site | `/api/webhooks/stripe` updates team |

**The team model supersedes the site model.** Issues #35 (site-level tier/credits columns) is **not needed**. The architecture has moved past it.

---

## What's Already Done (on m3-supabase-implementation)

| Issue | Status | Notes |
|---|---|---|
| #35 DB schema: tier+credits on geo_sites | **SUPERSEDED** | teams.creditBalance exists instead |
| #36 lib/config.ts | **NEEDS CHECK** | May not exist yet |
| #39 Stripe checkout endpoint | **DONE** | At /api/checkout, team-level, requires Supabase auth |
| #40 Stripe webhook | **DONE** | At /api/webhooks/stripe, adds 100 credits to team |
| #48 Supabase setup | **DONE** (closed) | Full auth pipeline working |
| #49-#60 M3 issues | **DONE** (closed) | Teams, members, domains, dashboard, auth callback |

## What's Still Missing

| Issue | Status | Effort | Dependencies |
|---|---|---|---|
| #36 lib/config.ts | **TODO** | Small | None |
| #37 Tier-aware crawl depth | **TODO** | Medium | #36 — but needs redesign for team model |
| #38 API gating (strip paid fields) | **TODO** | Medium | Needs tier concept — derive from team credits? |
| #41 Credit deduction on regenerate | **PARTIALLY DONE** | Small | Already deducts from team; may need config constants |
| #42 Dashboard paywall UI | **TODO** | Large | #38, #39 |
| #43 Post-payment toast | **TODO** | Small | #42 |
| #44 Login page /login | **SUPERSEDED** | N/A | Supabase auth/login already exists |
| #45 Pricing page /pricing | **TODO** | Medium | #36 |
| #9 Before/after scoring | **TODO** | Large | Separate milestone item |
| #11 Customer allowlist | **TODO** | Medium | Separate milestone item |
| #12 Alpha tester onboarding | **TODO** | Medium | Operational, not code |
| #13 DMZ architecture | **PARTIALLY DONE** | Small | Stripe already isolated in /api/webhooks/stripe |

---

## Recommended Approach: Reconcile M2 with M3 Reality

### Tier Derivation (no new DB column needed)

Instead of adding `tier` to `geo_sites`, derive it:
```
isPaid = team !== null && team.creditBalance > 0
```

Or more precisely:
- **Anonymous user** (no team) → free tier
- **Authenticated user, 0 credits** → free tier (exhausted)
- **Authenticated user, >0 credits** → paid tier

This means the paywall gating in the API (#38) and dashboard (#42) should check the team's credit balance, not a site-level flag.

### What to Build (Priority Order)

**Phase 1 — Config + Pipeline Gating (unblocks everything)**
1. **#36 — lib/config.ts** — Create pricing constants. Prerequisite for all other issues.
2. **#37 — Tier-aware crawl depth** — Adapt for team model: if team has credits, crawl 100 pages; otherwise 20.

**Phase 2 — Paywall + Checkout Flow**
3. **#38 — API gating** — Strip paid fields based on team credit balance, not site.tier.
4. **#42 — Dashboard paywall UI** — Blur/lock sections for free users with upgrade CTA.
5. **#43 — Post-payment toast** — Small UX polish after Stripe redirect.

**Phase 3 — Public Pages**
6. **#45 — Pricing page** — Static comparison page using config.ts constants.
7. **#44 — Login page** — MAY be superseded by existing `/auth/login`. Verify.

**Deferred (not M2 critical path)**
8. #9 — Before/after scoring (large scope, separate milestone)
9. #11 — Customer allowlist (security, can ship post-launch)
10. #12 — Alpha tester onboarding (operational)
11. #13 — DMZ architecture (partially done, refine later)

---

## Critical Path Diagram

```
#36 lib/config.ts
  │
  ├──→ #37 Tier-aware crawl depth
  │
  ├──→ #38 API gating (strip paid fields)
  │     │
  │     └──→ #42 Dashboard paywall UI
  │           │
  │           └──→ #43 Post-payment toast
  │
  └──→ #45 Pricing page
```

All paths start at #36. It's a 15-minute task. Ship it first.

---

## Risk Assessment

1. **Schema migration risk: LOW** — No new columns needed. The team model already has everything.
2. **Stripe integration risk: LOW** — Checkout + webhook already working.
3. **Paywall bypass risk: MEDIUM** — API gating (#38) is the security boundary. Must be airtight — free users should never see paid data even if they inspect network requests.
4. **Credit atomicity risk: LOW** — Already handled via `creditTransactions` table with `balanceBefore`/`balanceAfter`.
5. **Rate limit risk on crawl: MEDIUM** — Free tier 20-page crawls will be frequent. Firecrawl API limits may be hit. Monitor.

---

## Recommendation to Aditya

Ship M2 in 3 sprints:
1. **Sprint 1 (config + gating):** #36, #37, #38 — establishes the free/paid boundary
2. **Sprint 2 (paywall UI):** #42, #43 — the user-facing monetization
3. **Sprint 3 (public pages):** #45, verify #44 status — marketing and onboarding

The checkout flow and webhook are already working. The gap is purely in **what free users see** (gating) and **how they upgrade** (paywall UI). The plumbing is done.

Estimated: 6-8 tasks for ScriptDev, 1-2 for OpsMaster (middleware updates), ReviewMaster reviews each.
