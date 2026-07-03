# ES-090 — Security & Production Readiness Remediation

> **Author:** SpecMaster (agent 2)
> **Upstream TS:** `geo/docs/specs/technical/TS-090-security-production-readiness-remediation.md`
> **Input artifact (superseded):** `docs/specs/engineering/ES-100-security-audit-remediation.md` on branch `fix/security-audit-remediation` (Rao, commit 07917a2)
> **Main HEAD verified against:** `70645cbae6f3fcd09add526c215cdef7979f715b`
> **Spec authoring date:** 2026-04-15
> **Target score after remediation:** 8.5/10 (from 6.2/10)

---

## a. Overview

### Component / feature

Cross-cutting security & production-readiness hardening across `geo/` Next.js app. Twelve discrete fixes grouped into three risk classes, plus a hygiene bundle:

- **Class A — Critical:** CRIT-1 token expiry, CRIT-2 stored-XSS sanitization, CRIT-3 citation-check rate-limit, CRIT-4 sites-POST rate-limit, L-1 `.env*` hygiene, L-2 CSP.
- **Class B — Medium:** MED-2 host-header fallback removal, MED-3 OTP atomic increment, MED-4 tokens → HttpOnly cookies, MED-5 cluster-safe reextraction counter, MED-6 raw token in email → exchange-code.
- **Class C — Observability & compliance:** OBS-1 Sentry + `/api/health`, COMP-1 DPDP right-to-erasure, COMP-2 IP hashing, hygiene bundle (apify/mongo removal, puppeteer lazy-load, stray console.log).

### Source technical spec

- TS-090 §5 Fix inventory is the ground truth for each remediation. ES-090 converts every TS-090 acceptance criterion (17) into engineering-grade testable ACs (23 total — 17 direct + 6 cross-cutting for unit/integration/load/logging/rollout).

### Current implementation state (verified against main @ 70645cba on 2026-04-15)

| Concern | Verified file / line | Status |
|---|---|---|
| `geoSites.accessToken` write | `app/api/sites/[id]/verify/route.ts:321` | Exists — no expiry column |
| `geoSites.accessToken` enforcement sites | `sites/[id]/route.ts:26`, `regenerate/route.ts:29`, `citation-check/route.ts:83`, `competitor-discovery/route.ts:28` | Equality-only; no expiry check |
| `renderMd` XSS surface | `app/components/citation-monitor.tsx:10` defined, consumed at lines `156,279,310,341` | 4 `dangerouslySetInnerHTML` call sites — escape-only, no sanitization |
| citation-check rate-limit | `app/api/sites/[id]/citation-check/route.ts` auth at :83 | No `checkRateLimit` call exists |
| sites-POST rate-limit | `app/api/sites/route.ts` POST at :47, IP at :49, bulk branch :54-55 | `checkRateLimit` imported unused |
| CSP | `middleware.ts:98-106` `SECURITY_HEADERS` | 7 headers; no `Content-Security-Policy` |
| `.env*` tracked files | repo root | `.env.vercel-prod` etc. tracked; `.gitignore` does not block them |
| Host-header fallback | `app/api/pipeline/stage/route.ts:1124-1127` | `req.headers.get("host")` third fallback |
| OTP race | `lib/rate-limit.ts:51-89` `checkAndIncrementOtpAttempt` | SELECT-then-UPDATE pattern |
| Session tokens in body | `app/api/sites/[id]/verify/route.ts:550-556` | JSON returns `accessToken`, `authOtp`, `exchangeCode` |
| `activeReextractions` | `app/api/sites/[id]/citation-check/route.ts:51-52`, test shim :57-62 | Module-global `let`; cap 3; not cluster-safe |
| Raw token in completion email | `app/api/pipeline/stage/route.ts:1093-1100` | `sendCompletionEmail(…, completedSite.accessToken, …)` |
| Observability | — | No Sentry, no `/api/health`, `console.warn/error` only |
| DPDP erasure | — | No `DELETE /api/account` route |
| Raw IPs | `geo_crawl_logs.ip`, `geo_page_views.ip` | Stored indefinitely |

### Out of scope (carried from TS-090 §9)

- ES-087 UX overhaul (separate branch).
- MED-1 admin-auth bypass — `lib/pipeline-studio/admin-auth.ts` does not exist on main (re-verified 2026-04-15).
- `app/components/commerce-report/*` — directory does not exist on main.
- Secret rotation for values already in git history (operational task for Aditya).
- Sequencing by hiring milestone (dropped; risk class is the axis).

### PR strategy

This spec permits **multiple PRs gated by class**, but ReviewMaster regression gate must stay green across all PRs until the full set lands. Recommended slicing:

1. **PR #1 (Class A minus CRIT-2):** CRIT-1, CRIT-3, CRIT-4, L-2, L-1 — small additive schema + rate-limit wiring.
2. **PR #2 (CRIT-2 alone):** dompurify install + sanitize-html helper + 4 site edits. Isolated so CSP tuning in PR #1 does not hide sanitizer regressions.
3. **PR #3 (Class B):** MED-2, MED-3, MED-5 first (low surface); MED-4 + MED-6 each in their own PR (higher blast radius — both touch onboarding / email delivery).
4. **PR #4 (Class C):** OBS-1 Sentry + `/api/health`, COMP-1 account-delete, COMP-2 IP-hash migration, hygiene bundle.

---

## b. Implementation Requirements

### b.1 Schema migration

**File:** `lib/db/schema.ts` + new migration via `npx drizzle-kit push`.

**Additive columns on `geoSites`:**

```ts
// CRIT-1 — NOT NULL with DEFAULT so new rows always have an expiry even if
// the writer forgets. Backfill (below) satisfies existing rows. HP-196/HP-197:
// this closes the "NULL = valid forever" class of bugs at the column level.
tokenExpiresAt: timestamp("token_expires_at")
  .notNull()
  .default(sql`NOW() + INTERVAL '90 days'`),
tokenRotatedAt: timestamp("token_rotated_at"),         // nullable — rotate writes it, fresh rows don't need it
```

**Additive mirror column on `geoSiteView`** (read-optimized view layer; **Amendment 3, Aditya-accepted 2026-04-15**):

```ts
// Mirror of geoSites.tokenExpiresAt on the read-side view. GET /api/sites/[id]
// reads from geoSiteView (NOT geoSites base table); without this mirror, the
// HP-197 NULL-as-expired check at sites/[id]/route.ts:26 would see `undefined`
// for every request → fail-close → 401 TOKEN_EXPIRED on every authenticated
// call. Nullable on the view is fine: HP-197 semantics treat NULL as expired,
// which covers the narrow window where the mirror lags the base table.
tokenExpiresAt: timestamp("token_expires_at"),         // nullable mirror
```

Corresponding SQL in the migration file (parallel to the `geoSites` column addition):

```sql
ALTER TABLE geo_site_view
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMP;
```

**Propagation — `lib/services/site-view-sync.ts`:** both the full-sync and lightweight-sync code paths must copy `tokenExpiresAt` from `geoSites` to `geoSiteView` whenever either runs. ScriptDev's commit `ed94785` demonstrates the pattern; re-use it verbatim. Any new sync path added in the future must also carry the field, or the fail-close at the enforcement site will manifest as a silent 401 storm.

> **Rationale for treating this as spec-grade, not just impl detail:** the read-from-view design is load-bearing across the codebase — downstream call sites at the 4 enforcement routes already consume the view result. If a future refactor adds another sync path without copying the column, every authenticated request flips to 401. Locking this into §b.1 closes the regression surface.

**Additive columns on `geo_crawl_logs`** (via Drizzle schema file for that table, same migration):

```ts
ipHash: text("ip_hash"),                               // COMP-2
```

**Additive columns on `geo_page_views`:**

```ts
ipHash: text("ip_hash"),                               // COMP-2
```

> `raw ip` column is **retained** in this migration; drop-column is a follow-up TS after backfill completes + one-week safety window (TS-090 §5 COMP-2).

**New table `admin_audit_log`** (for COMP-1):

```ts
export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: text("action").notNull(),                    // e.g. "account_deletion"
  actorEmail: text("actor_email"),
  payload: jsonb("payload"),                           // { teamIds: [...], geoSiteIds: [...] }
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

**New table `exchange_codes`** (for MED-6, added per HP-186 — DB-backed one-time redemption; supersedes stateless JWT for new call sites):

```ts
export const exchangeCodes = pgTable("exchange_codes", {
  code: text("code").primaryKey(),                     // 32-char nanoid; URL-safe
  email: text("email").notNull(),                      // denormalized; indexed for DPDP erasure (no users-table FK target in schema)
  siteId: text("site_id").references(() => geoSites.id, { onDelete: "cascade" }), // nullable — site-scoped codes cascade; auth-only codes don't
  payload: jsonb("payload").notNull(),                 // { accessToken?, supabaseAccessToken?, supabaseRefreshToken?, redirect? }
  createdAt: timestamp("created_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at").notNull(),        // issue-time + ttlSeconds
  redeemedAt: timestamp("redeemed_at"),                // null until first successful redeem; atomic UPDATE sets this
  redeemedByIpHash: text("redeemed_by_ip_hash"),       // hashed per COMP-2 at redeem time
}, (t) => ({
  emailIdx: index("exchange_codes_email_idx").on(t.email),
  expiresIdx: index("exchange_codes_expires_idx").on(t.expiresAt),
}));
```

> No FK on `email` — there is no canonical users table in the app schema (see HP-186 rationale). `team_members.email` / `geo_sites.ownerEmail` are plain text; `auth.users` is Supabase's separate schema (no cross-schema FK). Email integrity is enforced at redemption time via proof-of-email, not at write time.

**Backfill on migration apply (one-time, in-migration SQL or a migration-adjacent script):**

```sql
UPDATE geo_sites
  SET token_expires_at = NOW() + INTERVAL '90 days',
      token_rotated_at = COALESCE(token_rotated_at, NOW())
  WHERE access_token IS NOT NULL AND token_expires_at IS NULL;

-- HP-233: Defensive — rows without access_token must also get non-NULL
-- expiry before the NOT NULL promotion. The first UPDATE handles the common
-- case (rows with access_token); this second UPDATE catches any remainder
-- (unverified rows, lead rows, etc.) so ALTER COLUMN ... SET NOT NULL finds
-- zero nulls.
UPDATE geo_sites
  SET token_expires_at = NOW() + INTERVAL '90 days'
  WHERE token_expires_at IS NULL;
