# TS-080 — Audit Pipeline Cost Audit (Deep-dive the `/api/sites/[id]/regenerate` path)

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-08
**Priority:** P1 — validates TS-079 pricing assumptions; does not block TS-077/078 implementation
**Scope:** GEO app (audit pipeline route + all services it calls)
**Type:** Research spec (produces a cost audit document, not code)
**Depends on:** TS-077 gateway pattern (preferred — gives us the cost accounting primitive) but can run in parallel

---

## 1. What

Perform the same class of deep-dive cost audit on the GEO audit pipeline (`/api/sites/[id]/regenerate`) that we just did for the citation-check pipeline. Produce a standalone LaTeX document in `geo/docs/audit-pipeline-cost-audit.tex` that walks the full pipeline line-by-line, attributes every LLM call and external API call to a dollar cost, validates or refutes the current `$0.40/audit` estimate used in TS-079's margin math, and identifies architectural savings opportunities.

The output is a **research document + a set of recommendations**, not an implementation. If the audit finds large savings, those become follow-up specs (TS-081+). If the audit finds the pipeline is already efficient, we confirm the $0.40 estimate and move on.

## 2. Why

### 2.1 The $0.40/audit number is completely unverified

From the cost audit handoff (`session_citation_audit_2026_04_07.md` §Unverified claims):

> *"$0.40/audit estimate is completely unverified — I never audited the audit pipeline. Don't use this number in any spec until TS-080 lands."*

TS-079's free allowance math (Starter 50 checks + Growth 80 + Pro 200) assumes the audit pipeline consumes ~$0.40 of variable cost per regenerate invocation. If the real number is $0.80, Pro's gross margin gets thin. If it's $1.20, Pro loses money on any customer who runs more than ~2 audits/month.

Before TS-079 ships, this number must be empirically validated — either by confirming it's in the right range, or by producing a new one.

### 2.2 The audit pipeline is almost certainly fatter than the citation-check pipeline

The citation-check route (`app/api/sites/[id]/citation-check/route.ts`) requires `geoScorecard` to already exist, meaning the heavy lifting — tree extraction, category taxonomy, brand keyword extraction, page-by-page analysis — all happens during the **audit** pipeline, not the citation check. So the audit pipeline is where the real LLM spend lives.

Quick inventory of LLM calls that citation-checker.ts *references* but that actually run during audit:
- `extractTrees` — category tree extraction from scraped pages (Haiku)
- `extractCategoriesViaHaiku` — taxonomy classification (Haiku)
- `extractBrandKeywords` — brand term extraction (Haiku)
- `analyzeEnginePreferences` — per-engine ranking analysis (Haiku)
- Per-page content analysis for the scorecard (provider unknown — needs investigation)
- Competitor discovery and ranking (provider unknown)
- Tier-4 improvements from ES-056 (Sprint 33) — prompt recomposition, dimensional intelligence (provider unknown)
- Real-prompt discoverer (Sonar) — actually fires during citation check but may also fire during audit

All of these are billed at provider retail prices today. None are cached, none are batched across sites, and the pipeline has grown organically across Sprints 30–33 without a cost review. This is exactly the setup that produced the 5× overspend on the citation-check side.

### 2.3 The gateway and caching patterns from TS-077/078 apply directly

If the audit pipeline has similar structure to citation-check (many repeated calls with stable prefixes, same four providers, etc.), then the same architectural fixes apply:
- Route through OpenRouter
- Use Llama 3.3 70B on Fireworks/Together for structured-extraction tasks
- Cache responses in Redis with 24h TTL
- Preemptive inject evidence where external search is needed

This spec's value is two-fold: (a) validate the pricing assumption, (b) identify whether TS-077's gateway should be rolled out to the audit pipeline too.

## 3. Scope

### 3.1 In scope

- Full walkthrough of `app/api/sites/[id]/regenerate/route.ts` and every service/helper it calls, recursively, until every LLM call is identified
- Token-level cost attribution for each LLM call, using the same methodology as `citation-check-cost-audit.tex`
- Classification of each call into: *measurement* (user-visible, model-specific) vs. *auxiliary* (internal, model-agnostic)
- Identification of cacheable call sites (those with stable or partially-stable prefixes)
- Identification of call sites that could be merged, skipped, or batched
- External API cost attribution (Firecrawl scraping, Google PageSpeed, any other third-party calls in the audit flow)
- Production log sampling: 20 recent audit runs from `llm_call_log` (after TS-077 ships) to get empirical cost numbers
- Comparison of empirical cost vs. analytical estimate
- Recommendation: accept $0.40/audit as-is, revise up/down, or restructure the pipeline

### 3.2 Out of scope

- Implementing any of the recommendations. Those become follow-up specs.
- Auditing adjacent routes (`/api/sites/[id]/citation-check` — already done, `/api/sites/[id]/delete`, `/api/sites/[id]/rescan-page`, etc.) — separate specs if needed.
- Front-end cost display (showing users how much their audit "cost") — product decision for TS-079.
- Changing the audit's credit cost (`ACTION_CREDITS.shareOfVoice` and friends) — that's TS-079's job if the cost audit forces a pricing change.
- Firecrawl cost renegotiation or provider swap — separate spec if large savings are identified there.

