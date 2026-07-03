# ES-043 — Website Redesign: Unified Arc System

**Status:** FINAL
**Author:** SpecMaster (2)
**Date:** 2026-03-12
**Source:** TS-042-website-homepage-redesign.md
**Assigned to:** DaVinci (10)
**Pipeline:** TS-042 → ES-043 → CostMaster (taskboard) → DaVinci (implementation)

---

## a) Overview

### What This Covers

Redesign of flowblinq.com as a unified landing experience for two products — **GEO** (Generative Engine Optimization) and **ACP** (Agentic Commerce Protocol). The homepage carries an 8-beat narrative arc at full depth. Other pages compress or expand specific beats. A shared `<ArcBeat>` component and `data/stats.ts` registry govern all content rendering.

### Current Implementation State

**Codebase:** `/home/aditya/flowblinq/archive/V0-Website/`
**Stack:** Next.js 15.5.9, React 19.2.0, TypeScript 5, Tailwind CSS 4.1.9, Radix UI, Framer Motion 12.23.26, Shadcn/UI (New York style)

**What exists:**
- Homepage (`app/page.tsx`) — 2,449-line client component with ChatGPT phone demo, protocol diagram, audit form, inline stats, build-vs-buy comparison
- Header (`components/header.tsx`) — dark nav bar with logo, nav links (Solution, Use Cases, Docs, About, Blog), "Free Audit" CTA
- Footer (`components/footer.tsx`) — multi-column with Use Cases, Resources, Contact sections
- About page (`app/about/page.tsx`) — "What We Do / Don't Do" format, no team credentials section
- Agentic Commerce page (`app/agentic-commerce/page.tsx`) — existing product page with pricing
- For-AI page (`app/for-ai/page.tsx`) — machine-readable structured info (no Header/Footer)
- Audit form (`components/audit-form.tsx`) — URL input + iframe to audit.flowblinq.com
- Dashboard showcase (`components/dashboard-showcase.tsx`) — 6-tab interactive demo
- UI primitives in `components/ui/` — Shadcn/UI (button, input, label, table, textarea)
- `lib/utils.ts` — `cn()` utility (clsx + tailwind-merge)
- `data/` directory exists (empty `.gitkeep`)
- Design tokens in `app/globals.css` — CSS variables for colors, radii, shadows
- Path alias: `@/* → ./*`

**What's needed:**
- `data/stats.ts` stat registry (new file)
- `<ArcBeat>` shared component system (new)
- Homepage rewrite — 8 sections replacing current content
- Header nav update (Solution → GEO | ACP | Use Cases | Blog | About)
- Footer product links update (add GEO + ACP under "Products")
- `/geo` product page (new route)
- `/about` team credentials section (update)
- `/agentic-commerce` messaging alignment (update)

### Dependencies

| Dependency | Location | Status |
|-----------|----------|--------|
| V0-Website repo | `/home/aditya/flowblinq/archive/V0-Website/` | Exists, `main` branch |
| Design Spine | DaVinci CLAUDE.md (Apple HIG + Tufte) | Embedded in agent config |
| Apple HIG reference | `platform/website/design-assets/apple-style-guide.pdf` | Available |
| Tufte reference | `platform/website/design-assets/TufteTheVisualDisplayOfQuantitativeInformation.pdf` | Available |
| Audit flow | `audit.flowblinq.com` | Live |
| GEO audit | `geo.flowblinq.com` | Live |

---

## b) Implementation Requirements

### b.1 — `data/stats.ts` Stat Registry

**File:** `data/stats.ts` (new)

