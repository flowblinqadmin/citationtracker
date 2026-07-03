# ES-073 — EULA Acceptance Gate (First Login Click-Wrap)

**Source:** TS-073-eula-acceptance-gate.md
**Author:** SpecMaster (Agent 2)
**Date:** 2026-04-02
**Priority:** CRITICAL — legal compliance
**Codebase:** GEO app (`/home/aditya/flowblinq/geo`) + V0-Website (`/home/aditya/flowblinq/archive/V0-Website`)

---

## a) Overview

Add a mandatory EULA click-wrap acceptance gate after first authenticated login to the GEO app. Store consent with timestamp, document version, IP address, geolocation, and user-agent. Enforce via middleware with a cookie fast-path. Also update the existing T&C page on V0-Website with strengthened legal clauses.

**Current state:**
- No `legal_documents` or `user_legal_consents` tables exist.
- No `CURRENT_EULA_VERSION` constant in `lib/config.ts`.
- No `/auth/accept-eula` page or API route.
- Middleware (`lib/supabase/middleware.ts`, 107 lines) handles auth session refresh + protected path redirect but has no EULA check.
- V0-Website T&C page (`archive/V0-Website/app/terms/page.tsx`, 528 lines) has 14 sections, dates "February 12, 2026", liability cap "$100 USD", contact email `hello@flowblinq.ai`.

---

## b) Implementation Requirements

### b.1) Database Schema — Drizzle + DDL Migration

**File CREATE:** `geo/lib/db/migrations/20260402-legal-documents.sql`

```sql
-- Two new tables for EULA click-wrap consent tracking

CREATE TABLE legal_documents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  doc_type TEXT NOT NULL,              -- 'eula' | 'terms'
  version TEXT NOT NULL,               -- '1.0', '1.1', etc.
  title TEXT NOT NULL,
  body TEXT NOT NULL,                   -- Full document text (plain text or HTML)
  effective_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (doc_type, version)
);

CREATE TABLE user_legal_consents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,               -- Supabase auth.users.id
  doc_type TEXT NOT NULL,              -- 'eula'
  doc_version TEXT NOT NULL,           -- '1.0'
  accepted_at TIMESTAMP NOT NULL DEFAULT now(),
  ip_address TEXT,                     -- x-forwarded-for or x-real-ip
  geo_country TEXT,                    -- cf-ipcountry (Cloudflare/Vercel)
  geo_region TEXT,                     -- x-vercel-ip-country-region
  user_agent TEXT,                     -- user-agent header
  UNIQUE (user_id, doc_type, doc_version)
);

ALTER TABLE user_legal_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_consents" ON user_legal_consents
  FOR ALL USING (auth.uid()::text = user_id);

-- Index for middleware consent lookup (hot path)
CREATE INDEX idx_user_legal_consents_lookup
  ON user_legal_consents (user_id, doc_type, doc_version);

-- Seed EULA v1.0
-- NOTE: ScriptDev must extract full EULA text from /home/aditya/Downloads/Flowblinq_EULA_v1.0_Apr2026.docx
-- and insert it here. Entity name MUST read "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)".
-- Placeholder below — replace with actual text:
INSERT INTO legal_documents (doc_type, version, title, body, effective_date)
VALUES (
  'eula',
  '1.0',
  'End User License Agreement',
  '{{EULA_FULL_TEXT_FROM_DOCX}}',
  '2026-04-02 00:00:00'
);
```

**File MODIFY:** `geo/lib/db/schema.ts`

Add after the last `export const` (after `chatbotLogs`):

```typescript
// ── Legal documents & consent tracking (ES-073) ──────────────────────────────

export const legalDocuments = pgTable("legal_documents", {
  id: text("id").primaryKey(),
  docType: text("doc_type").notNull(),       // 'eula' | 'terms'
  version: text("version").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  effectiveDate: timestamp("effective_date").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const userLegalConsents = pgTable("user_legal_consents", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  docType: text("doc_type").notNull(),
  docVersion: text("doc_version").notNull(),
  acceptedAt: timestamp("accepted_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  geoCountry: text("geo_country"),
  geoRegion: text("geo_region"),
  userAgent: text("user_agent"),
});
```

### b.2) Config Constant

**File MODIFY:** `geo/lib/config.ts`

Add after the `ALPHA_TESTER_DOMAINS` block (line ~92):

```typescript
// Legal / EULA (ES-073)
export const CURRENT_EULA_VERSION = "1.0";
```

### b.3) EULA Acceptance Page

**File CREATE:** `geo/app/auth/accept-eula/page.tsx`

Server component (top) + client component (bottom).

