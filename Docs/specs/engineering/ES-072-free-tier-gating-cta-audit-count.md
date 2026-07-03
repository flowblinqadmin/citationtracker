# ES-072 — Free Tier: Gating, CTAs, Remaining Audit Count

**Source:** TS-072-free-tier-gating-cta-audit-count.md
**Priority:** P1 — free tier UX gaps
**Scope:** 5 files modified, ~40 lines of implementation code

---

## a) Overview

Three P1 changes for free-tier users:

1. **Show remaining free audits** — Display "X of 2 free audits remaining" in the header on both the portfolio dashboard and site page.

2. **Disable Map Competitors + Citation Check for free tier** — Both buttons greyed out with upgrade CTA tooltip on the site page. Citation rerun button disabled on dashboard RowActions.

3. **Upgrade CTAs** — Where gated content would appear for free users, show CTA text instead of empty/broken states.

### Current Implementation State

- **`SiteData.tier`** — Already `"free" | "paid"` (types.ts line 74). Site page determines tier based on `teamRow.creditBalance > 0` (page.tsx line 66-71).

- **Dashboard `page.tsx`** — Has `teamInfo.team.creditBalance` and `kpi.creditBalance`. Does NOT have a `tier` concept passed to child components. Does NOT query `geo_sites` count.

- **Dashboard `RowActions.tsx`** — Does NOT receive a `tier` prop. `initialPipelineStatus` is a prop (used by ES-071). Citation button currently only disabled by `citationRunning` state.

- **Dashboard `DomainTableRow.tsx`** — Does NOT pass `tier` to `RowActions`. The `DomainTableRowProps.row` interface does not have `tier` in the account-tier sense (only `tier: "GOOD" | "FAIR" | "WEAK" | "POOR" | null` for score tier).

- **`SitePageClient.tsx`** — "Scan Citations" button at ~line 813 disabled only by `citationScanActive`. "Map Competitors" button at ~line 835 disabled by `competitorScanActive || slotsRemaining === 0`. Neither checks `site.tier`.

- **`lib/config.ts`** — `FREE_AUDIT_LIMIT = 2` at line 16. No changes needed.

- **`geoSites` schema** — `ownerEmail: text("owner_email").notNull()` (schema.ts line 80). Count query: `SELECT COUNT(*) FROM geo_sites WHERE owner_email = :email`.

---

## b) Implementation Requirements

### Fix 1: Remaining audit count in header

#### 1a. Dashboard — `app/dashboard/page.tsx`

**Add audit count query** — Add to the existing `Promise.all` block (lines 135-153) or run in parallel alongside it:

```typescript
import { geoSites } from "@/lib/db/schema";
import { count } from "drizzle-orm";
import { FREE_AUDIT_LIMIT } from "@/lib/config";
```

Query (add to the parallel block):
```typescript
db.select({ count: count() })
  .from(geoSites)
  .where(eq(geoSites.ownerEmail, user.email!))
```

**Derive tier and remaining count:**
```typescript
const freeAuditsUsed = auditCountResult[0]?.count ?? 0;
const accountTier: "free" | "paid" = (teamInfo?.team.creditBalance ?? 0) > 0 ? "paid" : "free";
const freeAuditsRemaining = Math.max(0, FREE_AUDIT_LIMIT - freeAuditsUsed);
```

**Render in header** (line 245, inside the flex div next to SignOutButton):

```typescript
{accountTier === "free" && (
  <span style={{ fontSize: 12, color: T2 }}>
    {freeAuditsRemaining} of {FREE_AUDIT_LIMIT} free audits remaining
  </span>
)}
```

**Pass `accountTier` to DomainTableRow** — add to the `DomainRow` type or pass as a separate prop through the table rendering.

#### 1b. Site page — `app/sites/[id]/page.tsx`

The site page already has `site.teamId`. Use `teamDomains` count as a simpler proxy for audits used:

```typescript
const [auditCountResult] = await db
  .select({ count: count() })
  .from(geoSites)
  .where(eq(geoSites.ownerEmail, site.ownerEmail));
```