```ts
export interface Stat {
  value: string;
  label: string;
  source: string;
  verified: string;       // ISO date
  pages: string[];        // which pages use this stat
}

export const stats: Record<string, Stat> = {
  weeklyAIUsers: {
    value: "700M+",
    label: "weekly AI assistant users",
    source: "/* source URL */",
    verified: "2026-02-01",
    pages: ["home", "geo", "acp"],
  },
  aiTrafficGrowth: {
    value: "693%",
    label: "YoY growth in AI-referred traffic",
    source: "/* source URL */",
    verified: "2026-02-01",
    pages: ["home"],
  },
  aiConversionRate: {
    value: "15.9%",
    label: "conversion rate from AI-referred traffic",
    source: "/* source URL */",
    verified: "2026-02-01",
    pages: ["home", "acp"],
  },
  conversionMultiplier: {
    value: "6.6×",
    label: "higher conversion vs traditional search",
    source: "/* source URL */",
    verified: "2026-02-01",
    pages: ["home", "acp"],
  },
  // Additional stats added per page as content is authored
};

/** Helper: get stats for a given page */
export function getStatsForPage(page: string): Stat[] {
  return Object.values(stats).filter((s) => s.pages.includes(page));
}
```

**Rules:**
- No stat value may appear hardcoded in JSX — all stats must reference this registry
- Each stat must have a `source` URL (can be placeholder initially, DaVinci fills from TS-042 content)
- `verified` date must be present for audit trail

---

### b.2 — `<ArcBeat>` Component System

**File:** `components/arc-beat.tsx` (new)

```ts
export type Beat =
  | "shift"
  | "risk"
  | "opportunity"
  | "solution"
  | "difference"
  | "proof"
  | "credibility"
  | "convert";

export type Depth = "full" | "compressed" | "one-liner" | "cta-only";

export type Emphasis = "geo" | "acp" | "both";

export interface ArcBeatStat {
  value: string;
  label: string;
  source?: string;
}

export interface ArcBeatProps {
  beat: Beat;
  depth: Depth;
  stats?: ArcBeatStat[];
  emphasis?: Emphasis;          // default: "both"
  learnMoreHref?: string;       // link target for compressed beats
  children?: React.ReactNode;   // full-depth content slot
  className?: string;
}
```

**Rendering rules by depth:**
- **`full`** — Renders `children` (the full section content), stats, and all visuals. Each beat's full content is page-specific, passed as children.
- **`compressed`** — One stat + one sentence summary + "Learn more →" link to `learnMoreHref`. No children rendered. Max height: ~120px on desktop.
- **`one-liner`** — Single anchoring sentence. No stats, no expansion, no link. Context-setting only. Single `<p>` element.
- **`cta-only`** — Just the audit CTA button(s). No narrative. Applicable to `proof` and `convert` beats only.

**Component structure:**
- Wraps content in a `<section>` with `data-beat={beat}` and `data-depth={depth}` attributes
- Applies semantic `id` for scroll targeting: `id="arc-{beat}"`
- `aria-label` on the section: e.g., "The Shift — Market context"
- Respects `prefers-reduced-motion` — disable all Framer Motion animations when active
- All spacing uses 4px base unit multiples

**Beat content files (new, one per beat for full-depth homepage content):**
- `components/beats/shift-full.tsx` — S1 Hero
- `components/beats/risk-full.tsx` — S2 Risk/FOMO
- `components/beats/opportunity-full.tsx` — S3 Opportunity
- `components/beats/solution-full.tsx` — S4 Solution (GEO + ACP)
- `components/beats/difference-full.tsx` — S5 Differentiation
- `components/beats/proof-full.tsx` — S6 Proof (mid-page CTA)
- `components/beats/credibility-full.tsx` — S7 Credibility (team)
- `components/beats/convert-full.tsx` — S8 Convert (bottom CTA)

Each beat component receives `stats` and `emphasis` as props from the page. The page assembles beats — the beat component renders content.

---

### b.3 — Homepage Rewrite

**File:** `app/page.tsx` (rewrite)

The existing 2,449-line homepage is replaced with a clean 8-beat arc composition.

**Structure:**

