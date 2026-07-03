# ES-017 — Rate Limit Persistence

**Source spec:** TS-017-rate-limit-persistence.md  
**GitHub Issue:** #109  
**Date:** 2026-03-01  
**Priority:** P1 — active security vulnerability in production  
**Target branch:** dev-sprint-9  
**Depends on:** none (standalone fix)

---

## a) Overview

Replace two in-memory `Map`-based rate limiters with DB-backed persistence.

**Current state (broken):**
- `geo/lib/rate-limit.ts` — two module-level Maps: `store` (IP rate limit) + `otpAttemptStore` (OTP brute-force)
- Each Vercel cold start resets both Maps → bots bypass limits by hitting different instances
- `verify/route.ts` calls `checkOtpAttempt(id)` and `clearOtpAttempts(id)` — both synchronous
- `sites/route.ts` calls `checkRateLimit("ip:" + ip, ...)` and `checkRateLimit("email:" + ...) ` — both synchronous

**After this fix:**
- OTP lockout lives on the `geoSites` row (2 new columns) — persists across instances
- IP rate limit lives in a new `rate_limits` Postgres table — persists across instances
- Both functions become `async` — all callers need `await` added

**Files to modify (5):**

| File | Change |
|------|--------|
| `geo/lib/db/migrations/20260302-rate-limit-persistence.sql` | NEW — migration |
| `geo/lib/db/schema.ts` | Add 2 columns to `geoSites`; add `rateLimits` table |
| `geo/lib/rate-limit.ts` | Replace both Map implementations with async DB calls |
| `geo/app/api/sites/route.ts` | Add `await` to both `checkRateLimit` calls |
| `geo/app/api/sites/[id]/verify/route.ts` | Rename + await OTP functions |

---

## b) Implementation Requirements

### File 1: `geo/lib/db/migrations/20260302-rate-limit-persistence.sql` (NEW)

Write verbatim as specified in TS-017:

```sql
-- TS-017: Persist rate limiters to DB (issue #109)

-- Fix 1: OTP attempts on geoSites row
ALTER TABLE geo_sites
  ADD COLUMN IF NOT EXISTS otp_attempts    integer   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS otp_locked_until timestamp;

-- Fix 2: IP rate limit table
CREATE TABLE IF NOT EXISTS rate_limits (
  key       text        PRIMARY KEY,
  count     integer     NOT NULL DEFAULT 0,
  reset_at  timestamp   NOT NULL
);
```

No additional changes. Run this migration before deploying any code changes.

---

### File 2: `geo/lib/db/schema.ts` (EXTEND)

**Two additions — do not restructure the file:**

**A. Add two columns to `geoSites` table** — insert after `verifyToken` field (line ~138), before the timestamps block:

```typescript
// OTP brute-force protection (DB-backed, persists across Vercel instances)
otpAttempts:    integer("otp_attempts").notNull().default(0),
otpLockedUntil: timestamp("otp_locked_until"),
```

**B. Add `rateLimits` table** — add after the `citationCheckScores` export block at the bottom of the schema file:

```typescript
export const rateLimits = pgTable("rate_limits", {
  key:     text("key").primaryKey(),
  count:   integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});
```

**Import `rateLimits`** wherever needed downstream — the table export alone is sufficient; no `$inferSelect` type needed for this table.

---

### File 3: `geo/lib/rate-limit.ts` (FULL REPLACEMENT)

Replace the entire file. Keep the `RateLimitResult` interface. Remove both Maps and all sync functions. Add imports and two async functions:

