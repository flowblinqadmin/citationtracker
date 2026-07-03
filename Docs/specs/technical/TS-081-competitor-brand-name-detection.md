# TS-081 — Competitor Brand-Name Detection Fix

**Author:** CoFounder (Agent 1)
**Date:** 2026-04-08
**Priority:** P0 — product correctness bug affecting every audit
**Scope:** GEO app (`citation-checker.ts`, `brand-detector.ts`, competitor discovery pipeline, dashboard competitor display)
**Depends on:** None (independent of TS-077 gateway migration — see §3)
**Related:** TS-077 (citation-check architecture migration), TS-069 (user-defined competitors)

---

## 1. What

Replace the URL-only `extractCompetitors()` regex in `citation-checker.ts:72` with a brand-keyword matcher that detects competitors by **name** (e.g. "Apollo Hospitals", "Apollo") in addition to domain strings. Build the competitor keyword list using the same alias-generation pipeline (`generateAliases()` in `brand-detector.ts`) that already works for the subject brand. Replace the upstream `discovered_competitors.name` field — currently a domain stem like `"apollohospitals"` — with a real brand name extracted via the existing vendor-name LLM path. Backfill the existing 104 stored citation responses for site `-GzFX1KcKhmN0W_1t8SmY` (Manipal) and any other site whose `competitors_mentioned` array is empty/wrong.

The outcome: when a model response says *"Apollo Hospitals is the leading hospital chain in India, followed by Fortis"*, the row stores `["Apollo Hospitals", "Fortis Healthcare"]` (or matching domain forms), the dashboard shows real brand names, and `coPresenceSignal` returns the correct value.

## 2. Why

### 2.1 The bug — confirmed against production data

`extractCompetitors()` at `geo/lib/services/citation-checker.ts:72-86`:

```ts
function extractCompetitors(responseText: string, domain: string): string[] {
  const linked = [...responseText.matchAll(/https?:\/\/(?:www\.)?([a-z0-9-]+\.[a-z]{2,})/gi)].map(m => m[1]);
  const bare   = [...responseText.matchAll(/\b(?:www\.)?([a-z0-9][a-z0-9-]{1,30}\.(?:com|io|co|net|org|ai|app|dev))\b/gi)].map(m => m[1]);
  // ...
}
```

This only matches domain strings (URLs and bare `*.com` references). It does **not** match brand names. Validation against the live citation_check responses for Manipal site `-GzFX1KcKhmN0W_1t8SmY` (104 responses, 8 providers × 2 checks):

| Signal | Count |
|---|---|
| Total responses | 104 |
| Responses containing "apollo" in raw text | **8** |
| Responses containing "fortis" in raw text | **5** |
| Rows with non-empty `competitors_mentioned` | **3** |

The 3 non-empty entries are: `["justdial.com"]`, `["manipalhospitalsglobal.com"]`, `["consumercomplaints.in", "reddit.com"]`. Zero of these are actual competitors. Apollo and Fortis — the rivals being named by the LLMs in 13 separate responses — are completely invisible to the extractor.

### 2.2 The discovery layer is just as bad

`discovered_competitors` for Manipal:

```json
[{"name": "apollohospitals", "domain": "apollohospitals.com", "rank": 1, "mentions": 2},
 {"name": "fortishealthcare", "domain": "fortishealthcare.com", "rank": 2, "mentions": 2},
 {"name": "asterdmhealthcare", ...},
 {"name": "medanta", ...},
 {"name": "astemri", ...},
 {"name": "sakraworldhospital", ...}]
```

The `name` field is the domain stem with the TLD stripped. Users see `"apollohospitals"` in their dashboard instead of `"Apollo Hospitals"`. The `astemri` entry looks like a parsing artifact off `aster mri` or similar — domain-stem parsing is producing garbled names.

### 2.3 Downstream blast radius

The broken `competitors_mentioned` array feeds:

1. **`coPresenceSignal`** at `citation-checker.ts:401-405` — returns `100` ("alone in response") when the array is empty, which is now ~97% of rows. The brand looks like it's dominating responses when it's actually being named alongside Apollo and Fortis.
2. **`citationQualityScore`** at `citation-checker.ts:410-416` — averages in the inflated `100` from coPresence, so the score is misleadingly high.
3. **`tier1Competitors` matching** at `citation-checker.ts:413` — the Set is keyed on domain strings, but no responses produce domain strings, so the "alongside tier-1 rival" branch (`return 80`) never fires.
4. **Dashboard "competitors mentioned"** view — empty most of the time, and when populated shows useless entries (justdial, reddit).
5. **Share-of-voice analytics** — the entire competitive landscape view is computed from missing data.