```

> The `NOT NULL` promotion that follows (`ALTER COLUMN ... SET NOT NULL` — see §b.1 column definition) requires zero NULL values in the column. The two UPDATEs above guarantee that precondition. ScriptDev's migration already implements this pattern; the spec is updated here for parity.

### b.2 CRIT-1 — Token expiry + rotation

**Edits:**

1. `lib/db/schema.ts` — add columns per §b.1.
2. `app/api/sites/[id]/verify/route.ts:~321` and `:~306` — when writing `accessToken`, also write:
   ```ts
   tokenExpiresAt: new Date(Date.now() + 90 * 86_400_000),
   tokenRotatedAt: new Date(),
   ```

   **Re-login path (HP-224, CRITICAL — PR#1 merge blocker):** the two write paths above cover the fresh-verify case (`site.emailVerified === false`). The **already-verified** re-login path (`site.emailVerified === true`) in the same route today returns the EXISTING `accessToken` verbatim without considering expiry. After CRIT-1 ships that behavior locks a user out past day 90: their stored token is expired at every enforcement site (§b.2 step 3), regenerate's own CRIT-1 check rejects them (they can't call it with an expired bearer), and no other OTP-gated recovery path exists.

   **Security precondition — OTP verification REQUIRED before rotation (HP-237, CRITICAL — PR#1 merge blocker):** the re-login branch is reachable via `POST /api/sites/[id]/verify`, which sits in `middleware.ts` ALWAYS_ALLOWED (no session, no CSRF). On the main-branch code at `70645cba`, the `emailVerified === true` branch checks only `code.length === 6` — it does **not** invoke `verifyCode()`. Pre-HP-224 this was a passive-impersonation bypass (attacker with the siteId could POST any 6-char code and receive the stored `accessToken`). **Post-HP-224, the same bypass becomes active DoS + token theft** because the rotation fires on the attacker's call: legitimate user's cookie is silently invalidated and the attacker walks away with the new token.

   Before any expiry-check + rotation in the re-login branch, the handler MUST verify **all four** of:
   (a) `site.verificationCode` is set — a fresh OTP has been issued in the current auth flow.
   (b) `site.codeExpiresAt > new Date()` — the issued OTP has not expired.
   (c) `verifyCode(code, site.verificationCode)` returns true — the submitted `code` matches the stored code (constant-time compare inside `verifyCode`).
   (d) Brute-force lockout is not in effect — the route MUST reject when `otpLockedUntil > new Date()`, using the same threshold / window as fresh-verify.

   Failure in any of conditions (a)–(d) returns `401 { error: "Invalid or expired code" }` — **generic message**, do NOT distinguish "no OTP sent" vs "wrong code" vs "expired" vs "locked" in the response body, or the attacker can probe state to find a valid window to focus brute-force attempts.

   Only after all four conditions hold may the handler invoke `rotateIfExpired(site)` / the fresh-verify+rotate logic below.

   > **Split OTP-gate primitives (HP-239 resolution — CRITICAL):** the pre-amendment §b.9 primitive `checkAndIncrementOtpAttempt` conflates **lockout-read** and **attempt-increment** into a single atomic call. Running that combined primitive on every re-login POST creates a pure-DoS vector: an attacker with only the siteId POSTs `{code:"000000"}` five times and — because the atomic primitive increments unconditionally on every unlocked call — trips `otpLockedUntil` for 15 min without ever presenting a pending OTP. The real owner's legitimate recovery POST is then blocked during the lockout window, replayable indefinitely at 5 POSTs per 15-min cycle per site.
   >
   > **Fix — split the primitive into two pure operations**, used by both the re-login branch AND the fresh-verify path (symmetrically):
   >
   > - **`checkOtpLock(siteId) → { allowed: boolean; lockedUntil?: Date }`** — pure read. One DB SELECT against `geoSites.otpLockedUntil`. Returns `allowed: false` if `otpLockedUntil > new Date()`. **NO WRITE.** Safe to call before verifying any condition.
   > - **`incrementOtpAttempt(siteId) → { lockedOut: boolean }`** — pure write. One DB UPDATE that increments `otpAttempts`; if the threshold is reached, the same UPDATE sets `otpLockedUntil = now + 15min` and returns `lockedOut: true`. Caller MUST only invoke this on a `verifyCode` failure — i.e. condition (c) failed. Never on (a) / (b) / (d) failures.
   >
   > **Canonical 4-condition gate order (invariant):**
   >   1. `checkOtpLock(siteId)` — if `!allowed`, return 401 generic. **No further DB work.** Satisfies (d).
   >   2. Condition (a): `site.verificationCode` is non-NULL — if NULL, return 401 generic. **No `incrementOtpAttempt`.**
   >   3. Condition (b): `site.codeExpiresAt > new Date()` — if expired, return 401 generic. **No `incrementOtpAttempt`.**
   >   4. Condition (c): `verifyCode(code, site.verificationCode)` — if false, call `incrementOtpAttempt(siteId)` **exactly once**, then return 401 generic.
   >   5. On (c) success — call `clearOtpAttempts(siteId)` to reset the counter; proceed to rotation.
   >
   > **Invariant:** `otpAttempts` only ever increments when `verifyCode` actually ran and returned false. An attacker without a pending OTP (condition a fails) or with an expired OTP (condition b fails) or on a pre-locked row (condition d fails) **cannot inflate the counter**. This closes the HP-239 DoS vector at the primitive level — no amount of future refactoring inside the handler can re-introduce it, because the increment path is topologically unreachable from the (a)/(b)/(d) branches.
   >
   > **Symmetry requirement:** the fresh-verify path MUST migrate to the same split primitives via the same `assertOtpGate(site, code)` helper. Both branches call the helper; the helper encapsulates the canonical order above. Any test for fresh-verify that previously asserted `checkAndIncrementOtpAttempt` was invoked must be updated to assert the split sequence instead.
   >
   > **Legacy helper:** `checkAndIncrementOtpAttempt` may remain exported from `lib/rate-limit.ts` as a thin wrapper over the split primitives for any **non-verify** call site that legitimately wants the combined semantics (none exist on main @ `70645cba`, but third-party hooks could rely on it). Neither the re-login nor the fresh-verify branch calls it directly — both go through `assertOtpGate`, which uses the split primitives in the canonical order. A spec-level regression test MUST grep the verify-route file and fail if a direct `checkAndIncrementOtpAttempt(` call string appears there.
   >
   > **Test-side implication (§c.1 invariants):** U2e-bf / U2f-bf / U2h-bf must structurally assert that `incrementOtpAttempt` was **not** called — not merely that rotation was blocked. U2g-bf must assert `incrementOtpAttempt` was called exactly once. This change is already reflected in the amended table below.

   > **Gate positioning — forward-drift forbidden (HP-241):** `assertOtpGate` MUST run at the **top** of the `site.emailVerified === true` branch, **before any DB mutation** — including but not limited to consent INSERT, rotation, team-link assignment, exchange-code generation, `emailVerified`/`updatedAt` writes, and any other write. A future refactor adding pre-rotation side-effects to this branch MUST place them AFTER `assertOtpGate` returns success. A code reviewer MUST reject any PR that adds a DB write in the re-login branch before `assertOtpGate`.
   >
   > **Rationale:** an attacker without a valid OTP could POST `{code:"000000", tosAccepted:true}` and, if a future reorder places consent-INSERT (or any other side-effect write) before the gate, force-insert a consent record bearing the real owner's userId without OTP proof. The rotation itself would still be blocked (the gate catches it), but the consent audit log integrity is compromised. Pinning the gate at the top of the branch forecloses that drift class.

   > **Reuse of existing code — IMPORTANT:** the fresh-verify path at `app/api/sites/[id]/verify/route.ts` **already** calls `verifyCode()` (line 192) + the legacy combined `checkAndIncrementOtpAttempt` path (line 204). The HP-237 + HP-239 fix is **not** a new primitive; it is extending the existing pattern to also cover the `emailVerified === true` branch, AND migrating both branches to the split primitives. Do NOT inline a second copy of the OTP-check logic — extract the 4-step gate into the `assertOtpGate(site, code) → void | throws` helper and call it from both branches.

   **Fix — treat verify as rotation for the re-login path (after OTP gate above):** in the `emailVerified === true` branch, AFTER the OTP precondition passes, inspect `site.tokenExpiresAt`:
   - **NULL or `< new Date()`** → ROTATE. Generate `accessToken = nanoid(32)`, write `tokenExpiresAt: new Date(Date.now() + 90 * 86_400_000)`, `tokenRotatedAt: new Date()`. Return the NEW token in the JSON response body (replaces today's verbatim echo at the two re-login return sites — the current code paths that return the stored `site.accessToken` without rewriting it).
   - **Still valid (`site.tokenExpiresAt >= new Date()`)** → return the existing `site.accessToken` unchanged. Preserves today's fast-path for legitimate recent re-logins (cookie lost, different device, etc.). No rotation when not needed.

   **Security model after HP-237:** re-login rotation is gated by the same trust evidence fresh-verify requires — possession of the OTP + mailbox control. An attacker with only the siteId (leaked via URL, referrer header, server log, sharing) cannot trigger rotation, because rotation is gated on OTP possession. This preserves HP-224's self-recovery semantics (users past day 90 can recover via fresh OTP) while closing the auth-bypass surface HP-237 identified.

   **Implementation note for ScriptDev:** the re-login path currently lives alongside the fresh-verify write path in the verify route (the two are branched on `site.emailVerified`). Insert the OTP precondition + expiry-check + rotation as a single ordered block inside the re-login branch, reusing both the `assertOtpGate` helper (§b.2 step 2 above) and the 90-day interval constant used at the fresh-verify write so drift is impossible. If a `rotateAccessToken(siteId)` helper has already been extracted during PR#1, re-use it here.

   **Tests required (landed in §c.1 as U2a/U2b/U2c/U2e-bf/U2f-bf/U2g-bf/U2h-bf/U2i):** re-login with expired token + valid OTP rotates + returns new token; re-login with valid token + valid OTP returns existing token unchanged; re-login with NULL `tokenExpiresAt` + valid OTP rotates; re-login with NO pending OTP → 401 no rotation; re-login with expired OTP → 401 no rotation; re-login with wrong OTP → 401 + `otpAttempts` incremented + no rotation; re-login past `otpAttempts` threshold → 401 per `otpLockedUntil` freeze + no rotation; re-login happy path with OTP gate fully satisfied → rotate.

3. Four enforcement sites — insert expiry check **after** the equality check. **HP-197: treat NULL as expired (not as valid)** — if any write path forgets to populate `tokenExpiresAt`, the row fails closed, not open:
   - `app/api/sites/[id]/route.ts:26` — after `if (site.accessToken !== token) return 401`, add:
     ```ts
     if (!site.tokenExpiresAt || site.tokenExpiresAt < new Date()) {
       return NextResponse.json({ error: "Unauthorized", code: "TOKEN_EXPIRED" }, { status: 401 });
     }
     ```
     Combined with the NOT NULL column default (§b.1), this is belt-and-suspenders: database enforces non-null; code treats NULL as expired anyway.
   - `app/api/sites/[id]/regenerate/route.ts:29` — same insertion.
   - `app/api/sites/[id]/citation-check/route.ts:83` — same insertion.
   - `app/api/sites/[id]/competitor-discovery/route.ts:28` — same insertion.

   > **Forward reference (HP-191):** the `token` variable at each of these 4 sites is extracted today via `req.headers.get("authorization")?.replace("Bearer ", "") ?? req.nextUrl.searchParams.get("token")` (verified against main @ `70645cba`). That extraction does NOT include the `flowblinq_site_token` cookie. CRIT-1's PR #1 leaves the extraction unchanged (existing clients work). **§b.10 (MED-4, PR #3) replaces the extraction at all 4 sites with a precedence chain that adds cookie support.** Do not duplicate the cookie-read logic in the CRIT-1 PR — ship it in the MED-4 PR to avoid merge conflicts.
4. `app/api/sites/[id]/regenerate/route.ts` — extend the regenerate action to rotate:
   ```ts
   const nextToken = nanoid(32);
   await db.update(geoSites)
     .set({
       accessToken: nextToken,
       tokenExpiresAt: new Date(Date.now() + 90 * 86_400_000),
       tokenRotatedAt: new Date(),
     })
     .where(eq(geoSites.id, id));
   ```

**Contract:** 401 body shape `{ error: "Unauthorized", code: "TOKEN_EXPIRED" }` is new but additive — existing clients already treat all 401 as "unauthorized".

### b.3 CRIT-2 — Stored-XSS sanitization

**New dependencies:**

```bash
npm install dompurify @types/dompurify jsdom
```

> `jsdom` needed because DOMPurify runs server-side in some Next pathways (RSC prerender); client-side uses `window` directly.

**New file — `lib/utils/sanitize-html.ts`:**

```ts
import DOMPurify from "dompurify";

const isServer = typeof window === "undefined";

let purify: DOMPurify.DOMPurifyI;
if (isServer) {
  const { JSDOM } = require("jsdom") as typeof import("jsdom");
  const jsdomWindow = new JSDOM("").window as unknown as Window;
  purify = DOMPurify(jsdomWindow);
} else {
  purify = DOMPurify;
}

const CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "a", "code", "br", "p", "ul", "ol", "li"],
  ALLOWED_ATTR: ["href", "title", "target", "rel"],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
  FORBID_TAGS: ["script", "iframe", "style", "object", "embed", "link", "meta"],
  FORBID_ATTR: [
    "onload", "onerror", "onclick", "onfocus", "onmouseover",
    "onmouseenter", "onmouseleave", "onanimationstart", "onkeydown", "onkeyup",
  ],
  RETURN_TRUSTED_TYPE: false,
};

export function sanitizeMarkdown(html: string): string {
  return purify.sanitize(html, CONFIG) as unknown as string;
}
```

**Edits — `app/components/citation-monitor.tsx`:**

- Import: `import { sanitizeMarkdown } from "@/lib/utils/sanitize-html";`
- Lines 156, 279, 310, 341 — wrap `renderMd(...)` output:
  ```tsx
  dangerouslySetInnerHTML={{ __html: sanitizeMarkdown(renderMd(...)) }}
  ```

**Do not** remove `renderMd` itself — it performs markdown-to-inline-HTML transform that the sanitizer then scrubs. The combination is: `escape → renderMd → sanitize`.

### b.4 CRIT-3 — Citation-check rate limit

**Edit — `app/api/sites/[id]/citation-check/route.ts:83+` (immediately after the `if (site.accessToken !== token)` check and the new expiry check from §b.2):**

```ts
const rl = await checkRateLimit(`citation_check:${siteId}`, 1, 30_000);
if (!rl.allowed) {
  return NextResponse.json(
    { error: "Too Many Requests", retryAfterMs: rl.resetAt - Date.now() },
    { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
  );
}
```

> Key convention `citation_check:${siteId}` matches the `<domain>:<id>` pattern used in `app/api/chatbot/route.ts:51` and `app/api/auth/otp/send/route.ts:25`. Do **not** key by IP — legitimate multi-device use must not share a bucket.

### b.5 CRIT-4 — Sites POST rate limit

**Edit — `app/api/sites/route.ts`:**

Insert **after** the `if (bulkUrls !== undefined) { … return … }` block but **before** any single-audit handling:

```ts
const rl = await checkRateLimit(`sites_create:${ip}`, 10, 60_000);
if (!rl.allowed) {
  return NextResponse.json(
    { error: "Too Many Requests", retryAfterMs: rl.resetAt - Date.now() },
    { status: 429, headers: { "Retry-After": String(Math.ceil((rl.resetAt - Date.now()) / 1000)) } },
  );
}
```

> Bulk path remains unguarded (credit-gated per comment at line 54-55). Must verify bulk branch returns **before** this rate-limit call in every path (the `if (bulkUrls !== undefined)` block already returns).

### b.6 L-1 — `.env*` hygiene

**Edits:**

1. `.gitignore` — append:
   ```
   # Security: never track .env files (see ES-090 L-1)
   .env
   .env.*
   !.env.example
   !.env.local.supabase
   ```
2. `git rm --cached .env.vercel-prod .env.<others>` — run via a scripted `scripts/migrations/es-090-env-scrub.sh` that enumerates matches from `git ls-files '.env*'` excluding the allow-list.
3. `.husky/pre-commit` (create if absent) — reject staged `.env*`. Regex **must anchor at path boundary** (amended per HP-204, 2026-04-15) so subdirectory env files in the monorepo (`geo/.env.test`, a future `admin/.env`) are caught too:
   ```bash
   #!/usr/bin/env bash
   # HP-204: (^|/) anchors to path boundary, not just repo root, so
   # staged "geo/.env.test" or "admin/.env.production" is caught.
   staged_env=$(git diff --cached --name-only | grep -E '(^|/)\.env(\..+)?$' | grep -Ev '(^|/)\.env\.(example|local\.supabase)$' || true)
   if [ -n "$staged_env" ]; then
     echo "[pre-commit] Rejecting tracked .env file(s):"
     echo "$staged_env"
     exit 1
   fi
   ```
4. Add `"prepare": "husky install"` to `package.json` scripts if husky not already wired.

> History scrubbing (BFG / filter-branch) is **explicitly out of scope** per TS-090 §5 L-1.

### b.7 L-2 — Content-Security-Policy (amended per HP-190, 2026-04-15)

**Architectural context (HP-190):** the original spec sent `Content-Security-Policy-Report-Only` without any `report-to` or `report-uri` directive. Browsers would fire `securitypolicyviolation` DOM events client-side but send **no HTTP report** to any endpoint. The 7-day observation window would collect zero data; the G5 flip-to-enforcing decision would be made blind.

**Amendment:** add a reporting path — both `Reporting-Endpoints` (modern browsers) and `report-uri` (older browsers) — pointing at a new `/api/csp-report` route we own. Owning the endpoint (rather than pointing `report-uri` directly at Sentry's ingestion URL) lets us scrub PII out of `document-uri` / `blocked-uri` fields before forwarding to Sentry — matters for AC-22 PII-safe telemetry (see HP-194 when addressed; CSP reports are sent by the browser directly, bypassing Sentry SDK's `beforeSend` scrubber, so we need server-side scrubbing).

**Edit — `middleware.ts:98-106`:**

```ts
// HP-192: nonce-based CSP — replaces permissive 'unsafe-inline'/'unsafe-eval'
// with a per-request nonce + 'strict-dynamic'. Inline scripts without the
// nonce are blocked (closes the stored-XSS-via-inline vector CRIT-2 defends).
// 'strict-dynamic' lets nonced scripts load additional scripts by script-node,
// which is how Next.js hydration bootstraps.
import { randomBytes } from "crypto";

// Inside middleware(req): generate per-request nonce + pass to downstream
// via a request header that Next.js hydration reads. See companion
// app/layout.tsx / _document.tsx edits below.
const nonce = randomBytes(16).toString("base64");

const CSP_DIRECTIVES = [
  "default-src 'self'",
  // HP-192: the nonce + strict-dynamic combination is the production-grade
  // script policy Google/Chromium recommend. Keep 'unsafe-inline' as a
  // fallback for browsers that don't honor strict-dynamic (older Safari);
  // strict-dynamic in presence of a nonce tells modern browsers to IGNORE
  // 'unsafe-inline', so the fallback is free in compliant browsers.
  `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' https:`,
  // HP-192: 'unsafe-eval' removed. If any library breaks in prod (rare;
  // Next.js build output generally doesn't use eval), surface via CSP
  // violation reports (HP-190 endpoint) rather than re-allowing eval.
  "connect-src 'self' *.supabase.co *.upstash.io *.sentry.io https://api.stripe.com https://*.ingest.sentry.io",
  "img-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",  // Tailwind uses inline styles pervasively; keeping relaxed for styles only
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // ES-090 HP-190 — browsers report violations here. Both directives
  // because browser support is split: Chrome/Edge use report-to (newer),
  // Firefox/older Safari fall back to report-uri (legacy).
  "report-to csp-endpoint",
  "report-uri /api/csp-report",
].join("; ");

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Permitted-Cross-Domain-Policies": "none",
  // ES-090 HP-190 — wire the report-to endpoint name to its URL.
  "Reporting-Endpoints": `csp-endpoint="/api/csp-report"`,
  // ES-090 L-2 — start in Report-Only mode per TS-090 §8 rollout mitigation.
  "Content-Security-Policy-Report-Only": CSP_DIRECTIVES,
};
```

**New route — `app/api/csp-report/route.ts`:**

```ts
import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";