```typescript
import { db } from "@/lib/db";
import { geoSites, rateLimits } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * DB-backed IP/email rate limiter. Replaces in-memory Map.
 * Atomic upsert prevents race conditions across Vercel instances.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  const now = new Date();
  const resetAt = new Date(Date.now() + windowMs);

  // Atomic upsert: if key missing or window expired → reset to count=1
  // If key exists and window active → increment count
  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count:   sql`CASE WHEN ${rateLimits.resetAt} < ${now} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${rateLimits.resetAt} < ${now} THEN ${resetAt} ELSE ${rateLimits.resetAt} END`,
      },
    })
    .returning();

  const resetAtMs = row.resetAt.getTime();

  if (row.count > limit) {
    return { allowed: false, remaining: 0, resetAt: resetAtMs };
  }

  return { allowed: true, remaining: limit - row.count, resetAt: resetAtMs };
}

/**
 * DB-backed OTP brute-force limiter. Reads and increments geoSites row atomically.
 * Replaces in-memory otpAttemptStore Map.
 *
 * Logic:
 *   - otp_locked_until > now  → denied, lock still active
 *   - otp_attempts >= 4 (5th attempt) → set lock for 15 min, deny
 *   - otherwise → increment otp_attempts, allow
 */
export async function checkAndIncrementOtpAttempt(
  siteId: string
): Promise<{ allowed: boolean; attemptsLeft: number }> {
  const now = new Date();
  const lockUntil = new Date(Date.now() + 15 * 60 * 1000);

  // Read current state
  const [site] = await db
    .select({ otpAttempts: geoSites.otpAttempts, otpLockedUntil: geoSites.otpLockedUntil })
    .from(geoSites)
    .where(eq(geoSites.id, siteId));

  if (!site) {
    // Site not found — deny silently (caller returns 404 first anyway)
    return { allowed: false, attemptsLeft: 0 };
  }

  // Lock still active
  if (site.otpLockedUntil && site.otpLockedUntil > now) {
    return { allowed: false, attemptsLeft: 0 };
  }

  const currentAttempts = site.otpAttempts ?? 0;

  if (currentAttempts >= 4) {
    // 5th attempt — apply lock
    await db
      .update(geoSites)
      .set({ otpAttempts: 5, otpLockedUntil: lockUntil })
      .where(eq(geoSites.id, siteId));
    return { allowed: false, attemptsLeft: 0 };
  }

  const newAttempts = currentAttempts + 1;
  await db
    .update(geoSites)
    .set({ otpAttempts: newAttempts })
    .where(eq(geoSites.id, siteId));

  return { allowed: true, attemptsLeft: 5 - newAttempts };
}

/**
 * Resets OTP counter and lock on successful verification.
 */
export async function clearOtpAttempts(siteId: string): Promise<void> {
  await db
    .update(geoSites)
    .set({ otpAttempts: 0, otpLockedUntil: null })
    .where(eq(geoSites.id, siteId));
}
```

**Deleted exports:** `checkOtpAttempt` (replaced by `checkAndIncrementOtpAttempt`).  
**Kept export:** `RateLimitResult` interface (unchanged shape).

---

### File 4: `geo/app/api/sites/route.ts` (TWO EDITS)

**Edit 1** — line 30, IP rate limit (add `await`):
```typescript
// BEFORE:
const ipLimit = checkRateLimit("ip:" + ip, 3, 60 * 60 * 1000);

// AFTER:
const ipLimit = await checkRateLimit("ip:" + ip, 3, 60 * 60 * 1000);
```

**Edit 2** — line 179, email rate limit (add `await`):
```typescript
// BEFORE:
const emailLimit = checkRateLimit("email:" + emailLower, 2, 24 * 60 * 60 * 1000);

// AFTER:
const emailLimit = await checkRateLimit("email:" + emailLower, 2, 24 * 60 * 60 * 1000);
```

No other changes to this file. The import `{ checkRateLimit }` remains the same.

---

### File 5: `geo/app/api/sites/[id]/verify/route.ts` (TWO EDITS)

**Edit 1** — update import at top of file:
```typescript
// BEFORE:
import { checkOtpAttempt, clearOtpAttempts } from "@/lib/rate-limit";

// AFTER:
import { checkAndIncrementOtpAttempt, clearOtpAttempts } from "@/lib/rate-limit";
```

**Edit 2** — OTP check call (line ~44), rename + await:
```typescript
// BEFORE:
const otpCheck = checkOtpAttempt(id);

// AFTER:
const otpCheck = await checkAndIncrementOtpAttempt(id);
```

**Edit 3** — clear call (line ~57), add `await`:
```typescript
// BEFORE:
clearOtpAttempts(id);

// AFTER:
await clearOtpAttempts(id);
```

No other changes. The `maxDuration = 30` is sufficient — these are fast DB ops.

---

## c) Unit Test Plan

**Test file:** `geo/__tests__/rate-limit-db.test.ts`

