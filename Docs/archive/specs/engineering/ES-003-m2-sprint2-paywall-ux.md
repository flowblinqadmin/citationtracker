# ES-003: M2 Sprint 2 — Paywall UX + Pricing Page

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#42](https://github.com/flowblinqadmin/geo/issues/42) · [#43](https://github.com/flowblinqadmin/geo/issues/43)  
> **Delivery Commit:** `2bad500`  

---

**Source:** TS-003-m2-sprint2-paywall-ux.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-26
**Branch:** `dev-an`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/archive/geo`)
**Issues:** #42, #43, #45
**Depends on:** ES-002 / TS-002 (Sprint 1 — API gating must be in place, `tier` and `credits` fields in API response)

---

## a) Overview

### What This Covers
Sprint 2 is the **user-facing monetization layer**. Sprint 1 built the server-side boundary (API gating strips paid data). Sprint 2 makes that boundary visible and actionable in the UI.

3 tasks:

1. **#42 — Dashboard Paywall UI**: Gate premium sections in `ResultsDashboard.tsx` with blur overlays and upgrade CTAs. Auto-unlock after Stripe payment via existing polling.
2. **#43 — Post-Payment Toast**: Show success toast when user returns from Stripe checkout. Clean URL params.
3. **#45 — Pricing Page**: Create `/pricing` comparing free vs paid tiers with CTAs.

```
Sprint 1 complete (API returns tier/credits)
    │
    ├──→ #42 Dashboard paywall UI (reads tier from API)
    │     └──→ #43 Post-payment toast (after checkout redirect)
    │
    └──→ #45 Pricing page (uses config.ts constants, no Sprint 1 runtime dependency)
