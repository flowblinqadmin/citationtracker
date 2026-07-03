# TS-074 — Restore Domain Integration Steps to Setup Tab

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-03
**Priority:** P0 (blocking user onboarding)
**Scope:** GEO app — `app/sites/[id]/SitePageClient.tsx`

---

## 1. What

Restore the 3 domain integration steps that were stripped during the Apple HIG UI refactor. After domain verification, users currently see nothing — no instructions on how to serve their generated AI files from their own domain. This blocks the entire post-audit implementation flow.

The 3 steps are:
1. **Add rewrites config** — platform-specific rewrite rules (Vercel, Netlify, Cloudflare, nginx, WordPress, Apache, Other)
2. **Inject schema in layout** — tracking pixel + schema injection script (mandatory, not optional)
3. **Update robots.txt** — AI crawler directives for GEO files

## 2. Why

Users (confirmed: knair on buzztimeelectronics.com.au) complete the audit, verify their domain, then hit a dead end. There are no instructions telling them what to do next. The 3 integration steps existed in `ResultsDashboardLegacy.tsx` (lines 2419–2626) but were not carried forward when the UI was rebuilt to Apple HIG design in commit `17e9bef`. This is a P0 bug — it breaks the core user journey from audit to implementation.

## 3. What Existed (Reference Only — Do NOT Apply Old Code)

The legacy implementation in `ResultsDashboardLegacy.tsx` had:

### 3A. Integration Config Object (`integrationConfigs`)

A `Record<string, string>` keyed by platform (vercel, netlify, cloudflare, nginx, wordpress, apache) containing platform-specific code blocks. Each block covered all 3 steps in a single copyable snippet. Located at legacy lines 1176–1312.

### 3B. Platform Tabs

Tab bar with 7 options: Vercel, Netlify, Cloudflare, nginx, WordPress, Apache, Other. The "Other" tab had a text input where users could type their platform name and get AI-generated instructions via an API call. Located at legacy lines 2508–2520.

### 3C. Step Pill Badges

Three pill badges shown above the code block: "1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt". Located at legacy line 2574.

### 3D. Test Connection Button

A button that verified whether the rewrites were working by hitting the user's domain for `/llms.txt` and checking the response. Located at legacy lines 2601–2622.

### 3E. Template Variables

| Variable | Value |
|----------|-------|
| `geoBase` | `https://geo.flowblinq.com/api/serve/${slug}` |
| `pixelTag` | `<img src="https://geo.flowblinq.com/api/t/${slug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />` |
| `scriptTag` | `<script src="https://geo.flowblinq.com/api/t/${slug}" async></script>` |
| `cspNote` | CSP warning about adding geo.flowblinq.com to img-src, script-src, connect-src |
| `robotsBlock` | robots.txt directives for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, anthropic-ai, PerplexityBot, Google-Extended |
| `referrerSteps` | Platform-specific middleware for server-side referrer capture (`_geo_ref` cookie) |

### 3F. Config Content Per Platform

**Vercel:** `vercel.json` rewrites → pixel tag → schema script → referrer middleware → robots.txt
**Netlify:** `netlify.toml` redirects (status 200) → pixel → script → edge function → robots.txt
**Cloudflare:** Worker fetch handler routes → pixel → script → referrer worker → robots.txt
**nginx:** `proxy_pass` location blocks → pixel → script → `map` + `add_header` → robots.txt
**WordPress:** `.htaccess` RewriteRules → `functions.php` wp_footer (pixel) → wp_head (script) → referrer init hook → robots.txt
**Apache:** `.htaccess` RewriteRules → pixel → script → PHP referrer capture → robots.txt

## 4. Changes Required

### 4A. Add Domain Integration Section to Setup Tab

**File:** `app/sites/[id]/SitePageClient.tsx`

**Location:** Inside the `activeTab === "setup"` block, after the existing Domain Verification section (currently ends around line 1877).

**New section:** "Domain Integration" — only shown when `site?.domainVerified` is true.

Contains:
1. Green banner: "Domain verified. Add the config below to serve your AI files from {domain}."
2. Platform tab bar (Vercel, Netlify, Cloudflare, nginx, WordPress, Apache, Other)
3. Step pill badges: "1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt"
4. Code block with platform-specific config (copyable)
5. "Other" tab with text input + AI-generated instructions
6. Test Connection button with result feedback

### 4B. Add Template Variables

Add the same computed variables (`geoBase`, `pixelTag`, `scriptTag`, `cspNote`, `robotsBlock`, `referrerSteps`) to `SitePageClient.tsx`. These are derived from `site.slug`.

### 4C. Add State Variables

- `integrationTab` — currently selected platform tab (default: "vercel")
- `otherPlatform` — text input for "Other" tab
- `otherConfig` — AI-generated config for custom platform
- `otherLoading` / `otherError` — loading/error state for AI generation
- `testingConnection` — loading state for test connection
- `connectionResult` — test connection result (`{ connected: boolean; detail: string }`)

### 4D. Key Difference from Legacy: Schema Injection is Mandatory

In the legacy code, Step 2 comments said "(Optional) Add schema injection for AI bots". In the new implementation, schema injection is **mandatory**. Remove the "(Optional)" qualifier from all platform configs. The `scriptTag` must be presented as a required step, not optional.

### 4E. API Dependencies

- `POST /api/sites/[id]/test-connection` — already exists (used by legacy). Checks if `/llms.txt` resolves on the user's domain.
- `POST /api/sites/[id]/integration-config` — already exists (used by "Other" tab). Takes `{ platform: string }` and returns AI-generated config.

Verify both endpoints still exist on Rao's branch before implementation.

## 5. Styling

Must match the current Apple HIG copper design system:
- Use existing design tokens: `COPPER`, `TEXT`, `T2`, `T3`, `CARD`, `BORDER`, `GREEN`, `RED`, `BG`
- Platform tabs: pill-shaped, copper highlight on active
- Code block: monospace, `#f5f5f7` background, rounded corners, max-height with scroll
- Copy button: top-right of code block
- Test Connection: secondary button style (border, no fill)
- Step pills: `11px` font, rounded capsules, subtle border

## 6. Acceptance Criteria

- [ ] Setup tab shows "Domain Integration" section after domain is verified
- [ ] 7 platform tabs render (Vercel, Netlify, Cloudflare, nginx, WordPress, Apache, Other)
- [ ] Each platform tab shows a copyable code block with all 3 steps
- [ ] Schema injection is presented as mandatory (no "Optional" label) in all configs
- [ ] Step pill badges visible above code block: "1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt"
- [ ] Copy button copies the full config block to clipboard
- [ ] "Other" tab accepts platform name input and generates config via API
- [ ] Test Connection button hits the user's domain and reports success/failure
- [ ] Section hidden when domain is not yet verified
- [ ] Responsive — works on mobile viewports
- [ ] Matches Apple HIG copper design system (tokens, spacing, radii)

## 7. Risks

| Risk | Mitigation |
|------|-----------|
| `test-connection` or `integration-config` API removed in refactor | Verify endpoints exist on `feat/tos-eula-consent` branch before implementation |
| Config snippets reference stale GEO URLs | All URLs derived from `site.slug` at render time — always current |
| "Other" tab AI generation may fail | Show error state, fallback to manual instructions |

## 8. Files Affected

| File | Action |
|------|--------|
| `geo/app/sites/[id]/SitePageClient.tsx` | **MODIFY** — Add Domain Integration section to Setup tab |

---

*TS-074 — CoFounder, 2026-04-03*