// Browsers POST CSP violation reports as application/csp-report or
// application/reports+json (report-to). Receive both.
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse(null, { status: 204 }); // malformed — accept silently
  }

  // Normalize: report-uri sends { "csp-report": {...} }; report-to sends [{ type, body: {...} }, ...]
  const reports: Record<string, unknown>[] = Array.isArray(body)
    ? body.filter((r: any) => r?.type === "csp-violation").map((r: any) => r.body ?? {})
    : body && typeof body === "object" && "csp-report" in (body as any)
      ? [(body as any)["csp-report"]]
      : [];

  for (const r of reports) {
    // PII scrubbing (HP-190 + AC-22): strip query strings from any URL field
    // because document-uri / blocked-uri / referrer can embed tokens or emails.
    const scrub = (url: unknown) =>
      typeof url === "string" ? url.split("?")[0].split("#")[0] : url;
    const scrubbed = {
      ...r,
      "document-uri": scrub(r["document-uri"]),
      "blocked-uri": scrub(r["blocked-uri"]),
      referrer: scrub(r.referrer),
    };

    Sentry.captureMessage("CSP violation", {
      level: "warning",
      tags: {
        directive: String(r["violated-directive"] ?? "unknown"),
        disposition: String(r.disposition ?? "report"),
      },
      contexts: { csp: scrubbed },
    });
  }

  return new NextResponse(null, { status: 204 });
}
```

**Edit — `middleware.ts`:** add `/^\/api\/csp-report$/` to the `ALWAYS_ALLOWED` list. Browsers POST reports without credentials; the route is otherwise safe because it only writes to Sentry via captureMessage.

**Rate-limit guard** (same file): `checkRateLimit("csp_report:" + (req.headers.get("x-forwarded-for")?.split(",")[0] ?? "unknown"), 100, 60_000)` — prevents a hostile browser or attacker from flooding Sentry. 100/min per IP is generous for legitimate report volume.

**Nonce propagation (HP-192 — required for nonce-based CSP to work with Next.js):**

Middleware passes the per-request nonce to the app via a request header; Next.js layout reads it and stamps it on `<Script>`, `<script>`, and `<Script nonce={nonce}>` tags. Pattern:

```ts
// middleware.ts — after generating `nonce` above
req.headers.set("x-csp-nonce", nonce);
const supabaseRes = await updateSession(req);
supabaseRes.headers.set("Content-Security-Policy-Report-Only", CSP_DIRECTIVES);
// ... existing ALWAYS_ALLOWED match returns the response
```

```tsx
// app/layout.tsx — read the nonce and forward to Next.js Script components
import { headers } from "next/headers";
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get("x-csp-nonce") ?? undefined;
  return (
    <html>
      <body>
        {children}
        {/* Any <Script> tags inline or via next/script must pass nonce={nonce} */}
      </body>
    </html>
  );
}
```

ScriptDev verifies, in the CSP rollout PR, that all `<Script>` usages and inline `<script>` tags in app/ and components/ either (a) pass `nonce={nonce}` via prop, or (b) get their nonce from `next/document`'s `_document.tsx` (if pages-router remnants exist). Grep for `dangerouslySetInnerHTML.*script` and `<script>` literal — each match should be reviewed.

> **Rollout gate:** ship as `Content-Security-Policy-Report-Only` first with the nonce-based policy. After one week of Sentry CSP violation reports AND **non-zero report volume confirmed in Sentry** (the HP-190 gate), AND zero unexplained blocks on dashboard/results/verify/auth pages, rename the header to `Content-Security-Policy` (enforcing). AC-6 (§h) requires the Report-Only deploy, confirmation of report volume, **and** a follow-up commit that flips to enforcing; ReviewMaster verifies the flip commit only after the safety window AND after confirming report data actually flowed. Expect more violation reports than with the permissive draft — that's the point; the nonce policy will surface every currently-tolerated inline script so ScriptDev can decide (nonce-it OR remove-it).

### b.8 MED-2 — Remove host-header fallback

**Edit — `app/api/pipeline/stage/route.ts:1122-1127`:**

```ts
const baseUrl = process.env.PIPELINE_CALLBACK_URL ?? process.env.NEXT_PUBLIC_APP_URL;
if (!baseUrl) {
  console.error("[stage:verifyAuth] PIPELINE_CALLBACK_URL and NEXT_PUBLIC_APP_URL both unset — failing closed");
  return false;
}
const url = `${baseUrl}/api/pipeline/stage`;
```

**Startup warning (amended per HP-200, 2026-04-15)** — `lib/config/assert-env.ts` (new, imported once at app bootstrap via `instrumentation.ts`). **Original spec threw on missing env; HP-200 flagged this as dangerous** (one missing env var kills ALL cold starts → 100% 500 rate; request-time fail-closed at `verifyAuth` already exists and is more surgical). Amendment: log a warning/Sentry breadcrumb at boot; do NOT throw. The request-time check above continues to be the authoritative fail-closed.

```ts
import * as Sentry from "@sentry/nextjs";

export function warnIfProductionEnvMissing() {
  if (process.env.NODE_ENV !== "production") return;
  const required = ["PIPELINE_CALLBACK_URL"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    const msg = `[env-warn] missing production env vars: ${missing.join(", ")}. Request-time checks will fail closed.`;
    console.warn(msg);
    // Sentry may not be initialized yet at register() time; swallow gracefully.
    try {
      Sentry.captureMessage(msg, { level: "warning", tags: { kind: "env-misconfig" } });
    } catch {
      // deliberately swallow — we're in boot, don't crash
    }
  }
}
```

Wire into `instrumentation.ts`:

```ts
export async function register() {
  const { warnIfProductionEnvMissing } = await import("./lib/config/assert-env");
  warnIfProductionEnvMissing();
}
```

Rationale: the request-time check in `verifyAuth` (above) already returns 401 for the single misconfigured route. A boot-time throw escalates that to a site-wide outage. Log loudly, act surgically.

### b.9 MED-3 — OTP atomic increment

**Edit — `lib/rate-limit.ts:51-89` — replace `checkAndIncrementOtpAttempt` body:**

```ts
export async function checkAndIncrementOtpAttempt(
  siteId: string,
): Promise<{ allowed: boolean; attemptsLeft: number }> {
  const now = new Date();
  const lockUntil = new Date(Date.now() + 15 * 60 * 1000);

  // Atomic read-modify-write — prevents two concurrent verifies from
  // both reading attempts=4 and both succeeding.
  const [row] = await db
    .update(geoSites)
    .set({ otpAttempts: sql`${geoSites.otpAttempts} + 1` })
    .where(eq(geoSites.id, siteId))
    .returning({
      otpAttempts: geoSites.otpAttempts,
      otpLockedUntil: geoSites.otpLockedUntil,
    });

  if (!row) return { allowed: false, attemptsLeft: 0 };

  if (row.otpLockedUntil && row.otpLockedUntil > now) {
    return { allowed: false, attemptsLeft: 0 };
  }

  if (row.otpAttempts >= 5) {
    // Idempotent lockout write.
    await db.update(geoSites)
      .set({ otpLockedUntil: lockUntil })
      .where(eq(geoSites.id, siteId));
    console.warn(`[rate-limit] OTP lock applied siteId=${siteId} attempts=${row.otpAttempts}`);
    return { allowed: false, attemptsLeft: 0 };
  }

  return { allowed: true, attemptsLeft: 5 - row.otpAttempts };
}
```

> The atomic `UPDATE … SET otpAttempts = otpAttempts + 1 … RETURNING` is the serialization point. PostgreSQL guarantees row-level locking under the UPDATE so concurrent callers see strictly monotonically increasing values.

### b.10 MED-4 — Session & site tokens → HttpOnly cookies (amended per HP-188, 2026-04-15)

**Architectural context (HP-188):** the app's Supabase client is built with `@supabase/ssr`'s `createServerClient` (verified at `lib/supabase/middleware.ts:39` and `app/auth/exchange/route.ts:74`). That library does NOT read flat-named cookies like `sb-access-token` / `sb-refresh-token`. It uses structured, chunked storage keys — `sb-<PROJECT_REF>-auth-token.0`, `.1`, ... — because JSON-encoded session objects routinely exceed the 4KB per-cookie browser limit. Manually-named `sb-*` cookies would be invisible to every server-side `getSession()` call, and removing the client-side `supabase.auth.setSession(...)` (as originally specified) would eliminate the only path currently writing the canonical cookies.

**Strategy:** use Supabase SSR's `createServerClient` + cookies delegate pattern — the pattern **already in use** at `app/auth/exchange/route.ts:74-96`. Call `supabase.auth.setSession({access_token, refresh_token})` on the response object and let Supabase write its own canonically-named chunked cookies via the delegate. The custom `flowblinq_site_token` cookie (our app-level siteToken, not a Supabase session token) is set manually alongside — it's a different concern and doesn't conflict with Supabase's SSR.

**Edit — `app/api/sites/[id]/verify/route.ts:550-556` (and the consent branch at :311-317):**

Replace the JSON-body token return with two cooperating cookie writes — Supabase SSR for session, manual for siteToken:

```ts
import { createServerClient } from "@supabase/ssr";

// ... inside the success branch, AFTER Supabase `tokens` object is populated ...

const res = NextResponse.json({
  success: true,
  siteId: id,
  redirect: `/sites/${id}`,
}, { status: 200 });

// ─── ES-090 MED-4 part 1: Supabase session via SSR delegate ──────────────────
// IMPORTANT: DO NOT set "sb-access-token" / "sb-refresh-token" directly —
// @supabase/ssr uses chunked cookies (sb-<PROJECT_REF>-auth-token.0, .1, ...)
// and flat-named cookies are invisible to server-side getSession(). Let the
// SDK write its own cookies via the cookies delegate (HP-188).
if (tokens?.access_token && tokens?.refresh_token) {
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            res.cookies.set(name, value, {
              ...options,
              httpOnly: true,
              secure: true,
              sameSite: "lax",   // NOT strict — see HP-199 (email/external link navigation)
              path: "/",
            } as any);
          });
        },
      },
    }
  );

  // Replace any pre-existing session, then write the new one through the delegate.
  await supabase.auth.signOut();
  await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  });
}

// ─── ES-090 MED-4 part 2: siteToken as our own cookie ────────────────────────
// flowblinq_site_token is the app-level bearer credential for the 4 token-gated
// site routes. It is orthogonal to Supabase session and named in our own
// namespace, so manual setting is fine.
res.cookies.set("flowblinq_site_token", accessToken, {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge: 90 * 86_400, // 90 days — matches tokenExpiresAt (CRIT-1)
});

return res;
```

**Edit — `app/verify/[id]/page.tsx`:** remove client-side `supabase.auth.setSession(...)` call. On successful verify, navigate via `window.location.href = data.redirect`. Supabase cookies have already been written server-side via the SSR delegate; middleware's `updateSession(req)` on the next request will hydrate the session correctly.

**Server-side read of `flowblinq_site_token` (amended per HP-191, 2026-04-15 — closes HP-191):**

Without a cookie-read path on the server side, the HttpOnly cookie set by MED-4 is invisible to the 4 token-gated routes that check `Authorization: Bearer` or `?token=` query only — fresh MED-4-authenticated sessions would 401 on every protected route. The extraction pattern must be replaced with a precedence chain that adds cookie support.

**Extract a shared helper — `lib/auth/extract-site-token.ts`:**

```ts
import { NextRequest } from "next/server";