**Server part:**
1. Query `legalDocuments` table: `SELECT * FROM legal_documents WHERE doc_type = 'eula' ORDER BY effective_date DESC LIMIT 1`
2. Use Drizzle: `db.select().from(legalDocuments).where(eq(legalDocuments.docType, 'eula')).orderBy(desc(legalDocuments.effectiveDate)).limit(1)`
3. If no document found, render error state
4. Pass `{ title, body, version, effectiveDate }` + `redirectTo` (from searchParams) to client component

**Client part — `AcceptEulaForm`:**

Props: `{ title: string; body: string; version: string; effectiveDate: string; redirectTo: string | null }`

State:
- `checked: boolean` (default `false`)
- `loading: boolean` (default `false`)
- `error: string | null` (default `null`)

Render:
1. Flowblinq logo (reuse pattern from `app/auth/login/page.tsx`)
2. Title: "End User License Agreement" — `fontSize: 24, fontWeight: 700, color: TEXT (#1c1917)`
3. Subtitle: `"Version {version} — Effective {effectiveDate formatted}"` — `fontSize: 14, color: TEXT_2 (#78716c)`
4. Scrollable container: `maxHeight: "60vh", overflowY: "auto", border: "1px solid rgba(0,0,0,0.07)", borderRadius: 12, padding: 24, background: "#ffffff", marginTop: 24` — renders `body` as pre-wrapped text (use `whiteSpace: "pre-wrap"`)
5. Checkbox row (below scroll container): `<label>` with `<input type="checkbox" checked={checked} onChange={...} />` + text "I have read and agree to the End User License Agreement" — `fontSize: 14, color: TEXT, marginTop: 20`
6. Continue button: `width: "100%", padding: "14px", borderRadius: 10, fontWeight: 700, fontSize: 16` — disabled style: `background: "#e5e5e5", color: "#a8a29e", cursor: "not-allowed"` — enabled style: `background: "#b45309", color: "#fff", cursor: "pointer"` (matches login page accent)
7. Error display below button if `error` is set

**Styling tokens** (match `app/auth/login/page.tsx`):
```
BG     = "#faf8f5"
CARD   = "#ffffff"
BORDER = "rgba(0,0,0,0.07)"
TEXT   = "#1c1917"
TEXT_2 = "#78716c"
TEXT_3 = "#a8a29e"
ACCENT = "#b45309"
RED    = "#dc2626"
```

Page wrapper: `minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, -apple-system, sans-serif"`

Card container: `maxWidth: 640, width: "100%", padding: 32, background: CARD, borderRadius: 16, border: "1px solid " + BORDER, boxShadow: "0 1px 3px rgba(0,0,0,0.04)"`

**On submit:**
```typescript
async function handleAccept() {
  setLoading(true);
  setError(null);
  try {
    const res = await fetch("/api/auth/accept-eula", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc_type: "eula", doc_version: version }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Failed to record acceptance" }));
      setError(data.error ?? "Failed to record acceptance");
      return;
    }
    window.location.href = redirectTo ?? "/dashboard";
  } catch {
    setError("Network error. Please try again.");
  } finally {
    setLoading(false);
  }
}
```

Use `window.location.href` (not `router.push`) so the middleware re-evaluates and picks up the new `eula_accepted` cookie set by the API response.

### b.4) EULA Acceptance API Route

**File CREATE:** `geo/app/api/auth/accept-eula/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/supabase/authenticated-client";
import { db } from "@/lib/db";
import { legalDocuments, userLegalConsents } from "@/lib/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { CURRENT_EULA_VERSION } from "@/lib/config";

export async function POST(request: NextRequest) {
  // 1. Authenticate
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Parse body
  const body = await request.json() as { doc_type?: string; doc_version?: string };
  const { doc_type, doc_version } = body;

  if (doc_type !== "eula" || !doc_version) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // 3. Verify version matches current
  if (doc_version !== CURRENT_EULA_VERSION) {
    return NextResponse.json({ error: "EULA version mismatch. Please refresh the page." }, { status: 400 });
  }

  // 4. Verify document exists
  const [doc] = await db.select({ id: legalDocuments.id })
    .from(legalDocuments)
    .where(and(eq(legalDocuments.docType, "eula"), eq(legalDocuments.version, doc_version)));

  if (!doc) {
    return NextResponse.json({ error: "EULA document not found" }, { status: 404 });
  }

  // 5. Extract consent metadata from headers
  const headersList = request.headers;
  const ipAddress = headersList.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? headersList.get("x-real-ip")
    ?? null;
  const geoCountry = headersList.get("cf-ipcountry") ?? null;
  const geoRegion = headersList.get("x-vercel-ip-country-region") ?? null;
  const userAgent = headersList.get("user-agent") ?? null;

  // 6. Upsert consent (idempotent on unique constraint)
  await db.insert(userLegalConsents).values({
    id: crypto.randomUUID(),
    userId: user.id,
    docType: "eula",
    docVersion: doc_version,
    acceptedAt: new Date(),
    ipAddress: ipAddress,
    geoCountry: geoCountry,
    geoRegion: geoRegion,
    userAgent: userAgent,
  }).onConflictDoNothing();

  // 7. Set cookie fast-path for middleware
  const res = NextResponse.json({ success: true });
  res.cookies.set("eula_accepted", doc_version, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 86400, // 24 hours
    path: "/",
  });

  return res;
}
```

