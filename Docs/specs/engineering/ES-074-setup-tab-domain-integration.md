# ES-074 — Setup Tab Domain Integration

**Source:** TS-074-setup-tab-domain-integration.md
**Author:** 2-specmaster
**Date:** 2026-04-03
**Priority:** P0 (blocks user onboarding — users see nothing after domain verification)

---

## a) Overview

After the Apple HIG refactor (commit `17e9bef`), the 3 domain integration steps were stripped from the UI and never ported forward. Users verify their domain, then hit a dead end — no instructions on how to serve AI files from their own domain.

**What exists:**
- `SitePageClient.tsx` (2000 lines) — Setup tab has AI Files section (lines 1841–1922) and Domain Verification section (lines 1924–1973). No integration section.
- `ResultsDashboardLegacy.tsx` — Has complete integration code (lines 1080–1312 configs, lines 2419–2626 UI) for reference only. DO NOT copy legacy code.
- `/api/sites/[id]/verify-connection/route.ts` — Exists. POST endpoint that checks `/llms.txt` via 3-tier proxy fetch (direct → ScraperAPI → Firecrawl). Returns `{ connected: boolean, detail: string }`.
- `/api/integration-instructions/route.ts` — Exists but at root level (not under `sites/[id]`). POST takes `{ platform, siteId }`, uses GPT-4o-mini to generate platform-specific instructions. Returns `{ instructions: string }`.

**What's needed:**
- Add Domain Integration section to Setup tab (after Domain Verification, gated on `site?.domainVerified`)
- 7 platform tabs with platform-specific config blocks
- Step pill badges, copy button, Test Connection button
- "Other" tab with AI generation via existing `/api/integration-instructions` endpoint

---

## b) Implementation Requirements

### File: `geo/app/sites/[id]/SitePageClient.tsx` (MODIFY)

#### b1) New State Variables

Add after existing state declarations (~line 179):

```typescript
const [integrationTab, setIntegrationTab] = useState("vercel");
const [otherPlatform, setOtherPlatform] = useState("");
const [otherConfig, setOtherConfig] = useState("");
const [otherLoading, setOtherLoading] = useState(false);
const [otherError, setOtherError] = useState("");
const [testingConnection, setTestingConnection] = useState(false);
const [connectionResult, setConnectionResult] = useState<{ connected: boolean; detail: string } | null>(null);
```

#### b2) Template Variables

Add computed template variables (inside the component, after site/slug are available):

```typescript
const geoBase = `https://geo.flowblinq.com/api/serve/${site?.slug}`;
const pixelTag = `<img src="https://geo.flowblinq.com/api/t/${site?.slug}" width="1" height="1" alt="" style="position:absolute;opacity:0" />`;
const scriptTag = `<script src="https://geo.flowblinq.com/api/t/${site?.slug}" async></script>`;
const cspNote = `// NOTE: If you have a Content-Security-Policy, add https://geo.flowblinq.com to img-src, script-src, and connect-src`;
```

The `robotsBlock` and `referrerSteps` objects are identical to the legacy definitions. Copy the content verbatim from `ResultsDashboardLegacy.tsx` lines 1040–1174.

#### b3) Integration Configs Object

`integrationConfigs: Record<string, string>` — 6 platform keys (vercel, netlify, cloudflare, nginx, wordpress, apache). Structure identical to legacy lines 1176–1312.

**CRITICAL CHANGE from legacy:** All configs must replace `(Optional)` with `(Mandatory)` in Step 3 (schema injection). The `scriptTag` step is **required**, not optional. Change every occurrence of:
- `"Step 3 — (Optional) Add schema injection"` → `"Step 3 — Add schema injection (mandatory)"`
- Remove any "(Optional)" qualifier from step 3 comments in all 6 platform configs

#### b4) Domain Integration Section

Insert after the Domain Verification section closing `</div>` (line 1973), inside the `activeTab === "setup"` block. The section is a new `<div>` that renders **only when** `site?.domainVerified` is true.

**Structure:**

1. **Green banner** — Background `#ecfdf5` (or `GREEN` at 10% opacity), border `1px solid rgba(52,199,89,0.25)`, rounded 10px. Text: "Domain verified. Add the config below to serve your AI files from {site.domain}."