```tsx
export default function HomePage() {
  return (
    <main>
      <ArcBeat beat="shift" depth="full" stats={[stats.weeklyAIUsers, ...]} emphasis="both">
        <ShiftFull />
      </ArcBeat>
      <ArcBeat beat="risk" depth="full" emphasis="both">
        <RiskFull />
      </ArcBeat>
      <ArcBeat beat="opportunity" depth="full" stats={[stats.aiConversionRate, ...]} emphasis="both">
        <OpportunityFull />
      </ArcBeat>
      <ArcBeat beat="solution" depth="full" emphasis="both">
        <SolutionFull />
      </ArcBeat>
      <ArcBeat beat="difference" depth="full" emphasis="both">
        <DifferenceFull />
      </ArcBeat>
      <ArcBeat beat="proof" depth="full" emphasis="both">
        <ProofFull />
      </ArcBeat>
      <ArcBeat beat="credibility" depth="full" emphasis="both">
        <CredibilityFull />
      </ArcBeat>
      <ArcBeat beat="convert" depth="full" emphasis="both">
        <ConvertFull />
      </ArcBeat>
    </main>
  );
}
```

**Section-by-section requirements (referencing TS-042 §3):**

#### S1 — Hero: "The Shift" (`components/beats/shift-full.tsx`)
- **Differentiating tagline** above the fold, before main headline — visually distinct (smaller, lighter weight or accented, like a super-headline)
  - Examples from TS: "Other tools show you the problem. We fix it." / "Not another dashboard. Actual optimization."
- **Lead stat:** 700M+ weekly AI users (from `stats.weeklyAIUsers`)
- **Supporting stats:** YoY growth, % product research in AI (from registry)
- **Main headline/thesis:** "The way people find products has fundamentally changed..."
- **Visual:** Dark background, large typography, animated counter or stat reveal on scroll
- **Semantic:** `<section>`, heading hierarchy starts at `<h1>` (only h1 on the page)
- **Existing patterns to reuse:** Stats counter pattern exists in current homepage

#### S2 — "The Risk" (`components/beats/risk-full.tsx`)
- **Content:** 3-4 sentences max. Binary framing: cited or not cited.
- **Visual:** Split screen or before/after. "What AI sees" (structured, cited brand) vs "What AI says about you" (nothing/hallucinated). Mock ChatGPT-style response.
- **Components:** Two-column comparison layout with subtle animation
- **Accessibility:** Ensure contrast works for both "good" and "bad" states

#### S3 — "The Opportunity" (`components/beats/opportunity-full.tsx`)
- **Stats:** 15.9% conversion rate, 6.6× vs traditional (from registry)
- **Three advantage cards:** Citation dominance, Conversion premium, Protocol lock-in
- **Visual:** Three-card grid with icons, stat per card. Green/aspirational tones.
- **Components:** Card grid — each card has icon, heading, stat, 1-2 sentence description

#### S4 — "The Solution" (`components/beats/solution-full.tsx`)
- **Opening frame:** "Visibility alone isn't enough..."
- **Two product cards:** GEO (left) and ACP (right), mirrored design, different accent colors
- **Each card:** Icon, headline, 2-3 bullets, "Learn more" link (`/geo` and `/agentic-commerce`)
- **Connecting statement:** "GEO gets you found. ACP gets you paid."
- **Visual:** Side-by-side cards, possibly connected by visual flow element

#### S5 — "The Difference" (`components/beats/difference-full.tsx`)
- **Opening frame:** "Every other tool gives you a report. We give you the fix."
- **Three-column comparison table:**
  - Column 1: "What others do" (muted/grey styling)
  - Column 2: "What that means"
  - Column 3: "What we do" (bold/vivid styling)
- **Three rows** per TS-042 §3 S5 content
- **Key lines:** "We don't sell dashboards. We sell results."
- **Visual:** Clear hierarchy — "others" = muted, "us" = bold. No animation needed.

#### S6 — "The Proof" (`components/beats/proof-full.tsx`)
- **Two audit cards** side by side:
  - **GEO Audit:** "See how AI models currently perceive your brand" → `geo.flowblinq.com`
  - **ACP Audit:** "See how ready your store is for AI agent commerce" → `audit.flowblinq.com`
- **Each card:** Headline, 1-2 line description, URL input or CTA button
- **Primary conversion point** — highest visual prominence on page
- **Can extend existing `audit-form.tsx`** — two instances, configured per context
- **No signup copy:** "No signup. No credit card. Just your URL."