**Function signatures:**
- `POST(request: NextRequest): Promise<NextResponse>`

**Error handling:**
- 401: Not authenticated (no user from `getAuthenticatedUser()`)
- 400: Missing/invalid `doc_type` or `doc_version`, or version mismatch
- 404: Document not found in `legal_documents`
- 200: Success (including repeat submissions — `onConflictDoNothing`)

### b.5) Middleware EULA Check

**File MODIFY:** `geo/lib/supabase/middleware.ts`

Add the EULA check **after** the auth check (after line 83, before the header forwarding block at line 86). Insert between the "redirect authenticated users away from login" block and the "forward user info" block.

Import at top of file:
```typescript
import { CURRENT_EULA_VERSION } from "@/lib/config";
```

New block to insert (~lines 84-104):

```typescript
  // ── EULA acceptance check (ES-073) ─────────────────────────────────────────
  // Exempt paths: /auth/*, /api/auth/*, /api/blocked, static assets, _next
  const isEulaExempt =
    pathname.startsWith("/auth") ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/blocked") ||
    pathname.startsWith("/api/sites") ||       // token-based site access (no auth)
    pathname.startsWith("/sites") ||            // public site pages
    pathname.startsWith("/report") ||           // shared report pages
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";

  if (isAuthenticated && !isEulaExempt) {
    // Fast-path: check cookie first
    const eulaAcceptedVersion = request.cookies.get("eula_accepted")?.value;

    if (eulaAcceptedVersion !== CURRENT_EULA_VERSION) {
      // Slow-path: query DB to confirm (cookie may have expired or never been set)
      // Import db inline to avoid circular deps in middleware
      // NOTE: middleware runs on Edge — use fetch to the API instead of direct DB
      // Actually, since this is Node.js middleware (not Edge), direct DB is fine.
      // However, to keep middleware light, we trust the cookie absence = no consent.
      // The cookie is set for 24h by the accept-eula API route.
      // On cookie expiry, user gets redirected, accept-eula page checks DB and
      // if consent exists already, auto-submits (or we add a DB check here).
      //
      // Decision: redirect to accept-eula. That page will check if already accepted
      // and auto-redirect if so. This keeps middleware DB-free.
      const redirectTo = encodeURIComponent(pathname + (request.nextUrl.search ?? ""));
      if (DEBUG) console.error(`[MIDDLEWARE] EULA not accepted, redirecting to /auth/accept-eula`);
      return NextResponse.redirect(
        new URL(`/auth/accept-eula?redirectTo=${redirectTo}`, request.url)
      );
    }
  }
```

**Critical design decisions:**
1. Middleware does NOT query DB — it only checks the `eula_accepted` cookie. This keeps the middleware fast (no DB round-trip on every request).
2. Cookie is `httpOnly`, `secure`, `sameSite=strict`, `maxAge=86400` (24h). After 24h, user is redirected to accept-eula page again.
3. The accept-eula page (server component) queries `user_legal_consents` to check if user already accepted. If yes, it can auto-redirect to dashboard (avoiding re-acceptance after cookie expiry).
4. `/sites/*`, `/report/*`, `/api/sites/*` are exempt because they use token-based access (no Supabase auth required).

**Accept-EULA page server-side auto-redirect** (add to the server component in b.3):
```typescript
// If user already accepted this version, redirect immediately
const user = await getAuthenticatedUser();
if (user) {
  const [existing] = await db.select({ id: userLegalConsents.id })
    .from(userLegalConsents)
    .where(and(
      eq(userLegalConsents.userId, user.id),
      eq(userLegalConsents.docType, "eula"),
      eq(userLegalConsents.docVersion, CURRENT_EULA_VERSION),
    ));
  if (existing) {
    // Consent exists but cookie expired — re-set cookie and redirect
    // Can't set cookies from server component, so redirect to API endpoint
    // that re-sets the cookie. Or just show the page — user clicks "Continue"
    // and it's idempotent.
    // Simplest: redirect to dashboard directly (accept that cookie re-set
    // happens naturally next time they hit the API).
    redirect(redirectTo ?? "/dashboard");
  }
}
```

### b.6) Version Bump Re-Acceptance Logic