```

### Current Implementation State

- **`ResultsDashboard.tsx`** — 910 lines, client component, renders ALL data unconditionally. Uses inline `style={{}}` objects with color constants (`BG="#000"`, `CARD="#0a0a0a"`, etc.). No CSS modules or Tailwind classes in this component.
- **`SiteData` interface** (lines 5-76) does NOT include `tier` or `credits` fields yet — Sprint 1 adds these to the API response.
- **Polling mechanism** (lines 270-285): Polls `GET /api/sites/[id]` every 3s via `setInterval`. Stops when `isStoppedStatus` is true (pipeline `complete` or `failed`). **Problem**: After pipeline completion, polling stops — won't detect payment tier change. Needs extension.
- **Regenerate button** (lines 604-606): Already partially gated — `manualRunsLeft = 4 - (site.manualRunsThisMonth ?? 0)`, disabled when `<= 0`. Free tier should show 0 re-runs.
- **Toast library**: `sonner` v2.0.7 installed. `<Toaster theme="dark" position="top-right" />` in `app/layout.tsx`. Already used in `app/page.tsx` with `toast.error()`.
- **`/pricing` page**: Does NOT exist. Route is already allowlisted in `middleware.ts:72`. Stripe checkout `cancel_url` points to `/pricing` (currently 404).
- **Dashboard page** (`app/dashboard/page.tsx`): Server component. No query param handling. No client component wrapper — needs one for toast.
- **No shared Header/Nav component** — each page builds its own nav inline.
- **Checkout success_url**: `/dashboard?payment=success`
- **Checkout cancel_url**: `/pricing`

### Ambiguities Flagged to CoFounder

1. **Checkout success redirect destination**: TS-003 recommends Option A (keep `/dashboard?payment=success`). However, better UX would return user to their specific site report. The checkout route doesn't know which site the user was viewing. **Recommendation**: Accept Option A for Sprint 2, add `returnTo` in Sprint 3 if needed.

2. **Pricing page "Buy Credits" CTA for unauthenticated users**: `/api/checkout` requires Supabase auth. If user isn't logged in, clicking "Buy Credits" will fail. **Recommendation**: Use `<a href="/auth/login?returnTo=/pricing">` for unauthenticated state, or redirect to login from the checkout API (it already returns 401).

3. **`manualRunsLeft` calculation**: Currently `4 - (manualRunsThisMonth ?? 0)` — this implies free users get 4 re-runs. TS-003 says free tier gets 0 re-runs (initial only). This should be `tier === "free" ? 0 : 4 - (manualRunsThisMonth ?? 0)` or similar. Need CoFounder to confirm if paid users get 4 monthly re-runs.

4. **Quick Wins section** (lines 683-703): TS-003 doesn't mention this section. It derives from `rankedRecommendations` (filtered for high-impact, low-effort). For free tier, with only 3 truncated recommendations, quick wins may be empty or misleading. **Recommendation**: Hide Quick Wins section entirely for free tier.

---

## b) Implementation Requirements

### Task 1: Dashboard Paywall UI (#42)

**Modify file:** `app/sites/[id]/ResultsDashboard.tsx`

#### Step 1: Update SiteData Interface (lines 5-76)

Add two new fields:

```ts
interface SiteData {
  // ... existing fields ...
  tier: "free" | "paid";
  credits: number;
}
```

#### Step 2: Add Upgrade Handler (after line ~265, inside component body)

```ts
const handleUpgrade = async () => {
  try {
    const res = await fetch("/api/checkout", { method: "POST" });
    const data = await res.json();
    if (data.checkoutUrl) {
      window.location.href = data.checkoutUrl;
    }
  } catch (err) {
    toast.error("Failed to start checkout. Please try again.");
  }
};
```

Add import at top: `import { toast } from "sonner";` (if not already imported).

#### Step 3: Add PaywallOverlay Component (before ResultsDashboard function, or at top of file)

Use inline styles consistent with existing component pattern:

```tsx
function PaywallOverlay({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div style={{
      position: "absolute",
      inset: 0,
      backdropFilter: "blur(8px)",
      WebkitBackdropFilter: "blur(8px)",
      background: "rgba(0,0,0,0.5)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: 10,
      borderRadius: 12,
    }}>
      <div style={{ textAlign: "center", padding: 24 }}>
        <h3 style={{ fontSize: 18, fontWeight: 600, color: "#fff", marginBottom: 8 }}>
          Upgrade to unlock full report
        </h3>
        <p style={{ fontSize: 14, color: "#888", marginBottom: 16 }}>
          100 credits for $10 — full audit details, recommendations, and generated files
        </p>
        <button
          onClick={onUpgrade}
          style={{
            padding: "10px 24px",
            background: "#2563eb",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            fontWeight: 500,
            cursor: "pointer",
            fontSize: 14,
          }}
          onMouseOver={(e) => (e.currentTarget.style.background = "#3b82f6")}
          onMouseOut={(e) => (e.currentTarget.style.background = "#2563eb")}
        >
          Upgrade Now
        </button>
      </div>
    </div>
  );
}
```

**Note:** Uses inline styles (not Tailwind classes) to match the existing component's styling approach. All colors follow the existing palette.

#### Step 4: Add Payment Polling (extend existing poll, after line ~285)

The existing poll stops when `isStoppedStatus` (pipeline complete/failed). Add a separate poll for free users waiting to unlock:

```ts
useEffect(() => {
  if (site.tier !== "free" || site.pipelineStatus !== "complete") return;
  const interval = setInterval(async () => {
    try {
      const res = await fetch(`/api/sites/${site.id}?token=${site.token}`);
      if (res.ok) {
        const data = await res.json() as SiteData;
        if (data.tier === "paid") {
          setSite((prev) => ({ ...data, token: prev.token }));
          clearInterval(interval);
        }
      }
    } catch { /* ignore */ }
  }, 3000);
  return () => clearInterval(interval);
}, [site.tier, site.pipelineStatus, site.id, site.token]);
```

#### Step 5: Gate Each Section

Apply this pattern to each gated section — wrap in `position: relative` container, conditionally render `PaywallOverlay`:

```tsx
<div style={{ position: "relative" }}>
  {site.tier === "free" && <PaywallOverlay onUpgrade={handleUpgrade} />}
  <div style={site.tier === "free" ? { pointerEvents: "none", userSelect: "none" } : {}}>
    {/* ... existing section content ... */}
  </div>
