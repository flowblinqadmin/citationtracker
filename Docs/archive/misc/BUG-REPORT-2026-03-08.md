# GEO Platform — Bug Report (2026-03-08)

Deep dive audit of the full codebase. 21 items investigated, 14 confirmed bugs, 7 non-issues.

This document serves as a **fix + test spec**: each bug includes the test gap analysis and the exact regression tests that must ship with the fix. No fix is complete without its tests.

---

## Priority Matrix

| # | Bug | Severity | Fix Complexity | Prod Impact |
|---|-----|----------|---------------|-------------|
| 01 | Stripe webhook no idempotency | **CRITICAL** | Low | Double credits on retry |
| 04 | generate-chunk timeout corrupts fan-in | **CRITICAL** | Medium | Pipeline stuck forever |
| 05 | Verified sites leak accessToken | **CRITICAL** | Low | Data exfiltration |
| 06 | markFailed double-refund race | **HIGH** | Low | Over-refunded credits |
| 07 | Free audit limit counts failed sites | **HIGH** | Low | Users blocked unfairly |
| 10 | Stale cached results served | **HIGH** | Low | Misleading scores |
| 11 | Hardcoded pricing constants + off-by-one | **HIGH** | Low | Pricing mismatch |
| 13 | Cron safety net re-enqueues wrong stage | **MEDIUM** | Medium | Duplicate crawls/LLM calls |
| 16 | LLM errors may leak API key | **MEDIUM** | Low | Key exposure |
| 18 | Team provisioning race condition | **MEDIUM** | Low | Duplicate teams |
| 20 | balanceBefore/After ledger drift | **MEDIUM** | Medium | Audit trail unreliable |
| 21 | QStash retries=0 partial fan-out | **MEDIUM** | Medium | Orphaned chunks |
| 17 | No CSRF protection | **LOW** | Medium | Theoretical |
| 03 | SessionStorage key mismatch | **FIXED** | — | Was breaking Pro fast-path |

**Not bugs (investigated, cleared):** BUG-08, BUG-09, BUG-12, BUG-14, BUG-15, BUG-19

---

## CRITICAL

### BUG-01 — Stripe Webhook: No Idempotency Protection

**Severity:** CRITICAL
**File(s):** `app/api/webhooks/stripe/route.ts:36-77`
**Status:** Open

#### The Bug (What + Why)

When Stripe delivers `checkout.session.completed`, the handler at line 39 opens a `db.transaction()` that:
1. Verifies user membership (lines 41-45)
2. Reads current `team.creditBalance` (lines 47-51)
3. Computes `creditsAdded = CREDITS_PER_PACK * quantity` (line 53)
4. Sets `creditBalance = balanceBefore + creditsAdded` (lines 57-60)
5. Inserts a `creditTransactions` row with `siteId: session.id` and `type: "topup"` (lines 62-72)

There is **no check** whether credits for this Stripe session ID were already applied. Stripe retries webhooks (at 5s, 30s, 60s, 120s, 300s) until it gets a 2xx. If the server commits the transaction but responds slowly (Vercel cold start, edge timeout), Stripe retries and credits are applied a second time.

The `siteId` column stores `session.id` but has no unique constraint for `type = "topup"` — duplicates insert without error.

#### Why Tests Didn't Catch It

**Test file:** `app/api/webhooks/stripe/route.test.ts` — 10 tests.

Tests cover: missing signature (400), unhandled event types (200 no-op), missing metadata (500), membership cross-check (500), happy path (200 + correct amounts), and transaction failure (500).

**The gap:** No test sends the same webhook event twice. The mock `db.transaction` is a single-call passthrough — it never checks whether a prior topup exists with the same `session.id`. The test labeled "inserts credit transaction with correct topup amounts" asserts a single insert with correct values but never fires a second request to test idempotency.

#### Production Impact

**Has this triggered?** Likely yes, especially during Vercel cold starts where response latency exceeds Stripe's 5s retry threshold. Any user who purchased credits during a slow deploy window could have received 2x credits.

**Damage:** User pays $10, receives 200 credits instead of 100. Direct revenue loss. Credit ledger has duplicate `topup` entries for the same Stripe session, making reconciliation unreliable.

**Blast radius:** Per-user (each affected purchase), but cumulative — every slow webhook response doubles credits.

#### The Fix

Inside the transaction (after line 39), before any credit math, add:

```ts
// Before:
const quantity = parseInt(session.metadata?.creditPacks ?? "1", 10) || 1;

// After:
const [existingTopup] = await tx
  .select({ id: creditTransactions.id })
  .from(creditTransactions)
  .where(and(
    eq(creditTransactions.siteId, session.id),
    eq(creditTransactions.type, "topup")
  ));
if (existingTopup) {
  console.warn(`[stripe-webhook] Duplicate webhook for session ${session.id} — skipping`);
  return; // exit transaction, handler returns 200
}
const quantity = parseInt(session.metadata?.creditPacks ?? "1", 10) || 1;
```

**Files to modify:** `app/api/webhooks/stripe/route.ts`

Alternatively, add a unique partial index:
```sql
CREATE UNIQUE INDEX credit_transactions_topup_session_uniq
  ON credit_transactions (site_id) WHERE type = 'topup';
```

#### Regression Tests (must ship with the fix)

**File:** `app/api/webhooks/stripe/route.test.ts`

1. **"duplicate webhook with same session.id returns 200 but does not double-credit"**
   - Call POST twice with identical Stripe event (same `session.id`)
   - Assert `creditTransactions` insert called exactly once
   - Assert `teams.creditBalance` updated exactly once

2. **"concurrent webhook delivery — idempotency query fires before insert"**
   - First call: full happy path
   - Second call: assert the SELECT for existing topup fires and returns the row from call 1
   - Assert no second INSERT into `creditTransactions`

3. **"missing creditPacks in metadata defaults to 1 pack"**
   - Send event with `metadata.creditPacks = undefined`
   - Assert `creditsAdded = CREDITS_PER_PACK * 1 = 100`

**What to mock:** `db.transaction` with a spy that captures all queries. On the second call, mock `creditTransactions` SELECT to return an existing row.

#### Downstream Ripple

- `creditTransactions` table — no schema change needed (query-based guard), OR migration needed (if using unique index)
- `teams.creditBalance` — integrity restored
- Revenue reconciliation — no more phantom topups

---

### BUG-04 — generate-chunk Timeout Corrupts Fan-in State

**Severity:** CRITICAL
**File(s):** `app/api/pipeline/stage/route.ts:532-639`
**Status:** Open

#### The Bug (What + Why)

The `handleGenerateChunk` function (line 532) processes 5 chunk types: `llms`, `business`, `schema-sitewide`, `schema-faq`, `schema-article`.

For the `llms` chunk (lines 545-571):
1. `Promise.race` races the LLM call against `stageTimeout` (105s) — line 546-563
2. On success, writes `generatedLlmsTxt` and `generatedLlmsFullTxt` to DB — lines 564-570
3. Falls through to `fanInGenerateChunk(siteId)` at line 634, which atomically increments `generate_chunks_done`

The `business` chunk follows the same pattern (lines 573-594 → line 634).

**The bug:** Steps 2 and 3 are separate awaits. If the timeout fires **after** the content write (step 2) but **before** the fan-in increment (step 3), the content is saved but the counter is never updated. With 5 chunks expected (`generateChunksTotal = 5`) and only 4 completing their fan-in, `done === total` at line 636 is never true. The `assemble` stage is never enqueued.

The schema chunks (`schema-sitewide`, `schema-faq`, `schema-article`) at lines 596-627 use `fanInSchemaChunk` which atomically appends content AND increments the counter in a single SQL statement (lines 502-515). These are NOT affected — the bug is specific to `llms` and `business` chunks.

