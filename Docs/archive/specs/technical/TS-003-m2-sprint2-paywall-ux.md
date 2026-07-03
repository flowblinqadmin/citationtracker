# TS-003: M2 Sprint 2 — Paywall UX + Pricing Page

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** [#42](https://github.com/flowblinqadmin/geo/issues/42) · [#43](https://github.com/flowblinqadmin/geo/issues/43)  
> **Delivery Commit:** `2bad500`  

---

**Agent:** 1-CoFounder
**Date:** 2026-02-26
**Branch:** `dev-an`
**Repo:** flowblinqadmin/geo
**Issues:** #42, #43, #45
**Depends on:** TS-002 (Sprint 1 — API gating must be in place)

---

## Overview

Sprint 2 is the user-facing monetization layer. Sprint 1 built the server-side boundary (API gating). Sprint 2 makes it visible and actionable in the UI.

```
#38 API gating (Sprint 1, done)
 ├──→ #42 Dashboard paywall UI
 │     └──→ #43 Post-payment toast
 └──→ #45 Pricing page
```

---

## Task 1: Dashboard Paywall UI (#42)

### What
Gate paid features in `app/sites/[id]/ResultsDashboard.tsx`. Free users see scores and pillar names, but detailed findings, recommendations, and generated files are blurred/locked with an upgrade CTA. After Stripe payment, the paywall drops automatically via the existing 3s poll — no reload required.

### Why
This is how free users discover they need to pay. Without this, free users either see nothing (bad UX) or see everything (no monetization). The blurred preview creates desire.

### Current State
- `ResultsDashboard.tsx` — 910 lines, renders everything unconditionally
- Component receives `SiteData` via props from the page server component
- Existing 3s poll: the page already polls `GET /api/sites/[id]` every 3 seconds during pipeline runs (for status updates)
- After Sprint 1 (#38), the API response includes `tier` and `credits` fields

### SiteData Interface Update

At the top of `ResultsDashboard.tsx`, the `SiteData` interface needs two new fields:

```ts
interface SiteData {
  // ... existing fields ...
  tier: "free" | "paid";
  credits: number;
}
```

### Upgrade Handler

Add near the top of the `ResultsDashboard` component:

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

### Paywall Component

Create a reusable `PaywallOverlay` component (can be inline in the same file or extracted):

```tsx
function PaywallOverlay({ onUpgrade }: { onUpgrade: () => void }) {
  return (
    <div className="absolute inset-0 backdrop-blur-md bg-black/40 flex items-center justify-center z-10 rounded-lg">
      <div className="text-center p-6">
        <h3 className="text-lg font-semibold text-white mb-2">
          Upgrade to unlock full report
        </h3>
        <p className="text-sm text-gray-300 mb-4">
          100 credits for $10 — full audit details, recommendations, and generated files
        </p>
        <button
          onClick={onUpgrade}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium"
        >
          Upgrade Now
        </button>
      </div>
    </div>
  );
}
```

### Sections to Gate

Wrap these sections with a `relative` container + `PaywallOverlay` when `tier === "free"`:

| Section | Current Location (approx) | Gate Behavior |
|---------|--------------------------|---------------|
| Pillar findings (detailed breakdown) | Pillar accordion/expansion | Blur — show pillar name + score, lock findings |
| Recommendations (detail view) | Recommendations section | Show first 3 titles, blur details + remaining |
| Executive summary (full) | Summary section | Show first paragraph, blur rest |
| Generated files (llms.txt, schema, etc.) | File preview / download section | Fully locked — show file names only |
| Regenerate button | Regenerate section | Disable with "Upgrade to re-run" tooltip |

### Pattern for each gated section:

```tsx
<div className="relative">
  {tier === "free" && <PaywallOverlay onUpgrade={handleUpgrade} />}
  {/* existing content renders underneath, visible but blurred */}
  <div className={tier === "free" ? "pointer-events-none select-none" : ""}>
    {/* ... existing section content ... */}
  </div>
</div>
```

### Auto-Unlock After Payment

The existing 3s poll already fetches fresh data from the API. After payment:
1. Stripe webhook adds credits to team → `creditBalance > 0`
2. Next poll hit returns `tier: "paid"` and full data
3. React state updates, `tier === "free"` conditions flip to false
4. Paywall overlays disappear, content renders — no reload needed

**Verify:** The 3s poll must continue even when pipeline is `complete`. Currently it may stop polling after pipeline completion. If so, add a secondary poll that runs while `tier === "free"` and `pipelineStatus === "complete"`:

```ts
// Poll for payment completion (when free user is waiting to unlock)
useEffect(() => {
  if (siteData.tier !== "free" || siteData.pipelineStatus !== "complete") return;
  const interval = setInterval(async () => {
    const res = await fetch(`/api/sites/${siteData.id}?token=${token}`);
    const data = await res.json();
    if (data.tier === "paid") {
      setSiteData(data);
      clearInterval(interval);
    }
  }, 3000);
  return () => clearInterval(interval);
}, [siteData.tier, siteData.pipelineStatus]);
```

### Acceptance Criteria
- [ ] Free users see overall score, pillar names + scores, first paragraph of summary, first 3 recommendation titles
- [ ] All premium content is blurred with `backdrop-blur-md` — not hidden, creating visual curiosity
- [ ] "Upgrade Now" CTA is prominent and functional — redirects to Stripe checkout
- [ ] After payment, paywall drops within 3 seconds without page reload
- [ ] Regenerate button disabled for free users with clear messaging
- [ ] No layout shift or flash when transitioning from free to paid view

### Risks
- **MEDIUM: Component complexity.** ResultsDashboard.tsx is 910 lines. Wrapping sections with conditional overlays must not break the existing layout. Test on both free and paid states.
- **LOW: Checkout redirect.** The checkout route creates a Stripe session and returns `checkoutUrl`. The `success_url` in checkout route points to `/dashboard?payment=success` — this may need to change to `/sites/[id]?payment=success` so the user returns to their report, not the dashboard.

---

## Task 2: Post-Payment Toast (#43)

### What
After Stripe redirects back to the app with `?payment=success`, show a success toast and clean the URL params.

### Why
UX polish. User just paid — confirm the action succeeded immediately.

### Current State
- Stripe checkout `success_url` in `app/api/checkout/route.ts:40` points to `/dashboard?payment=success`
- No handler for this param exists anywhere

### Changes

**Step 1: Update checkout success_url**

In `app/api/checkout/route.ts`, the `success_url` should return the user to their specific site report, not the generic dashboard. But checkout doesn't know which site the user was viewing. Two options:

- **Option A (simpler):** Keep `/dashboard?payment=success`. Dashboard shows the toast.
- **Option B (better UX):** Accept a `returnTo` query param in the checkout request, pass it through Stripe metadata, and redirect back to that page.

Recommend **Option A** for now. The dashboard already shows the user's domains — they can click through.

**Step 2: Add toast handler to dashboard**

In `app/dashboard/page.tsx` (or its client component), add:

```tsx
"use client";
import { useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner"; // or whatever toast lib is in use

// Inside the component:
const searchParams = useSearchParams();
const router = useRouter();

useEffect(() => {
  if (searchParams.get("payment") === "success") {
    toast.success("Payment successful — 100 credits added!");
    // Clean URL
    const url = new URL(window.location.href);
    url.searchParams.delete("payment");
    router.replace(url.pathname, { scroll: false });
  }
}, [searchParams, router]);
```

**Step 3: Verify toast library**

Check which toast library the project uses. Search for `toast` imports in existing files. If `sonner` is already installed, use it. If `react-hot-toast`, use that. Do not add a new toast library.

### Acceptance Criteria
- [ ] After Stripe payment redirect, user sees success toast
- [ ] URL params are cleaned (no `?payment=success` remaining)
- [ ] Toast appears once, not on every render
- [ ] Works on both dashboard and site report page (if we later add return-to-site)

### Risks
- LOW. Pure UI polish.

---

## Task 3: Pricing Page (#45)

### What
Create a standalone `/pricing` page showing free vs paid comparison with CTAs.

### Why
Marketing page. Users need to understand what they get before clicking "Upgrade." The checkout `cancel_url` already points to `/pricing` but the page doesn't exist.

### Current State
- No `app/pricing/page.tsx` exists
- Middleware allowlist on `dev-an` branch includes `/pricing` (already whitelisted)
- `cancel_url` in checkout route: `${appUrl}/pricing`

### Create `app/pricing/page.tsx`

Server component (no interactivity — links only). Style must match rest of app (dark background, same nav pattern as homepage).

```tsx
import { CREDITS_PER_PACK, CREDITS_PRICE_USD, PAID_MAX_PAGES, FREE_MAX_PAGES } from "@/lib/config";

export const metadata = {
  title: "Pricing — GEO by Flowblinq",
  description: "Free and paid plans for GEO optimization audits",
};

export default function PricingPage() {
  return (
    // ... layout matching app style
  );
}
```

### Content Structure

**Two-column comparison:**

| Feature | Free | Paid |
|---------|------|------|
| GEO audit | Yes | Yes |
| Pages crawled | {FREE_MAX_PAGES} | {PAID_MAX_PAGES} |
| Overall score | Yes | Yes |
| Pillar scores | Yes | Yes |
| Detailed findings | No | Yes |
| Recommendations | First 3 titles | All with implementation details |
| Executive summary | First paragraph | Full |
| Generated llms.txt | No | Yes |
| Generated schema blocks | No | Yes |
| Generated business.json | No | Yes |
| Re-runs | Initial only | {CREDITS_PER_PACK / PAID_CRAWL_CREDIT_COST} per pack |
| Price | Free | ${CREDITS_PRICE_USD} for {CREDITS_PER_PACK} credits |

**CTAs:**
- Free column: "Start Free Audit" → links to `/` (homepage with domain input)
- Paid column: "Buy Credits" → triggers `/api/checkout` (needs client component wrapper or link to dashboard)

Note: The checkout endpoint requires Supabase auth. If the user isn't logged in, the CTA should link to `/auth/login?returnTo=/pricing` or show a "Sign in to purchase" flow.

### Navigation
Add a "Pricing" link to the site navigation (if a shared nav component exists). Check `app/layout.tsx` or any shared header component.

### Acceptance Criteria
- [ ] `/pricing` renders a comparison table with all values from `lib/config.ts`
- [ ] No hardcoded numbers — all pulled from config constants
- [ ] CTAs functional: free → homepage, paid → checkout (or login if unauthenticated)
- [ ] Page matches existing app design language (dark theme, same fonts, responsive)
- [ ] Stripe cancel redirect (`/pricing`) now lands on a real page instead of 404

### Risks
- LOW. Static page with config imports.
- MINOR: Authentication check on "Buy Credits" CTA — unauthenticated users need to be redirected to login first.

---

## Sprint 2 Dependency Chain

```
Sprint 1 complete (API returns tier/credits)
    │
    ├──→ #42 Dashboard paywall UI (reads tier from API)
    │     │
    │     └──→ #43 Post-payment toast (after checkout redirect)
    │
    └──→ #45 Pricing page (uses config.ts constants)
```

#42 and #45 can be built in parallel. #43 depends on #42 only conceptually (same user flow) but can also be built independently.

## Effort Estimate

| Task | Effort | Files Changed |
|------|--------|---------------|
| #42 Dashboard paywall | Large (conditional rendering across 5+ sections in 910-line component) | 1-2 files |
| #43 Post-payment toast | Small (one useEffect + toast call) | 1 file |
| #45 Pricing page | Medium (new page, design work, auth-aware CTA) | 1-2 files |

**Total Sprint 2:** 6-8 hours for ScriptDev, 1-2 review cycles.