</div>
```

**Sections to gate with line references:**

| Section | Lines | Gate Behavior | Notes |
|---------|-------|---------------|-------|
| **Executive Summary** | 613-629 | Show first paragraph (API already truncates), blur visual placeholder for "more" | API handles truncation; UI shows blur hint below visible content |
| **GEO Scorecard — Pillar Findings** | 631-681 | Show pillar names + scores + score bars. Blur the expanded findings content. Pillar accordion should not expand for free tier. | Disable `setExpandedPillar()` when `tier === "free"` OR let it expand with PaywallOverlay on the findings content |
| **Quick Wins** | 683-703 | Hide entirely for free tier | `{site.tier === "paid" && (/* Quick Wins JSX */)}` |
| **All Recommendations** | 705-733 | Show first 3 titles (API already limits to 3 for free). Blur details. Block expansion. | Disable `setExpandedRec()` when `tier === "free"` |
| **Files Live Status** | 735-762 | Full PaywallOverlay. Show file name cards underneath (blurred). | Entire section gated — files are `null` for free tier |
| **Regenerate Button** | 604-606 | Disable button. Change label to "Upgrade to re-run audit" | Override `manualRunsLeft` to 0 when `tier === "free"` |

#### Step 6: Update Regenerate Button Logic (line ~290)

```ts
// BEFORE
const manualRunsLeft = 4 - (site.manualRunsThisMonth ?? 0);

// AFTER
const manualRunsLeft = site.tier === "free" ? 0 : 4 - (site.manualRunsThisMonth ?? 0);
```

Update button label (line ~604-606):
```tsx
{site.tier === "free" ? (
  <button
    onClick={handleUpgrade}
    style={{ /* same button style, different color — amber/gold */ }}
  >
    Upgrade to Re-run Audit
  </button>
) : (
  /* existing regenerate button */
)}
```

#### Step 7: Free Tier Banner (optional, high-impact)

Add a persistent banner below the header for free users:

```tsx
{site.tier === "free" && (
  <div style={{
    background: "linear-gradient(90deg, #1e1b4b, #312e81)",
    border: "1px solid #4338ca",
    borderRadius: 12,
    padding: "16px 24px",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 24,
  }}>
    <div>
      <div style={{ color: "#fff", fontWeight: 600, fontSize: 15 }}>
        You're on the Free plan
      </div>
      <div style={{ color: "#a5b4fc", fontSize: 13, marginTop: 4 }}>
        Upgrade to unlock detailed findings, all recommendations, and generated files
      </div>
    </div>
    <button onClick={handleUpgrade} style={{ /* blue button style */ }}>
      Upgrade — $10
    </button>
  </div>
)}
```

Insert after the header section (~line 609), before Executive Summary.

**Files changed:** 1 modified (`ResultsDashboard.tsx`)

---

### Task 2: Post-Payment Toast (#43)

**Context:** Dashboard is a server component (`app/dashboard/page.tsx`). Server components cannot use `useSearchParams` or `useEffect`. Need a client component wrapper.

#### Step 1: Create Client Payment Toast Component

**Create file:** `app/dashboard/PaymentToast.tsx`

```tsx
"use client";

import { useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";

export default function PaymentToast() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    if (searchParams.get("payment") === "success") {
      toast.success("Payment successful — 100 credits added!");
      const url = new URL(window.location.href);
      url.searchParams.delete("payment");
      router.replace(url.pathname, { scroll: false });
    }
  }, [searchParams, router]);

  return null;
}
```

#### Step 2: Add to Dashboard Page

**Modify file:** `app/dashboard/page.tsx`

Add import and render the client component:

```tsx
import PaymentToast from "./PaymentToast";

// Inside the JSX, at the top level:
<PaymentToast />
```

**Note:** The `<Suspense>` boundary is recommended around `useSearchParams()` per Next.js 14+ requirements. Wrap with:

```tsx
import { Suspense } from "react";

<Suspense fallback={null}>
  <PaymentToast />
</Suspense>
```

**Files changed:** 1 new (`PaymentToast.tsx`), 1 modified (`dashboard/page.tsx`)

---

### Task 3: Pricing Page (#45)

**Create file:** `app/pricing/page.tsx`

Server component — no interactivity needed for the comparison table. The "Buy Credits" CTA links to dashboard (which handles auth-gated checkout).

#### Page Structure

```tsx
import { CREDITS_PER_PACK, CREDITS_PRICE_USD, PAID_MAX_PAGES, FREE_MAX_PAGES, PAID_CRAWL_CREDIT_COST } from "@/lib/config";

export const metadata = {
  title: "Pricing — GEO by Flowblinq",
  description: "Free and paid plans for GEO optimization audits",
};