No new code required. The system handles this automatically:

1. Admin inserts new row in `legal_documents` with version `1.1`
2. Admin updates `CURRENT_EULA_VERSION` in `lib/config.ts` from `"1.0"` to `"1.1"`
3. Deploy triggers:
   - Middleware checks `eula_accepted` cookie → value is `"1.0"` → `!== "1.1"` → redirect to `/auth/accept-eula`
   - Accept-EULA page fetches latest document (version `1.1`) → user must re-accept
   - API route validates `doc_version === CURRENT_EULA_VERSION` → stores consent for `1.1`
   - Cookie updated to `"1.1"`

### b.7) V0-Website T&C Page Updates

**File MODIFY:** `archive/V0-Website/app/terms/page.tsx`

All changes are to JSX text content. No structural changes.

**Change 1 — Section 1 (Agreement), line 39-64:**
After the Privacy Policy link (line 57), add before the closing `</p>`:
```
{" "}and our{" "}
<a href="https://geo.flowblinq.com/auth/accept-eula" className="text-[#C2652A] hover:text-[#8B4513] underline">
  End User License Agreement (EULA)
</a>
, which is incorporated by reference into these Terms
```

**Change 2 — Section 3 (AI Visibility Audit), lines 119-172:**
Add two new list items after line 165 (before the closing `</ul>`):
```jsx
<li className="flex items-start gap-3">
  <span className="text-[#C2652A] mt-1.5 text-xs">&#9679;</span>
  <span>
    The audit <strong className="text-[#000000]">does not constitute professional legal, financial, technical, or compliance advice</strong>.
    You should consult qualified professionals before acting on audit findings.
  </span>
</li>
<li className="flex items-start gap-3">
  <span className="text-[#C2652A] mt-1.5 text-xs">&#9679;</span>
  <span>
    The algorithms, scoring models, and methodology used to generate audit results are proprietary
    and confidential. FlowBlinq is not obligated to disclose the methodology or internal workings
    of its scoring system.
  </span>
</li>
```

**Change 3 — Section 4 (Your Content), lines 175-218:**
Add new subsection after "Your responsibility" div (after line 217, before closing `</div>`):
```jsx
<div>
  <h4 className="text-[#000000] font-semibold mb-1.5">Feedback</h4>
  <p className="text-[#4A4A4A] text-sm leading-relaxed">
    Any suggestions, ideas, enhancement requests, feedback, or recommendations
    you provide regarding the services (&ldquo;Feedback&rdquo;) are entirely voluntary.
    You grant FlowBlinq a perpetual, irrevocable, worldwide, royalty-free license
    to use, modify, and incorporate Feedback into our products and services
    without restriction, attribution, or compensation.
  </p>
</div>
```

**Change 4 — Section 5 (Our Intellectual Property), lines 221-235:**
Replace the `<p>` content (line 228-233) with:
```jsx
<p className="text-[#1A1A1A] leading-relaxed mb-4">
  The FlowBlinq platform, including all software, algorithms, scoring models,
  scanning infrastructure, audit methodologies, designs, content, and branding,
  is the proprietary Intellectual Property of{" "}
  <strong className="text-[#000000]">Ideaexec Solutions and Services Canada Inc.</strong>{" "}
  and is protected by intellectual property laws including copyright, patent, and trade secret law.
</p>
<p className="text-[#1A1A1A] leading-relaxed">
  You are granted a limited, non-exclusive, non-transferable, revocable right to
  access and use the services for your internal business purposes only. You may not
  copy, modify, reverse engineer, decompile, disassemble, or create derivative works
  from any part of our platform.
</p>
```

**Change 5 — Section 7 (Warranty Disclaimer), lines 299-343:**
Replace the first `<p>` (lines 305-309) with:
```jsx
<p className="text-[#1A1A1A] leading-relaxed mb-4 uppercase text-sm font-semibold">
  THE SERVICES AND ALL AUDIT REPORTS ARE PROVIDED &ldquo;AS IS&rdquo; AND
  &ldquo;AS AVAILABLE&rdquo; WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS,
  IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES
  OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.
</p>
```

**Change 6 — Section 8 (Limitation of Liability), lines 347-365:**
Replace the second `<p>` (lines 360-364) — change "one hundred US dollars ($100)" to:
```jsx
<p className="text-[#1A1A1A] leading-relaxed text-sm">
  Our total aggregate liability for all claims will not exceed the
  greater of (a) the amount you paid us in the 12 months before the
  claim, or (b) one hundred Canadian dollars (CAD $100).
</p>
```

