# TS-076 — Pricing Overhaul (Credits-Based, Single Source of Truth)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-04
**Priority:** P1
**Scope:** GEO app + V0-Website

---

## 1. What

Overhaul pricing from the current hardcoded per-repo model to a credits-based system with a single source of truth in GEO's `config.ts`, served via API to V0-Website.

## 2. Why

Current state:
- Pricing hardcoded separately in GEO (`PricingToggle.tsx`) and V0-Website (`pricing-client.tsx`) — out of sync risk
- V0-Website toggle ("Monthly" / "Pay upfront") doesn't function correctly
- Per-action credit costs only shown on 2 of 5 action buttons in GEO
- Dashboard `RowActions.tsx` shows no credit costs on hover
- Features lists include unbuilt features (dedicated account manager, additional prompts, social media mapping, content writing)
- Free tier was over-gated (citations/competitors blocked)

## 3. Pricing Model (from PricingDiscussionSheet.csv)

### 3A. Monthly Prices

| Tier | Monthly Price | Credits/Month | USD/Credit | Discount vs Starter |
|------|-------------|--------------|-----------|-------------------|
| Free | $0 | 0 | — | — |
| Starter | $99 | 1,430 | $0.07 | — |
| Growth | $249 | 7,465 | $0.03 | 52% more per $ |
| Pro | $499 | 28,915 | $0.02 | 75% more per $ |

### 3B. Billing Intervals

| Tier | Monthly | Quarterly (10% off) | Annual (20% off) |
|------|---------|-----------|--------|
| Starter | $99/mo | $267/qtr (save $30) | ✗ |
| Growth | $249/mo | $672/qtr (save $75) | ✗ |
| Pro | $499/mo | ✗ | $4,792/yr (save $1,196) |

Formula: quarterly = 0.9 × 3 × monthly, annual = 0.8 × 12 × monthly.
Toggle labels: "Monthly" / "Quarterly".

### 3C. Per-Action Credit Costs

| Action | Credits/Use |
|--------|-----------|
| GEO Audit (per 100 pages) | 10 |
| Share of Voice | 5 |
| AI Chat Support | 5 |
| Competitor Mapping | 5 |
| Crawl Notification | 5 |
| PDF Report Download | 5 |
| ZIP Download | 5 |
| Weekly Optimization | 10 |
| Sentiment Analysis | 5 |
| Competitive Positioning | 5 |

### 3D. Credits Are a Common Bucket

All credits go into one pool per team. No per-feature usage restrictions. A user can spend all credits on audits or all on citations. We do NOT gate features by credit type — only by tier feature access.

### 3E. Tier Feature Gating (what's available, not credit-gated)

| Feature | Free | Starter | Growth | Pro |
|---------|------|---------|--------|-----|
| GEO Audit | ✓ (20 pages max) | ✓ (100 pages) | ✓ (500 pages) | ✓ (unlimited) |
| Crawl frequency | Manual | Weekly | Daily | Daily |
| Share of Voice | ✓ | ✓ | ✓ | ✓ |
| Competitors tracked | 3 | 5 | 10 | 20 |
| AI Chat Support | ✓ | ✓ | ✓ | ✓ |
| PDF & ZIP downloads | ✗ | ✓ | ✓ | ✓ |
| Recommendations | ✓ | ✓ | ✓ | ✓ |
| User access / team seats | ✗ | ✗ | ✓ | ✓ |
| Bulk CSV upload | ✗ | ✗ | ✓ | ✓ |
| Group membership | ✗ | ✗ | ✗ | ✓ |

**NOT shown (not built yet):** dedicated account manager, additional prompts, social media mapping, content writing

### 3F. Free Tier Allowances

Free tier gets limited uses (not credits-based):
- 2 GEO Audits (20 pages each)
- 1 Share of Voice
- 1 Competitor Mapping
- 1 of everything else (PDF download, ZIP download, etc.)
- CTA: "Start Free!"

### 3G. What to Show on Pricing Page

- Dollar price per tier (monthly or quarterly depending on toggle)
- Total credits per month (paid tiers)
- Discount vs Starter for Growth (52%) and Pro (75%)
- Feature checklist per tier (only built features)
- No USD/credit shown anywhere
- Pro shows "Talk to Us" CTA (annual only)
- Free: "Start Free!" button, no price column — text/CTA below the 3-column grid

## 4. Components

### 4A. GEO `lib/config.ts` — Single Source of Truth

Update `SUBSCRIPTION_TIERS`:
- Starter: price 99, credits 1430, pages 1000, maxAuditPages 100, maxCompetitors 5, weekly
- Growth: price 249, credits 7465, pages 5000, maxAuditPages 500, maxCompetitors 10, daily
- Pro: price 499, credits 28915, pages 10000, maxAuditPages null (unlimited), maxCompetitors 20, daily
- Free: unchanged (price 0, pages 20, maxCompetitors 3, manual)

Add `credits` field to each tier.

Add `ACTION_CREDITS` object with per-action costs.

Add `PRICING_PLANS` array with feature lists (single source for both pricing pages).

Update `UPFRONT_PRICES` with correct quarterly/annual values (awaiting Aditya input).

Pro: remove quarterly option, annual only.

### 4B. GEO `GET /api/pricing` — New Endpoint