### 3.3 Deliverables

1. **`geo/docs/audit-pipeline-cost-audit.tex`** — full LaTeX document, same structure as the citation-check audit (sections: Context, What the pipeline does, Call inventory, Cost rollup, Empirical validation, Architectural alternatives, Recommendations)
2. **`geo/docs/audit-pipeline-cost-summary.md`** — 2-page executive summary with the final empirical number, the gap vs. $0.40 estimate, and the top 3 savings opportunities
3. **`llm_call_log` SQL queries** for ongoing monitoring — stored in `geo/sql/audit-pipeline-cost-queries.sql`
4. **Recommendation memo** — a section in the LaTeX doc that either (a) confirms the $0.40 estimate and unblocks TS-079, (b) proposes a revised estimate with impact on TS-079, or (c) proposes follow-up specs to fix the architecture before TS-079 ships

## 4. Methodology

### 4.1 Static analysis phase

1. Read `app/api/sites/[id]/regenerate/route.ts` top to bottom
2. Build a call graph: every function it invokes, recursively, until LLM calls and HTTP calls are reached
3. For each LLM call, record:
   - File + line number
   - Model used
   - Purpose (single sentence)
   - Typical input token count (analytical estimate based on prompt length + expected context)
   - Typical output token count
   - Temperature (flags non-determinism)
   - Number of times called per audit invocation (1, N where N is per-page, N where N is per-category, etc.)
4. For each external HTTP call (Firecrawl, PageSpeed, etc.), record:
   - Endpoint
   - Cost per request
   - Number of calls per audit
5. Assemble into a cost table with line totals, subtotals by category, and a grand total

### 4.2 Empirical validation phase (requires TS-077 shipped)

1. Wait until TS-077's `llm_call_log` has been collecting data for ≥ 48 hours
2. Query 20 recent audit runs, grouped by `site_id`, filtered to `task_key LIKE 'audit.%'`
3. Compare empirical cost per audit against the analytical table from §4.1
4. Flag large discrepancies: any call site where empirical cost > 150% of analytical estimate is investigated (usually means input tokens are much larger than expected — typically because of long scraped page content)
5. Produce adjusted analytical estimates based on empirical data

### 4.3 Architectural review phase

For each expensive call site (top 5 by cost), ask:
1. Is this a measurement call or an auxiliary call? (Measurement stays on the current provider. Auxiliary can route through the gateway.)
2. Is the prefix stable across invocations? (If yes → candidate for prompt caching via TS-077 pattern.)
3. Is the output cacheable across 24h? (If yes → candidate for response caching via TS-078.)
4. Could this be batched with other similar calls? (If yes → architectural change.)
5. Could this be eliminated entirely? (E.g., is it adding real value to the scorecard, or is it vestigial from an earlier iteration?)

### 4.4 Recommendation phase

Produce a prioritized list of savings opportunities, each with:
- Expected savings per audit
- Implementation effort estimate (S/M/L)
- Dependencies on other specs
- Risks

## 5. Known unknowns going in

These are the questions the audit needs to answer:

1. **Does the audit pipeline use `@ai-sdk/*` wrappers or direct SDK calls?** Affects whether the TS-077 gateway can wrap it cleanly.
2. **How many LLM calls per audit?** Rough prior: ~20-40. Could be much higher if there's per-page LLM analysis.
3. **What's the most expensive single call?** Prior hypothesis: whatever analyzes the scorecard's scoring dimensions, probably multi-page input.
4. **Are there any temperature > 0 calls that break caching?** Known issue from the citation-check audit; needs to be checked for the audit path too.
5. **Does Firecrawl dominate the cost or is LLM the bigger line item?** Firecrawl billing is per-page; LLM is per-token. Depends on page count.
6. **Are there retry loops or fan-out patterns that multiply costs?** The citation-check audit found `Promise.allSettled` batching; the audit path's pattern is unknown.
7. **Does the audit path call the real-prompt discoverer or is that citation-check only?** If both, the Sonar cost doubles.
8. **Do the Tier 2/3/4 improvements from ES-054/055/056 introduce expensive new LLM calls?** These sprints shipped aggressively and may not have been cost-reviewed.

All of these get resolved in the static analysis phase.

## 6. Acceptance criteria

- ✅ LaTeX document `geo/docs/audit-pipeline-cost-audit.tex` exists and compiles with `pdflatex` (twice for ToC)
- ✅ Executive summary `geo/docs/audit-pipeline-cost-summary.md` exists
- ✅ Call graph diagram (even if hand-drawn in the LaTeX) covers every LLM call site in the audit path
- ✅ Empirical cost number from `llm_call_log` is within ±20% of the analytical estimate in the audit doc (if not, the gap is investigated and explained)
- ✅ Final recommendation on the $0.40 number: confirm, revise, or restructure
- ✅ Recommendations section lists at least 3 concrete savings opportunities (even if the recommendation is "don't pursue, savings are marginal")
- ✅ TS-079 is unblocked: either its $0.40 assumption is confirmed, or a new number is plugged in