**Change 7 — Section 9 (Indemnification), lines 368-383:**
Replace the `<p>` content (lines 374-381) with:
```jsx
<p className="text-[#1A1A1A] leading-relaxed text-sm mb-4">
  You agree to indemnify and hold harmless FlowBlinq and its
  officers, directors, employees, and agents from any claims,
  damages, losses, and expenses (including legal fees) arising from:
  (a) your use of the services; (b) your content, including
  intellectual property infringement claims; (c) your violation of
  these Terms; (d) your violation of any applicable laws; or
  (e) any third-party claims arising from your sharing, publication,
  or distribution of Audit Reports generated by FlowBlinq.
</p>
<p className="text-[#4A4A4A] text-sm leading-relaxed">
  You are solely responsible for the accuracy and appropriateness of
  any use you make of Audit Report data, including sharing with third parties.
</p>
```

**Change 8 — New Section: Confidentiality**
Insert as Section 10 (after current Section 9, before current Section 10 "Termination"). Renumber subsequent sections (current 10→11, 11→12, 12→13, 13→14, 14→15).

```jsx
{/* 10. Confidentiality */}
<section className="mb-14">
  <h2 className="fb-heading text-2xl text-[#000000] mb-6">
    10. Confidentiality
  </h2>
  <div className="bg-[#EDD6CC] border border-[#DCB09E] p-8">
    <p className="text-[#1A1A1A] leading-relaxed text-sm mb-4">
      Each party may disclose confidential information to the other in
      connection with these Terms. &ldquo;Confidential Information&rdquo; means
      any non-public information disclosed by either party that is designated
      as confidential or that reasonably should be considered confidential given
      the nature of the information and circumstances of disclosure.
    </p>
    <p className="text-[#1A1A1A] leading-relaxed text-sm mb-4">
      The receiving party agrees to: (a) use Confidential Information only to
      exercise its rights and perform its obligations under these Terms; and
      (b) protect Confidential Information using at least reasonable care.
    </p>
    <p className="text-[#4A4A4A] text-sm leading-relaxed">
      Confidentiality obligations survive for five (5) years from the date of disclosure
      or, for trade secrets, for as long as they remain trade secrets under applicable law.
    </p>
  </div>
</section>
```

**Change 9 — New Section: Data Protection**
Insert as Section 11 (after Confidentiality, before Termination which becomes 12).

```jsx
{/* 11. Data Protection */}
<section className="mb-14">
  <h2 className="fb-heading text-2xl text-[#000000] mb-6">
    11. Data Protection
  </h2>
  <div className="bg-[#EDD6CC] border border-[#DCB09E] p-8">
    <p className="text-[#1A1A1A] leading-relaxed text-sm mb-4">
      FlowBlinq processes personal information in accordance with the
      Personal Information Protection and Electronic Documents Act (PIPEDA)
      and applicable Canadian privacy legislation. For details on how we
      collect, use, and protect your data, see our{" "}
      <Link href="/privacy" className="text-[#C2652A] hover:text-[#8B4513] underline">
        Privacy Policy
      </Link>.
    </p>
    <p className="text-[#1A1A1A] leading-relaxed text-sm">
      Where our services process personal information on your behalf (e.g.,
      email addresses submitted for audits), you are responsible for ensuring
      you have the necessary consents to share such information with us.
    </p>
  </div>
</section>
```

**Change 10 — Dates and contact email:**
- Line 25: `"February 12, 2026"` → `"April 2, 2026"` (Effective date)
- Line 28: `"February 12, 2026"` → `"April 2, 2026"` (Last updated)
- Line 159 (`hello@flowblinq.ai` in audit section): → `legal@flowblinq.com`
- Line 489 (`hello@flowblinq.ai` in contact section): → `legal@flowblinq.com`
- Line 488 (`mailto:hello@flowblinq.ai`): → `mailto:legal@flowblinq.com`
- Line 159 (`mailto:hello@flowblinq.ai`): → `mailto:legal@flowblinq.com`

**Section renumbering** (after inserting Confidentiality as 10 and Data Protection as 11):
- Old 10 (Termination) → 12
- Old 11 (Governing Law) → 13
- Old 12 (Changes) → 14
- Old 13 (General) → 15
- Old 14 (Contact) → 16

---

## c) Unit Test Plan

**File CREATE:** `geo/__tests__/eula-acceptance.test.ts`

**Minimum coverage:** 90% of new code paths.

### API Route Tests (mock DB + headers)

**UT-073-1:** POST `/api/auth/accept-eula` with valid user + valid version → 200, consent inserted
- Mock: `getAuthenticatedUser()` returns `{ id: "user-1", email: "test@test.com", token: "t", tokenExpiry: null }`
- Mock: `legalDocuments` query returns `{ id: "doc-1" }`
- Mock: `userLegalConsents` insert succeeds
- Assert: response status 200, body `{ success: true }`
- Assert: response has `Set-Cookie` header with `eula_accepted=1.0`