export function extractSiteToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (header) return header;
  const query = new URL(req.url).searchParams.get("token");
  if (query) return query;
  const cookie = req.cookies.get("flowblinq_site_token")?.value;
  if (cookie) return cookie;
  return null;
}
```

**Replace the inline extraction at all 4 sites:**
- `app/api/sites/[id]/route.ts:26` (current — `const token = req.headers.get("authorization")?.replace("Bearer ", "") ?? ...`)
- `app/api/sites/[id]/regenerate/route.ts:29` (same pattern)
- `app/api/sites/[id]/citation-check/route.ts:78` (same pattern, explicit `if (!token)` null-check already present)
- `app/api/sites/[id]/competitor-discovery/route.ts:28` (same pattern)

With:
```ts
const token = extractSiteToken(req);
if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
// existing site.accessToken !== token check follows, unchanged
// CRIT-1 tokenExpiresAt check follows (from §b.2)
```

**Precedence order rationale:** header first (API consumers / ScriptDev integration tests), query second (existing `?token=` URLs in emails or shared links — kept working for backward compatibility but phase-out is a follow-up), cookie last (post-MED-4 browsers). Cookie is last so existing clients continue working unchanged during the cookie-migration canary.

**Cookie-writer helper (amended per HP-201, 2026-04-15)** — `lib/auth/set-auth-cookies.ts`:

HP-201 flagged that §b.10's original code sample covered only the main success branch of `verify/route.ts:550-556`. The verify route has **four** token-returning branches and all four must switch to cookies, not just the main one:

- `:129-134` — early exchange-code return
- `:311-317` — `requiresConsent` branch
- `:488-496` — bulk-audit branch (returns N `siblings[].accessToken`)
- `:550-556` — main success

Extract the cookie-writing logic into a helper so all four call sites apply it identically:

```ts
import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

export async function setAuthCookies(
  req: NextRequest,
  res: NextResponse,
  opts: {
    siteToken?: string;                          // flowblinq_site_token
    supabaseAccessToken?: string;                // → Supabase SSR delegate
    supabaseRefreshToken?: string;               // → Supabase SSR delegate
  },
): Promise<void> {
  if (opts.supabaseAccessToken && opts.supabaseRefreshToken) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return req.cookies.getAll(); },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              res.cookies.set(name, value, {
                ...options, httpOnly: true, secure: true, sameSite: "lax", path: "/",
              } as any);
            });
          },
        },
      }
    );
    await supabase.auth.signOut();
    await supabase.auth.setSession({
      access_token: opts.supabaseAccessToken,
      refresh_token: opts.supabaseRefreshToken,
    });
  }
  if (opts.siteToken) {
    res.cookies.set("flowblinq_site_token", opts.siteToken, {
      httpOnly: true, secure: true, sameSite: "lax", path: "/",
      maxAge: 90 * 86_400,
    });
  }
}
```

**Apply `setAuthCookies(req, res, {...})` at all four verify branches; remove `accessToken` / `authOtp` / `tokens.access_token` / `tokens.refresh_token` from the JSON response body at each site.** The bulk branch needs one call per sibling site (loop); the main/consent/early branches need one call each.

**Verify page cleanup (amended per HP-195, 2026-04-15)** — `app/verify/[id]/page.tsx:66-91`:

Original §b.10 only removed the client-side `supabase.auth.setSession(...)` call. HP-195 flagged two additional token-leak surfaces that must be removed in the same PR:

- **Delete** line 66-68 (sessionStorage write of `geo-token-<siteId>`). The cookie path replaces persistence; sessionStorage is a redundant leak target for any XSS on `/sites/[id]`.
- **Delete** line 90 (URL-param fallback `router.replace('/sites/${siteId}?token=${accessToken}')`). Replace with a clean `router.replace('/sites/${siteId}')` — no token in the URL. URL tokens leak to browser history and Referer headers.

Exchange-code path (line 88, `window.location.href = /auth/exchange?code=...`) is preserved — the code is redeemed server-side via HP-186's DB-backed flow and does not persist in sessionStorage.

Any read-side code that depended on sessionStorage (`sessionStorage.getItem('geo-token-...')`) must be migrated to rely on the cookie in the same PR. Grep for `sessionStorage.*geo-token` before merge; zero matches expected.

**Feature-flag rollout (per TS-090 §8 risk row 1):**

```ts
const COOKIE_AUTH_ENABLED = process.env.NEXT_PUBLIC_COOKIE_AUTH === "true";
```

When flag is off: retain JSON-body token return (legacy behavior) — but sessionStorage/URL-param leaks are removed unconditionally per HP-195. When flag is on: cookies + no JSON body. Default **off** in preview; flip **on** after canary deploy confirms cookie hydration end-to-end on dashboard, checkout, team-management, and **all four verify branches** (HP-201). The flag must be off when the corresponding verify-page client change lands — flip both together.

> **`exchangeCode` field remains in body** — per TS-090 §6, that path is still a fallback.

### b.11 MED-5 — Cluster-safe reextraction counter

**Edit — `app/api/sites/[id]/citation-check/route.ts:51-62` and consumption sites :164-232:**

Replace the module-global `let activeReextractions = 0` + cap-check with Upstash-backed atomic counter.

**New file — `lib/concurrency/reextract-gate.ts`:**

```ts
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const KEY = "reextract:global";
const CAP = 3;
const LEASE_TTL_SEC = 300; // 5 min — auto-expire leaked slots

export type ReleaseFn = () => Promise<void>;

export async function tryAcquireReextractSlot(): Promise<ReleaseFn | null> {
  // Atomic INCR+EXPIRE via Lua script (HP-193): ensures the TTL is refreshed
  // on EVERY acquire (sliding TTL), not just on the 0→1 transition. Without
  // this, three slots held for ~300s each would TTL-expire mid-flight, causing
  // the key to disappear while operations continue, and new acquires would
  // start a fresh counter from 0 — up to 6 concurrent re-extractions instead
  // of the cap of 3.
  const SLIDING_ACQUIRE = `
    local next = redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
    return next
  `;
  const next = Number(await redis.eval(SLIDING_ACQUIRE, [KEY], [String(LEASE_TTL_SEC)]));
  if (next > CAP) {
    await redis.decr(KEY);
    return null;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const after = await redis.decr(KEY);
    if (after < 0) {
      // Counter drift (e.g. process crash between increment and release, or
      // TTL refresh race). Normalize to 0 and log a discrepancy breadcrumb
      // (HP-193 discrepancy-logging requirement).
      await redis.set(KEY, 0);
      if (typeof Sentry !== "undefined") {
        Sentry.addBreadcrumb({
          category: "reextract-gate",
          level: "warning",
          message: "counter drift detected; normalized to 0",
          data: { afterDecr: after },
        });
      }
    }
  };
}

// Test-only: in-memory fake for Vitest; swapped in when NODE_ENV === "test".
export const __test_internals = {
  setCount: async (n: number) => { await redis.set(KEY, n); },
  getCount: async () => Number((await redis.get<number>(KEY)) ?? 0),
};
```

**Edit — `app/api/sites/[id]/citation-check/route.ts`:**

- Delete `let activeReextractions = 0` and `MAX_CONCURRENT_REEXTRACTIONS`.
- Replace the cap-check block (:164) with:
  ```ts
  const release = await tryAcquireReextractSlot();
  if (!release) {
    console.warn(`[citation-check] reextract slot unavailable siteId=${siteId}`);
    // Proceed with empty trees per ES-086 AC-22 (reextraction is best-effort).
    treeReextractionDeferred = true;
  } else {
    try {
      // …existing reextraction work…
    } finally {
      await release();
    }
  }
  ```
- Preserve the `__test_internals` shape the existing tests import — re-export from `reextract-gate.ts`.

> **ES-086 interaction:** tree re-extraction semaphore is governed by ES-086 AC-22 (proceed with empty trees + `treeReextractionDeferred` flag). This replacement must **not** short-circuit with an early return; the saturated path still proceeds to serve results.

### b.12 MED-6 — Completion email uses exchange-code (amended per HP-186, 2026-04-15)

**Architectural context (HP-186):** existing `lib/services/exchange-code.ts` exports `generateExchangeCode(params) → string` returning a stateless 60-second JWT, consumed by four existing call sites: `verify/route.ts:114`, `verify/route.ts:538`, `consent/route.ts:115`, `auth/otp/verify/route.ts:108`. A stateless JWT is **architecturally incompatible** with AC-12's one-time redemption and 7-day TTL requirements — JWTs are inherently multi-use within their `exp` window, and a 7-day window dramatically enlarges the replay surface vs 60 seconds.

**Strategy:** introduce a **parallel DB-backed API** (`createExchangeCode` / `redeemExchangeCode`) used exclusively by the completion-email flow. The legacy `generateExchangeCode` / `jwtVerify` path stays untouched — no rename, no return-shape change, no call-site migration in ES-090 scope. Migrating the 4 legacy call sites to the DB-backed API is explicit **out of scope** and tracked separately as follow-up TS.

**New API — `lib/services/exchange-code.ts` (additive; legacy functions preserved):**

```ts
// NEW — DB-backed, one-time-redeemable. Used by completion-email flow (MED-6).
export async function createExchangeCode(opts: {
  email: string;                  // required — who the code was issued to
  siteId?: string;                // nullable — present when the code unlocks a specific site
  payload: {
    accessToken?: string;
    supabaseAccessToken?: string;
    supabaseRefreshToken?: string;
    redirect?: string;
  };
  ttlSeconds: number;             // required — no silent default; caller picks
}): Promise<{ code: string; expiresAt: Date }> {
  const code = nanoid(32);
  const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);
  await db.insert(exchangeCodes).values({
    code,
    email: opts.email,
    siteId: opts.siteId ?? null,
    payload: opts.payload,
    expiresAt,
  });
  return { code, expiresAt };
}

// NEW — atomic one-time redeem. Returns payload only on first success.
export async function redeemExchangeCode(
  code: string,
  proofOfEmail: { source: "supabase-session" | "active-otp"; email: string } | null,
  ipHash: string | null,
): Promise<
  | { ok: true; payload: ExchangeCodePayload; email: string; siteId: string | null }
  | { ok: false; reason: "not-found" | "expired" | "already-redeemed" | "proof-mismatch" }
> {
  // Atomic: lookup + mark redeemed in a single UPDATE with RETURNING.
  const [row] = await db
    .update(exchangeCodes)
    .set({ redeemedAt: new Date(), redeemedByIpHash: ipHash })
    .where(
      and(
        eq(exchangeCodes.code, code),
        isNull(exchangeCodes.redeemedAt),
        gt(exchangeCodes.expiresAt, new Date()),
      ),
    )
    .returning();

  if (!row) {
    // Distinguish not-found vs expired vs already-redeemed for observability (not surfaced to caller via 4xx code — all map to generic 401 externally).
    const [existing] = await db.select().from(exchangeCodes).where(eq(exchangeCodes.code, code));
    if (!existing) return { ok: false, reason: "not-found" };
    if (existing.redeemedAt) return { ok: false, reason: "already-redeemed" };
    return { ok: false, reason: "expired" };
  }

  // Proof-of-email check (HP-186 + HP-202 mitigation): reject if the redeeming request can't prove it's the email the code was issued to.
  // Exception: if the code has no `email` binding (legacy semantics, not emitted by NEW createExchangeCode), skip this check.
  if (proofOfEmail === null || proofOfEmail.email.toLowerCase() !== row.email.toLowerCase()) {
    // Caller has already won the atomic redeem — we rolled it forward. Revert.
    await db.update(exchangeCodes)
      .set({ redeemedAt: null, redeemedByIpHash: null })
      .where(and(eq(exchangeCodes.code, code), eq(exchangeCodes.redeemedAt, row.redeemedAt!)));
    return { ok: false, reason: "proof-mismatch" };
  }

  return { ok: true, payload: row.payload as ExchangeCodePayload, email: row.email, siteId: row.siteId };
}
```

> **Preserved untouched (DO NOT MODIFY in ES-090 scope):**
>
> - `generateExchangeCode(params) → string` (existing JWT path) — still used by `verify/route.ts:114,538`, `consent/route.ts:115`, `auth/otp/verify/route.ts:108`.
> - `/auth/exchange?code=…` handler's existing JWT branch.
>
> Migration of legacy call sites to the new DB-backed API is a **follow-up TS**, not ES-090.

**Edit — `app/api/pipeline/stage/route.ts:1093-1100`** (replaces raw `accessToken` in completion email):

```ts
if (completedSite?.ownerEmail && completedSite.accessToken) {
  const { code } = await createExchangeCode({
    email: completedSite.ownerEmail,
    siteId,
    payload: { accessToken: completedSite.accessToken },
    ttlSeconds: 7 * 86_400, // 7 days — per TS-090 §5 MED-6
  });

  await sendCompletionEmail(
    completedSite.ownerEmail,
    domain,
    siteId,
    code,                                      // was: completedSite.accessToken
    geoScorecard.overallScore,
    projectedScore,
    (completedSite.autoDiscoveredUrlCount as number | null) ?? 0,
  );
}
```

**Edit — `/auth/exchange?code=…` route handler** (additive branch, not replacing existing JWT branch):

1. Attempt `redeemExchangeCode(code, proofOfEmail, ipHashForCurrentIp)` first — if `ok: true`, proceed with the DB-backed flow: set siteToken cookie (§b.10) or Supabase session (§b.10), redirect to `/sites/<siteId>`.
2. If `ok: false` with `reason: "not-found"`, fall through to the **existing JWT branch** — preserves the 4 legacy call sites without changing their contract.
3. If `ok: false` with any other reason, return 401 with a short, non-enumerable error message (DO NOT distinguish "expired" vs "already-redeemed" vs "proof-mismatch" to the client — log the distinction server-side only).

**Proof-of-email source selection** (in the `/auth/exchange` handler):

- If the user has an active Supabase session (`getSession()` returns a user with a verified email), pass `{ source: "supabase-session", email: user.email }`.
- Otherwise, if the request carries an OTP-verified session cookie for a specific email within the last 10 minutes, pass `{ source: "active-otp", email: <otp-email> }`.
- Otherwise, `proofOfEmail = null` — redemption fails with `proof-mismatch`.

**HP-202 mitigation (amended with explicit defuse, 2026-04-15):** email-preview scanners (Gmail Link Scan, Outlook Safe Links, Proofpoint, Mimecast) consume links without a Supabase session or active OTP for the target email. The proof-of-email flow above produces the following sequence for a scanner click:

1. Scanner GETs `/auth/exchange?code=<code>` with no session cookie for `<email>`.
2. `redeemExchangeCode` wins the atomic UPDATE (marks `redeemed_at = NOW()`).
3. Proof-of-email check fails (no session, no active OTP matching `<email>`).
4. The compare-and-swap revert at `where redeemed_at = row.redeemed_at` unwinds the mark, setting `redeemed_at` and `redeemed_by_ip_hash` back to NULL.
5. Scanner receives 401.
6. Real user clicks later → code is once again redeemable → proof-of-email check passes → redeem succeeds.

**Net:** scanners cannot one-way-consume the code. This is a full defuse, not a partial mitigation, provided the compare-and-swap in `redeemExchangeCode` is faithfully implemented (atomic UPDATE with RETURNING and the CAS-guarded revert).

**Observability hook (ScriptDev):** count `proof-mismatch` return reasons per `(email, day)`. A sustained non-zero rate suggests scanner activity is succeeding in invalidating codes; a nonzero rate combined with `already-redeemed` returns from the real user's click suggests a race between scanner consume-then-revert and real user's click arriving in the revert window. If that race is observed in production, harden further by option (b) from HolePoker (GET lands on intermediate page; client-side JS POSTs the actual redeem — scanners don't execute JS).

**Edit — `lib/services/send-completion-email.ts`** (or the email template file): change the link parameter name from `token` to `code`, update the email copy to say "This link expires in 7 days and can be used once", keep the URL query param name the same for SendGrid template compatibility if template uses Mustache variable substitution.

**Janitor cron** (new — `app/api/cron/expire-exchange-codes/route.ts`): runs daily, `DELETE FROM exchange_codes WHERE expires_at < NOW() - INTERVAL '30 days'`. Prevents unbounded growth; redeemed rows linger 30 days for forensic audit.

### b.13 OBS-1 — Sentry + `/api/health`

**Install:**

```bash
npm install @sentry/nextjs
```

**New files (generated by `npx @sentry/wizard@latest`, then hand-reviewed):**

- `sentry.client.config.ts`
- `sentry.server.config.ts`
- `sentry.edge.config.ts` (for middleware)
- `instrumentation.ts` — merge with §b.8 env-assert register hook.

**Config requirements (amended per HP-194 for AC-22 satisfiability, 2026-04-15):**

The original scrubber covered only `?token=` URL params — it left Authorization headers, Cookie headers, request bodies, breadcrumb `data` objects, exception messages, stack traces, and `user.ip_address` unscrubbed. HP-194 correctly flagged this as unsatisfiable against AC-22's zero-match grep (raw IPv4/IPv6, 32-char nanoid access tokens, `sb-access-token` cookie values). The expanded scrubber below covers all documented leak surfaces; additions are marked with `// HP-194`.

