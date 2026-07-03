# TS-017 — Persist Rate Limiter to DB

**GitHub Issue:** #109
**Date:** 2026-03-02
**Priority:** P1 — active security vulnerability in production
**Depends on:** none (standalone fix)

---

## What

Replace the in-memory `Map`-based rate limiters in `lib/rate-limit.ts` with
DB-backed persistence using the existing Supabase/Postgres connection.

### Two limiters to fix

| Limiter | Current | Risk | Fix |
|---------|---------|------|-----|
| OTP brute-force (`checkOtpAttempt`) | `otpAttemptStore` Map on `geoSites.id` | Bot cycles Vercel instances → unlimited OTP guesses | Store on `geoSites` row (2 new columns) |
| IP submission rate limit (`checkRateLimit`) | `store` Map on IP string | Cold start resets counter → spam site creation | New `rate_limits` table in Postgres |

---

## Why

Vercel runs serverless functions across multiple instances. Each instance boots
with an empty Map. A bot making 5 OTP attempts to instance A, then 5 to B, then
5 to C bypasses the 15-minute lockout entirely. The same applies to the IP
rate limiter — a single IP can create unlimited sites by hitting different instances.

No new service or dependency is needed. The fix uses the existing Postgres
connection (already imported in every route via `@/lib/db`).

---

## Architecture

### Fix 1 — OTP lockout on `geoSites` row

**New columns on `geoSites`:**
```sql
ALTER TABLE geo_sites ADD COLUMN otp_attempts   integer   NOT NULL DEFAULT 0;
ALTER TABLE geo_sites ADD COLUMN otp_locked_until timestamp;
```

**New `lib/rate-limit.ts` functions (DB-backed):**

```typescript
// Replace checkOtpAttempt — now requires db + siteId, reads/writes geoSites directly
export async function checkAndIncrementOtpAttempt(
  siteId: string
): Promise<{ allowed: boolean; attemptsLeft: number }>

// Replace clearOtpAttempts — resets both columns to 0/null
export async function clearOtpAttempts(siteId: string): Promise<void>
```

**Logic** (mirrors existing in-memory logic):
- If `otp_locked_until > now()` → `{ allowed: false, attemptsLeft: 0 }`
- Else if `otp_attempts >= 4` (about to hit 5th) → set `otp_locked_until = now() + 15m`, `otp_attempts = 5` → `{ allowed: false, attemptsLeft: 0 }`
- Else → `otp_attempts += 1` → `{ allowed: true, attemptsLeft: 5 - newCount }`
- Use a single `UPDATE ... RETURNING` to atomically read + increment

**Update `app/api/sites/[id]/verify/route.ts`:**
- Change `checkOtpAttempt(id)` → `await checkAndIncrementOtpAttempt(id)`
- Change `clearOtpAttempts(id)` → `await clearOtpAttempts(id)`

---

### Fix 2 — IP rate limit via `rate_limits` table

**New table:**
```sql
CREATE TABLE rate_limits (
  key       text        PRIMARY KEY,
  count     integer     NOT NULL DEFAULT 0,
  reset_at  timestamp   NOT NULL
);
```

**New `checkRateLimit` signature (DB-backed, async):**
```typescript
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): Promise<RateLimitResult>
```

**Logic:**
1. `SELECT count, reset_at FROM rate_limits WHERE key = $key`
2. If not found, or `reset_at < now()`: `INSERT INTO rate_limits VALUES ($key, 1, now() + $windowMs) ON CONFLICT (key) DO UPDATE SET count = 1, reset_at = now() + $windowMs` → `{ allowed: true, remaining: limit - 1 }`
3. If `count >= limit`: `{ allowed: false, remaining: 0, resetAt: row.reset_at }`
4. Else: `UPDATE rate_limits SET count = count + 1 WHERE key = $key` → `{ allowed: true, remaining: limit - count - 1 }`

Use a single upsert where possible to avoid race conditions.

**Update `app/api/sites/route.ts`:**
- Change `const ipLimit = checkRateLimit(...)` → `const ipLimit = await checkRateLimit(...)`

---

## New Artifacts

| File | Change |
|------|--------|
| `lib/db/migrations/20260302-rate-limit-persistence.sql` | New — ALTER + CREATE TABLE |
| `lib/db/schema.ts` | Add `otpAttempts`, `otpLockedUntil` to `geoSites`; add `rateLimits` table export |
| `lib/rate-limit.ts` | Replace Map logic with async DB calls |
| `app/api/sites/route.ts` | Await `checkRateLimit` |
| `app/api/sites/[id]/verify/route.ts` | Await `checkAndIncrementOtpAttempt`, await `clearOtpAttempts` |

---

## Migration File

`lib/db/migrations/20260302-rate-limit-persistence.sql`:

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

---

## Acceptance Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| RL-1 | OTP lockout persists across cold starts | Simulate 5 failed attempts; restart server; 6th attempt → 429 |
| RL-2 | OTP lockout releases after 15 minutes | Set `otp_locked_until` to past in DB; verify attempt → allowed |
| RL-3 | OTP counter resets on successful verify | Successful verify; check `otp_attempts = 0`, `otp_locked_until = null` |
| RL-4 | IP rate limit persists across instances | 3 POST /api/sites from same IP; 4th → 429 regardless of instance |
| RL-5 | IP rate limit resets after window | `reset_at` in past → new window starts |
| RL-6 | Existing 815 tests still pass | `vitest run` → 0 failing |
| RL-7 | No new npm dependencies | `package.json` unchanged |

---

## Risks

| Risk | Mitigation |
|------|------------|
| DB latency on every OTP attempt | Acceptable — verify route already does multiple DB queries |
| Race condition on `rate_limits` upsert | Use `INSERT ... ON CONFLICT DO UPDATE` (atomic in Postgres) |
| `geoSites` rows without `otp_attempts` column (pre-migration) | `DEFAULT 0` handles all existing rows automatically |