**UT-073-2:** POST without auth → 401
- Mock: `getAuthenticatedUser()` returns `null`
- Assert: response status 401

**UT-073-3:** POST with wrong doc_version → 400
- Body: `{ doc_type: "eula", doc_version: "99.0" }`
- Assert: response status 400, error mentions version mismatch

**UT-073-4:** POST with missing doc_type → 400
- Body: `{}`
- Assert: response status 400

**UT-073-5:** POST with doc_version matching CURRENT but no document in DB → 404
- Mock: `legalDocuments` query returns empty
- Assert: response status 404

**UT-073-6:** Repeat acceptance is idempotent → 200
- Mock: `userLegalConsents` insert with `onConflictDoNothing` (no error)
- Assert: response status 200

**UT-073-7:** IP address extracted from x-forwarded-for (first IP in comma-separated list)
- Request header: `x-forwarded-for: 1.2.3.4, 5.6.7.8`
- Assert: inserted `ip_address` = `"1.2.3.4"`

**UT-073-8:** Geo headers extracted correctly
- Request headers: `cf-ipcountry: CA`, `x-vercel-ip-country-region: ON`
- Assert: inserted `geo_country` = `"CA"`, `geo_region` = `"ON"`

**UT-073-9:** Cookie attributes correct
- Assert: `httpOnly: true`, `sameSite: strict`, `maxAge: 86400`, `path: "/"`

### Middleware EULA Check Tests (mock cookies + request)

**UT-073-10:** Authenticated user with valid eula_accepted cookie → passes through
- Cookie: `eula_accepted=1.0`, `CURRENT_EULA_VERSION=1.0`
- Assert: no redirect, `NextResponse.next()` returned

**UT-073-11:** Authenticated user without eula_accepted cookie → redirect to `/auth/accept-eula`
- No `eula_accepted` cookie
- Request path: `/dashboard`
- Assert: redirect to `/auth/accept-eula?redirectTo=%2Fdashboard`

**UT-073-12:** Authenticated user with stale cookie version → redirect
- Cookie: `eula_accepted=1.0`, `CURRENT_EULA_VERSION=1.1`
- Assert: redirect to `/auth/accept-eula`

**UT-073-13:** Unauthenticated user on `/dashboard` → redirect to `/auth/login` (not EULA)
- No session
- Assert: redirect to `/auth/login?redirectTo=%2Fdashboard`

**UT-073-14:** Authenticated user on `/auth/accept-eula` (exempt path) → passes through
- No `eula_accepted` cookie, path = `/auth/accept-eula`
- Assert: no redirect

**UT-073-15:** Authenticated user on `/sites/abc123` (exempt) → passes through
- No `eula_accepted` cookie, path = `/sites/abc123`
- Assert: no redirect

**UT-073-16:** Authenticated user on `/api/sites/abc123` (exempt) → passes through
- No `eula_accepted` cookie, path = `/api/sites/abc123`
- Assert: no redirect

**UT-073-17:** Authenticated user on `/report/xyz` (exempt) → passes through
- Assert: no redirect

### Accept-EULA Page Tests

**UT-073-18:** Page renders EULA title and version
- Mock: `legalDocuments` returns `{ title: "EULA", version: "1.0", body: "...", effectiveDate: "2026-04-02" }`
- Assert: "End User License Agreement" heading visible
- Assert: "Version 1.0" subtitle visible

**UT-073-19:** Checkbox unchecked by default, Continue button disabled
- Assert: checkbox not checked
- Assert: Continue button has `disabled` attribute or equivalent styling

**UT-073-20:** Checking checkbox enables Continue button
- Action: click checkbox
- Assert: Continue button enabled

**UT-073-21:** Submit calls API with correct body
- Action: check checkbox, click Continue
- Assert: `fetch("/api/auth/accept-eula", { method: "POST", body: '{"doc_type":"eula","doc_version":"1.0"}' })`

**UT-073-22:** Successful submit redirects to dashboard
- Mock: fetch returns 200
- Assert: `window.location.href` set to `/dashboard`

**UT-073-23:** Successful submit with redirectTo preserves redirect
- SearchParams: `?redirectTo=/dashboard/domains/abc`
- Mock: fetch returns 200
- Assert: `window.location.href` set to `/dashboard/domains/abc`

**UT-073-24:** API error shows error message
- Mock: fetch returns 400 with `{ error: "Version mismatch" }`
- Assert: error text "Version mismatch" visible

**UT-073-25:** Server component auto-redirects if consent already exists
- Mock: `getAuthenticatedUser` returns user
- Mock: `userLegalConsents` query returns existing record
- Assert: redirect to dashboard

---