## 7. Work breakdown

### 7.1 Phase 1 — Static analysis (can start immediately)

Does not require TS-077 to be shipped. Aditya reviews and approves the inventory before empirical phase starts.

- Day 1: Read `regenerate/route.ts`, build call graph
- Day 2: Recursively read every called service, produce inventory table
- Day 3: Analytical cost estimation per call site, assemble first draft of LaTeX doc
- Day 4: Review with Aditya, revise

### 7.2 Phase 2 — Empirical validation (requires TS-077 + 48h of `llm_call_log` data)

- Day N+1: Query `llm_call_log` for 20 audit runs, produce empirical cost table
- Day N+2: Compare analytical vs. empirical, investigate gaps, produce final cost number
- Day N+3: Architectural review, write recommendations section
- Day N+4: Final review with Aditya, publish doc

### 7.3 Total calendar time

~8 days assuming TS-077 lands before Phase 2 starts. Phases can overlap — Phase 1 does not block on TS-077 or TS-078.

## 8. Risks

### 8.1 Real cost is dramatically higher than $0.40

**Risk:** Empirical number comes in at $1.20+ per audit. TS-079's Pro tier margin becomes negative.

**Likelihood:** Medium. Analytical estimates have been consistently underestimating in this codebase.

**Mitigation:** If this happens, escalate immediately. Options:
1. Apply TS-077's gateway + Llama 3.3 70B substitution to the audit pipeline (same 60-80% savings on auxiliary calls)
2. Revise TS-079 pricing upward (e.g., $599 Pro instead of $499)
3. Cap audits per month per tier (e.g., Pro includes 20 audits/month instead of unlimited)

The first option is strongly preferred — it preserves the pricing story and attacks the root cause.

### 8.2 Audit is trivially small and $0.40 was actually an overestimate

**Risk:** Real cost is $0.15/audit. We were over-pricing and under-delivering.

**Likelihood:** Low but possible.

**Mitigation:** Good news — TS-079 margins get fatter, and we can consider adding more free audits per tier or dropping prices slightly. But we should ship TS-079 at current numbers first and re-evaluate after 30 days of data.

### 8.3 The audit pipeline is so tangled that the static analysis takes longer than 4 days

**Risk:** Many of the ES-053 through ES-056 sprint deliveries added significant complexity. The call graph may be 5+ levels deep with non-obvious branches.

**Likelihood:** Medium. The Sprint 30-33 sessions shipped ~4 major features with minimal refactoring.

**Mitigation:** Parallelize — dispatch 3 Explore subagents to read different subtrees of the call graph simultaneously. Assemble their findings.

### 8.4 `llm_call_log` isn't granular enough for per-call attribution

**Risk:** TS-077 ships with `task_key` at a level of granularity that doesn't distinguish audit sub-calls. We can't attribute $X to `extractTrees` vs. $Y to `extractCategories`.

**Likelihood:** Depends on how TS-077 is implemented. Preventable.

**Mitigation:** TS-080 has a hard requirement on TS-077 that `task_key` is granular down to the call-site level (e.g., `audit.tree-extraction`, `audit.category-classification`, `audit.brand-keywords`, `audit.per-page-analysis.scorecard`). Document this as a dependency note on TS-077 before that spec ships.

## 9. Open questions for Aditya

1. **Phase 1 can start immediately (static analysis, no TS-077 dependency).** Do you want to greenlight that now, or wait until TS-077 is in flight?
2. **Should Phase 2's empirical validation sample 20 audit runs, or more?** More runs = tighter confidence interval, but also more wait time. Default: 20.
3. **If the audit finds large savings opportunities, should they be bundled into TS-077's rollout or shipped as separate follow-up specs?** Default: separate specs (TS-081+) to keep TS-077's scope contained, but this is a tradeoff.
4. **Does the audit document need to cover bulk CSV audits (TS-002) in addition to single-site regenerate?** They share some code paths. Default: this spec covers single-site only; bulk CSV cost audit is a follow-up if needed.

## 10. References

- `app/api/sites/[id]/regenerate/route.ts` — primary audit entry point (to be read during Phase 1)
- `geo/docs/citation-check-cost-audit.tex` — methodology template
- `geo/docs/specs/technical/TS-077-citation-check-architecture-migration.md` — gateway pattern to be applied if savings exist
- `geo/docs/specs/technical/TS-078-response-cache-redis.md` — caching pattern to be applied
- `geo/docs/specs/technical/TS-079-pricing-migration.md` — consumer of this spec's $0.40 validation
- `memory/session_citation_audit_2026_04_07.md` — where the $0.40 unverified claim originated
- `memory/session_geo_sprints_2026_03_24.md` — Sprint 30–33 context for features that may have added cost