**Shared helper — `lib/observability/scrubber.ts`:**

```ts
// Match any query-param-like key/value pair whose key smells like a credential.
// Broader than the original `?token=` regex: also catches authToken, code,
// access_token, refresh_token, sessionToken, key, apiKey, secret.
const SECRET_URL_PARAM = /([?&](?:token|authToken|auth_token|access_token|refresh_token|sessionToken|code|key|apiKey|api_key|secret)=)[^&#]+/gi;

// 32-char nanoid tokens used for accessToken + exchange_codes.code.
// Not perfectly precise (any 32-char base64url-ish string matches) but
// catches the leak classes AC-22 cares about.
const NANOID_32 = /\b[A-Za-z0-9_-]{32}\b/g;

// IPv4 with private/loopback/link-local retained (low-value PII); public v4 redacted.
// IPv6 wholesale redacted (too many forms to filter selectively).
const IPV4_PUBLIC = /\b(?:(?!10\.)(?!127\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!169\.254\.)(?:\d{1,3}\.){3}\d{1,3})\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

const REDACT = "[REDACTED]";

export function scrubString(s: unknown): unknown {
  if (typeof s !== "string") return s;
  return s
    .replace(SECRET_URL_PARAM, "$1" + REDACT)
    .replace(NANOID_32, REDACT)
    .replace(IPV4_PUBLIC, REDACT)
    .replace(IPV6, REDACT);
}

export function scrubObject(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return scrubString(obj);
  if (Array.isArray(obj)) return obj.map(scrubObject);
  if (typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      // Drop entire values of headers/cookies whose KEY is credential-like.
      const kl = k.toLowerCase();
      if (kl === "authorization" || kl === "cookie" || kl === "set-cookie" ||
          kl === "x-api-key" || kl === "x-auth-token" ||
          kl === "access_token" || kl === "refresh_token" || kl === "token") {
        out[k] = REDACT;
      } else {
        out[k] = scrubObject(v);
      }
    }
    return out;
  }
  return obj;
}
```

**Sentry init (`sentry.client.config.ts`, `sentry.server.config.ts`, `sentry.edge.config.ts` — all three share the same pattern):**

```ts
import * as Sentry from "@sentry/nextjs";
import { scrubString, scrubObject } from "./lib/observability/scrubber";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV ?? "development",
  tracesSampleRate: process.env.VERCEL_ENV === "production" ? 0.1 : 1.0,

  // HP-194: do NOT attach user IP / cookies / headers by default.
  sendDefaultPii: false,

  // HP-194: comprehensive scrub — URL params, headers, body, breadcrumbs,
  // exception values, stack-trace strings.
  beforeSend(event) {
    if (event.request) {
      event.request.url = scrubString(event.request.url) as string | undefined;
      event.request.headers = scrubObject(event.request.headers) as typeof event.request.headers;
      event.request.cookies = undefined;                       // drop wholesale
      event.request.data = scrubObject(event.request.data);    // body
    }
    // user.ip_address is a defense-in-depth removal — sendDefaultPii:false
    // should already suppress it, but strip explicitly for grep-safety.
    if (event.user) {
      event.user.ip_address = undefined;
    }
    if (event.exception?.values) {
      event.exception.values = event.exception.values.map((v) => ({
        ...v,
        value: scrubString(v.value) as string | undefined,
        // stacktrace frames: scrub each `vars` + `context_line` string
        stacktrace: v.stacktrace ? {
          ...v.stacktrace,
          frames: v.stacktrace.frames?.map((f) => ({
            ...f,
            vars: scrubObject(f.vars) as Record<string, unknown> | undefined,
            context_line: scrubString(f.context_line) as string | undefined,
          })),
        } : v.stacktrace,
      }));
    }
    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.map((b) => ({
        ...b,
        message: scrubString(b.message) as string | undefined,
        data: scrubObject(b.data) as Record<string, unknown> | undefined,
      }));
    }
    return event;
  },

  // HP-194: breadcrumb-level scrub too — some breadcrumbs bypass beforeSend
  // if they're emitted but the event never fires.
  beforeBreadcrumb(breadcrumb) {
    return {
      ...breadcrumb,
      message: scrubString(breadcrumb.message) as string | undefined,
      data: scrubObject(breadcrumb.data) as Record<string, unknown> | undefined,
    };
  },
});
```

**Verification loop (AC-22):** ScriptDev runs the AC-22 automated grep against a Sentry event export from the week following the OBS-1 ship. Zero matches for nanoid-32 and public IPv4 patterns. The scrubber is unit-tested in `scrubber.test.ts` against fixture events that embed tokens in every documented surface (URL, headers, cookies, body, breadcrumbs, exception message, stack frame `vars`, `context_line`).

**Replace `console.warn` / `console.error` → `Sentry.captureException` at:**

- `app/api/pipeline/stage/route.ts` — all `console.error` call sites (stage failures).
- `app/api/sites/route.ts` — `console.error` at auto-link + SSRF rejection.
- `app/api/auth/proxy/[...path]/route.ts` — error paths.
- Credit deduction paths (`lib/services/credits/*`).

Add breadcrumbs (not exceptions) for structured trace context:

```ts
Sentry.addBreadcrumb({
  category: "pipeline.stage",
  level: "info",
  data: { stage, siteId, durationMs },
});
```

**New route — `app/api/health/route.ts`:**

```ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET() {
  const started = process.hrtime.bigint();
  let dbOk = false;
  try {
    await db.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    /* reported below */
  }
  const uptimeMs = Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);

  const body = {
    ok: dbOk,
    version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
    uptimeMs,
    db: dbOk ? "ok" : "fail",
  };

  return NextResponse.json(body, { status: dbOk ? 200 : 503 });
}
```

**Edit — `middleware.ts`:** add `/^\/api\/health$/` to `ALWAYS_ALLOWED` list (around line 85-96, wherever the existing public-route allow-list lives).

**Sentry alert rules (configured in Sentry UI + checked in via `sentry/alerts.json` if CI-managed):**

- `pipeline stage failure rate > 5% over 10 min`
- `credit deduction error count > 0`
- `auth proxy error rate > 1% over 10 min`

**External uptime (operator-configured, not code):** Betterstack or similar pinging `/api/health` every 60s from two regions; documented in `docs/ops/uptime-monitoring.md` (new doc under OpsMaster domain).

### b.14 COMP-1 — DPDP right-to-erasure

**New route — `app/api/account/route.ts` (`DELETE`):**

