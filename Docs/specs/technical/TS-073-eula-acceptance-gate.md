# TS-073 — EULA Acceptance Gate (First Login Click-Wrap)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-02
**Priority:** CRITICAL
**Scope:** GEO app (`/home/aditya/flowblinq/geo`) + V0-Website T&C page update

---

## 1. What

Add a mandatory EULA click-wrap acceptance gate after first OTP login. Users must read and accept the EULA before accessing the dashboard. Store consent with timestamp, document version, IP address, and geo-location. Also update the existing `/terms` page on the marketing website with strengthened legal clauses.

## 2. Why

Flowblinq currently lacks a formal EULA acceptance mechanism. Without click-wrap consent, the company cannot evidence that a user agreed to terms governing use of Audit Reports, indemnification, IP ownership, and liability limitations. This is a legal compliance requirement identified in the April 2, 2026 legal strategy review. Comparable services (Semrush, Ahrefs, Moz) all require explicit acceptance.

## 3. Components

### 3A. Database Schema Changes (Supabase/Postgres)

#### New table: `legal_documents`

```sql
CREATE TABLE legal_documents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  doc_type TEXT NOT NULL,            -- 'eula' | 'terms'
  version TEXT NOT NULL,             -- '1.0', '1.1', etc.
  title TEXT NOT NULL,
  body TEXT NOT NULL,                -- Full document text (plain text / HTML)
  effective_date TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE (doc_type, version)
);
```

**Seed data:** Insert EULA v1.0 text (from `Flowblinq_EULA_v1.0_Apr2026.docx`, entity name corrected to "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)").

#### New table: `user_legal_consents`

```sql
CREATE TABLE user_legal_consents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id TEXT NOT NULL,             -- Supabase auth.users.id
  doc_type TEXT NOT NULL,            -- 'eula'
  doc_version TEXT NOT NULL,         -- '1.0'
  accepted_at TIMESTAMP NOT NULL DEFAULT now(),
  ip_address TEXT,                   -- From x-forwarded-for or x-real-ip header
  geo_country TEXT,                  -- From cf-ipcountry header (Cloudflare/Vercel)
  geo_region TEXT,                   -- From x-vercel-ip-country-region if available
  user_agent TEXT,                   -- From user-agent header
  UNIQUE (user_id, doc_type, doc_version)
);

-- RLS: users can only read/insert their own consents
ALTER TABLE user_legal_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_own_consents" ON user_legal_consents
  FOR ALL USING (auth.uid()::text = user_id);
```

**Note:** No columns added to existing tables. Consent is a separate table to support multiple document types and version history without schema changes.

### 3B. EULA Acceptance Page (GEO App)

#### New page: `/auth/accept-eula/page.tsx`

**Location:** `geo/app/auth/accept-eula/page.tsx`

**Behavior:**
1. Server component fetches latest EULA from `legal_documents` where `doc_type = 'eula'` ordered by `effective_date DESC LIMIT 1`
2. Renders:
   - Flowblinq logo at top
   - Title: "End User License Agreement"
   - Version + effective date subtitle
   - Scrollable container (`max-h-[60vh] overflow-y-auto`) with full EULA text
   - Checkbox: "I have read and agree to the End User License Agreement"
   - "Continue" button (disabled until checkbox checked)
3. On submit → calls `/api/auth/accept-eula` API route
4. On success → redirects to `/dashboard` (or original `redirectTo`)

**Styling:** Match existing GEO auth pages (same bg, font, color tokens as `app/auth/login/page.tsx`).

**Important UX details:**
- Checkbox must be unchecked by default
- User must scroll through the document (no enforcement, but checkbox is below the scroll container so they see it after the text)
- "Continue" button visually disabled (grayed out) until checkbox is checked
- Show EULA version number in subtitle for legal traceability

### 3C. EULA Acceptance API Route

#### New route: `/api/auth/accept-eula/route.ts`

**Location:** `geo/app/api/auth/accept-eula/route.ts`

**Method:** POST

**Request body:**
```json
{
  "doc_type": "eula",
  "doc_version": "1.0"
}
```