This requires access to `site.ownerEmail`. The current site view query may not expose it. Alternative: query `geoSites` directly since we have the `siteId` → can get `ownerEmail` → count.

**Simpler approach:** Since `tier` is already computed (line 66-71), and `site.ownerEmail` is available from the `geoSites` table (already queried for the main view), add a count query in the parallel block:

```typescript
db.select({ count: count() })
  .from(geoSites)
  .where(eq(geoSites.ownerEmail, site.ownerEmail))
```

Pass `freeAuditsRemaining` as a new prop to `SitePageClient`.

#### 1c. SitePageClient — `app/sites/[id]/SitePageClient.tsx`

**Add to `SitePageClientProps`** (line 66-75):
```typescript
freeAuditsRemaining?: number;
```

**Render in header** (line ~580, near SignOutButton):
```typescript
{site?.tier === "free" && freeAuditsRemaining !== undefined && (
  <span style={{ fontSize: 12, color: T2 }}>
    {freeAuditsRemaining} of {FREE_AUDIT_LIMIT} free audits remaining
  </span>
)}
```

Import `FREE_AUDIT_LIMIT` from `@/lib/config`.

### Fix 2: Disable competitor + citation buttons for free tier

#### 2a. Site page — `SitePageClient.tsx`

**"Scan Citations" button** (~line 813):

Add free-tier guard to the existing `disabled` condition:
```typescript
disabled={citationScanActive || site?.tier === "free"}
```

Update style opacity:
```typescript
opacity: (citationScanActive || site?.tier === "free") ? 0.4 : 1
cursor: (citationScanActive || site?.tier === "free") ? "not-allowed" : "pointer"
```

Update title:
```typescript
title={site?.tier === "free" ? "Upgrade to Pro to check AI citations" : "Scan Citations"}
```

**"Map Competitors" button** (~line 835):

Add free-tier guard:
```typescript
disabled={competitorScanActive || slotsRemaining === 0 || site?.tier === "free"}
```

Update style:
```typescript
opacity: (competitorScanActive || slotsRemaining === 0 || site?.tier === "free") ? 0.5 : 1
cursor: (competitorScanActive || slotsRemaining === 0 || site?.tier === "free") ? "not-allowed" : "pointer"
```

Update title:
```typescript
title={site?.tier === "free" ? "Upgrade to Pro to map competitors" : slotsRemaining === 0 ? "Competitor slots full" : "Map Competitors"}
```

#### 2b. Dashboard — `RowActions.tsx`

**Add `tier` prop** to `RowActionsProps`:
```typescript
tier?: "free" | "paid";
```

**Citation rerun button** (~line 138):

Add free-tier guard:
```typescript
disabled={citationRunning || tier === "free"}
```

Update style:
```typescript
opacity: (citationRunning || tier === "free") ? 0.4 : 1
cursor: (citationRunning || tier === "free") ? "wait" : tier === "free" ? "not-allowed" : "pointer"
```

Update title:
```typescript
title={tier === "free" ? "Upgrade to Pro" : "Rerun Citations"}
```

#### 2c. Dashboard — `DomainTableRow.tsx`

Pass `tier` through to RowActions. The `DomainTableRowProps.row` uses `tier` for score tier ("GOOD"/"FAIR"/etc.), so add a separate prop:

**Add `accountTier` to `DomainTableRowProps`** (line 40):
```typescript
interface DomainTableRowProps {
  row: { ... };
  accountTier?: "free" | "paid";
}
```

Pass to RowActions (line 290-299):
```typescript
<RowActions
  siteId={row.siteId}
  accessToken={row.accessToken}
  domain={row.domain}
  initialPipelineStatus={liveStatus}
  citationRate={row.citationRate}
  tier={accountTier}
  onScanStart={() => setIsOptimisticScan(true)}
  onCitationStart={() => setCitationRunning(true)}
  onCitationEnd={() => setCitationRunning(false)}
/>
```

#### 2d. Dashboard — `page.tsx`

Pass `accountTier` when rendering DomainTableRow. The table rendering needs the prop. Find where `DomainTableRow` is rendered and add `accountTier={accountTier}`.