## d) Integration Test Plan

**File CREATE:** `geo/__tests__/integration/eula-acceptance.integration.test.ts`

**IT-073-1:** Full EULA acceptance flow — DB round-trip
- Seed `legal_documents` with EULA v1.0
- Create user session
- POST `/api/auth/accept-eula` with `{ doc_type: "eula", doc_version: "1.0" }`
- Assert: row exists in `user_legal_consents` with correct `user_id`, `doc_type`, `doc_version`
- Assert: response cookie `eula_accepted=1.0`

**IT-073-2:** Repeat acceptance is idempotent
- Seed consent for user
- POST same request again
- Assert: 200 response, still one row in DB (not duplicated)

**IT-073-3:** Version bump triggers re-acceptance
- Seed consent for version `1.0`
- Update `CURRENT_EULA_VERSION` to `1.1`, seed document v1.1
- Middleware check: cookie `eula_accepted=1.0` → redirect to accept-eula
- POST accept with version `1.1` → success
- Assert: two rows in `user_legal_consents` (v1.0 and v1.1)

**IT-073-4:** Middleware allows request after EULA acceptance
- Set cookie `eula_accepted=1.0` on request
- Request `/dashboard`
- Assert: no redirect (middleware passes through)

**IT-073-5:** Middleware redirects without cookie
- No `eula_accepted` cookie, authenticated user
- Request `/dashboard`
- Assert: 307 redirect to `/auth/accept-eula?redirectTo=%2Fdashboard`

**IT-073-6:** Accept-eula page auto-redirect when consent exists but cookie expired
- Seed consent in DB for user + EULA v1.0
- No `eula_accepted` cookie
- Request `/auth/accept-eula`
- Assert: server redirects to `/dashboard` (auto-detect existing consent)

---

## e) Profiling Requirements

| Metric | Baseline | Measurement |
|--------|----------|-------------|
| Middleware latency (with cookie) | < 1ms added | Measure `Date.now()` around EULA cookie check |
| Middleware latency (DB fallback) | N/A | No DB in middleware — always cookie-only |
| Accept-eula API latency | < 100ms | Log `generationMs` in API route |
| Accept-eula page TTFB | < 200ms | Single DB query for latest document |

**Tool:** Next.js server timing headers + `console.info` timing logs (same pattern as existing `[sites/page:timing]` logs).

---

## f) Load Test Plan

| Scenario | Target |
|----------|--------|
| 100 concurrent EULA acceptances | p95 < 200ms, no unique constraint errors surfaced to user |
| 1000 middleware checks/sec (cookie path) | p99 < 5ms added latency |

**Success criteria:** Cookie check adds < 1ms. No DB connection pool exhaustion during mass acceptance.

---

## g) Logging & Instrumentation

| Event | Level | Fields |
|-------|-------|--------|
| `eula_acceptance` | `info` | `userId`, `docVersion`, `ipAddress`, `geoCountry` |
| `eula_acceptance_duplicate` | `debug` | `userId`, `docVersion` (idempotent repeat) |
| `eula_middleware_redirect` | `debug` | `userId`, `path`, `cookieVersion`, `requiredVersion` |
| `eula_version_mismatch` | `warn` | `userId`, `submittedVersion`, `currentVersion` |

Log format: `console.info(JSON.stringify({ event, ...fields }))` — same as existing GEO logging pattern.

---

## h) Acceptance Criteria

### Database (3A)
- [ ] **AC-1:** `legal_documents` table exists with `UNIQUE(doc_type, version)` constraint
- [ ] **AC-2:** `user_legal_consents` table exists with `UNIQUE(user_id, doc_type, doc_version)` constraint
- [ ] **AC-3:** RLS enabled on `user_legal_consents` — users can only read/insert their own rows
- [ ] **AC-4:** EULA v1.0 seeded in `legal_documents` with entity name "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)"
- [ ] **AC-5:** Drizzle schema definitions added (`legalDocuments`, `userLegalConsents`)
- [ ] **AC-6:** Index on `(user_id, doc_type, doc_version)` exists

### EULA Page (3B)
- [ ] **AC-7:** `/auth/accept-eula` renders full EULA text in scrollable container (`max-h-[60vh]`)
- [ ] **AC-8:** Checkbox unchecked by default, Continue button disabled until checked
- [ ] **AC-9:** EULA version and effective date displayed in subtitle
- [ ] **AC-10:** Page matches auth page styling (bg `#faf8f5`, card white, accent `#b45309`)
- [ ] **AC-11:** Responsive at 375px viewport width
- [ ] **AC-12:** If user already accepted current version (DB check), auto-redirect to dashboard