**Architectural note (amended per HP-187, 2026-04-15):** the original "cascade delete" phrasing is misleading — only 2 of the 8 siteId-referencing tables have `onDelete: "cascade"` (citation_check_responses, citation_check_scores at schema.ts:333,357). The other 6 are either enforced-FK-without-cascade (team_domains:52, firecrawl_jobs:313 — these will raise FK violations on `DELETE FROM geo_sites`) or soft-FK text columns without any constraint (credit_transactions.siteId, geo_crawl_logs.siteId, geo_page_views.siteId, chatbot_logs.siteId — these don't raise but leave orphan rows with PII unless explicitly handled).

**We intentionally DO NOT add `onDelete: cascade` to every child FK** — that would change delete semantics for every future non-DPDP delete path, an unbounded blast radius. Instead, this handler runs **explicit ordered DELETEs inside a single transaction** so a partial delete can never land.

**Preconditions:**
- Auth: require logged-in Supabase session via existing session cookie (post-MED-4 it's the HttpOnly cookie). Session's `user.email` is the authoritative `$email`.
- Require confirmation via request body: `{ confirmation: "DELETE_MY_ACCOUNT" }` — rejects anything else with 400.
- Rate-limit: `checkRateLimit(\`account_delete:${email}\`, 2, 3600_000)` — prevent rapid repeat.

**Scope resolution** (executed as read before the delete transaction):

```sql
-- Teams the user owns (role=owner). Non-owner memberships are removed but the team is preserved.
WITH owned_teams AS (
  SELECT team_id FROM team_members WHERE email = $email AND role = 'owner'
),
owned_sites AS (
  -- Sites belonging to an owned team OR explicitly owned by this email.
  SELECT DISTINCT id FROM geo_sites
    WHERE team_id IN (SELECT team_id FROM owned_teams) OR owner_email = $email
)
```

**Step 1 — Revoke in-flight tokens BEFORE the delete transaction opens** (per HP-186 amendment):
```sql
UPDATE geo_sites SET access_token = NULL, token_expires_at = NOW() WHERE owner_email = $email;
DELETE FROM exchange_codes WHERE email = $email;
```
Order matters: concurrent requests lose access immediately; any request mid-flight during the rest of the transaction will 401 cleanly.

**Step 1.5 — Pipeline deletion guard (amended per HP-198, 2026-04-15)** — in-flight QStash stage handlers for owned sites will FK-violate or insert-into-deleted-parent mid-delete. Without a guard they crash → QStash retry storm → Sentry alerts from §b.13's "pipeline stage failure rate > 5% over 10 min" fire for 5-60 minutes after the delete.

Mark sites as tombstoned so stage handlers early-exit cleanly:

```sql
-- Mark every owned site as "deleting" so stage handlers see the tombstone and exit.
UPDATE geo_sites
  SET pipeline_status = 'deleting'
  WHERE id IN owned_sites;
```

Then edit `app/api/pipeline/stage/route.ts` at the very top of the stage dispatch (after auth, before the handler body) to check:

```ts
const [site] = await db.select({ pipelineStatus: geoSites.pipelineStatus })
  .from(geoSites).where(eq(geoSites.id, siteId));
if (!site || site.pipelineStatus === "deleting") {
  // Site is being deleted; drop this stage cleanly with 200 so QStash doesn't retry.
  return NextResponse.json({ ok: true, skipped: "site-deleting" }, { status: 200 });
}
```

Stage handlers return 200 (not 5xx) so QStash does not retry. The delete transaction (Step 2 below) proceeds with the owned_sites already marked — in-flight handlers that hit this check after Step 1.5 but before the transaction commits exit cleanly. Handlers already past the check will hit either (a) the cascade deletion inside the transaction, in which case their writes roll back with the transaction, or (b) post-commit, in which case their writes FK-fail into nothing — which is why the `pipeline_status = 'deleting'` check must happen **before** any INSERT in the handler.

**Follow-up safety:** separately, the existing QStash dead-letter path (per ES-086) will catch any handler that exceeds retry budget. With the tombstone guard in place, dead-lettering for deleted sites should drop to zero in production — surface as a Sentry metric to detect regressions.

**Step 2 — Open transaction. Explicit ordered DELETEs** (dependency order = children before parents):

```sql
BEGIN;

-- 2a. Enforced-FK children WITHOUT cascade — must delete BEFORE parent:
DELETE FROM team_domains WHERE site_id IN owned_sites OR team_id IN owned_teams;
DELETE FROM firecrawl_jobs WHERE site_id IN owned_sites;

-- 2b. Soft-FK (text-only) children. Delete by siteId to remove PII:
DELETE FROM credit_transactions WHERE site_id IN owned_sites OR team_id IN owned_teams;
DELETE FROM chatbot_logs WHERE site_id IN owned_sites OR team_id IN owned_teams;

-- 2c. Soft-FK PII-bearing tables — soft-anonymize, don't delete
-- (preserves analytics aggregation; strips personal data):
UPDATE geo_crawl_logs
  SET ip = NULL, ip_hash = NULL, user_agent = NULL
  WHERE site_id IN owned_sites;
UPDATE geo_page_views
  SET ip = NULL, ip_hash = NULL, visitor_id = NULL, user_agent = NULL
  WHERE site_id IN owned_sites;

-- 2d. Now safe to delete parent geo_sites rows. The two cascade FKs
-- (citation_check_responses:333, citation_check_scores:357) + the new
-- exchange_codes.site_id FK automatically clean their children:
DELETE FROM geo_sites WHERE id IN owned_sites;

-- 2e. User-scoped rows not tied to a site or team:
DELETE FROM consent_records WHERE email = $email;
DELETE FROM audit_reports WHERE contact_email = $email;

-- 2f. Team-scoped API clients (for teams the user solely owns):
DELETE FROM api_clients WHERE team_id IN owned_teams;

-- 2g. Finally, remove team memberships and any teams left empty:
DELETE FROM team_members WHERE email = $email;
DELETE FROM teams WHERE id IN owned_teams
  AND NOT EXISTS (SELECT 1 FROM team_members WHERE team_id = teams.id);

-- 2h. Audit log (inside the transaction so the row lands iff the delete commits):
INSERT INTO admin_audit_log (action, actor_email, payload)
  VALUES ('account_deletion', $email,
          jsonb_build_object('teamIds', owned_teams, 'geoSiteIds', owned_sites));

COMMIT;
```

**Step 3 — Post-commit side effects:**
- Send confirmation email via existing `sendEmail` helper.
- Return 200 `{ ok: true, deletedAt: ISO }`.

**Idempotency:** second call returns 404 `{ error: "no_account" }` — no error, no retry storm.

**Rollback safety:** if any DELETE fails, `ROLLBACK` leaves all rows intact. The audit-log row is only written on commit, so the log reliably reflects successful deletions.

**Edit — `middleware.ts`** (amended per HP-189, 2026-04-15): add `/^\/api\/account$/` to the `ALWAYS_ALLOWED` list (alongside the `/api/health` entry added by §b.13). Without this the middleware returns 403 before the DELETE handler runs, silently bricking the entire DPDP path. The route handler performs its own auth via the Supabase session cookie, so middleware allowlist placement matches the pattern already used by every authenticated `/api/sites/[id]/*` entry.

```ts
// inside ALWAYS_ALLOWED array
/^\/api\/account$/,                      // DPDP right-to-erasure — auth in route
```

Method scoping: the route file exports only `DELETE`; Next.js returns 405 for other methods automatically. No method-scoped allowlist needed.

**What this intentionally leaves in place:**
- Teams where the user is a non-owner member: team stays, user's `team_members` row removed.
- Sites owned by other team owners (even if the deleted user interacted with them): preserved.
- Anonymized `geo_crawl_logs`/`geo_page_views` rows: retained for aggregate analytics with PII stripped.

**Idempotency:** second call returns 404 `{ error: "no_account" }` — no error, no retry storm.

**Rate-limit:** `checkRateLimit(\`account_delete:${email}\`, 2, 3600_000)` — prevent rapid repeat.

### b.15 COMP-2 — IP hashing

**New file — `lib/utils/ip-hash.ts`:**

```ts
import { createHmac, createHash } from "crypto";

export function dailySalt(date: Date, key: string): string {
  const yyyymmdd = date.toISOString().slice(0, 10);
  return createHmac("sha256", key).update(yyyymmdd).digest("hex");
}

export function hashIp(rawIp: string, date: Date = new Date()): string {
  const key = process.env.IP_HASH_KEY;
  if (!key) throw new Error("IP_HASH_KEY env not set");
  const salt = dailySalt(date, key);
  return createHash("sha256").update(salt + rawIp).digest("hex");
}
```

**Edits at ingress write sites:**

- `lib/services/crawl/crawl-logger.ts` (or wherever `geo_crawl_logs` inserts happen) — write `ipHash = hashIp(rawIp)` and **stop** writing `raw_ip` (set to null).
- `app/api/t/*` (tracking pixel) — same change at `geo_page_views` insert sites.

**Backfill script — `geo/scripts/backfill-ip-hash.ts`:**

- Default dry-run (operator-only, not crontab-scheduled).
- `--commit` flag gates actual writes.
- Batched `LIMIT 5000 WHERE ip_hash IS NULL AND ip IS NOT NULL`.
- For each row, compute `hashIp(row.ip, row.created_at)` — using the row's own date as salt source so historical hashes stay stable.
- Write `ipHash`, null `ip`.
- Loop until 0 rows affected.

**Environment:** `IP_HASH_KEY` added to Vercel env (production + preview). Prefix in `.env.example`: `IP_HASH_KEY=<32-byte base64 — ask ops>`.

**Trade-off documentation (amended per HP-203, 2026-04-15):**

Daily salt rotation is a deliberate privacy-by-default choice that **silently defeats cross-day IP correlation** downstream. Teams building abuse-detection, fraud analysis, or repeat-visitor tracking on top of `geo_crawl_logs` / `geo_page_views` must know this is a hard constraint:

| Use case | Works with daily salt? | Workaround |
|---|---|---|
| "Block IP X after 3 failed audits **today**" | ✓ Yes (within-day correlation intact) | — |
| "Block IP X after 3 failed audits over **7 days**" | ✗ No | Derive per-IP rate-limit bucket into a separate table keyed by a rolling HMAC with a longer salt period, written at ingress — not reconstructible from `ip_hash` alone |
| "Flag high-volume single-IP signups over a week" | ✗ No | Same as above: instrument at signup path |
| "Detect distributed botnets via per-IP session count over time" | ✗ No | Requires a dedicated abuse-detection pipeline writing to a separate hashed-IP table with explicit retention policy; source the raw IP at ingress BEFORE it's nulled |

**Once raw IP is nulled, it is not reconstructible.** This is a one-way door. Before the `drop column ip` follow-up TS lands, OpsMaster / any downstream analytics consumer must sign off that they do not require cross-day correlation.

**If cross-day correlation is later determined to be needed**, the options are (in order of preference):

1. **Weekly salt rotation** instead of daily. Migration: change `dailySalt` → `weeklySalt(date)`. Backfill: impossible without raw IPs; switchover is forward-only.
2. **Per-use-case HKDF-derived salts.** `abuse_detection_salt = HKDF(IP_HASH_KEY, "abuse-detection", weekOf(date))`. One extra table column per use case; raw IP still nulled.
3. **Accept the constraint.** Build use cases that do not need cross-day correlation (most rate-limits, fraud signals can be per-day).

The default (daily salt) is correct for privacy and default-safe. Document the trade-off explicitly so the next engineer doesn't discover this the hard way.

### b.16 Hygiene bundle

Bundle into one PR (Class C tail):

- `package.json` — remove `apify-client` dep; verify `grep -rn "apify" lib/ app/ --include="*.ts"` is zero-hit before commit.
- `package.json` — remove `mongodb` devDep; same grep check.
- `lib/services/crawl/puppeteer-fallback.ts` (or wherever puppeteer is imported) — move `import puppeteer from "puppeteer-core"` and `import chromium from "@sparticuz/chromium-min"` into a dynamic `await import()` inside the one function that uses them.
- `app/api/auth/proxy/[...path]/route.ts:144` — replace `console.log` with `console.info` (or `Sentry.addBreadcrumb` after §b.13 lands).
- `vercel.json` — verify crons for `/api/cron/recrawl` and `/api/cron/process-queue` exist; only add if missing (grep first).

---

## c. Unit Test Plan

**Test directory:** `geo/tests/unit/es-090/` (one subdir per concern).

**Coverage targets:** ≥90% for new files (`sanitize-html.ts`, `ip-hash.ts`, `reextract-gate.ts`, `assert-env.ts`, `health/route.ts`). ≥80% for edited files.

### c.1 CRIT-1 token expiry — `tests/unit/es-090/token-expiry.test.ts`

| ID | Name | Input | Expected |
|---|---|---|---|
| U1 | `verify-route writes tokenExpiresAt on new token` | POST /verify OK path | `site.tokenExpiresAt ≈ now + 90d` (±5s tolerance) |
| U2 | `regenerate rotates token and resets expiry` | POST /regenerate | new `accessToken`, `tokenExpiresAt` refreshed, `tokenRotatedAt = now` |
| U2a | `re-login with expired token rotates + returns new token` (HP-224) | site.emailVerified=true, tokenExpiresAt=now-1s, valid OTP | response body `accessToken` differs from DB's prior `accessToken`; new `tokenExpiresAt ≈ now + 90d`; `tokenRotatedAt = now` |
| U2b | `re-login with valid token returns existing token unchanged` (HP-224) | site.emailVerified=true, tokenExpiresAt=now+60d, valid OTP | response body `accessToken` equals DB's pre-call `accessToken`; no rotation write (`tokenRotatedAt` unchanged) |
| U2c | `re-login with NULL tokenExpiresAt rotates` (HP-224, pre-migration transition) | site.emailVerified=true, tokenExpiresAt=NULL, valid OTP | rotation fires; new token returned; `tokenExpiresAt` now non-NULL |
| U2d | `site-view-sync propagates tokenExpiresAt on both full + lightweight paths` (Amendment 3) | invoke both sync entrypoints after rotating the base row | `geoSiteView.tokenExpiresAt` matches `geoSites.tokenExpiresAt` after each sync; regression test fails if a future sync path forgets to carry the column |
| U2e-bf | `re-login: no pending OTP → 401 generic + NO incrementOtpAttempt call` (HP-237 + HP-239) | site.emailVerified=true, site.verificationCode=NULL, POST `{code:"123456"}` | 401 body `{ error: "Invalid or expired code" }`; `tokenRotatedAt` unchanged; `accessToken` unchanged; **spy on `incrementOtpAttempt`: assert NOT called** (HP-239 invariant — no counter inflation without a pending OTP) |
| U2f-bf | `re-login: expired OTP → 401 generic + NO incrementOtpAttempt call` (HP-237 + HP-239) | site.emailVerified=true, verificationCode set, codeExpiresAt=now-1s, POST matching code | 401 generic; no rotation; **spy on `incrementOtpAttempt`: assert NOT called** (condition b fails before verifyCode runs) |
| U2g-bf | `re-login: wrong OTP → 401 + incrementOtpAttempt called exactly once + no rotation` (HP-237 + HP-239) | site.emailVerified=true, verificationCode set + valid, codeExpiresAt in future, POST mismatched code | 401 generic; **spy on `incrementOtpAttempt`: assert called exactly once with siteId**; `otpAttempts` incremented by 1 in DB; `accessToken` + `tokenRotatedAt` unchanged |
| U2h-bf | `re-login: otpLockedUntil active → 401 generic + NO verifyCode call + NO incrementOtpAttempt call` (HP-237 + HP-239) | otpLockedUntil=now+5min, POST any code | 401 generic; no further otpAttempts increment; no rotation; **spy on `verifyCode`: assert NOT called; spy on `incrementOtpAttempt`: assert NOT called** (canonical order step 1 short-circuits before any of a/b/c/d work runs) |
| U2i | `re-login: valid OTP + emailVerified=true + tokenExpiresAt past → rotate + clearOtpAttempts called` (HP-237 + HP-239 happy path) | all 4 OTP preconditions pass + tokenExpiresAt=now-1s | NEW `accessToken` returned; `tokenExpiresAt ≈ now + 90d`; `tokenRotatedAt = now`; **spy on `clearOtpAttempts`: assert called exactly once**; DB `otpAttempts` reset to 0 |
| U2j | `split-primitives regression: verify-route contains no direct checkAndIncrementOtpAttempt( calls` (HP-239) | static source grep of `app/api/sites/[id]/verify/route.ts` | zero matches for the literal string `checkAndIncrementOtpAttempt(` — both branches must go through `assertOtpGate` |
| U2k | `gate positioning: no DB write before assertOtpGate in re-login branch` (HP-241) | static AST / grep check: first DB mutation in the `emailVerified === true` branch is after the `assertOtpGate` call site | test fails if any `db.update` / `db.insert` / `db.delete` appears before `assertOtpGate` in that branch |
| U3 | `sites/[id] GET returns 401 when expired` | set `tokenExpiresAt = now - 1s` | 401 body `{ code: "TOKEN_EXPIRED" }` |
| U4 | `citation-check returns 401 when expired` | same | 401, and **no** credit debit attempted |
| U5 | `competitor-discovery returns 401 when expired` | same | 401 |
| U6 | `regenerate returns 401 when expired but not rotated` | expired current token, caller uses old token | 401 |
| U7 | `null tokenExpiresAt is treated as valid` (migration-transition case) | existing row, no expiry column value | 200 (matches equality check) |

### c.2 CRIT-2 sanitize — `tests/unit/es-090/sanitize-html.test.ts`

| ID | Name | Input | Expected |
|---|---|---|---|
| U8 | `strips <script> tag` | `<script>alert(1)</script>hi` | `hi` |
| U9 | `strips onerror attribute` | `<img src=x onerror=alert(1)>` | `<img …>` without `onerror` |
| U10 | `strips javascript: URL` | `<a href="javascript:alert(1)">x</a>` | `<a>x</a>` (href removed or neutralized) |
| U11 | `preserves bold/italic` | `<strong>bold</strong> <em>it</em>` | unchanged |
| U12 | `preserves safe links` | `<a href="https://x.com" rel="noopener">x</a>` | unchanged |
| U13 | `strips iframe` | `<iframe src=evil></iframe>` | `` |
| U14 | `strips style tag` | `<style>body{}</style>` | `` |
| U15 | `server-side (jsdom) path works` | same as U8 via server render | identical output |
| U16 | `handles empty string` | `""` | `""` |
| U17 | `handles non-string null-safe` | called through `renderMd` on empty answer | empty string, no throw |

### c.3 CRIT-3 citation-check rate limit — `tests/unit/es-090/citation-check-ratelimit.test.ts`

| ID | Name | Expected |
|---|---|---|
| U18 | `first call allowed` | 200 (or normal response) |
| U19 | `second call within 30s returns 429` | 429 with `Retry-After` header, `retryAfterMs` in body |
| U20 | `call after window expiry allowed` | clock-forward 31s → 200 |
| U21 | `rate-limit check runs before credit debit` | 429 case → no credit deduction row written |
| U22 | `key scoped per-siteId` | siteA blocked, siteB proceeds |

### c.4 CRIT-4 sites-POST rate limit — `tests/unit/es-090/sites-post-ratelimit.test.ts`

| ID | Name | Expected |
|---|---|---|
| U23 | `10 single-audit POSTs from same IP in 60s all pass` | all 200 |
| U24 | `11th POST from same IP returns 429` | 429 |
| U25 | `bulk POST not blocked by IP limit` | 200 even after 11 single-audits exhausted |
| U26 | `unknown IP keyed as "unknown"` | works, but all `unknown`-IP callers share bucket — test accepts this |

### c.5 MED-3 OTP atomic increment — `tests/unit/es-090/otp-atomic.test.ts`

| ID | Name | Expected |
|---|---|---|
| U27 | `single increment returns attemptsLeft - 1` | correct |
| U28 | `attempts = 5 triggers lockout write` | `otpLockedUntil` set to now+15m |
| U29 | `locked row returns not-allowed` | `allowed: false`, no extra increment |
| U30 | `clearOtpAttempts resets to 0` | subsequent call `attemptsLeft = 4` |
| U31 | `siteId not found → not allowed` | `allowed: false` |
| U32 | `concurrent 20 calls: blocked ≥ 15` | Vitest via `Promise.all(Array(20).map(fn))` against a **real Postgres** fixture (pglite in-process OR Dockerized Postgres). **HP-205: pg-mem is explicitly forbidden for this test** — it's a JS reimplementation without MVCC or row-level locking; concurrent `UPDATE ... SET col = col + 1` serializes through the JS event loop and always looks atomic regardless of whether the real fix is in place. A regression (e.g., someone reverts to select-then-update) would still pass U32 on pg-mem. Use `@electric-sql/pglite` for fast in-process Postgres semantics, or gate U32 behind a docker-compose Postgres helper |

### c.6 MED-5 reextract gate — `tests/unit/es-090/reextract-gate.test.ts`

| ID | Name | Expected |
|---|---|---|
| U33 | `tryAcquireReextractSlot returns release fn when under cap` | non-null fn |
| U34 | `release decrements counter` | counter back to 0 after release |
| U35 | `4th concurrent acquire returns null` | Redis mock rejects 4th |
| U36 | `acquire sets TTL on first holder` | verify EXPIRE was called |
| U37 | `double-release is idempotent` | second release no-op |
| U38 | `counter drift (negative after decr) self-heals to 0` | SET 0 invoked |
| U39 | `__test_internals matches old API surface` | re-export shape preserved |

### c.7 MED-4 cookie path — `tests/unit/es-090/verify-cookies.test.ts`

| ID | Name | Expected |
|---|---|---|
| U40 | `verify response body excludes accessToken` | JSON has no `accessToken` field |
| U41 | `verify response sets flowblinq_site_token cookie` | `Set-Cookie` header, HttpOnly + Secure + SameSite=Strict |
| U42 | `verify response sets sb-access-token cookie when tokens present` | same |
| U43 | `exchangeCode field remains in body` | per TS-090 §6 exception |
| U44 | `feature-flag off preserves body path` | `NEXT_PUBLIC_COOKIE_AUTH !== "true"` → tokens in body |

### c.8 MED-2 env assert — `tests/unit/es-090/assert-env.test.ts`

| ID | Name | Expected |
|---|---|---|
| U45 | `assertProductionEnv no-ops in development` | no throw |
| U46 | `assertProductionEnv throws when PIPELINE_CALLBACK_URL unset in prod` | throws with var name in message |
| U47 | `verifyAuth returns false when both callback envs unset` | false, no throw |
| U48 | `verifyAuth uses env URL, ignores host header` | signature verified against env |

### c.9 MED-6 exchange code in completion email — `tests/unit/es-090/completion-email.test.ts`

| ID | Name | Expected |
|---|---|---|
| U49 | `completion email link uses exchange code not raw token` | link `?code=<code>`, no `token=` query |
| U50 | `exchange code TTL = 7 days` | `expiresAt ≈ now + 7d` |
| U51 | `exchange code one-time consumption` | second redeem returns expired |

### c.10 OBS-1 health — `tests/unit/es-090/health.test.ts`

| ID | Name | Expected |
|---|---|---|
| U52 | `GET /api/health returns 200 when DB up` | 200 + `{ ok: true, db: "ok" }` |
| U53 | `GET /api/health returns 503 when DB down` | 503 + `{ ok: false, db: "fail" }` |
| U54 | `health body includes VERCEL_GIT_COMMIT_SHA` | version string set |

### c.11 COMP-1 account deletion — `tests/unit/es-090/account-delete.test.ts`

| ID | Name | Expected |
|---|---|---|
| U55 | `DELETE without auth cookie → 401` | 401 |
| U56 | `DELETE without confirmation body → 400` | 400 |
| U57 | `DELETE removes team_members row` | row gone |
| U58 | `DELETE cascades geo_sites` | geoSites rows gone for owned teams |
| U59 | `DELETE anonymizes crawl logs (not deletes)` | row retained, `ip`, `ip_hash`, `user_agent` null |
| U60 | `DELETE writes admin_audit_log` | row present with action + actorEmail |
| U61 | `second DELETE returns 404` | idempotent |
| U62 | `rate-limit: 3rd attempt in 1h → 429` | 429 |

### c.12 COMP-2 IP hashing — `tests/unit/es-090/ip-hash.test.ts`

| ID | Name | Expected |
|---|---|---|
| U63 | `hashIp deterministic for same IP + same date salt` | equal outputs |
| U64 | `hashIp differs across days` | different outputs for same IP different date |
| U65 | `hashIp throws when IP_HASH_KEY unset` | throws `IP_HASH_KEY env not set` |
| U66 | `new crawl-log insert writes ip_hash, nulls ip` | `ip = null`, `ip_hash` set |
| U67 | `backfill script dry-run writes nothing` | no rows changed |
| U68 | `backfill script --commit writes ip_hash, nulls ip` | counts match |

### c.13 Hygiene — `tests/unit/es-090/hygiene.test.ts`

| ID | Name | Expected |
|---|---|---|
| U69 | `package.json excludes apify-client` | grep test |
| U70 | `package.json excludes mongodb` | grep test |
| U71 | `puppeteer not in top-level imports` | source grep: only dynamic import |
| U72 | `vercel.json crons present` | `/api/cron/recrawl` and `/api/cron/process-queue` configured |

### c.14 L-2 CSP — `tests/unit/es-090/csp.test.ts`

| ID | Name | Expected |
|---|---|---|
| U73 | `middleware response includes Content-Security-Policy(-Report-Only)` | header present |
| U74 | `CSP forbids default-src *` | not `'unsafe-*'` on default-src |
| U75 | `CSP allow-list contains supabase.co` | present on connect-src |

---

## d. Integration Test Plan

**Test directory:** `geo/tests/integration/es-090/`.

Runs against Docker-Compose stack (`docker/ops/docker-compose.yml`): Postgres + Upstash-local + Next.js dev.

| ID | Name | Scenario | Expected |
|---|---|---|---|
| IT1 | Token expiry E2E | Create site → get accessToken → fast-forward DB clock to `tokenExpiresAt + 1s` → hit all 4 gated routes | All 401 with `code: "TOKEN_EXPIRED"` |
| IT1a | Self-lockout recovery via re-login (HP-224) | Create site → get accessToken → fast-forward DB clock past expiry → regenerate with old token expect 401 (proves lockout) → request OTP → verify with fresh OTP | Verify returns NEW accessToken with `tokenExpiresAt ≈ now + 90d`; subsequent call to any of the 4 gated routes succeeds with the new token |
| IT1b | Re-login bypass attempt w/o OTP (HP-237 — BLOCKING) | Create site with `emailVerified=true` + `verificationCode=NULL` → POST `/api/sites/[id]/verify {code:"000000"}` | 401 body `{ error: "Invalid or expired code" }`; `accessToken` unchanged in DB; `tokenRotatedAt` unchanged; no `geoSiteView` sync fired |
| IT1c | Re-login brute-force lockout (HP-237) | Seed pending OTP; POST wrong code 5× rapidly | Each wrong attempt 401; `otpAttempts` monotonically increments through N-1; final attempt + any subsequent within 15m returns 401 per `otpLockedUntil` freeze; no rotation at any step; legitimate attempt with correct code while lock active also 401 (confirms lock beats correctness — matches fresh-verify semantics) |
| IT2 | Regenerate flow | Call regenerate with old token → expect new token in response + cookie | Old token rejected on next call, new token accepted |
| IT3 | XSS payload in LLM answer | Insert `<img src=x onerror=alert(1)>` into `citation_responses.answer` → render `/sites/[id]` page → inspect HTML | Payload scrubbed, no `onerror` in final DOM |
| IT4 | Citation-check rate-limit under concurrency | 5 parallel `POST /citation-check` same siteId | Exactly 1 returns 200, 4 return 429; credit debit = 1 |
| IT5 | Sites-POST IP rate-limit | 15 parallel `POST /api/sites` (non-bulk) same IP | 10×200, 5×429 |
| IT6 | Sites-POST bulk path unaffected | Submit bulk audit (12 URLs) while IP is in rate-limit cooldown | 200 — bulk not blocked |
| IT7 | OTP concurrent verify race | 20 parallel wrong-OTP submits against same siteId | ≤5 succeed in incrementing; lockout applied; attempt-6+ all blocked |
| IT8 | MED-4 cookie hydration | OTP → verify → navigate to `/sites/[id]` | Page renders fully authenticated; `document.cookie` does not contain `flowblinq_site_token` (HttpOnly) |
| IT9 | Cluster-safe reextract | 2 Vitest workers × 3 parallel calls each = 6 concurrent | Only 3 acquire slot at any time; slot counter never exceeds 3 |
| IT10 | Completion email exchange | Trigger stage `assemble` for a fixture site → capture email payload → click link with code → land on `/sites/[id]` authenticated | `Set-Cookie` present; code one-time |
| IT11 | `/api/health` reachable unauth | curl without cookies | 200 |
| IT12 | `/api/health` 503 when DB down | Stop Postgres container → hit health | 503 `{ ok: false, db: "fail" }` |
| IT13 | Account delete full sweep | Owner deletes account → verify cascades + anonymization + audit row | All assertions pass |
| IT14 | IP hash migration parity | Insert 10 `geo_crawl_logs` pre-migration → apply ES-090 → run backfill `--commit` → verify `ip_hash` set, `ip` null | Row counts match |
| IT15 | CSP report-only emits no console violations | Load `/`, `/sites/[id]`, `/verify/[id]`, `/dashboard` with headless Chrome → collect CSP reports | Zero unexpected violations (pre-documented allow-list acceptable) |
| IT16 | Host-header spoof rejected | Send fake `Host: evil.com` to stage route | Signature verification still uses env URL; returns 401/403 not 200 |
| IT17 | Raw token not in outbound email | Trigger completion email; grep SendGrid payload for `accessToken` value | No match |
| IT18 | Sentry captures forced error | Inject a throw in stage handler | Sentry event visible in test tenant; breadcrumb contains siteId |
| IT19 | OBS-1 pipeline failure alert fires | Simulate 6/100 pipeline failures in 10 min | Sentry rule evaluates, alert object visible |
| IT20 | Rollout feature flag off preserves body-auth | `NEXT_PUBLIC_COOKIE_AUTH=false` verify run | response body still carries `accessToken`; IT8 skipped |

---

## e. Profiling Requirements

**Measure:**

| Metric | Target | Tool |
|---|---|---|
| Token expiry check latency overhead per gated route | <1ms p99 (single timestamp compare) | Vitest bench or manual `performance.now()` around the check |
| DOMPurify sanitize on 10KB LLM answer | <3ms p95 server-side, <1ms p95 client-side | `performance.now()` in unit test |
| `checkRateLimit` DB-backed call latency added | <15ms p95 | Vitest bench against local Postgres |
| Atomic OTP UPDATE-RETURNING latency | <10ms p95 | same |
| Upstash `INCR + EXPIRE` round-trip | <25ms p95 from Vercel us-east | measured via `/api/health` perf probe |
| `/api/health` latency | <50ms p99 (cheap `SELECT 1`) | external uptime monitor |
| Sentry `captureException` overhead | <5ms p95 non-blocking (fire-and-forget via worker) | Sentry SDK default |

**Baseline expectations:** none of the above should add >5% to the existing p95 of any customer-facing API route. If a route regresses more than 5%, ReviewMaster halts merge.

**Profiling tools:**
- Vercel Analytics / Speed Insights for prod-side p95.
- Vitest benchmarks (`.bench.ts` adjacent to unit tests) for isolated measurements.
- Sentry Performance tracing (post-OBS-1) for prod routes.

---

## f. Load Test Plan

**Harness:** `k6` scripts under `geo/tests/load/es-090/`.

| Scenario | Ramp | Assertion |
|---|---|---|
| LT1 — Citation-check rate-limit defence | 50 VUs × 60s same siteId | ≥98% of requests 429; p99 latency of 429 response <80ms; credit_transactions rows = 1 (or ≤ floor(60/30) per siteId) |
| LT2 — Sites-POST IP-limit defence | 100 VUs × 60s same IP single-audit | ≥10 pass per 60s window; remainder 429; no SendGrid API calls over 10 |
| LT3 — MED-5 cluster-safe counter | Two k6 workers × 50 VUs = 100 concurrent citation-check calls triggering re-extraction | Redis `reextract:global` key value never exceeds 3 across run; leaked slots auto-expire after TTL |
| LT4 — OTP lockout under flood | 50 VUs × 30s wrong-OTP submits, same siteId | ≤5 total `UPDATE otp_attempts` reach row_id before lockout; lockout timestamp within 15m window; no database deadlocks |
| LT5 — `/api/health` sustained | 10 rps × 10min | p99 <50ms; 0% error; DB pool not exhausted |
| LT6 — Verify flow post-MED-4 | 20 VUs × 60s real OTP + verify | p95 verify < current+50ms; cookie set rate 100%; no body-leak of accessToken |

**Success criteria:**
- Each scenario passes without cascading failures in other prod routes (measured via parallel `/api/health` probe).
- p50 / p95 / p99 latency tables recorded in PR description per each scenario.

**Resource bounds:**
- No scenario may consume >30% of allocated Postgres connections.
- No scenario may trigger Supabase rate limits.
- No scenario may page Sentry for non-test errors (use a separate Sentry test environment).

---

## g. Logging & Instrumentation

### g.1 Events to log

| Event | Level | Fields | Destination |
|---|---|---|---|
| Token expired 401 | `warn` | `siteId, route, tokenRotatedAt, tokenExpiresAt` | Sentry breadcrumb |
| Token rotated | `info` | `siteId, previousExpiresAt` | Sentry breadcrumb |
| XSS sanitizer stripped tags | `info` (sampled 1%) | `siteId, strippedTagCount` | Sentry breadcrumb only — do not log payload |
| Citation-check 429 | `warn` | `siteId, retryAfterMs` | Sentry breadcrumb |
| Sites-POST 429 | `warn` | `ipHash, retryAfterMs` (never raw IP) | Sentry breadcrumb |
| OTP lockout applied | `warn` | `siteId, attempts` | Sentry breadcrumb + `admin_audit_log` |
| Reextract slot exhausted | `warn` | `siteId, slotValue` | Sentry breadcrumb |
| Exchange code redeemed | `info` | `siteId, codeId, ttlRemainingMs` | Sentry breadcrumb |
| Account deletion | `info` | `actorEmail, teamIds, geoSiteIds` | `admin_audit_log` row |
| Pipeline stage failure | `error` | `stage, siteId, phase, err.message` | `Sentry.captureException` |
| CSP violation report | `warn` | `blocked-uri, violated-directive, document-uri` | Sentry (via report-to endpoint if wired) |

### g.2 Metrics to emit

Via Sentry `addBreadcrumb` + custom measurements (no separate Prometheus stack):

- `es090.token.expired.count` — incremented on each 401 by TOKEN_EXPIRED path
- `es090.ratelimit.blocked.count` — by route label (`citation_check`, `sites_create`)
- `es090.sanitizer.stripped.count` — aggregate strips (not per-request payload)
- `es090.reextract.slot.current` — gauge, sampled every minute via a tiny cron-less poll in `/api/health` (piggybacked)
- `es090.account.deleted.count` — counter

### g.3 Log-level guidance

- `console.error` → replace with `Sentry.captureException` (payload includes breadcrumbs).
- `console.warn` → keep in dev; in prod, funnel through `Sentry.addBreadcrumb` with `level: "warning"`.
- `console.log` → remove outright (see hygiene §b.16 `auth/proxy/[...path]/route.ts:144`).
- **Never** log raw IPs, raw `accessToken`, OTP codes, `exchangeCode`, or email bodies. Redact in `beforeSend` as shown §b.13.

---

## h. Acceptance Criteria

> Tick when the named test (or pair) passes AND the ReviewMaster regression gate stays GREEN.

### Direct coverage of TS-090 AC-1 through AC-17

- [ ] **AC-1** (schema migration): columns `tokenExpiresAt`, `tokenRotatedAt`, `ipHash`, table `admin_audit_log` present after `drizzle-kit push`; **`geoSiteView.tokenExpiresAt` mirror column present (Amendment 3); `lib/services/site-view-sync.ts` propagates `tokenExpiresAt` on both full-sync and lightweight-sync paths (regression test U2d)**; **both backfill UPDATEs (HP-233) run clean such that the subsequent `ALTER COLUMN ... SET NOT NULL` promotion succeeds on a pre-migration snapshot containing both access-tokened and access-token-NULL rows**; `docker run --rm geo-test` passes. Verified by **IT1 + IT14**.
- [ ] **AC-2** (token expiry 401 on 4 routes + re-login self-recovery + OTP gate + split primitives + gate positioning): **U3, U4, U5 + IT1** green for the 4-route enforcement. **HP-224 re-login rotation (U2a + U2b + U2c + IT1a)** green — verify route must rotate on expired-token re-login, preserve token on valid re-login, and rotate on NULL-expiry transition rows. **HP-237 OTP gate (U2e-bf + U2f-bf + U2g-bf + U2h-bf + U2i + IT1b + IT1c)** green — re-login branch must verify all four OTP preconditions (pending code exists, not expired, matches, not locked out) before rotating; bypass attempts return generic 401 with no state change; brute-force attempts respect `otpLockedUntil` freeze. **HP-239 split-primitive invariants (U2e-bf / U2f-bf / U2h-bf assert NO `incrementOtpAttempt` call on a/b/d failures; U2g-bf asserts exactly-one call on c failure; U2j regression grep for direct `checkAndIncrementOtpAttempt(` in verify-route returns zero)** green — counter-inflation DoS vector structurally closed. **HP-241 gate positioning (U2k)** green — no DB mutation in the re-login branch appears before the `assertOtpGate` call site. **PR #1 merge is blocked on IT1a + IT1b + U2j + U2k all passing** (recovery happy-path, bypass-attempt rejection, primitive-split structural regression guard, gate-positioning structural regression guard). IT1c is blocking if brute-force isn't already symmetric with fresh-verify — confirm via inspection during PR#1 review.
- [ ] **AC-3** (XSS sanitized): **U8–U17 + IT3** green; `dompurify` in `package.json`; `lib/utils/sanitize-html.ts` exports `sanitizeMarkdown`; grep confirms 4 call sites in `citation-monitor.tsx` (lines 156, 279, 310, 341) wrap via `sanitizeMarkdown(renderMd(...))`.
- [ ] **AC-4** (citation-check rate-limit): **U18–U22 + IT4** green; 429 with `Retry-After` header.
- [ ] **AC-5** (sites-POST rate-limit, single-audit only): **U23–U26 + IT5 + IT6** green; bulk path unaffected.
- [ ] **AC-6** (CSP shipped): **U73–U75 + IT15** green for Report-Only variant; **separate commit** flips `Content-Security-Policy-Report-Only` → `Content-Security-Policy` after 7-day safety window — this commit is explicitly part of AC-6 and gates the AC.
- [ ] **AC-7** (`.env*` hygiene): `git check-ignore .env.vercel-prod` returns 0; pre-commit hook rejects staged `.env.test` (manual verification via ReviewMaster script); tracked `.env*` files (except allow-list) removed.
- [ ] **AC-8** (host-header fallback removed): **U45–U48 + IT16** green; production build fails if `PIPELINE_CALLBACK_URL` unset; signature verification ignores `Host` header.
- [ ] **AC-9** (OTP atomic increment): **U27–U32 + IT7** green; concurrent-20 test blocks ≥15.
- [ ] **AC-10** (HttpOnly cookies): **U40–U44 + IT8** green; full OTP → dashboard integration test passes; `accessToken` absent from JSON body; feature-flag on confirmed via canary.
- [ ] **AC-11** (cluster-safe reextract): **U33–U39 + IT9 + LT3** green; global counter never exceeds 3.
- [ ] **AC-12** (exchange-code in completion email): **U49–U51 + IT10 + IT17** green; raw `accessToken` absent from email payload; 7-day TTL enforced.
- [ ] **AC-13** (Sentry wired): **IT18** green; config files present; forced error surfaces in Sentry with stage + siteId breadcrumbs.
- [ ] **AC-14** (`/api/health`): **U52–U54 + IT11 + IT12 + LT5** green; `/api/health` in `ALWAYS_ALLOWED`; external uptime monitor documented in `docs/ops/uptime-monitoring.md`.
- [ ] **AC-15** (DPDP erasure): **U55–U62 + IT13** green; confirmation email sent; `admin_audit_log` row written.
- [ ] **AC-16** (IP hashing): **U63–U68 + IT14** green; new inserts have `ip_hash` populated and `ip` null; backfill idempotent.
- [ ] **AC-17** (hygiene bundle): **U69–U72** green; grep for `apify`, `mongodb` in `lib/`, `app/` returns zero non-doc hits; puppeteer only dynamically imported; stray `console.log` at `app/api/auth/proxy/[...path]/route.ts:144` replaced.

### Cross-cutting ACs (ES-090 scope additions)

- [ ] **AC-18** (unit test coverage): ≥90% branch coverage on new files (`sanitize-html.ts`, `ip-hash.ts`, `reextract-gate.ts`, `assert-env.ts`, `app/api/health/route.ts`, `app/api/account/route.ts`). ≥80% on edited `verify/route.ts`, `stage/route.ts`, `citation-check/route.ts`, `sites/route.ts`, `rate-limit.ts`, `middleware.ts`. `npm run test:coverage` passes gate.
- [ ] **AC-19** (integration regression gate): full integration suite before ES-090 = baseline; after = ≥ baseline (no previously-passing test turns red). ReviewMaster asserts identical pass-count on both sides of the diff; new IT1-IT20 layer on top.
- [ ] **AC-20** (load-test results logged): PR descriptions for Class A + Class B PRs include LT1-LT6 p50/p95/p99 tables from at least one local run.
- [ ] **AC-21** (no prod-data regression from token-expiry backfill): on-migration backfill sets `tokenExpiresAt = now + 90d` for all existing non-null `accessToken` rows. Post-migration SQL probe confirms zero rows where `access_token IS NOT NULL AND token_expires_at IS NULL`.
- [ ] **AC-22** (PII-safe telemetry): automated grep over 1 week of Sentry events — zero matches for raw IPv4, raw IPv6, 32-char nanoid access tokens, or `sb-access-token` cookie value. Enforced by the `beforeSend` scrubber in §b.13.
- [ ] **AC-23** (PR-description hygiene): each of the 4 PRs includes a table listing (a) findings closed, (b) test IDs covering them, (c) feature-flag state (for PR #3 cookie migration), (d) rollback procedure. HolePoker adversarial pass uses this table to pick targets.

### Rollout gates (sequenced, not parallel)

- [ ] **G1** — PR #1 (CRIT-1 + CRIT-3 + CRIT-4 + L-1 + L-2 Report-Only) merges first. 72h soak on prod before PR #2.
- [ ] **G2** — PR #2 (CRIT-2 dompurify) merges. Sentry CSP violation count reviewed before PR #3.
- [ ] **G3** — PR #3 (MED-2, MED-3, MED-5 + MED-4 behind feature flag + MED-6). MED-4 flag flipped to `true` only after canary + integration suite clean.
- [ ] **G4** — PR #4 (OBS-1 + COMP-1 + COMP-2 + hygiene) merges. IP-hash backfill run with `--commit` only after new-insert path verified writing `ip_hash` for 7 days.
- [ ] **G5** — Follow-up commit flips CSP from Report-Only to enforcing. Gates AC-6.
- [ ] **G6** — Follow-up TS filed to drop the legacy `ip` column on `geo_crawl_logs`, `geo_page_views` after one-week safety window post-backfill.

---

## i. Dependencies & References

- **TS-090:** `geo/docs/specs/technical/TS-090-security-production-readiness-remediation.md`
- **Superseded input:** `docs/specs/engineering/ES-100-security-audit-remediation.md` on `fix/security-audit-remediation` — SpecMaster requests CoFounder direct Rao to delete ES-100 pre-merge (filename collision with the next ES-100 that numbering reaches).
- **Key upstream files verified against main @ 70645cba:**
  - `lib/db/schema.ts:90, 233` (`accessToken` column definitions)
  - `lib/rate-limit.ts:15-45` (`checkRateLimit`), `:51-89` (`checkAndIncrementOtpAttempt`)
  - `middleware.ts:85-106` (ALWAYS_ALLOWED + SECURITY_HEADERS)
  - `app/components/citation-monitor.tsx:10, 156, 279, 310, 341`
  - `app/api/sites/route.ts:47, 49, 54-55`
  - `app/api/sites/[id]/route.ts:26`
  - `app/api/sites/[id]/verify/route.ts:300-317, 321-346, 540-556`
  - `app/api/sites/[id]/regenerate/route.ts:29`
  - `app/api/sites/[id]/citation-check/route.ts:51-62, 79-83, 150-232`
  - `app/api/sites/[id]/competitor-discovery/route.ts:28`
  - `app/api/pipeline/stage/route.ts:1085-1107, 1111-1134`
- **New packages:** `dompurify`, `@types/dompurify`, `jsdom`, `@sentry/nextjs`, `husky` (if absent).
- **New env vars:** `IP_HASH_KEY`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN` (CI), `NEXT_PUBLIC_COOKIE_AUTH` (feature flag).

---

## j. Notes to ReviewMaster

1. **Phase A (RED tests):** deliver tests U1–U75 + IT1–IT20 as RED first; use fixtures under `tests/fixtures/es-090/` (xss-payloads.json, otp-race.ts, csp-baseline.html).
2. **Regression gate:** baseline is `main @ 70645cba` full test run. After each PR, re-run gate; any previously-green test turning red blocks merge unless explicitly acknowledged as intentional scope change.
3. **Split test responsibility:**
   - Phase A delivery can land in a single PR against the `fix/security-audit-remediation` branch (currently Rao's).
   - Aditya's call whether to rename branch to `fix/es-090-security-production-readiness` before PR review.
4. **Adversarial (HolePoker):** invited to specifically target (a) CSP bypasses via data: URIs, (b) DOMPurify config gaps (e.g. SVG tags if allowed), (c) OTP race at extreme concurrency (>100 parallel), (d) exchange-code TTL boundary and replay, (e) MED-4 cookie + CSRF interaction, (f) PII leakage in Sentry error stacks.
5. **Line-number drift:** if any of the cited lines drifts by >5 lines between TS authoring (2026-04-15) and ES implementation, ReviewMaster must flag it in Phase A delivery and SpecMaster re-verifies before ScriptDev ships.

---

*End of ES-090.*