export default function PricingPage() {
  const rerunsPerPack = Math.floor(CREDITS_PER_PACK / PAID_CRAWL_CREDIT_COST);

  return (
    <main style={{ background: "#000", minHeight: "100vh", color: "#fff" }}>
      {/* Nav bar — matching homepage pattern */}
      {/* Hero: "Simple, transparent pricing" */}
      {/* Two-column comparison cards */}
      {/* FAQ section (optional) */}
    </main>
  );
}
```

#### Comparison Table Content

| Feature | Free | Paid |
|---------|------|------|
| GEO audit | Yes | Yes |
| Pages crawled | `{FREE_MAX_PAGES}` (20) | `{PAID_MAX_PAGES}` (100) |
| Overall score | Yes | Yes |
| Pillar scores | Yes | Yes |
| Detailed findings per pillar | No | Yes |
| Recommendations | First 3 titles | All with implementation details |
| Executive summary | First paragraph | Full |
| Generated llms.txt | No | Yes |
| Generated schema blocks | No | Yes |
| Generated business.json | No | Yes |
| Re-runs | Initial audit only | `{rerunsPerPack}` per credit pack |
| Price | Free | `${CREDITS_PRICE_USD}` for `{CREDITS_PER_PACK}` credits |

#### CTAs

- **Free column**: `<a href="/">Start Free Audit</a>` → homepage with domain input
- **Paid column**: `<a href="/dashboard">Buy Credits</a>` → dashboard (requires auth). If user not logged in, middleware or dashboard redirects to auth.

#### Styling Requirements

Must match existing app design language:
- Background: `#000` (same as `BG` constant)
- Cards: `#0a0a0a` with `#1a1a1a` borders (same as `CARD` and `BORDER`)
- Text: `#fff` primary, `#888` secondary
- Accent: `#2563eb` (blue) for CTAs
- Responsive: single column on mobile, two columns on desktop
- Font: Inter (already loaded in `app/layout.tsx`)

#### Navigation Link

Add "Pricing" link to the homepage nav. Check `app/page.tsx` — the home page already has a nav bar. Verify if it already links to `/pricing` (exploration suggests it does at line 60). If not, add:

```tsx
<a href="/pricing" style={{ color: "#888", textDecoration: "none" }}>Pricing</a>
```

**Files changed:** 1 new (`app/pricing/page.tsx`), possibly 1 modified (nav link if missing)

---

### Data Structures & Types

**Updated SiteData interface** (ResultsDashboard.tsx):
```ts
interface SiteData {
  // ... all existing fields unchanged ...
  tier: "free" | "paid";  // NEW — from Sprint 1 API gating
  credits: number;         // NEW — from Sprint 1 API gating
}
```

No new database tables or columns. All data comes from the Sprint 1 API response changes.

### Error Handling Requirements

- **Checkout fetch failure**: `handleUpgrade` catches errors and shows `toast.error()`. Do not crash the dashboard.
- **Payment toast — missing searchParams**: `PaymentToast` only fires when `payment=success` exists. No action otherwise.
- **Pricing page — config import**: If `lib/config.ts` doesn't exist (Sprint 1 not merged), build will fail at import time. This is intentional — Sprint 2 depends on Sprint 1.
- **Poll network failure**: Existing poll already has `catch { /* ignore */ }`. Payment poll should follow same pattern.

### Performance Requirements

- **No new API calls** beyond the payment poll (3s interval, only for free users after pipeline complete).
- **PaywallOverlay rendering**: Lightweight — no animations, no external assets. CSS backdrop-filter is GPU-accelerated.
- **Pricing page**: Server component, statically rendered. Zero client-side JS.

---

## c) Unit Test Plan

**Test file:** `__tests__/paywall-ui.test.tsx` (NEW)

**Testing framework:** Vitest + React Testing Library (if installed) or Vitest with manual DOM assertions.

**Mock requirements:**
- Mock `fetch` for `/api/checkout` and `/api/sites/[id]`
- Mock `sonner` toast functions
- Mock `next/navigation` (`useSearchParams`, `useRouter`)

### Test Cases for PaywallOverlay Component

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 1 | PaywallOverlay renders with blur styling | Render component | `backdrop-filter: blur(8px)` style present |
| 2 | "Upgrade Now" button calls onUpgrade | Render + click button | `onUpgrade` callback called once |
| 3 | PaywallOverlay displays correct copy | Render | "Upgrade to unlock full report" text visible, "$10" price visible |

### Test Cases for Tier Gating in ResultsDashboard