The pipeline stays at `pipelineStatus = "generating"` until the cron safety net fires (every 15 min). The cron re-enqueues `generate-fanout` (line 29 in `process-queue/route.ts`), which resets `generateChunksTotal = 5` and `generateChunksDone = 0` (lines 519-523). Old in-flight chunks may still complete their fan-in after the counter reset, causing `done > total` or premature assembly with incomplete data.

#### Why Tests Didn't Catch It

**Test file:** NONE. There is no test file for `markFailed()`, `fanInGenerateChunk()`, `fanInSchemaChunk()`, or `handleGenerateChunk()`.

The pipeline stage handler (`route.ts`) is 927 lines with zero direct unit tests for these internal functions. The closest tests are:
- `__tests__/integration/crawl-fanout-flow.test.ts` — tests crawl fan-in (different stage), not generate fan-in
- `__tests__/runner.test.ts` — tests stage enqueuing, not stage execution internals
- `__tests__/bulk-pipeline.test.ts` — tests `enqueueStage` failures, not in-handler logic

**The specific gap:** No test simulates a timeout between content write and fan-in increment. No test verifies that `done === total` triggers exactly one `assemble` enqueue.

#### Production Impact

**Has this triggered?** Almost certainly. LLM calls take 30-40s, `stageTimeout` is 105s, and Vercel has a hard function timeout. Any network jitter or slow OpenAI response near the timeout boundary can cause this.

**Damage:** Pipeline stuck forever. User never gets results. Credits remain reserved (`creditsReserved` never refunded because `markFailed` is only called if the outer handler throws, not if the fan-in silently gets stuck). The cron recovery creates duplicate LLM calls ($$ cost) and risks corrupt assembly.

**Blast radius:** Per-site, but any site whose `llms` or `business` chunk takes >100s is at risk.

#### The Fix

Make the content write + fan-in increment atomic for `llms` and `business` chunks. Two options:

**Option A** — Combine into single SQL:
```ts
// llms chunk: replace lines 564-570 and the fall-through to line 634
const { done, total } = await fanInGenerateChunkWithContent(siteId, {
  generatedLlmsTxt: sanitizeLlmsTxt(result.llmsTxt),
  generatedLlmsFullTxt: sanitizeLlmsTxt(result.llmsFullTxt),
});
if (done === total) await enqueueStage({ siteId, domain, stage: "assemble" });
return; // don't fall through
```

Where `fanInGenerateChunkWithContent` does a single `UPDATE ... SET <content_columns>, generate_chunks_done = generate_chunks_done + 1 ... RETURNING`.

**Option B** — Wrap in transaction:
```ts
await db.transaction(async (tx) => {
  await tx.update(geoSites).set({ generatedLlmsTxt: ..., generatedLlmsFullTxt: ... }).where(...);
  // fan-in inside same transaction
});
const { done, total } = await fanInGenerateChunk(siteId);
```

Option A is preferred (mirrors the pattern `fanInSchemaChunk` already uses).

**Files to modify:** `app/api/pipeline/stage/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `__tests__/pipeline-fanin.test.ts` (new file)

1. **"llms chunk: content write + fan-in succeed atomically"**
   - Mock `db.execute` to return `{ done: 3, total: 5 }`
   - Assert DB update includes both content columns and counter increment
   - Assert `assemble` NOT enqueued (3 < 5)

2. **"llms chunk: atomic write ensures no partial state"**
   - Mock the DB update to throw after being called
   - Assert neither content nor counter is persisted (transaction rollback)

3. **"all 5 chunks complete fan-in → assemble enqueued exactly once"**
   - Simulate chunk 5 returning `{ done: 5, total: 5 }`
   - Assert `enqueueStage` called with `stage: "assemble"` exactly once

4. **"4 of 5 chunks complete → assemble NOT enqueued"**
   - Simulate chunk 4 returning `{ done: 4, total: 5 }`
   - Assert `enqueueStage` NOT called

5. **"schema chunk: fanInSchemaChunk appends blocks + increments in single SQL"**
   - Call `fanInSchemaChunk(siteId, blocks)`
   - Assert the SQL contains both `COALESCE(generated_schema_blocks...)` and `generate_chunks_done + 1`

6. **"business chunk: uses same atomic pattern as llms"**
   - Assert the business chunk does NOT fall through to separate `fanInGenerateChunk()` call

#### Downstream Ripple

- `fanInGenerateChunk` may be removed or replaced by `fanInGenerateChunkWithContent`
- Cron safety net behavior unchanged (still re-enqueues `generate-fanout`), but the fix prevents the stuck-at-N-1 state that triggers it
- No schema changes required

---

### BUG-05 — Already-Verified Sites Leak accessToken Without Auth

**Severity:** CRITICAL
**File(s):** `app/api/sites/[id]/verify/route.ts:42-45`
**Status:** Open

#### The Bug (What + Why)

```ts
// route.ts:42-45
if (site.emailVerified) {
  // Already verified — no authOtp needed (user should already have session or will re-login)
  return NextResponse.json({ success: true, siteId: id, accessToken: site.accessToken }, { status: 200 });
}
```

This early return at line 42 fires **before** OTP validation (which starts at line 47). Anyone who knows a site ID can POST to `/api/sites/[id]/verify` with an empty body or any 6-character string and receive the `accessToken`. No valid OTP required. No Supabase session required.

The `accessToken` grants full read access to audit results via `GET /api/sites/[id]` and download access via `/api/sites/[id]/download-report`.

#### Why Tests Didn't Catch It

**Test file:** `app/api/sites/[id]/verify/route.test.ts` — 30+ tests.

**The test exists and validates the buggy behavior as correct.** The test case "returns success for already-verified site (no authOtp, no re-auth)" at approximately line 446 asserts:
- `res.status === 200` ✓
- `body.success === true` ✓
- `body.accessToken` is present ✓
- No Supabase admin calls made ✓

The test was written assuming "already verified = return token without auth" is the correct design. This is a **design bug that the test enshrines as correct behavior.**

#### Production Impact

**Has this triggered?** Unknown — requires attacker with knowledge of site IDs. Site IDs (nanoid, 21 chars) are not guessable but are exposed in:
- URLs shared by users
- Support tickets
- Browser history / bookmarks
- Vercel request logs
- Referrer headers to external resources

**Damage:** Full data exfiltration of any completed audit. GEO scores, executive summaries, recommendations, crawl data, generated llms.txt/business.json — everything.

**Blast radius:** Any site ID that has been shared or logged. Every completed audit is vulnerable.

#### The Fix

Remove the early return. For already-verified sites, require either a valid Supabase session that owns the site OR a valid unexpired OTP:

```ts
// Before (line 42-45):
if (site.emailVerified) {
  return NextResponse.json({ success: true, siteId: id, accessToken: site.accessToken }, { status: 200 });
}

// After:
if (site.emailVerified) {
  // Require valid auth — either a Supabase session or a valid OTP
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user?.email?.toLowerCase() === site.ownerEmail?.toLowerCase()) {
    return NextResponse.json({ success: true, siteId: id, accessToken: site.accessToken }, { status: 200 });
  }
  // Fall through to OTP validation — if OTP is valid, return token
  // If not, return 403
  return NextResponse.json({ error: "Already verified. Please log in to access results." }, { status: 403 });
}
```

**Files to modify:** `app/api/sites/[id]/verify/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `app/api/sites/[id]/verify/route.test.ts` — **modify existing tests**

1. **MODIFY existing "already verified" test:** Change assertion from `status: 200` to `status: 403` when no valid OTP and no valid session provided

