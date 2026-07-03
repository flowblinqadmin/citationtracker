# Pseudocode Review — `fix/audit-incremental-on-main` vs `main`

> **Purpose:** a plain-language, pseudocode walkthrough of every behavioural change
> on this branch so you can review and engage *without* reading the diff line-by-line.
> Each section gives you: **the bug** (what `main` does today), **the fix** (pseudocode),
> and **why it matters** (customer/financial impact). Finding IDs map to
> `docs/BUG-AUDIT-2026-06-09.md`.
>
> **Branch:** `fix/audit-incremental-on-main` → PR #193
> **Base:** `origin/main` (merge-base `665f978`)
> **Shape:** 22 commits · 51 files · +5,537 / −230
> **Constraint:** additive-only on top of cofounder's `main`. Nothing here changes
> or reverts his work — every change is a new guard, column, helper, or test.

---

> ### 📌 Update log (2026-06-10) — read this first
> Your six inline questions are now **answered in place** — search for **`ANSWER`**
> to jump to each (✅ resolved, ⚠️ open gap, 🔄 changed since written):
> - **Q (1a)** "why reactivate an existing sub" → ✅ it's Stripe redelivery, not a customer action.
> - **Q (2a)** "isn't this guarded elsewhere?" → ✅ verified: no; the atomic CAS-clear is the real guard.
> - **Q (6b)** "how does it show up for the customer?" → ⚠️ **OPEN GAP you caught** — the no-data flag is computed but **never consumed**; outage still shows a bare 0%.
> - **Q (6c)** "is gpt-5.4 the right model?" → ✅ current, kept (gpt-5.5 is overkill/2× cost).
> - **Q (6d)** "are Google's models updated?" → ✅ **DONE** — all Gemini → `gemini-3.5-flash` (`054fb79`, see `docs/CHANGELOG.md`).
> - **Q (7)** "did routing change for external providers?" → ✅ yes for OpenAI-style; partial for Claude/Gemini (caveat noted).
>
> **🔄 Theme 6a was REVERSED** after a live incident (graceful-0 scorecard showed flowblinq's real 72 as 0). The section now documents the throw-and-retry fix (`051f175`). Same lesson drives the 6b gap.

---

## How to read this

The delta breaks into **8 themes**. Each theme is independent — you can accept or
push back on them one at a time. Roughly in priority order (money/data-loss first):

| # | Theme | Findings | Blast radius |
|---|-------|----------|--------------|
| 1 | Stripe webhook safety (clobber / double-activate / renewal date) | NEW-A-01, W-05, W-06 | **Money + account takeover** |
| 2 | Pipeline credit/page idempotency | NEW-L-01, AI-01, AI-02 | **Money (double-refund)** |
| 3 | Subscription-pages reconciliation | NEW-P-01 | **Customer allowance loss** |
| 4 | Crawl fan-in (poll-first) | integration #1 | Audits stall, never complete |
| 5 | Gmail-alias free-audit bypass | NEW-A-02 | Free-tier abuse |
| 6 | LLM robustness (parse / no-data / model pins) | NEW-AI-03/04/06/07 | Audit hard-fails, false 0% |
| 7 | LLM call centralization + local-LLM routing | centralise-llm-calls | Testability (prod unaffected) |
| 8 | Security hardening (RLS REVOKE + CHECKs, rate-limit) | NEW-S-01/02/03, A-06 | Defense-in-depth |

---

## Theme 1 — Stripe webhook safety

File: `app/api/webhooks/stripe/route.ts`

### 1a. NEW-A-01 — "reconcile, don't clobber" (subscription takeover)

**The bug (main today):**
When a `checkout.session.completed` for a subscription signup arrives, the handler
resolves a team from the email and then **blindly overwrites** the team's billing
columns. If that email already belongs to a returning customer with a *live, different*
subscription, their existing subscription is orphaned and their credit balance is wiped.

```
ON subscription checkout completed:
    team = provisionUserAndTeamFromEmail(email)   # may return an EXISTING team
    SET team.stripeSubscriptionId = newSubId       # ← clobbers their live sub
    SET team.creditBalance         = tier.credits  # ← wipes their balance
```

**The fix (pseudocode):**

```
ON subscription checkout completed:
    team = provisionUserAndTeamFromEmail(email)

    IF newSubId is present:
        existing = SELECT subscriptionStatus, stripeSubscriptionId
                   FROM teams WHERE id = team.id

        IF existing.status == "active"
           AND existing.subId is set
           AND existing.subId != newSubId:
               # Returning customer with a DIFFERENT live subscription.
               # Do NOT overwrite. Alert ops, ack the webhook (200 so Stripe
               # stops retrying — a retry would just clobber again), and stop.
               log_error("subscription_signup_clobber_conflict", {...})
               sendInternalPaymentAlert("manual follow-up required")
               RETURN 200 {skipped: "clobber_conflict"}

    # Safe: team is new/inactive OR carries the same subId (re-activation)
    activate_subscription(team, tier)
```
Question - Why would a customer reactivate when their subscription exists? what scenario does this even happen

> **✅ ANSWER (2026-06-10):** It isn't a *customer* action — it's **Stripe re-delivering the same webhook**. Stripe is at-least-once: a `checkout.session.completed` can arrive twice (network blip, our slow ack / 500, a manual replay from the Stripe dashboard during support, or `customer.subscription.updated` firing right after activation). The `subId == existing.subId` branch exists purely to make that **redelivery idempotent** — re-activating the *same* subscription is safe. The only dangerous branch is a *different* active subId (a returning customer whose live sub would be clobbered) → halt + alert ops. No customer ever deliberately "re-subscribes to a sub they already have."

**Why it matters:** without this, a second checkout under an existing customer's email
silently destroys their subscription + credits. This is the account-takeover class
flagged as NEW-A-01. The fix is conservative — on conflict it does **nothing
destructive** and hands off to a human.

### 1b. NEW-W-06 — idempotency marker for concurrent redeliveries

**The bug:** Stripe can deliver the same event twice concurrently. Both deliveries
read "no subscription yet" *before* either commits the `stripeSubscriptionId`, so the
existing `subscriptionId` guard doesn't catch the race → double activation.

**The fix (pseudocode):**

```
ON subscription checkout completed (after the clobber check):
    # Dedup on the Stripe session.id, reusing the creditTransactions table
    # (same siteId=session.id key the top-up path already uses — no schema change)
    marker = SELECT id FROM creditTransactions
             WHERE siteId == session.id AND type == "topup"
    IF marker exists:
        RETURN 200 {idempotent: true}      # someone already processed this session

    activate_subscription(...)             # the real work

    # Write the marker AFTER activation. type="topup", creditsChanged=0 is a
    # zero-value sentinel row. If THIS insert fails, the stripeSubscriptionId
    # guard still catches retries — so the failure is non-fatal.
    TRY insert creditTransactions{siteId: session.id, type: "topup", creditsChanged: 0}
    CATCH duplicate_key: ignore   # another concurrent delivery beat us — fine
```

**Why it matters:** stops the same paid signup from activating twice / granting
credits twice under concurrent webhook delivery. Note it leans on an existing table
rather than a migration — low risk, but worth your eyes on the "reuse topup row" choice.

### 1c. NEW-W-05 — renewal email shows the wrong next-charge date

**The bug:** the renewal email computed `nextDate = periodEnd + 31 days`. `periodEnd`
**is already** the next charge date. The `+31d` offset is flat wrong for quarterly /
annual plans (reports a month past the real charge).

**The fix:**

```
- nextDate = format(periodEnd + 2678400 seconds)   # +31 days — WRONG
+ nextDate = format(periodEnd)                       # periodEnd IS the next charge
```

**Why it matters:** pure customer-trust / support-load fix. No money moves; just an
incorrect date in a transactional email.

---

## Theme 2 — Pipeline credit/page idempotency

File: `app/api/pipeline/stage/route.ts` (`handleAssemble`) + `app/api/cron/process-queue/route.ts`

### 2a. NEW-L-01 — double credit refund on cron re-entry

**The bug:** the assemble stage refunds unused reserved credits. The safety-net cron
re-enqueues stale "assembling" sites. If a site is re-assembled, the refund runs
**again** — crediting the customer twice for the same unused pages.

```
handleAssemble(site):
    reserved = site.creditsReserved
    refund   = reserved - actualCreditsUsed
    IF refund > 0:
        team.creditBalance += refund     # ← runs again on every re-entry
```

**The fix (pseudocode) — atomic clear + completion-write clear:**

```
handleAssemble(site):
    # Guard 0: already done? bail before ANY work (incl. refund)
    IF site.pipelineStatus == "complete":
        RETURN

    refundAlreadyProcessed = (site.creditsReserved IS NULL or == 0)

    IF NOT refundAlreadyProcessed AND refund > 0:
        TRANSACTION:
            # CAS-clear inside the same tx — a concurrent invocation that reads
            # the row after commit sees NULL and skips.
            UPDATE geo_sites SET creditsReserved = NULL
                WHERE id = site.id AND creditsReserved IS NOT NULL
            UPDATE teams SET creditBalance += refund WHERE id = site.teamId
            INSERT ledger row

    ... at the final completion write ...
    SET creditsReserved = NULL    # belt-and-braces: even if no refund was needed,
                                  # re-entry now reads NULL and skips reconciliation
```

**Why it matters:** directly prevents the customer being over-credited. The pattern —
*CAS-clear the reservation inside the same transaction as the balance write* — is the
core anti-double-spend technique; worth confirming you're happy with it as the
house style (it's reused in Theme 3).
Question - are you sure? This seems like something that gets guarded somewhere else.

> **✅ ANSWER (2026-06-10):** Verified directly against `origin/main` — it is **not** guarded elsewhere. main's `handleAssemble` has **no** entry guard and does **not** clear `creditsReserved` on the completion write. Your instinct is half-right though: the `pipelineStatus === "complete"` check is only a cheap fast-path. The real danger window is a site stuck in **`"assembling"`** (refund ran, then the invocation died *before* writing `"complete"`) — the cron re-enqueues *assembling* sites, so a `complete`-check alone wouldn't catch it. The **load-bearing guard is the atomic CAS-clear of `creditsReserved` inside the same transaction as the balance write**: the second invocation reads `NULL` and skips. That's the part that actually prevents the double-refund.
### 2b. NEW-AI-01 — cron re-enqueue drops `runNumber`, bypassing the idempotency guard

**The bug:** the stage handler has a `runNumber` idempotency guard, but the cron
safety-net re-enqueued stages **without** `runNumber`. With it undefined, the guard
treats the message as "no idempotency requested" and re-runs analyze / generate-fanout
against stale in-progress rows.

**The fix:**

```
cron re-enqueue:
    runNumber = site.currentRunNumber        # ← now SELECTed and threaded
    enqueueStage({siteId, domain, stage, runNumber})   # every stage, not just discover
```

**Why it matters:** makes the cron net safe to fire repeatedly — it can no longer
reset generated state or double-fire chunks.

### 2c. NEW-AI-02 — same idempotency, applied to the assemble re-entry

Covered by Guard 0 above (`pipelineStatus == "complete" → RETURN`). Stale cron
re-enqueue of an already-complete assembling site does no work.

---

## Theme 3 — Subscription-pages reconciliation (NEW-P-01)

Files: `app/api/sites/route.ts`, `.../[id]/verify/route.ts`, `.../[id]/regenerate/route.ts`,
`app/api/pipeline/stage/route.ts`, schema + migration.

**The bug:** subscription pages are charged **up-front** (`monthlyPagesUsed += reserved`).
Credits already get reconciled on under-crawl, but **subscription pages did not** — if a
subscriber reserved 50 pages and the crawl only used 12, the other 38 were permanently
burned from their monthly allowance.

**The fix — mirror the `creditsReserved` lifecycle for subscription pages:**

```
# 1. New column: geo_sites.subscription_pages_reserved (default 0)
# 2. At audit start (sites/verify/regenerate), stamp what we reserved:
    SET subscriptionPagesReserved = budget.subscriptionPages

# 3. At assemble, reconcile the unused portion back:
handleAssemble(site):
    reserved = site.subscriptionPagesReserved
    IF reserved > 0:                                   # not yet reconciled
        usedFromSub  = min(actualPagesCrawled, reserved)   # sub pages are "used first"
        toReturn     = reserved - usedFromSub
        IF toReturn > 0:
            TRANSACTION:
                cleared = UPDATE geo_sites SET subscriptionPagesReserved = 0
                          WHERE id = site.id AND subscription_pages_reserved > 0
                          RETURNING id
                IF cleared is empty: RETURN          # another invocation won the race
                UPDATE teams
                    SET monthlyPagesUsed = GREATEST(0, monthlyPagesUsed - toReturn)
        ELSE:
            SET subscriptionPagesReserved = 0          # all used, just clear marker

    ... completion write ...
    SET subscriptionPagesReserved = 0                  # belt-and-braces
```

**Why it matters:** a subscriber who under-crawls now gets their allowance back. The
`GREATEST(0, …)` floor prevents underflow if a prior bug already decremented below the
reserved count. Same atomic-CAS idempotency as Theme 2 → safe under cron re-entry.

**Reviewer note — the "used first" assumption:** subscription pages are assumed
consumed *before* credits. That mirrors how the budget is split at reservation time.
Confirm that matches your intended billing semantics — it's the one judgement call here.

---

## Theme 4 — Crawl fan-in (poll-first, integration simplification #1)

File: `app/api/pipeline/stage/route.ts` (`handleCrawlFanout`)

**The bug (surfaced by the local bulk-audit stall):** `crawlChunksTotal` was set
*after* the submission loop. In `LOCAL_PIPELINE` mode `enqueueStage` runs the
poll-chunk **inline during** the loop, so the fan-in counter increments `done` against
`total == 0`. `done` never equals `total` → `merge-crawl` never fires → audit stalls
forever (we saw it hang at 8/10).

**The fix (pseudocode):**

```
handleCrawlFanout(site):
    numChunks = chunks.length
    # Set total UP-FRONT so inline polls see a real target
    SET crawlChunksTotal = numChunks, crawlChunksDone = 0

    FOR each chunk i:
        TRY submit chunk i
        CATCH submission error:
            record failed urls
            # No poll was enqueued for this chunk — fan it in NOW as abandoned
            (done, total) = fanInChunk(site, [], chunkUrls)   # atomic
            IF done == total AND successfulChunks > 0:
                enqueueStage(merge-crawl)     # exactly one caller observes done==total

    # (removed) the old "set total = successfulChunks AFTER loop" write is gone
```

**Why it matters:** makes the pipeline complete under local/poll-first execution
**and** keeps prod (async QStash) identical — in prod the poll runs later, sees the
up-front total, and merges normally. `fanInChunk` is an atomic `UPDATE…RETURNING`, so a
failed-submission fan-in and a real poll can't both trigger merge. This is what unblocked
the 10-URL FlowBlinq bulk audit locally.

**Reviewer note:** the correctness hinge is "exactly one caller sees `done == total`."
That holds because `fanInChunk` is atomic. Worth a careful read of that function if
you want to be fully convinced — the tests in `__tests__/integration/crawl-fanout-flow.test.ts`
assert the up-front-total behaviour.

---

## Theme 5 — Gmail-alias free-audit bypass (NEW-A-02)

Files: `lib/email-canonical.ts` (new), `app/api/sites/route.ts`, schema + migration.

**The bug:** the `FREE_AUDIT_LIMIT` (2 per email) counted by exact lowercased email.
Gmail ignores dots and `+tags`, so `u.ser@gmail.com`, `user+1@gmail.com`,
`user+2@gmail.com` all reach the same inbox but counted as distinct → unlimited free audits.

**The fix (pseudocode):**

```
canonicalizeEmail(email):
    e = lowercase(trim(email))
    (local, domain) = split e on last "@"
    IF domain in {gmail.com, googlemail.com}:
        local = local before "+"          # drop sub-address tag
        local = remove all "." from local # gmail ignores dots
        RETURN local + "@gmail.com"        # normalise googlemail → gmail
    ELSE:
        RETURN e                           # other providers: lowercase only

# New indexed column geo_sites.owner_email_canonical, written on every insert.
# Free-audit count now uses an indexed equality scan:
existing = SELECT id FROM geo_sites WHERE ownerEmailCanonical == canonicalizeEmail(email)
IF existing.length >= FREE_AUDIT_LIMIT: block
```

**Why it matters:** closes the free-tier abuse vector. Deliberately **conservative**:
only Gmail is canonicalized (other providers treat dots/plus literally, so over-
normalizing would wrongly merge distinct accounts). Backfill is going-forward only —
existing NULL rows are treated as unblocked, which is correct because they predate
enforcement.

**Reviewer note:** the index + canonical-equality replaces a full-table scan, so this
is also a small perf win. The raw `ownerEmail` is still stored as-is for delivery/display.

---

## Theme 6 — LLM robustness

Files: `lib/services/geo-analyzer.ts`, `lib/services/citation-checker.ts`,
`lib/services/citation-prompt-generator.ts`, `lib/claude.ts`, `lib/types/citation.ts`.

### 6a. NEW-AI-04 — a fenced/truncated LLM response hard-failed the whole audit

**The bug:** `GeoScorecardSchema.parse(JSON.parse(raw))` with no guard. One markdown
fence (```` ```json ````) or a truncated response throws → the entire audit fails.

> **🔄 UPDATED (2026-06-10) — this fix was REVERSED after a live incident.** My
> original fix (below, struck through) returned a *graceful empty scorecard
> (0/100)* on parse failure. On its first live run it turned a transient Gemini
> truncation into a **completed audit scoring 0** — flowblinq.com's real score of
> 72 showed as **0, twice in a row.** Silently-wrong customer data is worse than a
> visible retry. Cofounder commit `051f175` reversed it.

**The fix (CURRENT, after `051f175`):**

```
parse_scorecard(raw):
    TRY:
        stripped = strip ```json fences from raw      # KEPT — the good half
        RETURN schema.parse(JSON.parse(stripped))
    CATCH:
        log_error("NEW-AI-04 parse fail")
        THROW                                          # do NOT return zeros —
        # → stage 500s → QStash retries (analyze ∈ retryableStages, 2 retries,
        #   30s/60s backoff) → persistent failure surfaces as a FAILED audit
```

Plus the **root cause** was fixed: gemini thinking tokens count against
`maxOutputTokens`; at 16000 reasoning starved the JSON. Raised to **32768**.
And on 2026-06-10 the model was modernized to **`gemini-3.5-flash`** (which
thinks *more*, so the generous budget matters even more) — commit `054fb79`.

~~**Original (reverted) fix:**~~

```
    CATCH:
        RETURN graceful_empty_scorecard(   # ❌ REVERTED — showed real 72 as 0
            note = "Re-run the audit — LLM response was malformed")
```

**Why it matters:** the lesson is the through-line of this whole theme — **never
render a fabricated/zero value as if it were a real measurement.** Fail loud
(retry) or show an explicit "couldn't measure." This is exactly the still-open
gap in 6b below.

### 6b. NEW-AI-06 — all-provider outage looked like a genuine 0% citation score
question - how does this show up for the customer? do we have fallbacks?

> **⚠️ ANSWER (2026-06-10) — REAL GAP YOU CAUGHT:** Right now it **does not** show up for the customer. `allProvidersNoData` / `noData` are computed, returned, and logged **server-side only** — *nothing consumes them*. The citation-check route doesn't read the flag, and `HeroMetrics` / `citation-analytics` have no no-data branch. So a total provider outage **still renders as a bare 0%** to the customer. The flag is half-wired. **This is the same antipattern that caused the flowblinq 72→0 live incident** (see Theme 6a, since reversed): never render a fabricated 0 as if it were a real measurement. **Decision:** wire the flag through to an explicit *"Couldn't measure — provider outage"* state in `HeroMetrics`, OR treat total outage as a retryable failure. **Status: OPEN — not yet wired.**
**The bug:** if every citation provider errored (bad keys / outage), visibility came
back `0%` — indistinguishable from "brand genuinely not cited anywhere." Customers
would see an alarming real-looking 0.

**The fix (pseudocode):**

```
per provider:
    noData = (no indirect prompts) OR (every indirect response is an error)

allProvidersNoData = providerResults nonempty AND every provider.noData == true

IF allProvidersNoData:
    log_warn("citation_check_all_providers_no_data")
RETURN { ...scores, allProvidersNoData }   # caller can show "couldn't measure"
                                            # instead of a fake 0%
```

**Why it matters:** distinguishes "we couldn't measure" from "you scored 0." Adds a
`noData?: boolean` to `ProviderResult` and `allProvidersNoData` to the result — both
additive, no behaviour change when providers succeed.

### 6c. NEW-AI-03 — `max_tokens` vs `max_completion_tokens` on reasoning models
Question - investigate whether this is the right model to use for our requirement

> **✅ ANSWER (2026-06-10):** The `max_completion_tokens` fix is correct **regardless of model** (gpt-5.x reasoning models reject `max_tokens`). On model choice: pulled the live model cards + tested with real keys — **`gpt-5.4` and `gpt-5.4-mini` are current, not deprecated.** `gpt-5.5` exists but is ~2× the cost and aimed at frontier coding — overkill for JSON scoring / content gen. **Decision: keep gpt-5.4-mini** (deliberate cost/quality pick). Verified live: both `gpt-5.4` and `gpt-5.4-mini` return parseable output. **No change made.**
`gpt-5.x` reasoning models require `max_completion_tokens`; the old `max_tokens`
starved/failed the call. Fixed at every OpenAI-compatible call site.

### 6d. NEW-AI-07 — `gemini-2.5-flash-lite` hallucinates on unknown brands
Question - models have been updated by google, check if this is the best model to use

> **✅ ANSWER (2026-06-10) — DONE:** You were right; `gemini-2.5-flash` was a full generation behind. **Bumped every Gemini call site to `gemini-3.5-flash`** (+ `gemini-3.1-flash-lite` for narrative gen), verified live against the API — commit `054fb79`, see `docs/CHANGELOG.md`. Notes: `gemini-3-pro-preview` returns **404 "no longer available"**, so there is no stable Gemini 3.x Pro — the large-crawl tier also moved to `gemini-3.5-flash` (frontier-class **and ~2× faster** than the old 2.5-pro in JSON mode). Output budgets were kept/raised because 3.5-flash spends *more* thinking tokens than 2.5-flash. **⚠️ Re-baseline note:** `citation-checker`'s Google probe is a *measurement* model, so Google citation/visibility scores can shift after this deploy with no site change — documented in the changelog.
Citation-prompt generation bumped `flash-lite → flash` (lite invents facts about
brands it doesn't know, poisoning the prompts).

---

## Theme 7 — LLM call centralization + local-LLM routing (centralise-llm-calls)
Question: - Does this mean you also changed the actual routing in the code was also updated? This can  help us use external providers for our llm calls. This will also help with devops whenever models are updated

> **✅ ANSWER (2026-06-10):** Yes — for the **OpenAI-compatible** path. Routing now flows through three helpers: `openAILikeBaseUrl()` (set `LLM_BASE_URL` → point at *any* OpenAI-compatible provider — Together, Fireworks, OpenRouter, Azure OpenAI, local LM Studio — with **zero code change**), `resolveOpenAIModel(default)` (model bumps become one-line/env changes, exactly the devops win you describe), and `openAIApiKey()`. **⚠️ Honest caveat:** this fully covers OpenAI-style calls. The **Anthropic-native** (`claude.ts`) and **Gemini-native** (`geo-analyzer.callGemini`) paths still call their own SDKs directly *except* when `LLM_LOCAL` is set. So "swap providers via env for **all** LLM calls" is **true for OpenAI-style, partial for Claude/Gemini.** Full provider-portability + one-place model management across all three is the logical next step (route Claude + Gemini through the gateway too).
File: `lib/llm/openai-route.ts` (new) — consumed by claude.ts, geo-analyzer.ts,
content-generator.ts, citation-prompt-generator.ts.

**The intent:** every OpenAI-compatible call duplicated `new OpenAI({apiKey})` + a
hardcoded base URL + a hardcoded model. That made it impossible to (a) point the whole
pipeline at a local LM Studio server for testing, and (b) change a model pin in one place.

**The fix (pseudocode) — four tiny helpers + drop-in client:**

```
openAILikeBaseUrl()      = env.LLM_BASE_URL ?? "https://api.openai.com/v1"
isLocalLLM()             = env.LLM_LOCAL == "1" OR env.LLM_BASE_URL is set
resolveOpenAIModel(def)  = isLocalLLM() ? (env.LLM_LOCAL_MODEL ?? "google/gemma-4-12b") : def
openAIApiKey()           = env.OPENAI_API_KEY ?? (isLocalLLM() ? "local" : "")
createOpenAIClient()     = new OpenAI({ apiKey: openAIApiKey(), baseURL: openAILikeBaseUrl() })

# Call sites change from:
    new OpenAI({apiKey: env.OPENAI_API_KEY})         model: "gpt-5.4-mini"
# to:
    createOpenAIClient()                              model: resolveOpenAIModel("gpt-5.4-mini")

# claude.ts / geo-analyzer.ts also gain a local short-circuit:
    IF isLocalLLM():
        POST {base}/chat/completions  with the resolved local model
        RETURN          # bypass Anthropic / Gemini entirely
```

**Why it matters — and the safety argument:** in production **none** of the `LLM_*`
vars are set, so `isLocalLLM()` is false, `resolveOpenAIModel` returns the original
pin, and `openAILikeBaseUrl()` returns real OpenAI. **Prod behaviour is byte-for-byte
unchanged.** The only new capability is: set 2 env vars → the whole pipeline runs against
a local model for end-to-end testing (this is what `__tests__/system/prod-sim-local-llm.test.ts`
uses).

**Reviewer note:** the one judgement call is `isLocalLLM()` returning true whenever
`LLM_BASE_URL` is set (not only `LLM_LOCAL=1`). That's intentional — setting a base URL
*is* the opt-in — but confirm no prod config sets `LLM_BASE_URL` for an unrelated reason.

---

## Theme 8 — Security hardening

### 8a. NEW-S-01/02/03 — RLS REVOKE + DB CHECK constraints

File: `lib/db/migrations/20260609-rls-revoke-and-checks.sql` (additive to the existing
`20260605-enable-rls-all-tables.sql` — does **not** modify it).

```
# NEW-S-01: for every public BASE table except consent_records:
    REVOKE ALL ON <table> FROM anon, authenticated
# → converts "RLS silently returns 0 rows" into a hard 42501 error (fail loud).
# App + service role are the postgres superuser (BYPASSRLS) → ZERO runtime impact.

# NEW-S-02: CHECK constraints make text columns a closed domain at the storage layer
    teams.subscription_tier   IN (free, starter, growth, pro)
    teams.subscription_status IN (active, past_due, canceled, inactive, trialing, unpaid, paused)

# NEW-S-03: non-negative money/usage counters
    teams.credit_balance      >= 0
    teams.monthly_pages_used  >= 0
    # (skips adding the constraint if existing rows already violate it — warns instead,
    #  so the migration never aborts on dirty data)
```

**Why it matters:** defense-in-depth. The REVOKE makes any accidental anon-role DB
access **fail loudly** instead of silently returning empty. The CHECKs stop illegal
tier/status/negative-balance values from *any* path (raw SQL, admin scripts, migration
bugs) — not just the TypeScript layer. Whole migration is idempotent + safe to re-run.

**Reviewer note:** verify the app truly connects as the superuser/service role in every
environment (the migration header asserts this via `lib/db/index.ts`'s connection chain).
If any path connects as `anon`/`authenticated`, the REVOKE would break it — but per the
connection priority chain, none does.

### 8b. NEW-A-06 — per-email rate limit on subscription-signup checkout

File: `app/api/subscription-signup/checkout/route.ts`

**The bug:** only a per-IP limit existed. A rotating-IP botnet could spam a victim's
inbox with unsolicited Stripe checkout/confirmation emails.

**The fix:**

```
# Existing: 15 / 10 min per IP. Added, after email validation:
rl = checkRateLimit("sub-signup-email:" + email, limit=3, window=1 hour)
IF NOT rl.allowed: RETURN 429
```

DB-persisted (holds across serverless cold starts), keyed on the canonical email so it
works across IPs. A real user retrying 3×/hour is fine; beyond that is abuse.

### 8c. NEW-C-02 — checkout description hardcoded `*5`

File: `app/api/checkout/route.ts`

```
- description = `${credits} credits — audit up to ${credits * 5} pages`
+ description = `${credits} credits — audit up to ${credits * PAGES_PER_CREDIT} pages`
```

Pure correctness: the Stripe line-item description now tracks the config constant
instead of a magic number that would silently lie if `PAGES_PER_CREDIT` changed.

---

## Test coverage added (so the fixes can't silently regress)

| Test file | Tier | Covers |
|-----------|------|--------|
| `app/api/webhooks/stripe/__tests__/billing-clobber-idempotency.test.ts` | unit | Theme 1 (clobber + dedup) |
| `__tests__/integration/assemble-credit-refund-idempotency.test.ts` | integration (real PG) | Theme 2a double-refund |
| `__tests__/integration/assemble-subscription-pages-reconciliation.test.ts` | integration | Theme 3 |
| `__tests__/cron-process-queue-run-number.test.ts` | unit | Theme 2b runNumber threading |
| `__tests__/integration/crawl-fanout-flow.test.ts` | integration | Theme 4 poll-first |
| `__tests__/integration/email-alias-audit-limit.test.ts` + `lib/__tests__/email-canonical.test.ts` | integration + unit | Theme 5 |
| `lib/services/__tests__/geo-analyzer-new-ai-04.test.ts`, `__tests__/citation-checker.test.ts`, `lib/__tests__/claude-new-ai-03.test.ts`, `.../citation-prompt-generator-new-ai-07.test.ts` | unit | Theme 6 |
| `lib/llm/__tests__/openai-route.test.ts` | unit | Theme 7 routing helpers |
| `__tests__/integration/rls-revoke-enforcement.test.ts`, `.../rls-check-constraints.test.ts` | integration | Theme 8a |
| `__tests__/system/prod-sim-local-llm.test.ts` | system | Theme 7 end-to-end on local LLM |
| `e2e/billing-lifecycle.spec.ts`, `e2e/customer-integration.spec.ts`, `e2e/bulk-flowblinq.spec.ts` | E2E (Playwright) | customer flows |

**Test philosophy applied:** the integration tier runs against **real Postgres** (`:54322`,
`host.docker.internal` from Docker) — these are the tests that catch the cross-module
leakages a mocked DB hides (the reason 3,945 passing tests missed the original 84 bugs).

---

## What is NOT in this branch (deliberately)

- **No changes to anything your cofounder shipped.** Every change is additive — a new
  guard, column, helper, or test. Nothing reverts or rewrites his work.
- **No `tier.pages` rewrite.** Pages stay the advertised marketing figure (an earlier
  agent rewrote it to `credits × 10` and broke the "prices match the website" guarantee
  — reverted).
- **No push to `main` / prod.** This is PR #193 against main for your review.
- **The `geo_site_view` rename.** Documented as a denormalized base table (not a SQL
  view) but left named as-is to avoid a high-blast-radius rename across serve endpoints +
  migrations. Tracked as a follow-up.

---

## Suggested review order

1. **Theme 1 (webhook)** — highest stakes (money + takeover). Read the actual diff.
2. **Theme 2 + 3** — the atomic-CAS idempotency pattern; if you're happy with it once,
   you're happy with it in both.
3. **Theme 4** — the one-caller-sees-`done==total` argument; skim `fanInChunk`.
4. **Themes 5–8** — lower stakes, mostly additive guards; the pseudocode above should
   be enough to sign off without the diff.

The judgement calls I'd most like your eyes on:
- Theme 1b: reusing a `creditTransactions` `topup` row as the dedup marker (vs a migration).
- Theme 3: the "subscription pages used before credits" assumption.
- Theme 7: `isLocalLLM()` triggering on `LLM_BASE_URL` presence alone.