| # | Test Case | Setup | Expected | Edge |
|---|-----------|-------|----------|------|
| 4 | Free tier: PaywallOverlay shown on pillar findings | `tier: "free"`, scorecard with pillars | Overlay present in findings section | — |
| 5 | Free tier: PaywallOverlay shown on recommendations | `tier: "free"`, 5 recommendations | Overlay present, max 3 visible titles | — |
| 6 | Free tier: Quick Wins hidden | `tier: "free"` | Quick Wins section not rendered | — |
| 7 | Free tier: Generated files fully gated | `tier: "free"`, files null | Files section shows overlay | — |
| 8 | Free tier: Regenerate button shows upgrade text | `tier: "free"` | Button text = "Upgrade to Re-run Audit" | — |
| 9 | Free tier: manualRunsLeft = 0 | `tier: "free"`, `manualRunsThisMonth: 2` | `manualRunsLeft` is 0, not 2 | Override regardless of actual runs |
| 10 | Paid tier: no overlays rendered | `tier: "paid"` | Zero PaywallOverlay components in DOM | — |
| 11 | Paid tier: all sections visible | `tier: "paid"`, full data | Findings, recommendations, files, quick wins all rendered | — |
| 12 | Paid tier: regenerate button normal | `tier: "paid"`, `manualRunsThisMonth: 1` | Button text = "Regenerate (3/4 left)" | — |
| 13 | Free tier banner shown | `tier: "free"` | "You're on the Free plan" banner visible | — |
| 14 | Paid tier banner not shown | `tier: "paid"` | No free tier banner | — |

### Test Cases for handleUpgrade

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 15 | Successful checkout redirect | Mock fetch returns `{ checkoutUrl: "https://..." }` | `window.location.href` set to checkout URL |
| 16 | Checkout API error | Mock fetch throws | `toast.error()` called with failure message |
| 17 | Checkout API returns no URL | Mock fetch returns `{}` | No redirect, no crash |

### Test Cases for Payment Polling

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 18 | Poll starts for free + complete status | `tier: "free"`, `pipelineStatus: "complete"` | `setInterval` called with 3000ms |
| 19 | Poll stops when tier becomes paid | Poll returns `tier: "paid"` | `clearInterval` called, `setSite` updated |
| 20 | Poll does not start for paid users | `tier: "paid"` | No interval created |
| 21 | Poll does not start during pipeline run | `tier: "free"`, `pipelineStatus: "crawling"` | No interval (existing poll handles this) |

### Test Cases for PaymentToast Component

**Test file:** `__tests__/payment-toast.test.tsx` (NEW)

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 22 | Toast shown on payment=success | `searchParams: { payment: "success" }` | `toast.success()` called with "Payment successful" |
| 23 | URL cleaned after toast | `searchParams: { payment: "success" }` | `router.replace` called with clean pathname |
| 24 | No toast without payment param | `searchParams: {}` | `toast.success()` not called |
| 25 | No toast with wrong payment value | `searchParams: { payment: "failed" }` | `toast.success()` not called |

### Test Cases for Pricing Page

**Test file:** `__tests__/pricing-page.test.tsx` (NEW)

| # | Test Case | Setup | Expected |
|---|-----------|-------|----------|
| 26 | Page renders comparison table | Render `PricingPage` | Free and Paid columns visible |
| 27 | Config values rendered (not hardcoded) | Render | `FREE_MAX_PAGES` (20), `PAID_MAX_PAGES` (100), `CREDITS_PRICE_USD` (10) visible |
| 28 | Free CTA links to homepage | Render | `<a href="/">` present |
| 29 | Paid CTA links to dashboard | Render | `<a href="/dashboard">` present |
| 30 | Re-runs per pack calculated correctly | Render | Shows `5` (100 / 20) |

**Minimum coverage target:** 85% line coverage for `ResultsDashboard.tsx` gating logic, 100% for `PaymentToast.tsx` and `PricingPage`.

---

## d) Integration Test Plan

**Test file:** `__tests__/integration/paywall-flow.test.ts` (NEW)

### Scenarios