#### S7 — "The Credibility" (`components/beats/credibility-full.tsx`)
- **No names.** Credentials only.
- **Framing:** "Built by engineers, not marketers."
- **Two credential cards:**
  - Co-founder 1: PhD Quantitative Finance (IISc), 13+ years HFT systems
  - Co-founder 2: 15+ years supply chain, AWS initiatives at Amazon
- **Connecting statement:** "This isn't a marketing tool with AI sprinkled on top. It's infrastructure..."
- **Visual:** Clean, minimal. No headshots. Two-column card layout.

#### S8 — "The Convert" (`components/beats/convert-full.tsx`)
- **Reuse S6 audit component** (same dual CTA)
- **Secondary CTA:** "Want to talk first? Schedule a call." → existing demo/contact flow
- **Visual:** Full-width, high contrast background (dark or brand accent). Large CTA buttons.

---

### b.4 — Header Navigation Update

**File:** `components/header.tsx` (modify)

**Current nav links:** Solution | Use Cases | Docs | About | Blog
**New nav links:** GEO | ACP | Use Cases | Blog | About

**Changes:**
- Replace "Solution" with "GEO" → `/geo`
- Add "ACP" → `/agentic-commerce`
- Remove "Docs" from main nav (keep in footer)
- CTA button: "Free Audit" — on homepage scrolls to `#arc-proof` (S6), on other pages links to `audit.flowblinq.com`
- Mobile: Add hamburger menu with full nav (current mobile only shows "Home" link — needs proper mobile nav)
- Use Radix `NavigationMenu` or a simple responsive nav pattern

---

### b.5 — Footer Product Links Update

**File:** `components/footer.tsx` (modify)

**Changes:**
- Add "Products" column with:
  - GEO → `/geo`
  - ACP → `/agentic-commerce`
- Keep existing Use Cases, Resources, Contact columns
- Update "Resources" column: ensure `/geo` and `/agentic-commerce` are listed

---

### b.6 — `/geo` Product Page (New)

**File:** `app/geo/page.tsx` (new)

**Arc depth matrix (from TS-042 §4.2):**

| Beat | Depth |
|------|-------|
| Shift | compressed |
| Risk | **full** (GEO-specific) |
| Opportunity | compressed |
| Solution | **full** (GEO deep dive) |
| Difference | compressed |
| Proof | **full** (GEO audit CTA) |
| Credibility | compressed |
| Convert | **full** |

**Content:**
- Stats at visibility-specific level: "X% of AI responses cite zero brands", "Y% hallucination rate without structured data"
- Full Risk section emphasizes GEO-specific risks (brand invisibility in AI)
- Full Solution section deep-dives into GEO product features
- Full Proof section links to GEO audit at `geo.flowblinq.com`
- Metadata: title, description, OG tags

---

### b.7 — `/agentic-commerce` Messaging Alignment

**File:** `app/agentic-commerce/page.tsx` (modify)

**Arc depth matrix:**

| Beat | Depth |
|------|-------|
| Shift | compressed |
| Risk | compressed |
| Opportunity | **full** (ACP-specific) |
| Solution | **full** (ACP deep dive) |
| Difference | compressed |
| Proof | **full** (ACP audit CTA) |
| Credibility | compressed |
| Convert | **full** |

**Changes:**
- Restructure existing content to use `<ArcBeat>` component system
- Stats at commerce-specific level: "6.6× conversion vs traditional", "Y% of AI queries fail at checkout"
- Remove existing pricing section (per TS-042 §11 Q2 — defer pricing to post-audit)
- Align messaging with homepage narrative

---

### b.8 — `/about` Team Credentials Section

**File:** `app/about/page.tsx` (modify)

**Arc depth matrix:**

| Beat | Depth |
|------|-------|
| Shift | one-liner |
| Risk | compressed |
| Opportunity | compressed |
| Solution | compressed |
| Difference | compressed |
| Proof | CTA only |
| Credibility | **full** |
| Convert | **full** |

**Changes:**
- Add team credentials section (S7 content — same as homepage S7)
- No names, credentials only
- Keep existing "What We Do / Don't Do" content
- Add CTA at bottom

