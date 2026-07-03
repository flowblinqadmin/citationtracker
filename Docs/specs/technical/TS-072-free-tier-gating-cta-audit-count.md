# TS-072 — Free Tier: Gating, CTAs, Remaining Audit Count

**Author:** CoFounder (Agent 1)
**Date:** 2026-03-30
**Priority:** P1 — free tier UX gaps
**Scope:** Dashboard + site page

---

## What

Three changes for free-tier users:

1. **Show remaining free audits** — "X of 2 free audits remaining" in the header, next to Sign Out, on both the portfolio dashboard and the site page.

2. **Disable Map Competitors + Citation Check for free tier** — Both buttons greyed out with upgrade CTA tooltip on the site page. Citation rerun button disabled on the dashboard RowActions.

3. **Upgrade CTAs** — Where gated content would appear for free users, show CTA text like "Buy credits to see your AI visibility" instead of empty/broken states.

---

## Why

Free-tier users currently have access to competitor mapping and citation checks which are paid features. There's no indication of how many free audits remain, and no upgrade nudges.

---

## Data: Free Audit Count

`geo_site_view` does not have `owner_email`. The count must come from `geo_sites`:

```sql
SELECT COUNT(*) FROM geo_sites WHERE owner_email = :email;
```

- **Dashboard** (`page.tsx`): `user.email` is available from Supabase auth. Query count server-side, pass to header.
- **Site page** (`page.tsx`): Query count server-side using the site's `ownerEmail` (from `geoSites`, not `geoSiteView`). Pass as prop.

`FREE_AUDIT_LIMIT = 2` from `lib/config.ts`.

Display format: `"X of 2 free audits remaining"` — only shown when `tier === "free"`.

---

## Fix Specification

### Fix 1: Remaining audit count in header

**Dashboard — `app/dashboard/page.tsx`:**
- Query `geo_sites` count by `user.email` (add to existing parallel query)
- Pass `freeAuditsUsed` and `tier` ("free" if `creditBalance === 0`, "paid" otherwise) to the header area
- Render next to Sign Out: `"{FREE_AUDIT_LIMIT - used} of {FREE_AUDIT_LIMIT} free audits remaining"` in T2 color, font-size 12

**Site page — `app/sites/[id]/page.tsx`:**
- Query `geo_sites` count by `site.ownerEmail` (need to join/query `geoSites` for email)
- Actually simpler: use the existing `site.teamId` to count `teamDomains` for this team
- Pass count as `freeAuditsRemaining` prop to `SitePageClient`

**SitePageClient — `app/sites/[id]/SitePageClient.tsx`:**
- Show in header bar (line ~570, near SignOutButton): same format as dashboard

### Fix 2: Disable competitor + citation buttons for free tier

**Site page — `SitePageClient.tsx`:**

`site.tier` is already available in the component (`SiteData.tier: "free" | "paid"`).

- **"Scan Citations" button** (~line 814): Add `disabled={site?.tier === "free"}`, opacity 0.35, tooltip "Upgrade to Pro to check AI citations"
- **"Map Competitors" button** (~line 836): Add `disabled={site?.tier === "free"}`, opacity 0.35, tooltip "Upgrade to Pro to map competitors"

**Dashboard — `app/dashboard/RowActions.tsx`:**

RowActions doesn't currently receive `tier`. Add it as a prop.

- **Citation rerun button** (~line 190): Add `disabled={tier === "free"}`, opacity 0.35, tooltip "Upgrade to Pro"

### Fix 3: Upgrade CTAs for gated content

**Site page — `SitePageClient.tsx`:**

Where free-tier users see empty/null data for paid features, show CTA text:

- **AI Visibility KPI card** (overview tab): If `tier === "free"` and no citation data, show "Buy credits to see your AI visibility" with a link/button to upgrade
- **Competitor section** (overview tab): If `tier === "free"`, show "Upgrade to map and track your competitors"
- **Citation narrative section**: If `tier === "free"`, show "Upgrade to see how AI models cite your brand"

Style: T2 color, font-size 12, with copper-colored "Upgrade" link that opens the buy credits modal.

---

## Files Changed

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Add free audit count query, pass tier + count to header |
| `app/dashboard/DomainTableRow.tsx` | Pass tier to RowActions |
| `app/dashboard/RowActions.tsx` | Add `tier` prop, disable citation button for free |
| `app/sites/[id]/page.tsx` | Query free audit count, pass to SitePageClient |
| `app/sites/[id]/SitePageClient.tsx` | Disable buttons, show CTAs, show remaining count in header |
| `lib/config.ts` | No change (FREE_AUDIT_LIMIT = 2 stays) |

---

## Acceptance Criteria

### AC-1: Free audit count visible in dashboard header
- Free-tier user sees "X of 2 free audits remaining" next to Sign Out
- Pro users do NOT see this (they have credits)

### AC-2: Free audit count visible in site page header
- Same display as dashboard, next to Sign Out

### AC-3: Citation check disabled for free tier on site page
- Button greyed out (opacity 0.35, cursor not-allowed)
- Tooltip: "Upgrade to Pro to check AI citations"
- Clicking does nothing

### AC-4: Map competitors disabled for free tier on site page
- Button greyed out (opacity 0.35, cursor not-allowed)
- Tooltip: "Upgrade to Pro to map competitors"
- Clicking does nothing

### AC-5: Citation rerun disabled for free tier on dashboard
- Button greyed out in RowActions
- Tooltip: "Upgrade to Pro"

### AC-6: Upgrade CTAs shown for free tier
- AI Visibility section shows "Buy credits to see your AI visibility"
- Competitor section shows "Upgrade to map and track your competitors"
- CTA links open buy credits modal or navigate to upgrade

### AC-7: Pro users unaffected
- All buttons active, no CTAs, no remaining count shown

### AC-8: Docker CI passes

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Count query adds latency to dashboard | Low | Single COUNT query, indexed on owner_email |
| Free users feel locked out | Low | CTAs guide toward upgrade, core score is still visible |

---

## Test Plan

**T-072-1:** Free tier user sees remaining audit count in header
**T-072-2:** Pro tier user does NOT see remaining count
**T-072-3:** Citation button disabled when tier=free
**T-072-4:** Competitor button disabled when tier=free
**T-072-5:** Citation button active when tier=paid
**T-072-6:** Competitor button active when tier=paid
**T-072-7:** CTA text renders for free tier in AI visibility section
**T-072-8:** CTA text does NOT render for paid tier
**T-072-9:** Dashboard RowActions citation button disabled for free tier