This affects **every audit run**, not just Manipal. Any vertical where models name competitors by brand (which is most verticals) is silently miscounted.

### 2.4 The subject-brand path already proves the fix

`detectMention()` at `brand-detector.ts:187` already uses brand-keyword matching with longest-first alias resolution. For Manipal it stores `["manipal hospitals", "manipalhospitals", "manipal"]` and matches the bare prefix correctly. **The fix is to apply the same pattern to competitors.** No new infrastructure required.

## 3. Relationship to TS-077

TS-077 migrates `citation-checker.ts` to an OpenRouter gateway with preemptive tool injection. **This TS is independent of that work.** The bug is in extraction logic, not in the LLM call path. Two scenarios:

- **If TS-077 lands first:** apply this fix to the new gateway-routed `citation-checker.ts`. The brand-keyword logic lives in `brand-detector.ts` (shared), so the post-migration code calls the same updated functions.
- **If TS-081 lands first:** apply to current `citation-checker.ts`. TS-077 will inherit the fix when it rewrites the file because the brand-keyword logic is upstream of the rewrite scope.

Implementation order: **TS-081 should land first or in parallel** because (a) it's a 1-day fix vs TS-077's multi-week migration, (b) every day TS-077 is in flight is another day of broken competitor data, (c) TS-077 verification needs correct competitor data to validate that the migration didn't regress quality.

## 4. Scope of changes

### 4.1 `lib/services/brand-detector.ts`

Add a new export `extractCompetitorBrandKeywords()` that takes a list of competitors (each with `name` and `domain`) and returns a `Map<competitorId, BrandKeywords>`. Reuses `generateAliases()` per competitor.

```ts
export function extractCompetitorBrandKeywords(
  competitors: Array<{ id: string; name: string; domain: string }>,
): Map<string, BrandKeywords>
```

The `BrandKeywords` type already exists. The map keys by competitor id so downstream code can attribute matches back to a specific competitor entry.

### 4.2 `lib/services/citation-checker.ts`

Replace `extractCompetitors()` (lines 72-86) with a brand-keyword aware version:

```ts
function extractCompetitors(
  responseText: string,
  domain: string,
  competitorKeywords: Map<string, BrandKeywords>,
): string[]
```