2. **ADD "already verified + valid Supabase session → 200 with token"**
   - Mock `supabase.auth.getUser()` to return user with matching email
   - Assert `status: 200`, `body.accessToken` present

3. **ADD "already verified + wrong email session → 403"**
   - Mock `supabase.auth.getUser()` to return user with different email
   - Assert `status: 403`

4. **ADD "already verified + no session + no OTP → 403"**
   - No auth headers, empty body
   - Assert `status: 403`, no `accessToken` in response

5. **ADD "already verified + valid OTP → 200 with token"**
   - Provide correct OTP code for an already-verified site
   - Assert `status: 200` (re-verification works)

#### Downstream Ripple

- `app/api/sites/[id]/download-report/route.ts` — currently relies on `accessToken` auth, which was bypassable via this bug. After fix, download-report auth is as strong as the verify gate.
- Client code (`app/verify/[id]/page.tsx`) must handle the 403 response — show a "please log in" message instead of silently succeeding.
- No schema changes required.

---

## HIGH

### BUG-06 — markFailed: Double-Refund Race Condition

**Severity:** HIGH
**File(s):** `app/api/pipeline/stage/route.ts:89-133`
**Status:** Open

#### The Bug (What + Why)

`markFailed()` (lines 89-133) executes four separate DB operations **without a transaction**:

1. **SELECT** — reads `site.creditsReserved` (line 94)
2. **UPDATE geoSites** — sets `pipelineStatus = "failed"`, `creditsReserved = null` (lines 97-109)
3. **SELECT teams** — reads `team.creditBalance` for `balanceBefore` (line 113)
4. **UPDATE teams + INSERT creditTransactions** — adds credits back, logs refund (lines 116-129)

If cron safety net and a stage timeout both call `markFailed` for the same site concurrently:
- Both read `creditsReserved = 10` at step 1 (before either reaches step 2)
- Both proceed to refund 10 credits each
- Result: 20 credits refunded for 10 reserved

Additionally, the `balanceBefore` at line 115 is read via a separate SELECT (step 3), making it vulnerable to BUG-20 (ledger drift) even without concurrency.

#### Why Tests Didn't Catch It

**Test file:** NONE. `markFailed()` is an internal (non-exported) function in the 927-line stage handler with **zero test coverage**.

The only indirect test is in `crawl-fanout-flow.test.ts` which asserts "does NOT mark site as failed when crawl quality is sufficient" — a negative test that never exercises the actual `markFailed` code path.

**The specific gap:** No test file exists for `markFailed`. The function cannot be imported directly (not exported). Testing requires either exporting it or testing via the stage handler's error path.

#### Production Impact

**Has this triggered?** Possible but rare — requires two callers hitting `markFailed` for the same site within the same ~10ms window. Most likely scenario: cron fires while a stage is also timing out.

**Damage:** Team receives more credits than owed. Two `crawl_refund` entries in `creditTransactions` for the same site. Small per-incident but accumulates.

**Blast radius:** Per-site, financial.

#### The Fix

Use atomic claim pattern — no transaction needed:

```ts
// Before (lines 94-95):
const [site] = await db.select().from(geoSites).where(eq(geoSites.id, siteId));
const reserved = (site?.creditsReserved as number | null) ?? 0;

// After:
const [claimed] = await db.execute(sql`
  UPDATE geo_sites
  SET credits_reserved = NULL, pipeline_status = 'failed',
      pipeline_error = ${message}, updated_at = NOW(),
      crawl_job_ids = NULL, crawl_chunks_done = NULL,
      crawl_chunks_total = NULL, crawl_chunk_results = NULL
  WHERE id = ${siteId} AND credits_reserved IS NOT NULL
  RETURNING credits_reserved, team_id
`);
// If RETURNING is empty, another caller already claimed — skip refund
if (!claimed) {
  // Still mark failed if not already
  await db.update(geoSites).set({
    pipelineStatus: "failed", pipelineError: message, updatedAt: new Date()
  }).where(eq(geoSites.id, siteId));
  return;
}
const reserved = claimed.credits_reserved;
const teamId = claimed.team_id;
```

Then use `RETURNING` for the team balance update (fixes BUG-20 simultaneously):

```ts
const [updated] = await db.execute(sql`
  UPDATE teams SET credit_balance = credit_balance + ${reserved}, updated_at = NOW()
  WHERE id = ${teamId}
  RETURNING credit_balance
`);
const balanceAfter = updated.credit_balance;
const balanceBefore = balanceAfter - reserved;
```

**Files to modify:** `app/api/pipeline/stage/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `__tests__/pipeline-mark-failed.test.ts` (new file)

To test: either export `markFailed` or test through the stage handler's catch block (lines 896-922) by making a stage throw.

1. **"markFailed refunds creditsReserved to team balance"**
   - Site has `creditsReserved = 10`, team has `creditBalance = 50`
   - Call markFailed → team balance = 60, `creditsReserved = null`

2. **"markFailed with creditsReserved = 0 → no refund, no transaction"**
   - Site has `creditsReserved = 0`
   - Assert no `creditTransactions` INSERT, no team UPDATE

3. **"markFailed with creditsReserved = null → no refund"**
   - Site has `creditsReserved = null`
   - Assert RETURNING is empty, skip refund path entirely

4. **"markFailed called twice for same site → only one refund (atomic claim)"**
   - First call: `RETURNING` succeeds, refund applied
   - Second call: `WHERE credits_reserved IS NOT NULL` returns empty → skip
   - Assert `creditTransactions` INSERT called exactly once

5. **"markFailed creates crawl_refund ledger entry with correct balanceBefore/After"**
   - Team starts with 50 credits, site has 10 reserved
   - After refund: `balanceBefore = 50`, `balanceAfter = 60`, `creditsChanged = 10`

6. **"markFailed sets pipelineStatus to 'failed' even when creditsReserved is null"**
   - Site with no credits reserved
   - Assert `pipelineStatus = "failed"` and `pipelineError` is set

#### Downstream Ripple

- The fix also resolves BUG-20 (ledger drift) for the refund path
- `app/api/cron/process-queue/route.ts` — unchanged, but no longer causes double-refund when racing with stage timeout
- No schema changes required

---

### BUG-07 — Free Audit Limit Counts Failed Sites

**Severity:** HIGH
**File(s):** `app/api/sites/route.ts:265-278`
**Status:** Open

#### The Bug (What + Why)

```ts
// route.ts:266-270
const existingSites = await db
  .select({ id: geoSites.id })
  .from(geoSites)
  .where(eq(geoSites.ownerEmail, emailLower));