**Mocks required:**
- `@/lib/db` — mock `db.insert().values().onConflictDoUpdate().returning()` chain
- `@/lib/db` — mock `db.select().from().where()` chain (for OTP functions)
- `@/lib/db` — mock `db.update().set().where()` (for OTP write + clear)

### checkRateLimit tests

| ID | Description | Mock setup | Expected |
|----|-------------|------------|----------|
| U-1 | First request (key not found) | Insert returns count=1 | `{ allowed: true, remaining: 2 }` (limit=3) |
| U-2 | Second request, window active | Insert returns count=2 | `{ allowed: true, remaining: 1 }` |
| U-3 | At limit | Insert returns count=3 | `{ allowed: true, remaining: 0 }` |
| U-4 | Exceeded limit | Insert returns count=4 | `{ allowed: false, remaining: 0 }` |
| U-5 | Window expired | Insert returns count=1 (reset by CASE) | `{ allowed: true, remaining: 2 }` |
| U-6 | resetAt populated in result | Insert returns row.resetAt=Date | `result.resetAt === row.resetAt.getTime()` |

### checkAndIncrementOtpAttempt tests

| ID | Description | Mock setup | Expected |
|----|-------------|------------|----------|
| U-7 | Site not found | Select returns [] | `{ allowed: false, attemptsLeft: 0 }` |
| U-8 | First attempt | otpAttempts=0, no lock | `{ allowed: true, attemptsLeft: 4 }` |
| U-9 | Third attempt | otpAttempts=2, no lock | `{ allowed: true, attemptsLeft: 2 }` |
| U-10 | Fourth attempt | otpAttempts=3 | `{ allowed: true, attemptsLeft: 1 }` |
| U-11 | Fifth attempt triggers lock | otpAttempts=4 | `{ allowed: false, attemptsLeft: 0 }`; update called with lockedUntil ~15min |
| U-12 | Lock still active | otpLockedUntil = future | `{ allowed: false, attemptsLeft: 0 }`; no DB update |
| U-13 | Lock expired | otpLockedUntil = past, otpAttempts=5 | `{ allowed: true, attemptsLeft: 4 }` (treated as fresh) |

### clearOtpAttempts tests

| ID | Description | Expected |
|----|-------------|----------|
| U-14 | Called after success | `db.update` called with `{ otpAttempts: 0, otpLockedUntil: null }` for correct siteId |

**Coverage target:** 100% of all branches in `rate-limit.ts`.

---

## d) Integration Test Plan

**Test file:** `geo/__tests__/integration/rate-limit-integration.test.ts`

### Scenario 1 — OTP lockout persists across "instances"

1. Seed DB: geoSite with `otpAttempts=0`
2. Call `checkAndIncrementOtpAttempt(siteId)` 5 times
3. After 5th: assert `{ allowed: false }`
4. Re-read DB row: assert `otp_attempts=5`, `otp_locked_until IS NOT NULL` and is ~15min future
5. Call again immediately: assert `{ allowed: false }` (lock active)

### Scenario 2 — OTP resets after successful verify

1. Seed DB: geoSite with `otpAttempts=3`
2. Call `clearOtpAttempts(siteId)`
3. Read DB: `otp_attempts=0`, `otp_locked_until IS NULL`
4. Call `checkAndIncrementOtpAttempt`: `{ allowed: true, attemptsLeft: 4 }`

### Scenario 3 — IP rate limit: 3 requests allowed, 4th denied

1. Seed: `rate_limits` table empty
2. Call `checkRateLimit("ip:1.2.3.4", 3, 3600000)` three times
3. Assert all three: `allowed: true`
4. Fourth call: `allowed: false`
5. Read DB: `rate_limits` row has `count=4`

### Scenario 4 — IP rate limit resets after window

1. Insert `rate_limits` row: `key="ip:1.2.3.4"`, `count=3`, `reset_at = now() - 1ms` (expired)
2. Call `checkRateLimit("ip:1.2.3.4", 3, 3600000)`
3. Assert: `{ allowed: true, remaining: 2 }` (CASE branch resets count to 1)
4. Read DB: `count=1`, `reset_at` is ~1 hour in future

### Scenario 5 — verify/route integration: OTP blocks after 5 failed attempts