### API Route (3C)
- [ ] **AC-13:** POST `/api/auth/accept-eula` stores consent with user_id, version, timestamp, IP, geo, UA
- [ ] **AC-14:** Returns 401 for unauthenticated requests
- [ ] **AC-15:** Returns 400 if `doc_version !== CURRENT_EULA_VERSION`
- [ ] **AC-16:** Idempotent — repeat submissions return 200 without error
- [ ] **AC-17:** Sets `eula_accepted` cookie (httpOnly, secure, sameSite=strict, maxAge=86400)

### Middleware (3D)
- [ ] **AC-18:** Authenticated users without valid `eula_accepted` cookie redirected to `/auth/accept-eula`
- [ ] **AC-19:** `redirectTo` parameter preserved through EULA flow
- [ ] **AC-20:** Auth paths (`/auth/*`, `/api/auth/*`) exempt from EULA check
- [ ] **AC-21:** Public paths (`/sites/*`, `/report/*`, `/api/sites/*`) exempt from EULA check
- [ ] **AC-22:** Cookie fast-path — no DB query in middleware
- [ ] **AC-23:** Unauthenticated users get `/auth/login` redirect, not EULA redirect

### Version Bump (3E)
- [ ] **AC-24:** Changing `CURRENT_EULA_VERSION` triggers re-acceptance for all users
- [ ] **AC-25:** Old cookie version (`1.0`) does not satisfy new version check (`1.1`)
- [ ] **AC-26:** Users can re-accept new version without losing access to prior data

### T&C Page (3F)
- [ ] **AC-27:** EULA incorporation by reference added to Section 1
- [ ] **AC-28:** "Not professional advice" + algorithm non-disclosure added to Section 3
- [ ] **AC-29:** Feedback clause added to Section 4
- [ ] **AC-30:** IP ownership strengthened in Section 5 with explicit entity name
- [ ] **AC-31:** Warranty disclaimer strengthened with "STATUTORY" and "TITLE"
- [ ] **AC-32:** Liability cap changed to "CAD $100"
- [ ] **AC-33:** Audit report misuse indemnity added to Section 9
- [ ] **AC-34:** New Confidentiality section with 5-year survival
- [ ] **AC-35:** New Data Protection section with PIPEDA reference
- [ ] **AC-36:** Dates updated to "April 2, 2026"
- [ ] **AC-37:** Contact email updated to `legal@flowblinq.com` throughout
- [ ] **AC-38:** Entity name "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)" consistent throughout
- [ ] **AC-39:** Sections renumbered correctly (16 total after additions)
- [ ] **AC-40:** No visual regression — same styling/layout

### Cross-Cutting
- [ ] **AC-41:** Docker CI passes: `docker build -f Dockerfile.test -t geo-test . && docker run --rm geo-test`
- [ ] **AC-42:** No redirect loops (accept-eula page exempt from EULA check)

---

## Files Summary

| File | Action | Codebase |
|------|--------|----------|
| `geo/lib/db/migrations/20260402-legal-documents.sql` | CREATE | GEO |
| `geo/lib/db/schema.ts` | MODIFY | GEO |
| `geo/lib/config.ts` | MODIFY | GEO |
| `geo/app/auth/accept-eula/page.tsx` | CREATE | GEO |
| `geo/app/api/auth/accept-eula/route.ts` | CREATE | GEO |
| `geo/lib/supabase/middleware.ts` | MODIFY | GEO |
| `archive/V0-Website/app/terms/page.tsx` | MODIFY | V0-Website |

**Total:** 3 CREATE + 4 MODIFY = 7 files

---

## ScriptDev Notes

1. **EULA text extraction:** The full EULA body text must be extracted from `/home/aditya/Downloads/Flowblinq_EULA_v1.0_Apr2026.docx`. Ensure the entity name reads "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)" — not "Ideaexec" alone. Insert as the `body` value in the seed migration.
2. **Middleware insertion point:** Insert the EULA block after line 83 (the "redirect auth users away from login" block) and before line 86 (the "forward user info" block). Do NOT move or restructure existing middleware logic.
3. **Cookie security:** The `eula_accepted` cookie MUST be `httpOnly` and `secure` (in production). Never expose it to client-side JS.
4. **V0-Website is a separate codebase** at `archive/V0-Website/`. It uses Tailwind CSS classes (not inline styles). Maintain the existing class-based styling approach.
5. **Section renumbering:** When adding Confidentiality (10) and Data Protection (11), update all subsequent section numbers in both the `<h2>` headings and the JSX comments (`{/* N. Title */}`).
6. **No Edge Runtime:** The middleware in this project runs on Node.js (not Edge). Direct Drizzle/DB access is technically possible but NOT used in middleware to keep it fast. Cookie-only check is the design decision.

---

*ES-073 — SpecMaster, 2026-04-02*