---

### b.9 — Meta Tags, OG Tags, Structured Data

**Files:** All modified page files + `app/layout.tsx`

**Requirements:**
- Each page: `<title>`, `<meta name="description">`, OG title/description/image/url
- Homepage: Update existing organization + website schemas
- `/geo`: Add product page schema
- Alt text on all images (including decorative — use `alt=""` for decorative, descriptive alt for informational)

---

### b.10 — Design Token Compliance

**File:** `app/globals.css` (review, potentially modify)

**Rules (from Design Spine):**
- All colors via CSS variables / Tailwind config — no hardcoded hex in components
- Type scale uses named styles only — no ad-hoc `text-[17px]` or similar
  - Allowed sizes (Apple HIG): 11, 13, 15, 17, 20, 22, 28, 34 → map to Tailwind classes
- All spacing: multiples of 4px (`p-1`, `p-2`, `p-4`, `gap-2`, etc.)
- Border radius from design token scale
- No chartjunk (Tufte): every visual element earns its pixels

---

## c) Unit Test Plan

**Test framework:** Vitest (already in project)
**Test file location:** `__tests__/` or co-located `*.test.tsx` files

### c.1 — `data/stats.ts` Tests

**File:** `__tests__/data/stats.test.ts`

| Test Case | Input | Expected | Edge Case |
|-----------|-------|----------|-----------|
| All stats have required fields | — | Every stat has `value`, `label`, `source`, `verified`, `pages` | — |
| `getStatsForPage("home")` returns home stats | `"home"` | Array containing `weeklyAIUsers`, `aiTrafficGrowth`, `aiConversionRate` | — |
| `getStatsForPage("unknown")` returns empty | `"unknown"` | `[]` | Empty page name |
| No stat has empty `value` | — | All `value` fields are non-empty strings | — |
| `verified` dates are valid ISO dates | — | All parse as valid dates | — |
| `pages` arrays are non-empty | — | Every stat belongs to at least one page | — |

### c.2 — `<ArcBeat>` Component Tests

**File:** `__tests__/components/arc-beat.test.tsx`

| Test Case | Input | Expected | Edge Case |
|-----------|-------|----------|-----------|
| Renders with `depth="full"` | `beat="shift", depth="full", children=<div>content</div>` | Children rendered, `data-beat="shift"`, `data-depth="full"` | — |
| Renders with `depth="compressed"` | `beat="shift", depth="compressed", stats=[...], learnMoreHref="/geo"` | Stat + summary + "Learn more" link rendered; children NOT rendered | — |
| Renders with `depth="one-liner"` | `beat="risk", depth="one-liner"` | Single `<p>` element, no stats, no links | — |
| Renders with `depth="cta-only"` | `beat="proof", depth="cta-only"` | CTA button(s) only, no narrative | — |
| `data-beat` attribute set | Any beat value | `section[data-beat="{beat}"]` present | — |
| `id` attribute for scroll targeting | `beat="shift"` | `section#arc-shift` | — |
| `aria-label` present | Any beat | `aria-label` attribute on section | — |
| Stats rendered when provided | `stats=[{value:"700M+", label:"users"}]` | "700M+" and "users" visible in rendered output | — |
| No stats rendered when not provided | `stats=undefined` | No stat elements in DOM | — |
| `emphasis` prop accepted | `emphasis="geo"` | No crash, renders correctly | — |
| `className` prop forwarded | `className="my-class"` | Class applied to root element | — |
| Motion disabled when `prefers-reduced-motion` | — | No Framer Motion animations active | Media query mock |

### c.3 — Beat Content Component Tests (one per beat)

**Files:** `__tests__/components/beats/*.test.tsx`

For each of the 8 beat components (`shift-full`, `risk-full`, etc.):

| Test Case | Expected |
|-----------|----------|
| Renders without crashing | Component mounts successfully |
| Contains expected heading | Correct heading text present |
| Contains expected content elements | Key content elements (cards, stats, CTAs) present |
| No hardcoded stat values | All numeric values come from props, not inline |
| Semantic HTML used | Correct heading levels, no `div` soup |
| CTA links correct (for proof/convert) | `geo.flowblinq.com` and `audit.flowblinq.com` hrefs present |