1. POST `/api/sites/{id}/verify` with wrong code 5 times
2. 5th: assert 429 `{ error: "Too many attempts. Wait 15 minutes." }`
3. DB: `otp_attempts=5`, `otp_locked_until` set

---

## e) Profiling Requirements

| Metric | Tool | Target |
|--------|------|--------|
| `checkRateLimit` DB roundtrip | `console.time` | < 10ms p95 (single upsert) |
| `checkAndIncrementOtpAttempt` DB roundtrip | `console.time` | < 15ms p95 (1 select + 1 update) |
| `clearOtpAttempts` DB roundtrip | `console.time` | < 10ms p95 (1 update) |
| End-to-end verify route | Next.js dev timing | < 50ms added latency vs baseline |

**Baseline:** record verify route latency before this change. The additional DB calls should add ≤ 20ms on the warm path.

---

## f) Load Test Plan

**Target:** OTP path in `verify/route.ts` (1 select + 1 update per request).

### Scenario 1 — Concurrent OTP attempts (normal load)
- 20 concurrent requests/sec to POST `/api/sites/{id}/verify` with valid codes, 30s duration
- **Pass criteria:** p95 < 200ms total route latency; no deadlocks

### Scenario 2 — Rate limit table contention (same IP, burst)
- 50 simultaneous POST `/api/sites` from the same IP
- **Pass criteria:** Exactly `limit` requests succeed; remainder get 429; no 5xx; no DB errors from upsert conflicts

### Scenario 3 — OTP lockout under concurrency
- 10 simultaneous POST `/api/sites/{id}/verify` with wrong code (simulating bot)
- **Pass criteria:** After settling, DB row shows `otp_attempts` between 5–10 (at most `requests` + small overcount due to race on read); `otp_locked_until` is set

**Tool:** `k6`. Note: the OTP read+update is NOT atomic — acceptable; TS-017 accepts small overcount risk for the OTP path. The IP rate limiter uses a single atomic upsert and is safe.

---

## g) Logging & Instrumentation

### rate-limit.ts

```typescript
// checkRateLimit — on block:
console.warn(`[rate-limit] key=${key} blocked count=${row.count} limit=${limit}`);

// checkAndIncrementOtpAttempt — on lock applied:
console.warn(`[rate-limit] OTP lock applied siteId=${siteId} attempts=${newAttempts}`);

// checkAndIncrementOtpAttempt — on lock active:
console.warn(`[rate-limit] OTP attempt blocked (lock active) siteId=${siteId}`);
```

**Log level guidance:**
- `warn` — all rate limit blocks (security events worth monitoring)
- `error` — unexpected DB errors (catch + rethrow after logging)
- No `info`-level logging in the hot path (every request would log)

**No PII.** Log `siteId` and `key` (which is "ip:..." or "email:...") — do not log the raw OTP code or access tokens.

---

## h) Acceptance Criteria

| # | Criterion | Implementation reference |
|---|-----------|--------------------------|
| RL-1 | OTP lockout persists across cold starts | `otpAttempts` / `otpLockedUntil` on `geoSites` row; DB survives restarts |
| RL-2 | OTP lockout releases after 15 minutes | `otpLockedUntil > now` check; expired lock → treat as fresh |
| RL-3 | OTP counter resets on successful verify | `clearOtpAttempts` sets `otpAttempts=0`, `otpLockedUntil=null` |
| RL-4 | IP rate limit persists across instances | `rate_limits` table; atomic upsert |
| RL-5 | IP rate limit resets after window | CASE branch in upsert resets count when `reset_at < now` |
| RL-6 | Existing 815 tests still pass | `vitest run` — 0 failures; no type errors from async change |
| RL-7 | No new npm dependencies | `package.json` unchanged |

**Definition of Done:**
- [ ] Migration file written and matches TS-017 exactly
- [ ] `geoSites` schema has `otpAttempts` + `otpLockedUntil` columns
- [ ] `rateLimits` table defined in schema
- [ ] `rate-limit.ts` has no Maps; all exports are async
- [ ] Both `sites/route.ts` call sites have `await`
- [ ] `verify/route.ts` uses `checkAndIncrementOtpAttempt` (renamed) + both calls `await`-ed
- [ ] TypeScript compiles without errors (`tsc --noEmit`)
- [ ] `vitest run` → 0 failures
- [ ] Target branch: dev-sprint-9