**Behavior:**
1. Authenticate user via `getAuthenticatedUser()` (from `lib/supabase/authenticated-client.ts`)
2. Verify the `doc_version` matches the latest version in `legal_documents`
3. Extract from request headers:
   - `x-forwarded-for` or `x-real-ip` → `ip_address`
   - `cf-ipcountry` → `geo_country` (Cloudflare header, available on Vercel)
   - `x-vercel-ip-country-region` → `geo_region`
   - `user-agent` → `user_agent`
4. Insert into `user_legal_consents` (upsert on unique constraint — idempotent)
5. Return `{ success: true }`

**Error cases:**
- 401 if not authenticated
- 400 if `doc_version` doesn't match latest
- 409 if already accepted (return success anyway — idempotent)

### 3D. Middleware Intercept

#### Modified file: `geo/lib/supabase/middleware.ts`

**Current behavior (lines 59-106):** Checks auth, redirects unauthenticated users to `/auth/login`.

**New behavior:** After confirming the user is authenticated, check if they have accepted the current EULA version:

1. Query `user_legal_consents` for this `user_id` where `doc_type = 'eula'` and `doc_version` = current EULA version
2. If no consent record exists → redirect to `/auth/accept-eula?redirectTo={original_path}`
3. If consent exists → proceed normally

**Exempt paths** (do not check EULA acceptance):
- `/auth/*` (all auth routes including `/auth/accept-eula`)
- `/api/auth/*` (all auth API routes)
- `/api/blocked`
- Static assets, `_next`, favicon

**Performance consideration:** The EULA version should be read from an environment variable or config constant (e.g., `CURRENT_EULA_VERSION = '1.0'`) rather than querying `legal_documents` on every request. The consent check is a single indexed query on `(user_id, doc_type, doc_version)` — fast, but should be cached in the session/cookie if possible.

**Recommended approach:** After EULA acceptance, set a short-lived cookie `eula_accepted=1.0` (httpOnly, secure, sameSite=strict, maxAge=24h). Middleware checks cookie first; if missing/stale, falls back to DB query. This avoids a DB round-trip on every request.

### 3E. Version Bump Re-Acceptance

When EULA is updated:
1. Insert new row in `legal_documents` with incremented version (e.g., `1.1`)
2. Update `CURRENT_EULA_VERSION` env var / config constant
3. The `eula_accepted` cookie will carry the old version → middleware cookie check fails → DB query confirms no consent for new version → redirect to `/auth/accept-eula`
4. User must re-accept before continuing

### 3F. Website T&C Page Update (V0-Website)

#### Modified file: `archive/V0-Website/app/terms/page.tsx`

Update the existing Terms of Service page with strengthened clauses from the legal review:

1. **Section 1 (Agreement):** Add reference to EULA incorporation by reference
2. **Section 3 (AI Visibility Audit):** Strengthen disclaimer language — add "does not constitute professional legal, financial, technical, or compliance advice" and algorithm non-disclosure clause
3. **Section 4 (Your Content):** Add explicit Feedback clause (suggestions may be used without restriction)
4. **Section 5 (Our IP):** Add formal IP ownership declaration — "proprietary Intellectual Property of Ideaexec Solutions and Services Canada Inc." including algorithms, scoring models, scanning infrastructure
5. **Section 7 (Warranty Disclaimer):** Strengthen "AS IS" language per EULA Section 6.2
6. **Section 8 (Limitation of Liability):** Change cap to CAD $100 (was USD $100)
7. **Section 9 (Indemnification):** Add third-party Audit Report misuse indemnity — user indemnifies for claims arising from shared/published reports
8. **New Section: Confidentiality** — 5-year survival, reasonable care standard
9. **New Section: Data Protection** — PIPEDA reference, user responsibility for consent
10. **Update dates:** Effective date → April 2, 2026, Last updated → April 2, 2026
11. **Update entity name consistency:** Ensure "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)" throughout
12. **Update contact email:** Standardize to `legal@flowblinq.com` for legal pages

## 4. Dependencies