### c.4 — Header Tests

**File:** `__tests__/components/header.test.tsx`

| Test Case | Expected |
|-----------|----------|
| Renders all nav links | GEO, ACP, Use Cases, Blog, About links present |
| "Free Audit" CTA button present | Button rendered with correct text |
| Nav links have correct hrefs | `/geo`, `/agentic-commerce`, `/use-cases`, `/blog`, `/about` |
| Mobile menu toggles | Menu opens/closes on hamburger click |
| Logo links to `/` | Logo anchor has `href="/"` |

### c.5 — Footer Tests

**File:** `__tests__/components/footer.test.tsx`

| Test Case | Expected |
|-----------|----------|
| Products section present | "Products" heading visible |
| GEO and ACP links present | Links to `/geo` and `/agentic-commerce` |
| Existing sections preserved | Use Cases, Resources, Contact still present |

**Minimum coverage target:** 90% line coverage on all new files, 80% on modified files.

---

## d) Integration Test Plan

**File:** `__tests__/integration/pages.test.tsx`

### d.1 — Homepage Integration

| Scenario | Test |
|----------|------|
| Full homepage renders | All 8 arc sections present in correct order (S1→S8) |
| Stats from registry | All rendered stat values match `data/stats.ts` entries |
| Audit CTAs functional | Both GEO and ACP audit buttons/links present at S6 and S8 |
| Scroll targeting works | `#arc-proof` anchor resolves to S6 section |
| No hardcoded stats in JSX | Grep page output for stat values — all traced to registry |

### d.2 — Cross-Page Arc Depth

| Scenario | Test |
|----------|------|
| Homepage: all beats at full depth | 8 `[data-depth="full"]` sections |
| `/geo`: correct depth matrix | Risk + Solution + Proof + Convert at full; others compressed/one-liner |
| `/agentic-commerce`: correct depth matrix | Opportunity + Solution + Proof + Convert at full; others compressed |
| `/about`: correct depth matrix | Credibility + Convert at full; Proof at cta-only; others compressed/one-liner |

### d.3 — Navigation Integration

| Scenario | Test |
|----------|------|
| All nav links resolve | No 404s from header nav |
| Footer links resolve | No 404s from footer links |
| "Free Audit" on homepage | Scrolls to `#arc-proof` |
| "Free Audit" on other pages | Links to `audit.flowblinq.com` |

### d.4 — Responsive Rendering

| Scenario | Test |
|----------|------|
| 320px viewport | No horizontal scroll, all CTAs visible |
| 768px viewport | Layout shifts correctly |
| 1024px viewport | Full layout renders |
| 1440px viewport | No content stretching issues |

---

## e) Profiling Requirements

### What to Measure

| Metric | Target | Tool |
|--------|--------|------|
| Lighthouse Performance | > 90 | Lighthouse CI |
| Lighthouse Accessibility | > 95 | Lighthouse CI |
| First Contentful Paint (FCP) | < 1.5s | Lighthouse |
| Largest Contentful Paint (LCP) | < 2.5s | Lighthouse |
| Cumulative Layout Shift (CLS) | < 0.1 | Lighthouse |
| Total Blocking Time (TBT) | < 200ms | Lighthouse |
| Bundle size (homepage JS) | < 200KB gzipped | `next build` output |

### Baseline

Current homepage is a 2,449-line client component. The rewrite should reduce bundle size by splitting into per-beat components with dynamic imports where appropriate.

### Recommendations

- Use `next/dynamic` for below-the-fold beat components (S5–S8) to reduce initial JS
- Ensure stat counter animations use CSS where possible (vs JS-driven)
- Audit Framer Motion usage — only import what's needed per beat

---

## f) Load Test Plan

**Not applicable for this spec.** This is a static marketing site deployed on Vercel's edge network. No custom API endpoints are introduced. Existing audit flows (`audit.flowblinq.com`, `geo.flowblinq.com`) are external services with their own capacity.