2. **Platform tab bar** — Horizontal scrollable row of 7 pill-shaped tabs:
   - Labels: `Vercel`, `Netlify`, `Cloudflare`, `nginx`, `WordPress`, `Apache`, `Other ✦`
   - Values: `vercel`, `netlify`, `cloudflare`, `nginx`, `wordpress`, `apache`, `other`
   - Active tab: `background: COPPER`, `color: #fff`
   - Inactive tab: `background: transparent`, `border: 1px solid ${BORDER}`, `color: T2`
   - Font: 12px, fontWeight 500, padding `6px 14px`, borderRadius 20, cursor pointer
   - Gap 6px, overflow-x auto

3. **Step pill badges** — Row of 3 capsule badges:
   - "1. Add rewrites config"
   - "2. Inject schema in layout"
   - "3. Update robots.txt"
   - Style: fontSize 11, fontWeight 500, padding `4px 10px`, borderRadius 12, border `1px solid ${BORDER}`, background CARD, color T2

4. **Code block (standard tabs)** — Shown when `integrationTab !== "other"`:
   - Content: `integrationConfigs[integrationTab]`
   - Style: `<pre>` with background `#f5f5f7`, borderRadius 8, padding `12px 16px`, fontFamily `'SF Mono', Monaco, monospace`, fontSize 11, lineHeight 1.5, overflow auto, maxHeight 400, whiteSpace `pre-wrap`, wordBreak `break-word`, border `1px solid ${BORDER}`
   - Copy button: absolute positioned top-right of code block container. onClick → `navigator.clipboard.writeText(integrationConfigs[integrationTab])`

5. **"Other" tab content** — Shown when `integrationTab === "other"`:
   - Text input: placeholder "e.g. Shopify, Caddy, Render, Heroku, Fastly…", border `1px solid ${BORDER}`, borderRadius 8, padding `10px 14px`, fontSize 13, width 100%
   - "Generate" button: background COPPER, color #fff, disabled when `!otherPlatform.trim() || otherLoading`
   - Loading state: button text "Generating…", disabled
   - Error state: red text below button (`otherError`)
   - Result: same `<pre>` code block as standard tabs, showing `otherConfig`

6. **Test Connection button** — Below the code block, always visible:
   - Text: "Test Connection" (or "Testing…" when loading)
   - Style: secondary button — border `1px solid ${BORDER}`, background CARD, borderRadius 8, padding `10px 20px`, fontSize 13, fontWeight 500
   - Disabled while `testingConnection`
   - Result display below button: green dot + text if connected, red dot + text if not

#### b5) Event Handlers

**`handleTestConnection`:**
```typescript
async function handleTestConnection() {
  setTestingConnection(true);
  setConnectionResult(null);
  try {
    const res = await fetch(`/api/sites/${siteId}/verify-connection`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    setConnectionResult({ connected: data.connected, detail: data.detail });
  } catch {
    setConnectionResult({ connected: false, detail: "Failed to test connection. Please try again." });
  } finally {
    setTestingConnection(false);
  }
}
```

**`handleOtherPlatform`:**
```typescript
async function handleOtherPlatform() {
  setOtherLoading(true);
  setOtherError("");
  setOtherConfig("");
  try {
    const res = await fetch("/api/integration-instructions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ platform: otherPlatform.trim(), siteId }),
    });
    if (!res.ok) throw new Error("Failed to generate instructions");
    const data = await res.json();
    setOtherConfig(data.instructions);
  } catch (err: unknown) {
    setOtherError(err instanceof Error ? err.message : "Failed to generate instructions");
  } finally {
    setOtherLoading(false);
  }
}
```

---

## c) Unit Test Plan

**File:** `geo/__tests__/setup-domain-integration.test.tsx` (CREATE)
**Framework:** Vitest + React Testing Library
**Minimum coverage:** 90% of new code