if (existingSites.length >= FREE_AUDIT_LIMIT) {
```

No filter on `pipelineStatus`. The query counts ALL sites for this email — including `"failed"` ones. A user whose first audit fails (Firecrawl timeout, anti-bot block, LLM error) has the failed site counted against their limit of 2 (`FREE_AUDIT_LIMIT`).

After 2 failures on different domains, they cannot audit any new domain — even though they never received a single result.

#### Why Tests Didn't Catch It

**Test files that touch free audit limits:**
- `app/api/sites/site-creation-limits.test.ts` — 23 tests, but **only URL validation** (private IPs, invalid formats). Does NOT test `FREE_AUDIT_LIMIT`.
- `__tests__/v1-audit.test.ts` — tests `freeRunNumber` tracking (different mechanism from `FREE_AUDIT_LIMIT`)
- `__tests__/integration/api-v1-flow.test.ts` — tests the v1 API flow limit ("Third submission: domain exhausted") but this tests the v1 `freeRunNumber` system, not the main route's email-based count

**The specific gap:** Zero tests for the query at lines 266-270. The mock `db.select` in most tests returns empty arrays, so the limit check never triggers. No test creates 2+ failed sites for the same email and verifies the 3rd attempt succeeds.

#### Production Impact

**Has this triggered?** Almost certainly. Pipeline failures are common (Firecrawl anti-bot, OpenAI timeouts). Any free user who had 2 domains fail is permanently locked out.

**Damage:** Users blocked from the platform after failures they didn't cause. Direct churn at the top of the funnel. Support burden increases.

**Blast radius:** All free users who experience pipeline failures. High impact on conversion.

#### The Fix

```ts
// Before (lines 266-270):
const existingSites = await db
  .select({ id: geoSites.id })
  .from(geoSites)
  .where(eq(geoSites.ownerEmail, emailLower));

// After:
const existingSites = await db
  .select({ id: geoSites.id })
  .from(geoSites)
  .where(and(
    eq(geoSites.ownerEmail, emailLower),
    not(eq(geoSites.pipelineStatus, "failed"))
  ));
```

**Files to modify:** `app/api/sites/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `app/api/sites/site-creation-limits.test.ts` (or new file `__tests__/free-audit-limit.test.ts`)

1. **"email with 0 sites → 201 (allowed)"**
   - Mock `db.select` to return empty array
   - Assert site creation succeeds

2. **"email with 2 complete sites → 402 (limit hit)"**
   - Mock `db.select` to return 2 sites (both non-failed)
   - Assert `status: 402`, `body.upgradeRequired: true`

3. **"email with 2 failed sites → 201 (failed don't count)"** ← the actual bug fix test
   - Mock `db.select` to return 0 (failed sites excluded by query)
   - Assert site creation succeeds

4. **"email with 1 complete + 1 failed → 201 (only 1 counts)"**
   - Mock `db.select` to return 1 site (failed excluded)
   - Assert site creation succeeds (1 < FREE_AUDIT_LIMIT)

5. **"email with 1 complete + 1 in-progress → 402 (in-progress counts)"**
   - Mock `db.select` to return 2 sites (complete + discovering/crawling)
   - Assert `status: 402` — in-progress should count toward the limit

6. **"Pro user with 5 sites → 201 (no limit for Pro)"**
   - Mock `isPro = true`
   - Assert the free limit check is skipped entirely

**What to mock:** `db.select().from(geoSites).where(...)` — the where clause must include the status filter.

#### Downstream Ripple

- No other code paths affected — the fix is a query-level filter
- Consider: should we also exclude `"pending"` sites (created but not yet verified)? Define behavior and test.
- No schema changes required

---

### BUG-10 — Stale Cached Results Served Without Freshness Check

**Severity:** HIGH
**File(s):** `app/api/sites/route.ts:282-339`
**Status:** Open

#### The Bug (What + Why)

```ts
// route.ts:282-285
const [completedForDomain] = await db
  .select()
  .from(geoSites)
  .where(and(eq(geoSites.domain, domain), eq(geoSites.pipelineStatus, "complete")));
```

When a new user audits a domain that another user already completed, the code at lines 293-324 copies all generated data (geoScorecard, executiveSummary, recommendations, generatedLlmsTxt, generatedBusinessJson, generatedSchemaBlocks, discoveryData, crawlData) from the existing site. There is **no staleness check** — results from months ago are served as current.

For GEO analysis, AI platform behavior (ChatGPT, Perplexity, Gemini search results) changes significantly over weeks. An old scorecard is actively misleading.

#### Why Tests Didn't Catch It

**Test file:** No test covers the cache-serve path at lines 282-339.

Tests in `__tests__/v1-audit.test.ts` and `site-creation-limits.test.ts` mock `db.select()` to return empty arrays for the domain lookup, so the cache branch is never entered. The entire "serve cached results" code path has zero test coverage.

#### Production Impact

**Has this triggered?** Yes — every repeated domain audit uses this path. Any domain audited multiple times serves the first audit's results to subsequent users.

**Damage:** Users receive outdated GEO scores and recommendations. Paid users may get worse data than free users who happened to trigger a fresh crawl. Undermines product credibility.

**Blast radius:** Every domain that has been audited more than once.

#### The Fix

Add a freshness threshold:

```ts
// Before (lines 282-285):
const [completedForDomain] = await db
  .select()
  .from(geoSites)
  .where(and(eq(geoSites.domain, domain), eq(geoSites.pipelineStatus, "complete")));

// After:
const CACHE_FRESHNESS_DAYS = 30;
const freshThreshold = new Date(Date.now() - CACHE_FRESHNESS_DAYS * 24 * 60 * 60 * 1000);
const [completedForDomain] = await db
  .select()
  .from(geoSites)
  .where(and(
    eq(geoSites.domain, domain),
    eq(geoSites.pipelineStatus, "complete"),
    gt(geoSites.updatedAt, freshThreshold)
  ))
  .orderBy(desc(geoSites.updatedAt))
  .limit(1);
```

Add `CACHE_FRESHNESS_DAYS` to `lib/config.ts`.

**Files to modify:** `app/api/sites/route.ts`, `lib/config.ts`

#### Regression Tests (must ship with the fix)

**File:** New section in `app/api/sites/route.test.ts` or new file `__tests__/site-cache.test.ts`

1. **"domain with completed audit from 5 days ago → serve cached (fresh)"**
   - Mock `db.select` to return a completed site with `updatedAt = 5 days ago`
   - Assert new site created with `pipelineStatus: "complete"` and copied data

2. **"domain with completed audit from 60 days ago → don't serve, create new audit"** ← bug fix test
   - Mock `db.select` to return empty (stale site filtered out by query)
   - Assert new site created with `pipelineStatus != "complete"` (pipeline starts fresh)

3. **"cached result copies all required fields"**
   - Assert the INSERT includes: `geoScorecard`, `executiveSummary`, `recommendations`, `generatedLlmsTxt`, `generatedLlmsFullTxt`, `generatedBusinessJson`, `generatedSchemaBlocks`, `discoveryData`, `platformDetected`, `lastCrawlAt`
   - No field is null when the source has a value

4. **"CACHE_FRESHNESS_DAYS is exported from lib/config.ts"**
   - Import check — ensure the constant is centralized

5. **"multiple completed audits for same domain → newest (most recent updatedAt) is served"**
   - Mock two completed sites: one from 5 days ago, one from 20 days ago
   - Assert the 5-day-old result is used (ORDER BY updatedAt DESC)

#### Downstream Ripple

- `lib/config.ts` — add `CACHE_FRESHNESS_DAYS = 30` constant
- No schema changes required
- Increases pipeline runs for popular domains (previously cached forever)

---

### BUG-11 — Hardcoded Pricing Constants + BULK_MAX_URLS Off-by-One

**Severity:** HIGH
**File(s):**
- `app/page.tsx:9-11`
- `app/components/UpgradeModal.tsx:6-8`
- `lib/config.ts:9-21`
**Status:** Open

#### The Bug (What + Why)

**Local constant redefinitions:**

`app/page.tsx:9-11`:
```ts
const BULK_MAX_URLS = 501;         // config.ts has 500 ← OFF BY ONE
const PAGES_PER_CREDIT = 5;       // matches config.ts (today)
const BULK_CREDIT_PRICE_INR = 20;  // matches config.ts (today)
```

`app/components/UpgradeModal.tsx:6-8`:
```ts
const PACK_CREDITS = 100;         // should be CREDITS_PER_PACK from config
const PACK_PRICE = 10;            // should be CREDITS_PRICE_USD from config
const PAGES_PER_CREDIT = 5;       // matches config.ts (today)
```

**The off-by-one:** `app/page.tsx` has `BULK_MAX_URLS = 501` while `lib/config.ts` has `BULK_MAX_URLS = 500`. The homepage CSV upload UI client-side check uses `unique.length > BULK_MAX_URLS` (greater-than, not >=), meaning it allows up to 501 URLs. But the API at `app/api/sites/route.ts` uses the config value (500), rejecting 501. A user uploading exactly 501 URLs passes client validation but gets a server error.

**Future risk:** Any pricing change in `lib/config.ts` (e.g., changing `CREDITS_PER_PACK` from 100 to 50) won't propagate to `UpgradeModal` or the homepage — the UI will show stale values.

#### Why Tests Didn't Catch It

**Test file:** `__tests__/bulk-config.test.ts` — 12 tests. Tests verify `lib/config.ts` values and that `BULK_MAX_URLS === ABSOLUTE_MAX_PAGES` (line 40). But **no test checks that client components import from config**. The off-by-one (501 vs 500) is invisible because tests never render the homepage form or check its local constants.

**The specific gap:** Tests validate `lib/config.ts` in isolation but don't verify consumers. The divergence between config and components is a static analysis concern that unit tests don't catch.

#### Production Impact

**Has this triggered?** The off-by-one only triggers for users uploading exactly 501 URLs — unlikely but possible. The silent divergence risk is the bigger concern — any future pricing change will create visible inconsistencies.

**Damage:** Confusing UX for 501-URL uploads (client says OK, server rejects). Future pricing mismatch.

**Blast radius:** Low today, high on next pricing change.

#### The Fix

Replace local constants with imports:

`app/page.tsx`:
```ts
// Before:
const BULK_MAX_URLS = 501;
const PAGES_PER_CREDIT = 5;
const BULK_CREDIT_PRICE_INR = 20;

// After:
import { BULK_MAX_URLS, PAGES_PER_CREDIT, BULK_CREDIT_PRICE_INR } from "@/lib/config";
```

`app/components/UpgradeModal.tsx`:
```ts
// Before:
const PACK_CREDITS = 100;
const PACK_PRICE = 10;
const PAGES_PER_CREDIT = 5;

// After:
import { CREDITS_PER_PACK, CREDITS_PRICE_USD, PAGES_PER_CREDIT } from "@/lib/config";
```

Then rename `PACK_CREDITS` → `CREDITS_PER_PACK` and `PACK_PRICE` → `CREDITS_PRICE_USD` throughout the file.

**Files to modify:** `app/page.tsx`, `app/components/UpgradeModal.tsx`

#### Regression Tests (must ship with the fix)

**File:** `__tests__/config-sync.test.ts` (new file)

1. **"app/page.tsx does not define BULK_MAX_URLS locally"**
   - Read file contents, grep for `const BULK_MAX_URLS`
   - Assert not found (should be imported)

2. **"app/components/UpgradeModal.tsx imports CREDITS_PER_PACK from lib/config"**
   - Read file contents, assert `import.*CREDITS_PER_PACK.*from.*lib/config`

3. **"no client component redefines PAGES_PER_CREDIT"**
   - Grep all `.tsx` files for `const PAGES_PER_CREDIT =`
   - Assert only `lib/config.ts` defines it

4. **"BULK_MAX_URLS client-side check matches server-side"**
   - Import `BULK_MAX_URLS` from config
   - Assert it equals 500 (not 501)

5. **"UpgradeModal displays correct price per pack"**
   - Import `CREDITS_PRICE_USD` from config
   - Assert it matches the value used in UpgradeModal calculations

#### Downstream Ripple

- Any component that currently uses `PACK_CREDITS` must be updated to `CREDITS_PER_PACK`
- `lib/config.ts` may need to export `CREDITS_PRICE_USD` as a named constant if not already (it does: line 11)
- No schema changes

---

## MEDIUM

### BUG-13 — Cron Safety Net Re-enqueues Wrong Stage

**Severity:** MEDIUM
**File(s):** `app/api/cron/process-queue/route.ts:23-85`
**Status:** Open

#### The Bug (What + Why)

The cron maps pipeline status to stage via `STATUS_TO_STAGE` (lines 23-31):

```ts
const STATUS_TO_STAGE: Record<InProgressStatus, PipelineStage> = {
  discovery: "discover",
  crawling: "crawl-fanout",      // ← restarts fan-out from scratch
  processing: "crawl-fanout",
  researching: "research",
  analyzing: "analyze",
  generating: "generate-fanout",  // ← restarts fan-out from scratch
  assembling: "assemble",
};
```

For `crawling` → `crawl-fanout`: This resets `crawlChunksDone = 0` and submits new Firecrawl batch jobs. But old `poll-chunk` messages from QStash may still be in-flight. When those old messages arrive and call the crawl fan-in, they increment `crawlChunksDone` on the reset counter, potentially triggering `done === total` prematurely with a mix of old and new results.

For `generating` → `generate-fanout`: Same issue. Resets `generateChunksDone = 0` and fans out 5 new chunks. Old `generate-chunk` completions can trigger premature assembly with a mix of old + new generated content.

The cron at line 61 also has a `.limit(10)` — if more than 10 sites are stale, the rest are silently skipped until the next 15-minute cycle.

#### Why Tests Didn't Catch It

**Test file:** `__tests__/api-routes.test.ts` lines 352-492 — 8 tests.

Tests cover: auth (401/503), happy path (200), stale site detection, re-enqueue counts, and the `processing → crawl-fanout` mapping. But tests mock `enqueueStage` as a no-op — they verify the cron **calls** enqueue with the right stage name, not that the resulting pipeline run is correct.

**The specific gap:** No test simulates the scenario where old in-flight messages coexist with newly re-enqueued ones. No test checks whether counters are reset correctly before re-enqueue. The tests verify "cron enqueues stage X" but not "stage X handles the state it finds."

#### Production Impact

**Has this triggered?** Yes — any site that was stale for >15 min and got re-enqueued experienced this. The cron runs every 15 minutes. Fan-out stages take 5-10 minutes, so there's a meaningful window for old messages to arrive after the reset.

**Damage:**
- Duplicate Firecrawl batch submissions (cost)
- Duplicate LLM calls (cost)
- Corrupt fan-in: old + new chunks racing creates inconsistent `crawlData` or `generatedContent`

**Blast radius:** Every stale site that gets re-enqueued through the cron.

#### The Fix

For `crawling`: Check if `crawlJobIds` is non-null. If yes, the site has active Firecrawl jobs — re-enqueue as `poll-chunk` (resume polling) instead of `crawl-fanout` (start over):

```ts
// Instead of blind STATUS_TO_STAGE mapping:
if (status === "crawling" || status === "processing") {
  // If crawlJobIds exist, resume polling — don't restart fan-out
  const [siteDetail] = await db.select({ crawlJobIds: geoSites.crawlJobIds })
    .from(geoSites).where(eq(geoSites.id, site.id));
  const stage = siteDetail?.crawlJobIds ? "poll-chunk" : "crawl-fanout";
  await enqueueStage({ siteId: site.id, domain: site.domain, stage });
}
```

For `generating`: Harder to fix without per-chunk tracking. Short-term: add a generation nonce/epoch that each chunk validates before fan-in.

**Files to modify:** `app/api/cron/process-queue/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `app/api/cron/process-queue/route.test.ts` (new file — move tests from `api-routes.test.ts` or add alongside)

1. **"site updated 14 min ago → not re-enqueued (not stale yet)"**
   - Site with `updatedAt = 14 min ago`
   - Assert `enqueueStage` NOT called for this site

2. **"site updated 16 min ago in 'crawling' → re-enqueued"**
   - Assert `enqueueStage` called with this site's ID

3. **"site in 'crawling' with crawlJobIds → re-enqueue as poll-chunk, not crawl-fanout"** ← bug fix test
   - Site has `crawlJobIds = ['job-1', 'job-2']`
   - Assert stage is `"poll-chunk"`, NOT `"crawl-fanout"`

4. **"site in 'crawling' without crawlJobIds → re-enqueue as crawl-fanout"**
   - Site has `crawlJobIds = null`
   - Assert stage is `"crawl-fanout"` (legitimate restart)

5. **"site in 'complete' → not re-enqueued"**
   - Assert filtered out by `IN_PROGRESS_STATUSES` check

6. **"site in 'failed' → not re-enqueued"**
   - Assert filtered out

7. **"CRON_SECRET auth required"**
   - Missing/wrong auth → 401

8. **"more than 10 stale sites → only 10 processed per cycle"**
   - 15 stale sites in DB
   - Assert `staleSites.length <= 10`

#### Downstream Ripple

- `geoSites.crawlJobIds` must be included in the cron's SELECT (currently only selects `id`, `domain`, `pipelineStatus`, `auditMode` — line 48-53). Add `crawlJobIds`.
- `poll-chunk` stage must handle being re-enqueued for an existing batch job gracefully
- No schema changes

---

### BUG-16 — LLM API Errors May Leak API Key in pipelineError

**Severity:** MEDIUM
**File(s):** `app/api/pipeline/stage/route.ts:89-91`
**Status:** Open

#### The Bug (What + Why)

```ts
// route.ts:89-91
async function markFailed(siteId: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  // ...
  await db.update(geoSites).set({
    pipelineError: message,  // ← stored directly in DB
    // ...
  });
}
```

`error.message` is stored verbatim in `geoSites.pipelineError`. If an OpenAI SDK error includes request headers (some HTTP client libraries include the full request in error messages), the `Authorization: Bearer sk-proj-...` header could be stored in the DB.

The `pipelineError` field is returned to clients via `GET /api/sites/[id]` — visible to any user who has access to the site's results.

#### Why Tests Didn't Catch It

**Test file:** NONE for `markFailed()` (see BUG-06). No test checks the content of `pipelineError`. The stage handler's catch block at lines 896-922 is not tested for error message content.

#### Production Impact

**Has this triggered?** Depends on whether OpenAI SDK v4+ includes auth headers in error messages. As of the current SDK version, `error.message` typically does NOT include headers — but this is not guaranteed and varies across SDK versions and error types. The risk is non-zero.

**Damage:** If triggered, the OpenAI API key is stored in the DB and visible to users. Requires immediate key rotation.

**Blast radius:** All users if the key is exposed — anyone can use it.

#### The Fix

Sanitize error messages before storing:

```ts
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Bearer\s+sk-[a-zA-Z0-9_-]+/g, "Bearer [REDACTED]")
    .replace(/Authorization:\s*Bearer\s+[^\s"']+/gi, "Authorization: [REDACTED]")
    .replace(/sk-proj-[a-zA-Z0-9_-]+/g, "[REDACTED_API_KEY]")
    .replace(/sk-[a-zA-Z0-9]{20,}/g, "[REDACTED_API_KEY]");
}

// In markFailed:
const message = sanitizeErrorMessage(
  error instanceof Error ? error.message : String(error)
);
```

**Files to modify:** `app/api/pipeline/stage/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `__tests__/pipeline-mark-failed.test.ts` (same new file as BUG-06)

1. **"error containing 'Bearer sk-proj-abc123...' → stored without the key"**
   - Pass error with message `"Request failed: Authorization: Bearer sk-proj-abc123def456"`
   - Assert stored `pipelineError` contains `[REDACTED]`, not the key

2. **"error containing 'Authorization: Bearer' → header stripped"**
   - Pass error with full header line
   - Assert sanitized

3. **"normal error message → stored as-is"**
   - Pass `"OpenAI API timeout after 30s"`
   - Assert stored unchanged

4. **"error with multiple API keys → all redacted"**
   - Pass error with 2 different keys
   - Assert both redacted

#### Downstream Ripple

- `GET /api/sites/[id]` response — `pipelineError` field now contains sanitized messages
- Server-side console logs (lines 91, 907, 915) still show full errors for debugging
- No schema changes

---

### BUG-18 — Team Provisioning Race Condition

**Severity:** MEDIUM
**File(s):** `lib/services/provision-team.ts:28-74`
**Status:** Open

#### The Bug (What + Why)

`ensureTeamForUser` (line 28) performs a check-then-act:

```ts
// Line 32-35: Check for existing membership
const [existingMember] = await db
  .select().from(teamMembers)
  .where(eq(teamMembers.userId, userId));
if (existingMember) return { teamId: existingMember.teamId, isNewTeam: false };

// Line 64-71: Create new team (if no existing member found)
await db.insert(teams).values({ id: teamId, ... });
// Line 73+: Create team member
await db.insert(teamMembers).values({ ... });
```

Two concurrent calls (double-click on OAuth callback, or OTP verify + OAuth racing) both read no existing member at line 32-35, then both proceed to create a new team at line 64. Result: two teams for one user, each with signup bonus credits.

There is no unique constraint on `teamMembers.userId` — duplicate rows insert without error.

#### Why Tests Didn't Catch It

**Test file:** `lib/services/provision-team.test.ts` — 12 tests.

Tests include "does NOT create duplicate team if called twice for same user" (line 247) — but calls are **sequential**, not concurrent. The first call creates the team, the second call finds the existing member. The mock returns the member on the SECOND `db.select` call — this simulates sequential idempotency, not true concurrency where both reads return empty.

**The specific gap:** The test correctly validates sequential idempotency but cannot detect the race condition because JavaScript mocks don't simulate concurrent DB access. Both calls would need to call `db.select` "simultaneously" and both receive empty results.

#### Production Impact

**Has this triggered?** Unlikely but possible — requires two requests for the same user hitting the function within milliseconds. Most likely trigger: user clicks OAuth button twice quickly, and both callbacks arrive at Vercel simultaneously.

**Damage:** Duplicate team created, double signup bonus credits (40 instead of 20). User might see different data depending on which team their queries hit.

**Blast radius:** Per-user, rare.

#### The Fix

Add a unique constraint on `team_members(user_id)` (for non-null user_id):

```sql
CREATE UNIQUE INDEX team_members_user_id_uniq
  ON team_members (user_id) WHERE user_id IS NOT NULL;
```

Then wrap the insert in a try/catch:

```ts
try {
  await db.insert(teamMembers).values({ ... });
} catch (err: any) {
  if (err.code === '23505') { // unique_violation
    // Race: another call already created the member — fetch and return
    const [member] = await db.select().from(teamMembers).where(eq(teamMembers.userId, userId));
    return { teamId: member.teamId, isNewTeam: false };
  }
  throw err;
}
```

**Files to modify:** `lib/services/provision-team.ts`, migration for unique index

#### Regression Tests (must ship with the fix)

**File:** `lib/services/provision-team.test.ts`

1. **"concurrent ensureTeamForUser → only one team created"**
   - Mock first `db.select` to return empty for both calls
   - Second `db.insert(teamMembers)` throws `{ code: '23505' }` (unique violation)
   - Assert: function catches error, re-reads member, returns existing teamId
   - Assert: `db.insert(teams)` called at most once net

2. **"duplicate teamMembers insert → handled gracefully (ON CONFLICT)"**
   - Mock `db.insert(teamMembers)` to throw unique violation
   - Assert: no error propagated to caller, returns valid teamId

3. **"sequential idempotency still works (existing test — keep)"**
   - Second call finds existing member, returns without insert
   - Existing test at line 247 — keep as-is

#### Downstream Ripple

- Migration required: add unique partial index on `team_members(user_id)`
- `app/auth/callback/route.ts` — unchanged (calls `ensureTeamForUser` which now handles the race)
- `app/api/sites/[id]/verify/route.ts` — unchanged (same)
- Existing duplicate teams in production should be audited and merged

---

### BUG-20 — Credit Ledger balanceBefore/After Drift

**Severity:** MEDIUM
**File(s):**
- `app/api/webhooks/stripe/route.ts:47-72`
- `app/api/pipeline/stage/route.ts:113-129`
**Status:** Open

#### The Bug (What + Why)

In the Stripe webhook (lines 47-55):
```ts
const [team] = await tx.select({ creditBalance: teams.creditBalance })
  .from(teams).where(eq(teams.id, teamId));
const balanceBefore = team.creditBalance;         // ← stale snapshot
const balanceAfter = balanceBefore + creditsAdded;
await tx.update(teams).set({ creditBalance: balanceAfter, ... });
```

The `balanceBefore` is read via SELECT, then `creditBalance` is set to `balanceBefore + creditsAdded`. If another transaction concurrently modifies the balance between the SELECT and UPDATE, the UPDATE overwrites with a stale value.

**Note:** The webhook uses a Drizzle `tx` (transaction), which provides read-committed isolation by default in PostgreSQL — NOT serializable. Two concurrent webhook transactions can both SELECT the same `creditBalance`, then both UPDATE, with the last write winning.

In `markFailed` (lines 113-127), the same pattern occurs without even a transaction wrapper (see BUG-06). The `balanceBefore` is a separate SELECT from a separate query.

Contrast with the correct pattern already used in the assemble stage's bulk refund path, which uses `UPDATE ... RETURNING` and derives `balanceBefore = returned - delta`.

#### Why Tests Didn't Catch It

**Test file:** `app/api/webhooks/stripe/route.test.ts` — the happy path test mocks `teams.creditBalance` as a fixed value. The mock transaction executes all operations synchronously with no concurrent access, so `balanceBefore` is always accurate. The test cannot detect that a real concurrent update would make the SELECT stale.

#### Production Impact

**Has this triggered?** Rare for the webhook (requires two Stripe events processing simultaneously for the same team). More likely for `markFailed` (no transaction, cron + stage timeout racing — see BUG-06).

**Damage:** `balanceBefore` and `balanceAfter` in `creditTransactions` don't match the actual balance at time of update. The audit trail is unreliable — `balanceAfter` of one transaction doesn't match `balanceBefore` of the next.

**Blast radius:** All financial audit entries where concurrent updates occur.

#### The Fix

Use `RETURNING` everywhere:

**Stripe webhook (replace lines 54-60):**
```ts
const creditsAdded = CREDITS_PER_PACK * quantity;

const [updated] = await tx.execute(sql`
  UPDATE teams SET credit_balance = credit_balance + ${creditsAdded}, updated_at = NOW()
  WHERE id = ${teamId}
  RETURNING credit_balance
`);
const balanceAfter = updated.credit_balance;
const balanceBefore = balanceAfter - creditsAdded;
```

**markFailed (fixed as part of BUG-06):** Already uses RETURNING in the proposed fix.

**Files to modify:** `app/api/webhooks/stripe/route.ts`, `app/api/pipeline/stage/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `app/api/webhooks/stripe/route.test.ts`

1. **"balanceBefore derived from RETURNING, not from separate SELECT"**
   - Mock `tx.execute` for the UPDATE...RETURNING to return `{ credit_balance: 150 }`
   - Assert `creditTransactions` insert has `balanceBefore = 50` (150 - 100) and `balanceAfter = 150`

2. **"balanceAfter = balanceBefore + creditsAdded (always consistent)"**
   - For any `creditsAdded` value, assert `balanceAfter - balanceBefore === creditsAdded`

3. **"team SELECT no longer needed for balance"**
   - Assert the SELECT for `team.creditBalance` is removed (or only used for existence check)

#### Downstream Ripple

- All code paths that insert `creditTransactions` should be audited for the same pattern
- The assemble stage's refund path already uses the correct pattern — no change needed there
- No schema changes

---

### BUG-21 — QStash retries=0: Partial Fan-out Leaves Orphaned Chunks

**Severity:** MEDIUM
**File(s):**
- `lib/qstash.ts:47` (`retries: 0`)
- `app/api/pipeline/stage/route.ts:517-530` (`handleGenerateFanout`)
**Status:** Open

#### The Bug (What + Why)

`enqueueStage` at `lib/qstash.ts:47` sets `retries: 0` — intentional, because the pipeline always returns 200. But `enqueueStage` itself can fail (QStash unavailable, network timeout, rate limit).

In `handleGenerateFanout` (lines 517-530):
```ts
await updateStatus(siteId, "generating", {
  generateChunksTotal: total,  // ← set to 5 BEFORE enqueues
  generateChunksDone: 0,
});
await Promise.all(
  GENERATE_CHUNK_TYPES.map((chunkType) =>
    enqueueStage({ siteId, domain, stage: "generate-chunk", generateChunkType: chunkType })
  )
);
```

`generateChunksTotal` is set to 5 **before** the `Promise.all`. If 3 of 5 enqueue calls succeed and the 4th throws, `Promise.all` rejects. The outer catch (line 896) calls `markFailed`, setting `pipelineStatus = "failed"`. But 3 chunks are already enqueued in QStash and will execute. Those chunks:
1. Write generated content to a "failed" site's DB columns
2. Call `fanInGenerateChunk` which increments `generate_chunks_done` on a failed site
3. If `done === total` (3 === 5: won't happen for generate, but for crawl fan-out with fewer chunks it could), trigger `assemble` on a failed site

The same pattern exists in crawl fan-out (not shown here but uses the same `Promise.all` + `enqueueStage` pattern).

#### Why Tests Didn't Catch It

**Test file:** `__tests__/bulk-pipeline.test.ts` line 138 tests "enqueueStage throws → site marked failed". But it tests a **single** `enqueueStage` call failure, not a partial `Promise.all` failure where some calls succeed and others fail.

`enqueueStage` is mocked everywhere as a no-op or a simple spy. No test simulates partial failure of `Promise.all`.

#### Production Impact

**Has this triggered?** Unlikely unless QStash has a partial outage (some messages accepted, others rejected). But QStash rate limits or network blips could cause this.

**Damage:** Orphaned chunks writing to a "failed" site. Wasted LLM API calls ($). Potential for `assemble` to run on a failed site with partial data, producing corrupt results.

**Blast radius:** Per-site, but includes wasted API costs.

#### The Fix

Set `generateChunksTotal` **after** all enqueues succeed:

```ts
await updateStatus(siteId, "generating", {
  generateChunksTotal: 0,  // will be set after successful fan-out
  generateChunksDone: 0,
  generatedSchemaBlocks: null,
});

const results = await Promise.allSettled(
  GENERATE_CHUNK_TYPES.map((chunkType) =>
    enqueueStage({ siteId, domain, stage: "generate-chunk", generateChunkType: chunkType })
  )
);

const failed = results.filter(r => r.status === "rejected");
if (failed.length > 0) {
  // All-or-nothing: if any enqueue failed, mark site as failed
  // The successfully enqueued chunks will find generateChunksTotal = 0
  // and their fan-in will compute done > total, which is a no-op (never triggers assemble)
  throw new Error(`${failed.length} of ${GENERATE_CHUNK_TYPES.length} generate chunks failed to enqueue`);
}

// All succeeded — now set the total
await db.update(geoSites).set({ generateChunksTotal: GENERATE_CHUNK_TYPES.length })
  .where(eq(geoSites.id, siteId));
```

**Files to modify:** `app/api/pipeline/stage/route.ts`

#### Regression Tests (must ship with the fix)

**File:** `__tests__/pipeline-fanout.test.ts` (new file)

1. **"all 5 enqueueStage calls succeed → generateChunksTotal set to 5"**
   - Mock `enqueueStage` to resolve for all 5
   - Assert `generateChunksTotal` updated to 5 AFTER all calls

2. **"3 of 5 enqueueStage calls fail → site marked failed"**
   - Mock `enqueueStage` to reject for chunks 4 and 5
   - Assert `markFailed` called
   - Assert `generateChunksTotal` remains 0 (never set)

3. **"generateChunksTotal only set after all enqueues succeed"**
   - Assert the DB update for `generateChunksTotal = 5` happens AFTER `Promise.allSettled` resolves
   - Assert it does NOT happen in `updateStatus` at the start

4. **"orphaned chunks with generateChunksTotal = 0 → fan-in is no-op"**
   - Simulate a generate-chunk completing for a site with `generateChunksTotal = 0`
   - `fanInGenerateChunk` returns `{ done: 1, total: 0 }`
   - Assert `assemble` NOT enqueued (1 !== 0, and we guard against total = 0)

5. **"crawl fan-out uses same pattern (total set after enqueues)"**
   - Verify the crawl fan-out handler follows the same fix

#### Downstream Ripple

- `handleGenerateChunk` must handle `total = 0` gracefully (fan-in returns done > 0 but total = 0 → no-op)
- Same fix should be applied to crawl fan-out for consistency
- No schema changes

---

### BUG-17 — No CSRF Protection on State-Changing Endpoints

**Severity:** LOW
**File(s):** All POST route handlers
**Status:** Open (backlog)

#### The Bug (What + Why)

No CSRF token validation on state-changing endpoints (`/api/checkout`, `/api/sites`, `/api/sites/[id]/verify`, `/api/sites/[id]/regenerate`).

Mitigated by: JSON `Content-Type` requirement (browsers won't send cross-origin JSON without CORS preflight), `SameSite=Lax` cookies, and no `Access-Control-Allow-Origin: *` header. Practical risk is low given current architecture.

#### Why Tests Didn't Catch It

Not a test gap — CSRF protection was never implemented, so there's nothing to test.

#### Production Impact

Theoretical. Exploitation requires the user to visit a malicious page while authenticated. Even then, the attacker would need to bypass the JSON Content-Type requirement.

#### The Fix

Add CSRF tokens for cookie-authenticated endpoints. Low priority — backlog.

#### Regression Tests (must ship with the fix)

When implemented:
1. "POST without CSRF token → 403"
2. "POST with valid CSRF token → proceeds normally"
3. "CSRF token rotation on session refresh"

#### Downstream Ripple

All POST handlers would need to validate the token. Client must include it in requests.

---

## Cleared (Not Bugs)

| # | Concern | Finding |
|---|---------|---------|
| BUG-08 | Resend code creates new site | **Not a bug.** Code detects existing record by domain+email, updates in place. |
| BUG-09 | Pro fast-path credit reservation not transactional | **Not a bug.** Already wrapped in `db.transaction()`. |
| BUG-12 | Rate limit bypass via email case | **Not a bug.** Email normalized to lowercase before all checks. |
| BUG-14 | batchId query fails after code cleared | **Not a bug.** Uses `batchId` (never cleared), not `verificationCode`. |
| BUG-15 | Download report no auth | **Has auth.** Checks `accessToken` via query param. Risk only if BUG-05 is exploited. |
| BUG-19 | Webhook body encoding wrong | **Correct.** Uses `req.text()` which preserves raw bytes for HMAC verification. |

---

## Recommended Fix Order

1. **BUG-05** — Remove early return in verify (5 min, immediate security win)
2. **BUG-01** — Add idempotency check to Stripe webhook (15 min, prevents revenue loss)
3. **BUG-07** — Filter failed sites from free audit count (5 min, unblocks users)
4. **BUG-06** — Wrap markFailed in atomic claim (15 min, prevents over-refund)
5. **BUG-04** — Make generate-chunk fan-in atomic (30 min, prevents stuck pipelines)
6. **BUG-11** — Import constants from config (10 min, fix off-by-one)
7. **BUG-10** — Add freshness check to cached results (10 min)
8. **BUG-18** — Add unique constraint to team_members (15 min + migration)
9. **BUG-20** — Use RETURNING pattern for ledger accuracy (30 min)
10. **BUG-16** — Sanitize error messages (10 min)
11. **BUG-13** — Smarter cron re-enqueue (1 hr)
12. **BUG-21** — Guard partial fan-out (30 min)
13. **BUG-17** — CSRF tokens (backlog)

---

## Testing Strategy & Guardrails

These rules apply to **all** fixes in this report and to all future development:

### Rule 1: Every fix ships with its regression test

No fix PR is merged without the tests specified in its "Regression Tests" section. The tests must fail before the fix and pass after. No exceptions.

### Rule 2: Financial operations require idempotency tests

Any code that changes `teams.creditBalance` or inserts into `creditTransactions` must have a **duplicate-call test**: call the operation twice with the same inputs, assert credits are applied exactly once.

Applies to: BUG-01 (Stripe webhook), BUG-06 (markFailed refund), BUG-20 (ledger drift).

### Rule 3: Fan-in/fan-out stages require atomicity tests

Any counter increment (`crawlChunksDone`, `generateChunksDone`) must be tested for:
- Partial failure (some chunks succeed, some fail)
- Exactly-once trigger (last chunk triggers next stage exactly once)
- Counter consistency (done never exceeds total)

Applies to: BUG-04 (generate fan-in), BUG-21 (partial fan-out).

### Rule 4: Race condition tests use "mock-delay" pattern

For check-then-act races:
1. Mock the first SELECT to return empty for both callers
2. Mock the second INSERT to succeed for caller 1 and throw unique_violation for caller 2
3. Assert only one INSERT succeeds net

Applies to: BUG-06 (double refund), BUG-18 (team provisioning race).

### Rule 5: Error messages stored in DB must be sanitized

Any error message persisted to the database must pass through a sanitization function that strips API keys, auth headers, and other secrets. Test with known patterns.

Applies to: BUG-16 (API key leak).

### Recommended: Add `__tests__/helpers/concurrency.ts`

Utility for race condition testing:

```ts
/**
 * Simulates a race condition by running `fn` N times "concurrently"
 * (sequentially with mocks arranged to simulate concurrent reads).
 */
export async function simulateRace<T>(
  fn: () => Promise<T>,
  times: number,
  mockSetup: (callIndex: number) => void
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < times; i++) {
    mockSetup(i);
    results.push(await fn());
  }
  return results;
}
```

---

## Test Coverage Summary

| Bug | New Test File | New Test Cases | Modify Existing Tests |
|-----|--------------|----------------|----------------------|
| BUG-01 | — | 3 | `route.test.ts` (add to existing) |
| BUG-04 | `__tests__/pipeline-fanin.test.ts` | 6 | — |
| BUG-05 | — | 4 | `verify/route.test.ts` (modify 1 existing) |
| BUG-06 | `__tests__/pipeline-mark-failed.test.ts` | 6 | — |
| BUG-07 | `__tests__/free-audit-limit.test.ts` | 6 | — |
| BUG-10 | `__tests__/site-cache.test.ts` | 5 | — |
| BUG-11 | `__tests__/config-sync.test.ts` | 5 | — |
| BUG-13 | `app/api/cron/process-queue/route.test.ts` | 8 | — |
| BUG-16 | (with BUG-06 file) | 4 | — |
| BUG-18 | — | 2 | `provision-team.test.ts` (add to existing) |
| BUG-20 | — | 3 | `route.test.ts` (add to existing) |
| BUG-21 | `__tests__/pipeline-fanout.test.ts` | 5 | — |
| **TOTAL** | **6 new files** | **57 test cases** | **3 files modified** |
