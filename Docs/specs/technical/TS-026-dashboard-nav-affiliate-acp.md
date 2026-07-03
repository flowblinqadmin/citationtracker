# TS-026 — Dashboard Navigation: Affiliate + ACP Entry Point Cards

**Date:** 2026-03-04
**Priority:** P2
**Status:** HOLD — dispatch to SpecMaster after WordPress plugin (TS-019) is released
**Author:** CoFounder (Agent 1)

---

## What

Add two navigation cards to the GEO dashboard (`app/dashboard/page.tsx`) giving users visible surface for the Affiliate Portal and ACP (Agent Commerce Protocol) dashboard. UI-only change. No auth wiring, no API calls, no backend changes.

---

## Why

Currently the GEO dashboard shows only audit results. Users have no way to discover that Flowblinq offers affiliate and ACP products. These entry points serve as product awareness — users see "more from Flowblinq" without needing to visit the marketing site.

The cards link to placeholders initially (affiliate portal not yet live; ACP at `audit.flowblinq.com`). Once the affiliate API ships, the link is updated in a single line change.

**Hard constraint:** No `/api/v1/*` changes. No auth wiring. Fully isolated from v1 API release.

---

## Dependencies

- TS-019 (WordPress Plugin + Public API) released and stable — ensures dashboard codebase is not in active churn
- No backend dependencies

---

## Current Dashboard Structure

`app/dashboard/page.tsx` renders:
1. Navbar (user email + credits badge + sign out)
2. "Your Audits" heading + subtitle
3. Domain cards grid (or empty state)
4. "Run another audit" link (if domains exist)
5. `<ApiAccessSection>` (team API key management)

The new product cards go in a new section **below** the domain cards and above `<ApiAccessSection>`.

---

## Design Spec

### Section: "More from Flowblinq"

A two-card horizontal grid. Matches the existing dashboard visual language: `background: CARD`, `border: "1px solid rgba(0,0,0,0.07)"`, `borderRadius: "16px"`, `padding: "24px"`.

```
┌─────────────────────────────────────────────────────────────────┐
│  More from Flowblinq                                            │
│                                                                 │
│  ┌─────────────────────────────┐  ┌────────────────────────┐  │
│  │  ◈  Affiliate Portal        │  │  ◎  ACP Dashboard      │  │
│  │                             │  │                        │  │
│  │  Earn commissions by        │  │  Manage your Agent     │  │
│  │  publishing AI-optimized    │  │  Commerce Protocol     │  │
│  │  content for top brands.    │  │  listings and brand    │  │
│  │                             │  │  feed.                 │  │
│  │  [Coming soon →]            │  │  [Open dashboard →]    │  │
│  └─────────────────────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**Design tokens (reuse from existing dashboard):**
```typescript
const CARD    = "#fff"
const TEXT    = "#1a1a1a"
const TEXT_2  = "#6b7280"
const ACCENT  = "#b45309"  // amber-700 — matches existing CTA color
```

**Card structure (per card):**
- Icon: single Unicode character, `fontSize: "28px"`, `marginBottom: "12px"`
- Title: `fontSize: "16px"`, `fontWeight: 700`, `color: TEXT`
- Body: 2-line description, `fontSize: "14px"`, `color: TEXT_2`, `lineHeight: 1.5`, `marginBottom: "16px"`
- CTA link: styled as button or styled anchor, `fontSize: "14px"`, `fontWeight: 600`, `color: ACCENT`

**Grid:** `display: "grid"`, `gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))"`, `gap: "16px"`, `marginTop: "40px"`, `marginBottom: "32px"`

**Section heading:** `fontSize: "16px"`, `fontWeight: 700`, `color: TEXT_2`, `marginBottom: "16px"`, `letterSpacing: "0.02em"`, `textTransform: "uppercase"`

---

## Card Content

### Card 1: Affiliate Portal
- **Icon:** ◈
- **Title:** Affiliate Portal
- **Body:** "Earn commissions by publishing AI-optimized content for top brands in your niche."
- **CTA text:** "Coming soon →"
- **CTA href:** `#` (disabled for now — no live URL)
- **CTA style:** `opacity: 0.5`, `cursor: "default"` (visually indicates not yet live)

### Card 2: ACP Dashboard
- **Icon:** ◎
- **Title:** ACP Dashboard
- **Body:** "Manage your Agent Commerce Protocol listings, brand feed, and structured product data."
- **CTA text:** "Open dashboard →"
- **CTA href:** `https://audit.flowblinq.com` (external link, `target="_blank"`, `rel="noopener noreferrer"`)
- **CTA style:** normal, clickable

---

## Placement Rules

- Show section **only when the user has at least one domain** (`domains.length > 0`). Not shown in empty state.
- Show section **only when user has a team** (`teamInfo !== null`). Free/anonymous users don't see it.
- Inserted between the domain cards grid and the "Run another audit" link.

Rationale: users who have run an audit and have a team are the most relevant audience for these products. Empty-state users are still being onboarded.

---

## Files to Change

| File | Change |
|------|--------|
| `app/dashboard/page.tsx` | Add "More from Flowblinq" section with two product cards. Inline styles only — no new CSS files or components. |

No other files change. No new components. No new routes. No new API calls.

---

## Acceptance Criteria

1. **Visible:** Section appears below the domain card grid when `domains.length > 0 && teamInfo !== null`.

2. **Hidden:** Section does not appear in empty state (no domains) or when `teamInfo === null`.

3. **ACP card links:** `https://audit.flowblinq.com` opens in new tab with `rel="noopener noreferrer"`.

4. **Affiliate card:** CTA is visually disabled (`opacity: 0.5`, no pointer cursor). Clicking does nothing (href="#" or no-op).

5. **No regressions:** Existing dashboard features (domain cards, API key section, credit badge, sign out) are unchanged.

6. **Style consistency:** Cards use the same color tokens and border-radius as existing HoverCard components.

7. **Responsive:** Section renders correctly at 1200px, 900px, and 600px viewport widths (grid collapses to single column below 600px via `minmax(280px, 1fr)`).

---

## Implementation Notes

- All styles are inline (consistent with rest of `dashboard/page.tsx` — this file uses only inline styles, no Tailwind, no CSS modules).
- Do not create a new component file. Inline the section directly in `DashboardPage`.
- The section is pure presentational HTML. No client-side JS needed.

---

## Future (not in scope)

- When affiliate API goes live: update Card 1 `href` to real URL and remove `opacity: 0.5`
- When user has active affiliate account: show commission metrics inline on the card
- Mobile app deep links
- Referral program entry point