| # | Test Case | Input | Expected |
|---|-----------|-------|----------|
| U1 | Integration section hidden when domainVerified=false | site.domainVerified=false | Section not in DOM |
| U2 | Integration section visible when domainVerified=true | site.domainVerified=true | Section rendered |
| U3 | Default tab is "vercel" | domainVerified=true | Vercel tab has active style |
| U4 | Clicking Netlify tab switches config | Click "Netlify" | netlify config rendered in pre |
| U5 | All 7 tabs render | domainVerified=true | 7 tab buttons in DOM |
| U6 | Step pill badges render | domainVerified=true | 3 pills: "1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt" |
| U7 | Copy button copies config to clipboard | Click Copy | navigator.clipboard.writeText called with config text |
| U8 | Schema injection is mandatory in vercel config | Check vercel config text | Contains "mandatory", does NOT contain "(Optional)" |
| U9 | Schema injection is mandatory in all 6 configs | Check all 6 | None contain "(Optional)" in Step 3 |
| U10 | "Other" tab shows text input + Generate button | Click "Other ✦" | Input + button rendered |
| U11 | Generate button disabled when input empty | otherPlatform="" | Button disabled |
| U12 | Generate button calls /api/integration-instructions | Type "Shopify", click Generate | fetch called with correct payload |
| U13 | Generated config renders in code block | API returns instructions | Pre element with instructions text |
| U14 | Other tab error renders | API returns error | Red error text shown |
| U15 | Test Connection button rendered | domainVerified=true | Button in DOM |
| U16 | Test Connection calls /api/sites/[id]/verify-connection | Click Test Connection | fetch called with POST + Bearer token |
| U17 | Connected result shows green indicator | API returns connected=true | Green dot + detail text |
| U18 | Disconnected result shows red indicator | API returns connected=false | Red dot + detail text |
| U19 | Test Connection loading state | During fetch | Button shows "Testing…", disabled |
| U20 | Other loading state | During fetch | Button shows "Generating…", disabled |
| U21 | Template variables use site.slug | site.slug="test-slug" | geoBase contains "test-slug" |
| U22 | Green banner shows domain name | site.domain="example.com" | Banner text includes "example.com" |
| U23 | Platform tabs horizontally scrollable | Narrow viewport | overflow-x: auto on container |

**Mocks:**
- `fetch` → vi.fn() for API calls
- `navigator.clipboard.writeText` → vi.fn()
- `site` object with required fields (slug, domain, domainVerified, accessToken, id)

---

## d) Integration Test Plan

**File:** `geo/__tests__/integration/setup-domain-integration.integration.test.tsx` (CREATE)
**Framework:** Vitest

| # | Test Case | Scenario |
|---|-----------|----------|
| IT1 | Full flow: verify domain → see integration section | Render with domainVerified=true, confirm section appears with default Vercel tab |
| IT2 | Tab switch → config change → copy | Switch to nginx tab, click Copy, verify clipboard content is nginx config |
| IT3 | Other tab → generate → display | Select Other, type "Shopify", click Generate, mock API success, verify config displays |
| IT4 | Other tab → generate → error | Select Other, type "Caddy", click Generate, mock API 500, verify error message |
| IT5 | Test Connection → success | Click Test Connection, mock API returns connected=true, verify green result |
| IT6 | Test Connection → failure | Click Test Connection, mock API returns connected=false with 404 detail, verify red result |
| IT7 | Section not rendered before domain verification | Render with domainVerified=false, confirm no integration section in DOM |

---

## e) Profiling Requirements

| Metric | Target | Tool |
|--------|--------|------|
| Section render time | < 16ms (1 frame) | React DevTools Profiler |
| Config template computation | < 1ms | Performance.mark/measure |
| Tab switch re-render | < 5ms | React DevTools Profiler |

The integration section is entirely client-side rendering of static template strings. No profiling concerns expected.

---

## f) Load Test Plan

Not applicable — this is a purely client-side UI component. The only server calls are:
- `POST /api/sites/[id]/verify-connection` — already exists, already tested
- `POST /api/integration-instructions` — already exists, rate limited by OpenAI