### Fix 3: Upgrade CTAs for gated content

**File:** `app/sites/[id]/SitePageClient.tsx`

Three CTA insertion points (all in the overview tab rendering):

**3a. AI Visibility KPI card** — Where citation rate would display for free tier with no citation data:

```typescript
{site?.tier === "free" && !lastCitationCheck && (
  <div style={{ fontSize: 12, color: T2 }}>
    <span style={{ color: COPPER, fontWeight: 600, cursor: "pointer" }}
      onClick={() => { /* open buy credits modal or scroll to upgrade section */ }}>
      Buy credits
    </span>{" "}to see your AI visibility
  </div>
)}
```

**3b. Competitor section** — Where competitors would appear for free tier:

```typescript
{site?.tier === "free" && (
  <div style={{ fontSize: 12, color: T2, padding: "12px 0" }}>
    <span style={{ color: COPPER, fontWeight: 600, cursor: "pointer" }}
      onClick={() => { /* open buy credits modal */ }}>
      Upgrade
    </span>{" "}to map and track your competitors
  </div>
)}
```

**3c. Citation narrative section** — Where citation details would appear for free tier:

```typescript
{site?.tier === "free" && (
  <div style={{ fontSize: 12, color: T2, padding: "12px 0" }}>
    <span style={{ color: COPPER, fontWeight: 600, cursor: "pointer" }}
      onClick={() => { /* open buy credits modal */ }}>
      Upgrade
    </span>{" "}to see how AI models cite your brand
  </div>
)}
```

**CTA action:** ScriptDev should determine the appropriate action — either open the BuyCreditsButton modal programmatically or navigate to an upgrade page. The simplest approach is to wrap the "Upgrade" text in a link/button that scrolls to or opens the existing `BuyCreditsButton` component.

### Error Handling

- Count query failure: use `?? 0` default (no additional error handling needed).
- No new API endpoints or network calls beyond the count query.

### Performance