---

## g) Logging & Instrumentation

### Analytics Events

| Event | Trigger | Data |
|-------|---------|------|
| `page_view` | Page load | `page`, `referrer` |
| `arc_beat_visible` | Beat section enters viewport | `beat`, `depth`, `page` |
| `cta_click` | Audit CTA or "Schedule a call" clicked | `cta_type` ("geo_audit" / "acp_audit" / "schedule_call"), `position` ("mid" / "bottom") |
| `nav_click` | Header nav link clicked | `link_target` |

### Implementation

- Use Vercel Analytics (already integrated via `app/layout.tsx`)
- Viewport intersection tracking via `IntersectionObserver` in `<ArcBeat>` component
- CTA click tracking via `onClick` handlers

### Log Level

- No server-side logging required (static pages)
- Client-side: analytics events only, no console logging in production

---

## h) Acceptance Criteria

### Structural Requirements (Automated — Layer 1)

- [ ] AC-01: All pages render without errors on 320px, 768px, 1024px, 1440px
- [ ] AC-02: Lighthouse Performance > 90 on homepage
- [ ] AC-03: Lighthouse Accessibility > 95 on homepage
- [ ] AC-04: All nav links resolve — no 404s
- [ ] AC-05: Semantic HTML: `<nav>`, `<main>`, `<section>`, `<article>` used correctly
- [ ] AC-06: Keyboard navigation works for all interactive elements
- [ ] AC-07: Focus indicators visible on all interactive elements
- [ ] AC-08: `prefers-reduced-motion` respected — Framer Motion animations disabled
- [ ] AC-09: Touch targets >= 44px on all interactive elements
- [ ] AC-10: No text below 12px anywhere
- [ ] AC-11: All spacing uses 4px base unit multiples
- [ ] AC-12: `<ArcBeat>` component exists with `beat`, `depth`, `stats`, `emphasis`, `learnMoreHref` props
- [ ] AC-13: Each `<ArcBeat>` renders correctly at all 4 depth levels

### Content Requirements (Automated — Layer 2)

- [ ] AC-14: All stats render from `data/stats.ts` — no hardcoded stat values in JSX
- [ ] AC-15: Homepage section order matches TS-042 §3 (S1 → S2 → S3 → S4 → S5 → S6 → S7 → S8)
- [ ] AC-16: Arc depth matrix matches TS-042 §4.2 for homepage (all full), `/geo`, `/agentic-commerce`, `/about`
- [ ] AC-17: Differentiation tagline appears above the fold on homepage (S1)
- [ ] AC-18: Differentiation detail section appears at S5 position
- [ ] AC-19: Both audit CTAs present at S6 (mid-page) and S8 (bottom)
- [ ] AC-20: Team credentials present without names (S7)
- [ ] AC-21: Meta tags and OG tags present on all modified pages
- [ ] AC-22: Alt text on all images
- [ ] AC-23: `data/stats.ts` registry exists with `value`, `source`, `verified`, `pages` per stat
- [ ] AC-24: Header nav: GEO | ACP | Use Cases | Blog | About
- [ ] AC-25: Footer has "Products" section with GEO + ACP links
- [ ] AC-26: `/geo` route exists and renders GEO product page
- [ ] AC-27: `/agentic-commerce` pricing section removed
- [ ] AC-28: `/about` has team credentials section (no names)

### Design System Compliance (Automated + Review — Layer 2.5)

- [ ] AC-29: All colors from CSS variables / Tailwind config — no hardcoded hex in components
- [ ] AC-30: Type scale uses named styles — no ad-hoc font sizes
- [ ] AC-31: Spacing uses multiples of 4px only
- [ ] AC-32: `<ArcBeat>` sections have `data-beat` and `data-depth` attributes
- [ ] AC-33: `<ArcBeat>` sections have `id="arc-{beat}"` for scroll targeting

### Visual Review Checklist (Aditya — Layer 3)