Match logic:
1. For each competitor's keyword list, scan response text using the same longest-first regex pattern as `detectMention()`.
2. Apply the same `isAmbiguous` proximity guard for ambiguous brand names (use category keywords from the subject site as the proximity context).
3. Apply the same `noKnowledgePatterns` guard.
4. Return matched competitor ids (not raw matched strings) so the dashboard can render the canonical name.
5. Keep the existing domain-string regex as a **fallback** for competitors not in the keyword map (covers cases where the model includes a URL we haven't pre-registered).

The function signature change ripples to the call site at line 271. The keyword map must be built once per `runCitationChecks()` invocation and threaded into `extractCompetitors()` via the existing `discoveredCompetitors` parameter.

### 4.3 Competitor discovery — fix `discovered_competitors.name`

Find where `discovered_competitors` is populated. The current `name` is a domain stem (`"apollohospitals"`) which means the upstream code is doing something like `domain.replace(/\.[a-z]+$/, '')`. Replace with an LLM extraction step:

- Use the existing Haiku-based vendor-name extractor pattern (the one that produced `vendor.name = "Manipal Hospitals"` for the subject site).
- Input: list of competitor domains discovered during the audit.
- Output: `[{name: "Apollo Hospitals", domain: "apollohospitals.com"}, {name: "Fortis Healthcare", domain: "fortishealthcare.com"}, ...]`
- Cost: 1 Haiku call for ~6 competitors. Negligible.
- The garbled `astemri` entry suggests the current discovery is also breaking on multi-word stems. The LLM rename fixes this.

**Open question for ScriptDev:** identify the exact file/function that builds `discovered_competitors` (search for the literal string `"apollohospitals"` in code, or `discovered_competitors:` writes). Spec author was unable to locate it in a 5-minute search; ScriptDev should investigate as part of Phase 0.

### 4.4 Dashboard display

Anywhere the dashboard renders `discovered_competitors[i].name` or `competitors_mentioned[j]`, ensure the rendered value is the human-readable brand name, not a domain stem or id. Check:

- `app/dashboard/site/[slug]/...` competitor list components
- `lib/services/pdf-report-html.ts` PDF rendering of competitors
- Any "Top competitors mentioned" cards

This is mostly cosmetic but the user-visible bug ("apollohospitals" instead of "Apollo Hospitals") is what triggered Aditya's investigation.

### 4.5 `coPresenceSignal` — no change required

The function logic at `citation-checker.ts:401-405` is correct. Once `competitorsMentioned` carries real entries, the existing logic produces the right scores. No change needed.

### 4.6 `tier1Competitors` Set

At `citation-checker.ts` (search for `tier1Competitors`), the Set is keyed on domain strings. After the fix, it should be keyed on competitor ids that match what `extractCompetitors()` returns. Update Set construction to use ids.

## 5. Acceptance criteria

### 5.1 Functional

- [ ] AC-1: For Manipal site `-GzFX1KcKhmN0W_1t8SmY`, after backfill, at least 13 of 104 responses have non-empty `competitors_mentioned` (the 8 with "apollo" + 5 with "fortis").
- [ ] AC-2: The values in `competitors_mentioned` are real brand names or canonical competitor ids — not domain stems like `"apollohospitals"` and not arbitrary domains like `"reddit.com"`.
- [ ] AC-3: `discovered_competitors[i].name` for Manipal contains values like `"Apollo Hospitals"`, `"Fortis Healthcare"`, `"Aster DM Healthcare"` — proper brand names, not domain stems.
- [ ] AC-4: A new audit run on a different site (e.g. any e-commerce or SaaS site in the test corpus) shows competitors_mentioned populated at >50% of mention rate, validated by a manual spot-check on 10 responses.
- [ ] AC-5: `coPresenceSignal` returns `80` (tier-1 rival co-presence) for at least one Manipal response after backfill, where today it returns `100` for all of them.
- [ ] AC-6: Dashboard renders "Apollo Hospitals" not "apollohospitals" in the competitor list view.

### 5.2 No regression

- [ ] AC-7: Subject brand (`detectMention`) match rate for Manipal is unchanged: 60/104 mentioned, with the same 3 false negatives (no-knowledge guard responses).
- [ ] AC-8: Citation quality scores **may decrease** (because inflated `coPresenceSignal=100` was hiding real co-presence). Document the before/after delta in the implementation report so Aditya can sanity-check.
- [ ] AC-9: All existing citation-checker tests pass without modification of expected values, except where the test was asserting the buggy URL-only behavior.

### 5.3 Backfill

- [ ] AC-10: A backfill script runs against all `citation_check_responses` rows where `competitors_mentioned IS NULL OR jsonb_array_length(competitors_mentioned) = 0`, re-extracts competitors from the stored `response` text using the new logic, and updates the row in place.
- [ ] AC-11: Backfill is **idempotent** — running it twice produces the same result, and rows that already have correct competitors are not modified.
- [ ] AC-12: Backfill is gated behind a `--dry-run` flag by default. Aditya runs `--commit` manually after reviewing dry-run output.
- [ ] AC-13: A separate backfill updates `geo_sites.discovered_competitors[i].name` for all sites where the names look like domain stems. Use a regex heuristic (no dots, no spaces, all lowercase, length <= 30) to detect.

## 6. Dependencies

| Dependency | Status |
|---|---|
| `brand-detector.ts` `generateAliases()` exists and is tested | ✓ working today |
| `BrandKeywords` type exported | ✓ exists |
| Haiku vendor-name extraction LLM call exists | ✓ used by subject brand path |
| `discovered_competitors` schema field present on `geo_sites` | ✓ exists, jsonb |
| `competitors_mentioned` schema field on `citation_check_responses` | ✓ exists, jsonb |
| TS-077 implementation | **NOT a dependency** — see §3 |

## 7. Risks

### 7.1 Ambiguous brand names produce false positives

"Apollo" alone is ambiguous (Apollo Hospitals, Apollo Tyres, Apollo Pharmacy, NASA Apollo, Apollo Theatre). Without proximity context, matching the bare word "Apollo" in a response about hospitals could match a different Apollo.

**Mitigation:** reuse the existing `isAmbiguous` flag and `categoryKeywords` proximity check from `detectMention()`. Build the competitor keyword map with `isAmbiguous: true` for any single-word competitor name in the AMBIGUOUS_BRAND_WORDS set, OR for any competitor name where the first word is a generic English word. Require category keyword within 300-char window before matching.

**Residual risk:** the proximity window may still produce occasional false positives in long responses that mix verticals. Acceptable — the cost of a false positive (one wrong entry in `competitors_mentioned`) is far lower than the cost of the current 100% false negative rate.

### 7.2 Backfill changes existing scores

After backfill, `coPresenceSignal` will return lower values for many existing checks. This means `citationQualityScore` will go DOWN for sites that today look healthy. Users may see their scores drop overnight.

**Mitigation:**
- Run backfill in dry-run mode first; produce a CSV of (site_id, before_score, after_score, delta).
- Aditya reviews the delta distribution before committing.
- Communicate the score change to active users via in-app banner or email IF the median delta is > 5 points.
- Frame the score change as a methodology fix in any external comms.

### 7.3 LLM rename of competitors costs credits

Adding a Haiku call to rename competitors per audit adds ~$0.001/audit. Negligible vs current audit cost (TS-080 will quantify).

### 7.4 Discovery code path is not yet located

The spec author could not find the file that populates `discovered_competitors[i].name = "apollohospitals"`. ScriptDev Phase 0 must locate this. If the discovery path turns out to live inside `citation-checker.ts` itself (unlikely but possible), there's a small overlap with TS-077's rewrite scope.

**Mitigation:** Phase 0 of ScriptDev's work is "locate the discovery code path and report back to CoFounder before writing tests." If it's inside citation-checker.ts, CoFounder coordinates with the TS-077 implementer to merge the fixes.

## 8. Out of scope

- TS-077 gateway migration (separate spec, separate timeline)
- Subject brand detection improvements (already working)
- New ambiguity dictionary entries beyond existing AMBIGUOUS_BRAND_WORDS
- Multi-language brand matching (Hindi, Tamil, etc. for Indian healthcare)
- Fuzzy matching / Levenshtein distance for misspelled brands
- The `llms.txt` empty-string bug (separate TS — see open questions)
- Adding new competitor sources beyond what discovery already produces

## 9. Open questions for Aditya

1. **Should this TS also fix the `llms.txt` empty-string bug** (separate root cause: `withRetry` silent-fail with `maxAttempts=1` + `max_completion_tokens=2000` too small for gpt-5.4-mini reasoning model), or do you want a separate TS-082 for that?
2. **Backfill scope:** all sites, or just paid-tier sites + the Manipal site? Backfilling all free-tier sites costs nothing (no LLM calls — pure regex replay) but produces a large data churn.
3. **Score communication:** if backfill causes median citation quality scores to drop by >5 points, do you want a customer comms plan, or silent fix?
4. **Discovery code path:** do you know where `discovered_competitors[i].name` gets populated as a domain stem? If yes, point ScriptDev at it to skip the Phase 0 hunt.

## 10. Implementation plan summary (for ScriptDev)

**Phase 0** (locate, ~30 min): find the code path that writes `discovered_competitors`. Report file path back before proceeding.

**Phase 1** (TDD, ~2 hr): write tests against `extractCompetitorBrandKeywords()` and the new `extractCompetitors()` signature. Use Manipal's actual stored response text as fixture data — the tests must show that `["Apollo Hospitals", "Fortis Healthcare"]` are extracted from real LLM output that today extracts nothing.

**Phase 2** (implement, ~3 hr): make the tests pass. Update `brand-detector.ts`, `citation-checker.ts`, and the discovery code path. Update tier1Competitors keying.

**Phase 3** (ReviewMaster tests, ~1 hr): run independent tests from ES, fix any failures.

**Phase 4** (backfill, ~1 hr): write the dry-run backfill script. Run dry-run. Report results to CoFounder. CoFounder presents to Aditya for commit approval.

**Phase 5** (report): completion report to CoFounder including (a) the test fixture pass/fail counts, (b) the backfill dry-run delta CSV, (c) the discovery code path that was found, (d) any AC items that needed clarification.

---

**End of TS-081**