| # | Scenario | Flow | Assertions |
|---|----------|------|------------|
| 1 | Free user views report — gated | Fetch site (free tier) → render dashboard | Overlays present, findings hidden, max 3 recs, files null |
| 2 | Free user clicks Upgrade → checkout | Click "Upgrade Now" → verify `/api/checkout` called | POST to checkout, response has `checkoutUrl` |
| 3 | Payment completes → tier auto-upgrades | Free dashboard → simulate payment → poll returns paid | Overlays removed within poll cycle, full data rendered |
| 4 | Stripe redirect → toast shown | Navigate to `/dashboard?payment=success` | Toast appears, URL cleaned |
| 5 | Pricing page → checkout flow | Visit `/pricing` → click "Buy Credits" → redirects | Link navigates to `/dashboard` |
| 6 | Pricing page values from config | Render pricing page | All numeric values match `lib/config.ts` exports |

### End-to-End Data Flow

| # | Flow | Validates |
|---|------|-----------|
| 7 | Free → Pay → Unlock | API returns `tier: "free"` → user pays → next poll returns `tier: "paid"` → all PaywallOverlays removed → full data visible |
| 8 | Config change propagation | Change `CREDITS_PRICE_USD` in config → pricing page reflects new price |

### Failure Mode Tests

| # | Scenario | Expected |
|---|----------|----------|
| 9 | Checkout API returns 401 (unauthenticated) | `toast.error()` shown, no redirect |
| 10 | Checkout API returns 500 | `toast.error()` shown, dashboard remains functional |
| 11 | Payment poll network failure | Poll continues silently, no crash |
| 12 | Pipeline running + free tier | Only pipeline poll active (not payment poll) — no duplicate polling |

---

## e) Profiling Requirements

### What to Measure

| Metric | Baseline | Target | How |
|--------|----------|--------|-----|
| ResultsDashboard render time (free) | ~80ms (current, no overlays) | < 120ms (with overlays) | React DevTools Profiler |
| ResultsDashboard render time (paid) | ~80ms | < 85ms (no new overhead) | React DevTools Profiler |
| PaywallOverlay CSS paint | N/A | < 5ms per overlay | Chrome DevTools Performance |
| Pricing page TTFB | N/A | < 200ms (server rendered) | Lighthouse |
| Payment poll network overhead | N/A | < 1KB per poll (304 if no change) | Network tab |

### When to Profile