- [ ] AC-34: Hero section (S1): tagline + stats + thesis readable and hierarchically clear within 5 seconds
- [ ] AC-35: S2 Risk: before/after contrast is immediately visible
- [ ] AC-36: S4 Solution: GEO and ACP cards feel mirrored but distinct
- [ ] AC-37: S5 Difference: "others" column feels muted, "us" column feels bold
- [ ] AC-38: S6 Proof: audit CTAs are the most prominent elements on the page
- [ ] AC-39: S7 Credibility: credentials feel authoritative without being boastful
- [ ] AC-40: Mobile: comfortable reading, no horizontal scroll, CTAs thumb-reachable
- [ ] AC-41: Squint test passes — visual hierarchy visible with blurred text
- [ ] AC-42: No chartjunk (Tufte) — every visual element earns its pixels

---

## Task Breakdown (for CostMaster)

These are the implementation units. Task IDs match TS-042 §10.

| Task ID | Description | Dependencies | Page |
|---------|------------|-------------|------|
| T-042-01 | Create `data/stats.ts` stat registry | None | Shared |
| T-042-02 | Create `<ArcBeat>` component (8 beats × 4 depths) | T-042-01 | Shared |
| T-042-03 | Homepage S1–S2 (Hero + Risk) | T-042-02 | `/` |
| T-042-04 | Homepage S3–S4 (Opportunity + Solution) | T-042-02 | `/` |
| T-042-05 | Homepage S5 (Difference — detailed comparison) | T-042-02 | `/` |
| T-042-06 | Homepage S6 + S8 (Proof CTA + Convert CTA) | T-042-02 | `/` |
| T-042-07 | Homepage S7 (Credibility — team) | T-042-02 | `/` |
| T-042-08 | Header navigation update | None | Shared |
| T-042-09 | Footer product links update | None | Shared |
| T-042-10 | `/geo` product page (arc: GEO-emphasized) | T-042-02 | `/geo` |
| T-042-11 | `/agentic-commerce` messaging alignment (arc: ACP-emphasized) | T-042-02 | `/agentic-commerce` |
| T-042-12 | `/about` team credentials section | None | `/about` |
| T-042-13 | Meta tags, OG tags, structured data for all modified pages | T-042-03–T-042-12 | All |
| T-042-14 | Responsive QA pass (320px, 768px, 1024px, 1440px) | T-042-13 | All |
| T-042-15 | Accessibility QA pass (Lighthouse, keyboard, screen reader) | T-042-14 | All |

**Critical path:** T-042-01 → T-042-02 → T-042-03 through T-042-07 (parallel) → T-042-13 → T-042-14 → T-042-15

---

## ScriptDev / DaVinci Notes

1. **This is a frontend spec for DaVinci (agent 10).** The Design Spine (Apple HIG + Tufte) in DaVinci's CLAUDE.md governs all visual decisions — it is NOT repeated here.
2. **TDD is mandatory per DaVinci protocol.** Write tests first (§c and §d above), then implement until tests pass.
3. **Do NOT modify platform/ or geo/ directories.** Work exclusively in `/home/aditya/flowblinq/archive/V0-Website/`.
4. **The existing homepage is a single 2,449-line file.** The rewrite replaces it entirely — do not try to incrementally modify. Back up the file first, then write fresh.
5. **`audit-form.tsx` already exists.** Extend it for dual-CTA use in S6/S8 rather than creating a new component.
6. **Existing pages to preserve:** `/for-ai` (machine-readable, no changes), `/contact`, `/demo`, `/investors`, `/blog/*`, `/use-cases/*`, all API routes.
7. **No backend changes.** All audit flows remain external (`audit.flowblinq.com`, `geo.flowblinq.com`).
8. **Stat sources:** DaVinci should verify stat source URLs and fill placeholders in `data/stats.ts`. If a source cannot be verified, flag it rather than fabricate.
9. **Mobile nav:** The current mobile header only shows a "Home" link. A proper responsive nav (hamburger menu) is required per T-042-08.
10. **Existing theme:** Brand orange (#f97316), secondary emerald (#10b981). CSS variables already defined in `globals.css`. Use them — do not introduce new color values.