Returns full pricing config as JSON:
```json
{
  "tiers": { ... },
  "plans": [ ... ],
  "actionCredits": { ... },
  "upfrontPrices": { ... },
  "billingIntervals": { ... }
}
```

Public endpoint (no auth). Cacheable. Add to middleware ALWAYS_ALLOWED.

### 4C. GEO `PricingToggle.tsx` — Rewrite

- Remove hardcoded `plans` array
- Import `PRICING_PLANS`, `SUBSCRIPTION_TIERS`, `UPFRONT_PRICES` from config
- Match V0-Website design exactly (same copper theme, same layout, same toggle)
- Toggle: "Monthly" / "Quarterly" (rename from "Pay upfront")
- Pro: when "Quarterly" selected, show annual price with "/ year" label
- Show total credits per tier prominently
- Show discount vs Starter for Growth and Pro

### 4D. V0-Website `pricing-client.tsx` — Fetch from GEO

- Remove hardcoded `plans` array and inline prices
- Fetch from `GEO_API_BASE_URL/api/pricing` server-side (or in a parent Server Component)
- Render from the fetched data using same layout
- Toggle: "Monthly" / "Quarterly"
- Keep exact same visual design

### 4E. GEO `SitePageClient.tsx` — Credit Badges on Action Rail

Add credit cost badges to all action buttons (same style as existing "5cr" on Scan Citations):

| Button | Badge | Currently |
|--------|-------|-----------|
| Refresh Score | 10cr | NO badge |
| Scan Citations | 5cr | ✓ has it |
| Map Competitors | 5cr | Shows 2cr — WRONG |
| Download ZIP | 5cr | NO badge |
| Download PDF | 5cr | NO badge |

Import costs from `ACTION_CREDITS` in config.

### 4F. GEO `RowActions.tsx` — Credit Badges on Dashboard Hover

Add credit cost to hover tooltip for each action:

| Button | Tooltip |
|--------|---------|
| Rerun Audit | "Rerun Audit · 10cr" |
| Rerun Citations | "Rerun Citations · 5cr" |
| Download ZIP | "Download ZIP · 5cr" |
| Download PDF | "Download PDF · 5cr" |

Also: remove `tier === "free"` gate on Rerun Citations (lines 191-194).

### 4G. GEO `UpgradeModal.tsx` — Update

Update to use config values instead of hardcoded prices/features. Show credits per tier and discount.

## 5. Dependencies

- PricingDiscussionSheet.csv (already read)
- Aditya's input on quarterly prices and Pro annual price

## 6. Acceptance Criteria

### Config
- [ ] `SUBSCRIPTION_TIERS` has `credits` field for all tiers
- [ ] `ACTION_CREDITS` defines per-action costs
- [ ] `PRICING_PLANS` defines feature lists (no unbuilt features)
- [ ] Pro has no quarterly option
- [ ] Starter maxCompetitors: 5, Growth: 10, Pro: 20

### API
- [ ] `GET /api/pricing` returns full pricing config
- [ ] Endpoint is public (in ALWAYS_ALLOWED)
- [ ] Response is cacheable

### Pricing Pages (both repos)
- [ ] Show dollar price per tier
- [ ] Show total credits per month
- [ ] Show discount vs Starter (52% for Growth, 75% for Pro)
- [ ] Toggle switches between Monthly and Quarterly views
- [ ] Pro shows annual price when Quarterly toggle active
- [ ] No USD/credit shown anywhere
- [ ] No unbuilt features shown
- [ ] Both pages render identically
- [ ] V0-Website reads from GEO `/api/pricing`

### Action Rail (SitePageClient.tsx)
- [ ] All 5 buttons have credit cost badges
- [ ] Map Competitors shows 5cr (not 2cr)
- [ ] Badges use `ACTION_CREDITS` from config

### Dashboard (RowActions.tsx)
- [ ] All 4 buttons show credit cost in hover tooltip
- [ ] Citations not gated for free tier

## 7. Open Questions

All resolved by Aditya (2026-04-04):
- Quarterly: 10% off (0.9 × 3 × monthly) → Starter $267, Growth $672
- Pro annual: 20% off (0.8 × 12 × monthly) → $4,792
- Toggle: "Monthly" / "Quarterly" ✓
- Free: "Start Free!" CTA below grid, not a 4th column
- Free gets: 2 audits, 1 SoV, 1 competitor map, 1 of everything else

## 8. Files Affected

| File | Repo | Action |
|------|------|--------|
| `lib/config.ts` | GEO | MODIFY — tiers, credits, plans, action costs |
| `app/api/pricing/route.ts` | GEO | CREATE — public pricing endpoint |
| `middleware.ts` | GEO | MODIFY — add /api/pricing to ALWAYS_ALLOWED |
| `app/components/PricingToggle.tsx` | GEO | MODIFY — use config, match V0 design |
| `app/components/UpgradeModal.tsx` | GEO | MODIFY — use config values |
| `app/sites/[id]/SitePageClient.tsx` | GEO | MODIFY — credit badges on all actions |
| `app/dashboard/RowActions.tsx` | GEO | MODIFY — credit tooltips, remove free gate |
| `app/pricing/pricing-client.tsx` | V0-Website | MODIFY — fetch from GEO API |

---

*TS-076 — CoFounder, 2026-04-04*
