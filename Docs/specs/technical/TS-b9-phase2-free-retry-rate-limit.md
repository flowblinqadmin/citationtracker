# TS-b9-phase2 — Free-retry abuse rate-limit

**Status:** **DEFERRED** — Phase 2 follow-up to ES-B9 (Option γ free-retry on `status='failed'`). Author this spec into ES-form ONLY when an abuse vector materializes in production telemetry. As of 2026-04-27 (Shastri ratify of γ), Phase 1 ships without rate-limiting and the abuse risk is accepted.

**Parent:** ES-B9 §c.5 (AC-B9-10) + §d (RESOLVED γ)
**Owning agent:** SpecMaster (when promoted)
**Trigger to promote:** ≥ 3 distinct teams observed exceeding 2 free retries / parent site / 24h in any 7-day window.

---

## 1. Problem statement

ES-B9 §d ratifies Option γ — `/api/sites/[id]/retry-failed` charges 0 credits when the parent site's `pipelineStatus === 'failed'`. The abuse vector: a user submits a CSV containing exclusively unreachable / blocked URLs, the bulk audit reaches `pipelineStatus='failed'` deterministically, the user clicks Retry → free retry → the cycle repeats indefinitely.

Phase 1 (ES-B9 as-shipped) accepts this risk because:
- Most `status='failed'` outcomes are platform-side (Firecrawl outages, pipeline bugs, cloudflared disruptions).
- The user-induced cause requires deliberate construction of an all-bad CSV; honest users hit it accidentally at most once.
- Firecrawl per-URL cost is non-zero but small relative to the trust cost of double-charging legitimate failures.

Phase 2 introduces a hard rate-limit on the *free* path only — paid retries (`status='complete'` with failed URLs) remain unmetered.

---

## 2. Proposed mechanism

Cap free retries at **2 per parent site per 24h rolling window**, keyed on the parent site ID (NOT team ID — a team running 50 distinct bulk audits should still get 2 free retries each).

### 2.1 Storage

Reuse the existing `rate_limits` table (`lib/db/schema.ts:419-423`):

```ts
rateLimits = pgTable("rate_limits", {
  key:     text("key").primaryKey(),
  count:   integer("count").notNull().default(0),
  resetAt: timestamp("reset_at").notNull(),
});
```

**Key shape:** `bulk_retry_free:<parentSiteId>` — e.g. `bulk_retry_free:01JS9X3KQH...`.

No schema migration required — `rate_limits` already exists and supports the key→count→reset_at semantics.

### 2.2 Check + increment flow (in `/api/sites/[id]/retry-failed` route, before the credit-zero ledger insert per AC-B9-10)

1. Read row at `key='bulk_retry_free:<parentSiteId>'`.
2. If absent OR `now >= resetAt`: insert/update with `count=1, resetAt=now+24h`. Allow.
3. If present AND `now < resetAt` AND `count < 2`: increment `count`, leave `resetAt` unchanged. Allow.
4. If present AND `now < resetAt` AND `count >= 2`: 429 `{error: "Free retry limit reached. Please wait 24 hours or contact support.", code: "FREE_RETRY_RATE_LIMITED", resetAt}`. Reject.

### 2.3 Paid path (`status='complete'` with `failedUrls`) is NOT rate-limited

The check applies ONLY when AC-B9-10's `status='failed'` branch is taken. `status='complete'` retries continue through the existing credit-charge path — the credit cost is itself the throttle.

---

## 3. Acceptance criteria sketch (to be expanded when promoted to ES form)

- AC-Phase2-1: 1st and 2nd free retry within 24h of the same parent site → both succeed.
- AC-Phase2-2: 3rd free retry within 24h → 429 with `code: "FREE_RETRY_RATE_LIMITED"` and `resetAt` ISO timestamp in body.
- AC-Phase2-3: 25h after first retry → counter resets; next free retry succeeds.
- AC-Phase2-4: Different parent sites for the same team → independent counters (per-parent, not per-team).
- AC-Phase2-5: `status='complete'` retry path is NOT subject to rate-limit (paid path unaffected).
- AC-Phase2-6: Rate-limit row insert/update is transactional with the `bulk_retry_failed_free` ledger insert (atomic — counter and audit row land together or neither lands).

---

## 4. Out of scope (Phase 2 deferral note)

- UI surfacing of remaining free retries (e.g. "1 free retry left this 24h"): nice-to-have but not in trigger criteria.
- Per-team aggregate caps: not needed — per-parent caps already bound team-wide impact at `(2 retries × N parent sites)`, which is naturally bounded by the team's CSV-upload volume.
- Email/notification on rate-limit hit: out of scope.

---

## 5. Promotion checklist

When telemetry triggers promotion:

- [ ] Confirm trigger threshold (≥ 3 distinct teams × > 2 free retries / parent / 24h within 7 days).
- [ ] Promote this TS to `docs/specs/engineering/ES-Bx-free-retry-rate-limit.md`.
- [ ] Wire into ES-B9's AC-B9-10 verifier as a follow-up amendment (NEW AC-B9-11 covers rate-limit branch).
- [ ] Confirm `rate_limits` table is still in production schema (verify `lib/db/schema.ts` line ref before authoring).
- [ ] Reach Shastri for ratify on the 2-per-24h threshold (may want to start at 5 and tighten).