- After Task 1 (#42) paywall UI is implemented
- Test with realistic data: 16 pillars, 10+ recommendations, all generated files populated
- Profile both free and paid rendering paths
- Check for layout shift during free → paid transition

---

## f) Load Test Plan

### Scenarios

| # | Scenario | Concurrent Users | Duration | Description |
|---|----------|------------------|----------|-------------|
| 1 | Free users polling for payment | 100 free users | 120s | Each polls `/api/sites/[id]` every 3s |
| 2 | Mixed free + paid dashboard views | 80 free + 20 paid | 60s | Verify server handles both tier response shapes |
| 3 | Checkout API under load | 20 concurrent | 30s | Stripe session creation |

### Success Criteria

| Metric | Target |
|--------|--------|
| p50 poll response | < 100ms |
| p95 poll response | < 300ms |
| Checkout API p50 | < 500ms (Stripe latency dominates) |
| Error rate | < 0.1% |

### Resource Consumption

- **Payment polling concern**: If 1000 free users all poll every 3s = 333 req/s to the API. This is the primary scaling concern. Mitigation: Consider increasing poll interval to 5s or 10s, or using Server-Sent Events in a future sprint.

### Tool Recommendation

- **k6** for HTTP load testing against API routes
- Load tests are stretch-goal for Sprint 2

---

## g) Logging & Instrumentation

### Events to Log

| Event | Level | Fields | When |
|-------|-------|--------|------|
| `paywall_overlay_shown` | `info` | `{ siteId, section: string, tier }` | PaywallOverlay renders (client-side analytics) |
| `upgrade_cta_clicked` | `info` | `{ siteId, source: "overlay" \| "banner" \| "regenerate_button" }` | User clicks any upgrade CTA |
| `checkout_initiated` | `info` | `{ siteId }` | `/api/checkout` POST succeeds |
| `checkout_failed` | `warn` | `{ siteId, error: string }` | `/api/checkout` POST fails |
| `payment_toast_shown` | `info` | `{ source: "dashboard" }` | Post-payment toast fires |
| `tier_auto_upgraded` | `info` | `{ siteId, previousTier: "free", newTier: "paid" }` | Payment poll detects tier change |
| `pricing_page_viewed` | `info` | `{}` | `/pricing` page rendered (server-side or via analytics) |

### Metrics to Emit

| Metric | Type | Labels |
|--------|------|--------|
| `paywall_cta_clicks_total` | counter | `source: "overlay" \| "banner" \| "regenerate"` |
| `checkout_success_total` | counter | — |
| `checkout_failure_total` | counter | — |
| `payment_poll_requests_total` | counter | — |
| `tier_upgrade_latency_ms` | histogram | — (time from payment to tier flip) |

### Implementation Note

Client-side events should use the existing analytics pattern. If Vercel Analytics is the only tool (confirmed in `layout.tsx`), these can be logged via `console.log` in development and wired to a proper analytics service later. The event schema should remain stable.

---

## h) Acceptance Criteria

### Task 1: Dashboard Paywall UI (#42)

- [ ] `SiteData` interface includes `tier: "free" | "paid"` and `credits: number`
- [ ] Free users see: overall score, pillar names + scores, first paragraph of summary, first 3 recommendation titles
- [ ] All premium content blurred with `backdrop-filter: blur(8px)` — visible but locked, creating visual curiosity
- [ ] "Upgrade Now" CTA is prominent on every gated section — redirects to Stripe checkout
- [ ] After payment, paywall drops within 3-6 seconds (one poll cycle) without page reload
- [ ] No layout shift or flash when transitioning from free → paid view
- [ ] Regenerate button shows "Upgrade to Re-run Audit" for free users
- [ ] `manualRunsLeft = 0` for free tier regardless of `manualRunsThisMonth`
- [ ] Quick Wins section hidden for free tier
- [ ] Free tier banner displayed below header with upgrade CTA
- [ ] Payment polling only runs when `tier === "free"` AND `pipelineStatus === "complete"`
- [ ] Inline styles used (matching existing component pattern — no Tailwind classes in this component)
- [ ] All new unit tests pass (18 test cases)

### Task 2: Post-Payment Toast (#43)

- [ ] After Stripe redirect to `/dashboard?payment=success`, success toast appears
- [ ] Toast text: "Payment successful — 100 credits added!"
- [ ] URL param `?payment=success` cleaned from address bar
- [ ] Toast appears once, not on re-render
- [ ] `PaymentToast` wrapped in `<Suspense>` per Next.js requirements
- [ ] All new unit tests pass (4 test cases)

### Task 3: Pricing Page (#45)

- [ ] `/pricing` renders — no more 404
- [ ] Two-column comparison table with all features listed
- [ ] All numeric values from `lib/config.ts` — zero hardcoded numbers
- [ ] Free CTA → homepage (`/`), Paid CTA → dashboard (`/dashboard`)
- [ ] Page matches existing dark theme design language
- [ ] Responsive — single column mobile, two column desktop
- [ ] Stripe checkout cancel redirect now lands on the pricing page
- [ ] All new unit tests pass (5 test cases)

### Overall Sprint 2

- [ ] Sprint 1 (ES-002) is merged and `tier`/`credits` fields are in the API response
- [ ] All 3 tasks complete: #42 → #43, #45 (parallel)
- [ ] No regressions — existing paid user flow unchanged
- [ ] Build succeeds (`next build`)
- [ ] Test coverage ≥ 85% for modified/new files

---

## Dependencies & Ordering

```
ES-002 Sprint 1 complete (API returns tier/credits)
    │
    ├──→ #42 Dashboard paywall UI ← Start first (largest task)
    │     └──→ #43 Post-payment toast ← After #42 (same user flow)
    │
    └──→ #45 Pricing page ← Can parallel with #42
```

## Files Summary

| Action | File | Task |
|--------|------|------|
| **MODIFY** | `app/sites/[id]/ResultsDashboard.tsx` | #42 |
| **CREATE** | `app/dashboard/PaymentToast.tsx` | #43 |
| **MODIFY** | `app/dashboard/page.tsx` | #43 |
| **CREATE** | `app/pricing/page.tsx` | #45 |
| **CREATE** | `__tests__/paywall-ui.test.tsx` | #42 |
| **CREATE** | `__tests__/payment-toast.test.tsx` | #43 |
| **CREATE** | `__tests__/pricing-page.test.tsx` | #45 |
| **CREATE** | `__tests__/integration/paywall-flow.test.ts` | #42, #43 |
| **VERIFY** | `app/page.tsx` (nav link to /pricing) | #45 |

**Total:** 5 new files, 2 modified files, 1 verification