- One additional `COUNT(*)` query per page load. `geo_sites.owner_email` should be indexed (it's used in the site creation limit check). Single-row result.
- No new client-side computation.

---

## c) Unit Test Plan

**File:** `__tests__/free-tier-gating.test.tsx`

**Framework:** Vitest + React Testing Library

**Mock requirements:**
- Mock `fetch` for site API
- Mock `useRouter` from `next/navigation`

### Test Cases

**T-072-1: Free tier user sees remaining audit count in header (SitePageClient)**
- Render SitePageClient with `site.tier = "free"`, `freeAuditsRemaining = 1`.
- Assert: "1 of 2 free audits remaining" text visible in the DOM.

**T-072-2: Pro tier user does NOT see remaining count (SitePageClient)**
- Render SitePageClient with `site.tier = "paid"`.
- Assert: Text containing "free audits remaining" is NOT in the DOM.

**T-072-3: Citation button disabled when tier=free (SitePageClient)**
- Render SitePageClient with `site.tier = "free"`.
- Assert: "Scan Citations" button has `disabled` attribute.
- Assert: Button has `opacity: 0.4` and `cursor: "not-allowed"`.
- Assert: `title` is "Upgrade to Pro to check AI citations".

**T-072-4: Competitor button disabled when tier=free (SitePageClient)**
- Render SitePageClient with `site.tier = "free"`.
- Assert: "Map Competitors" button has `disabled` attribute.
- Assert: `title` is "Upgrade to Pro to map competitors".

**T-072-5: Citation button active when tier=paid (SitePageClient)**
- Render SitePageClient with `site.tier = "paid"`.
- Assert: "Scan Citations" button is NOT disabled (when `citationScanActive` is false).

**T-072-6: Competitor button active when tier=paid (SitePageClient)**
- Render SitePageClient with `site.tier = "paid"`.
- Assert: "Map Competitors" button is NOT disabled (when `competitorScanActive` is false and `slotsRemaining > 0`).

**T-072-7: CTA text renders for free tier in AI visibility section**
- Render SitePageClient with `site.tier = "free"`, no citation check.
- Assert: "Buy credits to see your AI visibility" text visible.

**T-072-8: CTA text does NOT render for paid tier**
- Render SitePageClient with `site.tier = "paid"`.
- Assert: "Buy credits" CTA text NOT in the DOM.

**T-072-9: Dashboard RowActions citation button disabled for free tier**
- Render RowActions with `tier = "free"`.
- Assert: Citation rerun button disabled, `title` is "Upgrade to Pro".

**Minimum coverage:** 100% of new conditional branches.

---

## d) Integration Test Plan

**File:** `__tests__/free-tier-gating.integration.test.ts`

### Scenarios

**IT-072-1: Dashboard renders free audit count when creditBalance=0**
- Setup: User with `creditBalance = 0`, 1 existing site in `geo_sites`.
- Render DashboardPage.
- Assert: "1 of 2 free audits remaining" visible in header.

**IT-072-2: Dashboard hides audit count when creditBalance > 0**
- Setup: User with `creditBalance = 50`.
- Render DashboardPage.
- Assert: "free audits remaining" NOT in header.

---

## e) Profiling Requirements

Not applicable — single COUNT query, no computation.

---

## f) Load Test Plan

Not applicable — no new endpoints, trivial query addition.

---

## g) Logging & Instrumentation

No new logging required. The count query is lightweight and runs once per page load.

---

## h) Acceptance Criteria

| # | Criterion | Section |
|---|-----------|---------|
| AC-1 | Free-tier user sees "X of 2 free audits remaining" in dashboard header | §b Fix 1a |
| AC-2 | Free-tier user sees "X of 2 free audits remaining" in site page header | §b Fix 1b/1c |
| AC-3 | Pro users do NOT see remaining audit count | §b Fix 1a/1c |
| AC-4 | Citation button disabled for free tier on site page, tooltip "Upgrade to Pro to check AI citations" | §b Fix 2a |
| AC-5 | Map Competitors button disabled for free tier on site page, tooltip "Upgrade to Pro to map competitors" | §b Fix 2a |
| AC-6 | Citation rerun button disabled for free tier on dashboard RowActions, tooltip "Upgrade to Pro" | §b Fix 2b |
| AC-7 | All three buttons active for paid-tier users (no regression) | §b Fix 2 |
| AC-8 | CTA "Buy credits to see your AI visibility" shown in AI visibility section for free tier | §b Fix 3a |
| AC-9 | CTA "Upgrade to map and track your competitors" shown in competitor section for free tier | §b Fix 3b |
| AC-10 | CTA "Upgrade to see how AI models cite your brand" shown in citation section for free tier | §b Fix 3c |
| AC-11 | CTA links open buy credits modal or navigate to upgrade | §b Fix 3 |
| AC-12 | T-072-1 through T-072-9 unit tests pass | §c |
| AC-13 | IT-072-1 and IT-072-2 integration tests pass | §d |
| AC-14 | `docker build -f Dockerfile.test -t geo-test . && docker run --rm geo-test` passes | §c |
| AC-15 | No new packages or schema changes introduced | TS-072 |

---

## ScriptDev Notes

1. **Account tier vs score tier** — `DomainRow.tier` is score tier ("GOOD"/"FAIR"/"WEAK"/"POOR"). Account tier ("free"/"paid") is a separate concept. Use `accountTier` as the prop name on `DomainTableRow` to avoid confusion.
2. **Count query** — `geoSites.ownerEmail` is the correct field (not `geoSiteView` which lacks it). Import `count` from `drizzle-orm` and `geoSites` from schema.
3. **CTA action** — The simplest approach is to have CTA click handlers call `document.querySelector('[data-testid="buy-credits-btn"]')?.click()` if `BuyCreditsButton` has a test ID, or lift the buy-credits modal state up. ScriptDev should determine the cleanest integration.
4. **`FREE_AUDIT_LIMIT` import** — Client components (`SitePageClient`) can import from `@/lib/config` since it's a simple constant export.
5. **RowActions `tier` prop** — Default to `"paid"` if not provided, so existing call sites without the prop don't break during incremental implementation.