- Supabase Postgres access (existing, no new services)
- Cloudflare/Vercel headers for geo-location (already available in production)
- EULA text from `Flowblinq_EULA_v1.0_Apr2026.docx` (entity name corrected)
- T&C update clauses from `Flowblinq_TC_Updates_v1.0_Apr2026.docx`

## 5. Interfaces

### Input
- User authentication (Supabase Auth session)
- HTTP headers (IP, geo, user-agent)
- EULA text from `legal_documents` table

### Output
- `user_legal_consents` row on acceptance
- `eula_accepted` cookie for middleware fast-path
- Redirect to dashboard on success

### API Contract

```
POST /api/auth/accept-eula
Headers: Authorization (Supabase session cookie)
Body: { "doc_type": "eula", "doc_version": "1.0" }
Response: { "success": true }
```

## 6. Acceptance Criteria

### 3A — Database
- [ ] `legal_documents` table exists with EULA v1.0 seeded
- [ ] `user_legal_consents` table exists with RLS enabled
- [ ] Unique constraint on `(user_id, doc_type, doc_version)` enforced
- [ ] Entity name in seeded EULA text reads "Ideaexec Solutions and Services Canada Inc. (DBA FlowBlinq)"

### 3B — EULA Page
- [ ] `/auth/accept-eula` renders full EULA text in scrollable container
- [ ] Checkbox unchecked by default, "Continue" button disabled until checked
- [ ] EULA version displayed in subtitle
- [ ] Page matches existing auth page styling
- [ ] Responsive — works on mobile viewports

### 3C — API Route
- [ ] POST `/api/auth/accept-eula` stores consent with user_id, version, timestamp, IP, geo, user-agent
- [ ] Returns 401 for unauthenticated requests
- [ ] Returns 400 if doc_version doesn't match latest
- [ ] Idempotent — repeat submissions succeed without error

### 3D — Middleware
- [ ] Authenticated users without EULA consent are redirected to `/auth/accept-eula`
- [ ] `redirectTo` parameter preserved through the EULA flow
- [ ] Auth paths exempt from EULA check
- [ ] Cookie fast-path avoids DB query on every request
- [ ] Cookie expires after 24h, triggering a re-check

### 3E — Version Bump
- [ ] Changing `CURRENT_EULA_VERSION` triggers re-acceptance for all users
- [ ] Old cookie version doesn't satisfy new version check
- [ ] Users can re-accept and continue without data loss

### 3F — T&C Page
- [ ] All 10 clause updates applied to `/terms` page
- [ ] Dates updated to April 2, 2026
- [ ] Entity name consistent throughout
- [ ] Contact email updated to legal@flowblinq.com
- [ ] No visual regression — same styling/layout as existing page

## 7. Risks

| Risk | Mitigation |
|------|-----------|
| Middleware DB query on every request adds latency | Cookie fast-path (24h TTL) — DB hit only on first request per day |
| Geo headers not available in local dev | Fallback to null — geo fields are nullable |
| EULA text too long for comfortable reading on mobile | Scrollable container with `max-h-[60vh]` — tested at 375px width |
| Users stuck in redirect loop if accept-eula page itself triggers redirect | `/auth/*` paths explicitly exempt from EULA check |
| Race condition: user opens two tabs, both redirect to accept-eula | Upsert on unique constraint — second insert is idempotent |

## 8. Files Affected (GEO App)

| File | Action |
|------|--------|
| `geo/app/auth/accept-eula/page.tsx` | **CREATE** — EULA acceptance page |
| `geo/app/api/auth/accept-eula/route.ts` | **CREATE** — Consent storage API |
| `geo/lib/supabase/middleware.ts` | **MODIFY** — Add EULA consent check |
| `geo/lib/config.ts` | **MODIFY** — Add `CURRENT_EULA_VERSION` constant |
| `geo/supabase/migrations/XXXXXX_legal_documents.sql` | **CREATE** — DDL migration |

## 9. Files Affected (V0-Website)

| File | Action |
|------|--------|
| `archive/V0-Website/app/terms/page.tsx` | **MODIFY** — Strengthen T&C clauses |

---

*TS-073 — CoFounder, 2026-04-02*