No new endpoints created. No load test needed.

---

## g) Logging & Instrumentation

| Event | Level | When |
|-------|-------|------|
| `integration.tab_switch` | info | User switches platform tab (include `platform` value) |
| `integration.copy_config` | info | User copies a config block (include `platform`) |
| `integration.test_connection.start` | info | User clicks Test Connection |
| `integration.test_connection.result` | info | Result received (include `connected`, `method` from detail) |
| `integration.other.generate` | info | User generates "Other" config (include `platform` name) |
| `integration.other.error` | warn | "Other" generation fails |

Log via existing client-side analytics if present, otherwise `console.info`/`console.warn`. No server-side logging changes needed.

---

## h) Acceptance Criteria

| # | Criterion | Section |
|---|-----------|---------|
| AC1 | Setup tab shows "Domain Integration" section only when `site.domainVerified === true` | b4 |
| AC2 | Section hidden when domain not verified | b4 |
| AC3 | Green banner displays with site domain name | b4.1 |
| AC4 | 7 platform tabs render: Vercel, Netlify, Cloudflare, nginx, WordPress, Apache, Other ✦ | b4.2 |
| AC5 | Active tab has copper background, white text | b4.2 |
| AC6 | Default tab is "vercel" on first render | b1 |
| AC7 | Clicking a tab switches the code block content | b4.4 |
| AC8 | Step pill badges visible: "1. Add rewrites config", "2. Inject schema in layout", "3. Update robots.txt" | b4.3 |
| AC9 | Code block is scrollable, monospace, `#f5f5f7` background | b4.4 |
| AC10 | Copy button copies full config block to clipboard | b4.4 |
| AC11 | Schema injection labeled "mandatory" (NOT "Optional") in ALL 6 platform configs | b3 |
| AC12 | "Other" tab shows text input + Generate button | b4.5 |
| AC13 | Generate disabled when input empty | b4.5 |
| AC14 | Generate calls `/api/integration-instructions` with `{ platform, siteId }` | b5 |
| AC15 | Generated config displays in code block | b4.5 |
| AC16 | Generation error shows red error text | b4.5 |
| AC17 | Test Connection button calls `/api/sites/[id]/verify-connection` with POST + Bearer token | b5 |
| AC18 | Connected result: green dot + detail text | b4.6 |
| AC19 | Disconnected result: red dot + detail text | b4.6 |
| AC20 | Loading states shown during API calls (Testing…/Generating…) | b4.5, b4.6 |
| AC21 | Responsive — works on mobile viewports | b4 |
| AC22 | Matches Apple HIG copper design system (COPPER, TEXT, T2, T3, CARD, BORDER tokens) | b4 |
| AC23 | 23 unit tests pass | c |
| AC24 | 7 integration tests pass | d |
| AC25 | No new API endpoints created (uses existing verify-connection + integration-instructions) | b5 |
| AC26 | Template variables derived from `site.slug` at render time | b2 |

---

## ScriptDev Notes

1. This is a **single-file change** to `SitePageClient.tsx`. No new files except test files.
2. The integration configs are large string templates (~230 lines). Place them in a `useMemo` or extract to a helper function to avoid re-computation on every render. The `referrerSteps` and `integrationConfigs` objects depend only on `site?.slug` — memoize on that.
3. The "Other" tab calls `/api/integration-instructions` (root-level route, NOT under `sites/[id]`). Note the different URL path.
4. The Test Connection calls `/api/sites/${siteId}/verify-connection` (under `sites/[id]`).
5. Insert the new section at line 1973 (after Domain Verification's closing `</div>`), still inside the `activeTab === "setup"` block which closes at line 1975.
6. The green banner, platform tabs, step pills, code block, and test connection button are all in a single new `<div>` gated on `{site?.domainVerified && ( ... )}`.
7. Use the **existing** design tokens already defined at the top of the file (lines 24–36). Do not create new constants.
8. DaVinci Agent 10 for design quality.

---

*ES-074 — SpecMaster, 2026-04-03*
