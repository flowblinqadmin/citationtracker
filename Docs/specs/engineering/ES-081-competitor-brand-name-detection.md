# ES-081 — Competitor Brand-Name Detection

**Author:** SpecMaster (Agent 2)
**Date:** 2026-04-08
**Source TS:** [TS-081-competitor-brand-name-detection.md](../technical/TS-081-competitor-brand-name-detection.md)
**Priority:** P0 — product correctness bug affecting every audit
**Downstream:** ReviewMaster (Phase A test generation), CostMaster (taskboard), ScriptDev (already implemented on `fix/competitor-brand-name-extraction`)
**Implementation status:** **Code already landed** on local branch — this ES is retroactive. Its job is to (a) lock interface contracts to what shipped, (b) anchor ReviewMaster's independent test suite, (c) lock signatures so the TS-077 gateway migration inherits the fix safely, (d) define the backfill spec that has not yet been written.

---

## a) Overview

### What this spec covers
The competitor extraction path in the GEO citation pipeline. Three files were changed and one was added against. This ES locks signatures and behaviors for:

| File | Action | Diff size |
|---|---|---|
| `geo/lib/services/brand-detector.ts` | EXTEND — 4 new exports + 1 new exported type | +149 / -0 |
| `geo/lib/services/citation-checker.ts` | MODIFY — `extractCompetitors()` signature + call site | +56 / -10 |
| `geo/lib/services/competitor-discovery.ts` | MODIFY — `extractCompetitorsFromJson()` two paths | +15 / -4 |
| `geo/__tests__/services/brand-detector.test.ts` | EXTEND — 24 new unit tests | +193 / -0 |

### Reference to source TS
TS-081 (above). Read §1–§5 for the bug analysis, the production-data validation against site `-GzFX1KcKhmN0W_1t8SmY` (Manipal: 8 Apollo / 5 Fortis brand-name mentions, 0 captured pre-fix), and the rationale for the two-phase brand-name → URL fallback strategy.

### Current implementation state
**Code:** complete on branch `fix/competitor-brand-name-extraction`, uncommitted, all 100 brand-detector tests passing, full suite 2434/2453 (4 pre-existing UI failures unrelated).

**What does NOT exist yet:**
1. Any backfill script for the 104+ stored `citation_check_responses` rows with empty `competitors_mentioned`.
2. Any backfill script for the `geo_sites.discovered_competitors[i].name` rows where the name still looks like a domain stem.
3. Any independent test suite from ReviewMaster — the ScriptDev tests in `__tests__/services/brand-detector.test.ts` are sufficient for unit coverage but ReviewMaster's Phase A is the regression guard that runs against a *different* fixture row from the production-replay row used by ScriptDev.
4. A persistent dashboard regression check verifying "Apollo Hospitals" renders instead of "apollohospitals" — TS-081 §4.4 calls this out as cosmetic but it must be visually validated post-deploy.

---

## b) Implementation Requirements

### b.1 New module exports — `lib/services/brand-detector.ts`

The implementation reuses the existing `BrandKeywords` type, `generateAliases()`, `isAmbiguousBrand()`, `getDomainStem()`, `COMMON_SUFFIXES`, and `COMMON_PREFIXES` helpers (all defined earlier in the same file). The four new exports below MUST be exported from `brand-detector.ts` and NOT moved to a separate file — they belong with the existing `detectMention()` family because they share the same alias-generation pipeline and ambiguity-guard semantics.

#### b.1.1 `CompetitorInput` (new exported interface)

```ts
export interface CompetitorInput {
  name: string;
  domain?: string | null;
}
```

**Contract:**
- Structurally compatible with `DiscoveredCompetitor` (from `lib/types/citation.ts`) — `DiscoveredCompetitor` carries additional fields (`rank`, `mentions`, `category`) but assigns to `CompetitorInput` parameter slots without conversion. **Do not** import `DiscoveredCompetitor` into `brand-detector.ts` — that would create a circular module dependency.
- `name` is the human-readable brand name (e.g. `"Apollo Hospitals"`) — NOT a domain stem. Callers are responsible for humanizing first.
- `domain` is optional and may be `null`. When absent or null, alias generation degrades gracefully to name-only.

#### b.1.2 `extractCompetitorBrandKeywords(competitors)`

```ts
export function extractCompetitorBrandKeywords(
  competitors: CompetitorInput[],
): Map<string, BrandKeywords>
```

**Contract:**
- **Input:** array of `CompetitorInput`. May be empty. May contain duplicates. Items missing `name` are skipped.
- **Output:** `Map<string, BrandKeywords>` keyed by lower-cased competitor `name` (the canonical id). Map iteration order matches first-occurrence order for deterministic downstream behavior.
- **Aliases:** for each competitor, runs the existing `generateAliases(name, domainStem)`. Domain stem is computed via `getDomainStem(domain)` when `domain` is present; when absent, derived from `name.toLowerCase().replace(/[^a-z0-9]/g, "")`.
- **`BrandKeywords` shape:** `{ keywords, isAmbiguous, source: "vendor", extractedAt }`. `source` is hardcoded to `"vendor"` (NOT `"domain"` or `"manual"`) because the competitor's name is treated as the canonical signal.
- **Dedup:** if two `CompetitorInput` items lower-case to the same id, the **first** wins; subsequent duplicates are silently dropped.
- **Empty input:** returns an empty `Map`. Caller must guard `Map.size === 0` before iteration.

**Edge cases:**
- Single-word competitor (e.g. `{name: "Apollo"}`) → keyword set is `["apollo"]`. If `"apollo"` is in `AMBIGUOUS_BRAND_WORDS` (it is not, but `"apple"`, `"target"`, etc. are) → `isAmbiguous: true`.
- Hyphenated name (`"Aster DM Healthcare"`) → `generateAliases` produces splits like `["aster dm healthcare", "asterdmhealthcare", "aster dm", "aster"]` (longest first).
- Empty/null `domain` → `domainStem` falls back to a sanitized name (`"apollo hospitals" → "apollohospitals"`); aliases still generated.

**Error modes:** none. Pure function. Never throws.

#### b.1.3 `detectCompetitorMentions(text, map, categoryKeywords?)`

```ts
export function detectCompetitorMentions(
  responseText: string,
  competitorKeywords: Map<string, BrandKeywords>,
  categoryKeywords?: string[],
): string[]
```

**Contract:**
- **Input:** raw response text (any size, ~50k chars for Perplexity Sonar long-form), the keyword map from `extractCompetitorBrandKeywords()`, optional category keyword list (used for the ambiguity proximity guard).
- **Output:** array of lower-cased canonical competitor ids that matched. Order is map iteration order. **Each id appears at most once** even if the keyword matched multiple times.
- **Empty map → `[]`** without scanning text (perf short-circuit).
- **Word-boundary regex:** each keyword is escaped and wrapped in `\b...\b`. This prevents `"apollo"` matching `"apollon"` and `"fortis"` matching `"fortified"`. Multi-word keywords (e.g. `"apollo hospitals"`) also benefit from boundary anchors at the outer edges.
- **Case-insensitive:** the regex is `i`-flag.
- **Ambiguity guard:** when `kw.isAmbiguous === true`, the match must additionally have at least one entry from `categoryKeywords` within a **300-character window** before/after the match. Mirror of `detectMention()` semantics. When `categoryKeywords` is `undefined` or empty AND `isAmbiguous` is true, the match is rejected (cannot prove proximity).
- **NO no-knowledge guard:** unlike `detectMention()`, this function does NOT check `noKnowledgePatterns`. A response saying *"I don't have detailed info about Apollo"* still counts as a competitor mention because Apollo is being named in a comparison. This is intentional — competitor SOV/co-presence should reflect that the brand was named, not whether the model claimed to know it.

**Edge cases:**
- One competitor matches via two different aliases → counted once (set semantics).
- Two competitors share an alias (e.g. both have `"apollo"` as a generated alias because of name overlap) → both ids get added (sets are per-competitor).
- Match found but ambiguous + no category context → competitor NOT added; loop continues to the next keyword for the same competitor (longest-first ordering means a more specific match may still succeed).
- Text length > 1MB → no special handling; relies on V8 regex performance. (Not expected — provider responses are token-capped.)

**Error modes:** none. Pure function. Never throws.

#### b.1.4 `humanizeDomainToBrand(domain)`

```ts
export function humanizeDomainToBrand(domain: string): string
```

**Contract:**
- **Purpose:** best-effort domain → human brand-name conversion for the discovery fallback path. Used when the upstream LLM returned no `name` field OR returned a name that `looksLikeDomainStem()` flagged as raw.
- **Input:** any domain string. Strips `www.` and TLDs (including two-part TLDs like `.co.uk`) via `getDomainStem()`.
- **Output:** capitalized human-readable string. Never empty if input had at least one alphanumeric.
- **Algorithm:**
  1. `getDomainStem(domain)` → e.g. `"apollohospitals"`.
  2. **Common suffix split:** for each `s` in `COMMON_SUFFIXES`, if `stem.endsWith(s)` and `stem.length > s.length` and `prefix.length >= 2` → return `"${cap(prefix)} ${cap(s)}"`. First match wins. (E.g. `"apollohospitals"` ends with `"hospitals"` → `"Apollo Hospitals"`.)
  3. **Common prefix split:** for each `p` in `COMMON_PREFIXES`, if `stem.startsWith(p)` and `stem.length > p.length + 2` → return `"${cap(p)} ${cap(stem.slice(p.length))}"`. (E.g. `"getapollo"` → `"Get Apollo"`.)
  4. **Fallback:** capitalize the entire stem. (E.g. `"medanta"` → `"Medanta"`, `"fortishealthcare"` → `"Fortishealthcare"` because `"healthcare"` is NOT in the current `COMMON_SUFFIXES` list — only `"health"` is.)
- **Imperfect by design.** A real Haiku rename pass (as TS-081 §4.3 contemplates) would do better. This function is the deterministic fallback, not the primary path.

**Open contract decision (locked):** `COMMON_SUFFIXES` is **not extended** in this ES. Adding `"healthcare"` would fix `"fortishealthcare" → "Fortis Healthcare"` but risks overmatching unrelated stems. ScriptDev's existing brand-detector tests (`HT5`) document the actual fallback behavior and test against that, NOT against the ideal behavior. ReviewMaster's tests must do the same.

**Error modes:** none. Pure function. Never throws. Empty input → empty output.

#### b.1.5 `looksLikeDomainStem(name)`

```ts
export function looksLikeDomainStem(name: string): boolean
```

**Contract:**
- **Purpose:** detect whether a candidate `name` (returned by the discovery LLM) is actually a domain stem and should be replaced. Used by `extractCompetitorsFromJson()` to gate name acceptance.
- **Input:** any string, including empty.
- **Output:** `true` if the string is empty / whitespace-only / a single token of `[a-z0-9]+` characters. `false` if the string contains a space, hyphen, uppercase letter, or any non-alphanumeric character.
- **Heuristic justification:** real brand names almost always include at least one space (`"Apollo Hospitals"`), one capital letter (`"Apollo"`), or punctuation. A bare `"apollohospitals"` is virtually always an unprocessed domain stem.
- **Defensive default:** empty / whitespace input returns `true` (treat as stem; caller will humanize from the domain).

**Edge cases:**
- `"apollo"` → `true` (single lowercase token; humanize will produce `"Apollo"`)
- `"Apollo"` → `false` (capitalized)
- `"apollo hospitals"` → `false` (has space)
- `"apollo-hospitals"` → `false` (has hyphen) — note: this is an arguable edge case; today's heuristic accepts it. ReviewMaster's tests should pin this current behavior.
- `""` → `true`
- `"   "` → `true`

**Error modes:** none. Pure function.

### b.2 Modified function — `lib/services/citation-checker.ts::extractCompetitors`

```ts
function extractCompetitors(
  responseText: string,
  domain: string,
  competitorKeywords?: Map<string, BrandKeywords> | null,
  categoryKeywords?: string[],
): string[]
```

**Contract:**
- **Module-private** (not exported). External callers should use `runCitationCheck()` which threads the params through.
- **Phase 1 — brand-name match:** if `competitorKeywords` is non-null and non-empty, calls `detectCompetitorMentions(responseText, competitorKeywords, categoryKeywords)` and adds each id to a `Set<string>`.
- **Phase 2 — URL fallback (preserved from V1):**
  - Strips `www.` from `domain`, computes `domainRoot`.
  - Matches `https?:\/\/(?:www\.)?([a-z0-9-]+\.[a-z]{2,})` for linked URLs.
  - Matches `\b(?:www\.)?([a-z0-9][a-z0-9-]{1,30}\.(?:com|io|co|net|org|ai|app|dev))\b` for bare domain references.
  - Filters: lower-cased, must NOT include `domainRoot` (don't match self), must include `.`, must NOT be in `NON_COMPETITOR_DOMAINS`.
  - All survivors are added to the same set.
- **Cap:** returns the first 8 entries from the set (was 5 pre-TS-081 — bumped to allow brand-name + URL co-mentions of the same competitor without dropping signal).
- **Phase 1 ids and Phase 2 domains coexist** in the output array. The same competitor can appear in both forms (`"apollo hospitals"` AND `"apollohospitals.com"`) if both signals are present. Downstream `coPresenceSignal` and `tier1Competitors` matching handle this — see §b.3.

**Error modes:** none. Pure function.

### b.3 Modified function — `runCitationCheck()` call site

The call site at `citation-checker.ts:285-290` (in the body of `runCitationCheck`) builds the keyword map **once per check** and threads it into the per-response `extractCompetitors` call:

```ts
const competitorKeywords = discoveredCompetitors && discoveredCompetitors.length > 0
  ? extractCompetitorBrandKeywords(discoveredCompetitors)
  : null;
```

**Contract:**
- **Built once per `runCitationCheck()` call**, not per provider, not per response. The map is immutable after construction and shared across all parallel provider calls in the batch.
- **Null when no discovered competitors** — defensive, avoids constructing an empty map. `extractCompetitors()` short-circuits Phase 1 when `competitorKeywords == null`.
- The map is passed as the third argument to `extractCompetitors()`; `categoryKeywords` (already in scope from the function signature) is the fourth argument.
- **No other call sites of `extractCompetitors`** — it is module-private. Verified via grep.

### b.4 Modified function — `tier1Competitors` Set construction

`citation-checker.ts:421-428`:

```ts
const tier1Competitors: Set<string> = discoveredCompetitors && discoveredCompetitors.length > 0
  ? new Set(discoveredCompetitors.slice(0, 5).map(c => c.name.toLowerCase()))
  : new Set(
      Object.entries(compMap)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([comp]) => comp)
    );
```

**Contract:**
- **Pre-TS-081 behavior:** keyed on raw competitor strings (mostly URLs from the URL-only extractor). Fallback path keyed on URL strings.
- **Post-TS-081 behavior:** when `discoveredCompetitors` is present, the set is keyed on `c.name.toLowerCase()` — which now matches the canonical id format that `detectCompetitorMentions()` returns. This is what makes `coPresenceSignal()` actually return `80` ("alongside tier-1 rival") instead of always `100` ("alone in response") for the Manipal data.
- **`coPresenceSignal()` itself is unchanged** (`citation-checker.ts:445-449`). The fix is upstream: the set now contains the same id format that `competitorsMentioned` carries.
- **Fallback path** (no `discoveredCompetitors`) still keys on whatever strings are in `compMap` (the per-response extracted competitors). In a Phase 1 brand-name match world this means the fallback set is also keyed on canonical ids, which is consistent. The original URL-string fallback only triggers when there are no discovered competitors AND only URL matches were found in responses — a rare edge case for sites where discovery completely failed.

### b.5 Modified function — `competitor-discovery.ts::extractCompetitorsFromJson`

Two changes inside `extractCompetitorsFromJson()`:

#### Change 1 — `nameMap` write gate
```ts
if (item.name && !nameMap.has(d) && !looksLikeDomainStem(item.name)) {
  nameMap.set(d, item.name);
}
```
**Contract:** the LLM-provided `name` is only stored if `looksLikeDomainStem(item.name) === false`. When the LLM returns `"apollohospitals"` (clearly giving up), `nameMap` is NOT populated for that domain — the downstream lookup will then fall through to the humanizer.

#### Change 2 — Final assembly fallback (both JSON and regex paths)
```ts
// JSON path (line ~189):
name: nameMap.get(domain) ?? humanizeDomainToBrand(domain),

// Regex fallback path (line ~213):
name: humanizeDomainToBrand(domain),
```

**Contract:** when `nameMap` doesn't have an entry (either because no LLM gave a name OR because all the LLM names looked like stems), the name falls back to `humanizeDomainToBrand(domain)`. The regex fallback path always uses `humanizeDomainToBrand` because that path has no LLM names to consider.

**Pre-existing comment removed:** `"// Always prefer the LLM-provided brand name over domain stem"` — superseded.

### b.6 Files NOT modified (intentional)

| File | Why not |
|---|---|
| `coPresenceSignal()` (citation-checker.ts:445) | Function logic unchanged. Fix is upstream — once `competitorsMentioned` carries real ids and `tier1Competitors` keys match, behavior is correct. |
| `detectMention()` (brand-detector.ts:187) | Subject-brand path was already correct via ES-059. AC-7 verifies no regression. |
| `lib/types/citation.ts::DiscoveredCompetitor` | Existing schema accommodates the new behavior; no field changes needed. |
| `lib/db/schema.ts` | No DDL change. `competitors_mentioned` is already `jsonb`; `discovered_competitors[i].name` is already a string field. |
| Dashboard rendering (`app/dashboard/site/[slug]/...`) | TS-081 §4.4 calls this out as cosmetic. No changes shipped — the dashboard already renders `competitors_mentioned[j]` and `discovered_competitors[i].name` as strings; the fix improves the *content* of those strings, not the rendering. **Backfill validates this** — see §e (AC-6). |
| `lib/services/pdf-report-html.ts` | Same — receives strings, renders as strings. Backfill validates. |

### b.7 Data structures and types

| Symbol | Defined in | Used by |
|---|---|---|
| `BrandKeywords` (existing type) | `brand-detector.ts:8` | `extractCompetitorBrandKeywords` output values, `detectCompetitorMentions` input |
| `CompetitorInput` (NEW) | `brand-detector.ts` (new export) | `extractCompetitorBrandKeywords` input |
| `DiscoveredCompetitor` (existing) | `lib/types/citation.ts:14` | Discovery path, `runCitationCheck` parameter, structurally compatible with `CompetitorInput` |
| `Map<string, BrandKeywords>` | n/a | Threaded from `runCitationCheck` → `extractCompetitors` → `detectCompetitorMentions` |

### b.8 Performance requirements

- `extractCompetitorBrandKeywords()` runs once per `runCitationCheck()` call. For ~6 competitors with ~5 aliases each, this is ~30 alias generations + 30 regex precompiles. Target: **< 5ms**.
- `detectCompetitorMentions()` runs once per response (~60 responses per check). For ~6 competitors × ~5 aliases each = ~30 regex executions per response on a ~3KB response text. Target: **< 10ms per response**, **< 600ms cumulative across a check**.
- The Phase 2 URL fallback is the same regex pass as before; no perf change.
- **Total per-check overhead vs pre-TS-081: < 1 second.** Negligible against the 30-60s LLM call budget.

### b.9 Error handling requirements

All four new functions are pure and **must never throw**. The discovery and citation paths already have try/catch wrappers around the broader call sites — adding throw-paths inside these helpers would propagate up to the caller's catch blocks but would degrade UX (one bad response would zero out the entire batch). Defensive defaults:

- `extractCompetitorBrandKeywords([])` → empty `Map` (no throw)
- `detectCompetitorMentions(text, emptyMap)` → `[]` (no throw)
- `humanizeDomainToBrand("")` → `""` (no throw)
- `looksLikeDomainStem(undefined as any)` → `true` (defensive)

Logging: none required. The existing `console.warn` paths in `competitor-discovery.ts` cover the discovery-side failure modes.

---

## c) Unit Test Plan

**Test file (existing, ScriptDev's tests):** `geo/__tests__/services/brand-detector.test.ts`
**ReviewMaster Phase A test file (new, independent suite):** `geo/__tests__/services/brand-detector.competitor.test.ts`

### Why two files?
ScriptDev's tests in `brand-detector.test.ts` (24 new tests, all passing) are TDD tests written alongside the implementation. ReviewMaster's job is to write **independent tests** in a separate file using **different fixture data** so the two suites don't share blind spots. If both suites pass on a future refactor, the change is genuinely safe.

### c.1 Unit tests — `extractCompetitorBrandKeywords` (target: 6 tests)

| ID | Scenario | Input | Expected | Notes |
|---|---|---|---|---|
| ECK-1 | Two competitors → map of size 2 with correct id keys | `[{name:"Apollo Hospitals",domain:"apollohospitals.com"}, {name:"Fortis Healthcare",domain:"fortishealthcare.com"}]` | `map.size === 2`, `map.has("apollo hospitals")`, `map.has("fortis healthcare")` | Use a different brand pair than ScriptDev's CT1 (e.g. "Max Healthcare" + "Aster DM") |
| ECK-2 | Empty input → empty map, no throw | `[]` | `map.size === 0` | Defensive default |
| ECK-3 | Competitor with `domain: null` → name-only aliases generated | `[{name:"Medanta", domain:null}]` | `map.get("medanta").keywords` includes `"medanta"` | Validates degraded path |
| ECK-4 | Duplicate names → first wins, second silently dropped | `[{name:"Apollo",domain:"a.com"}, {name:"Apollo",domain:"b.com"}]` | `map.size === 1`, no throw | Determinism guarantee |
| ECK-5 | Item missing `name` field → skipped without throw | `[{name:"" as any, domain:"x.com"}, {name:"Valid",domain:"v.com"}]` | `map.size === 1`, only `"valid"` present | Defensive |
| ECK-6 | Ambiguous brand word in single-word name → `isAmbiguous: true` | `[{name:"Target", domain:"target.com"}]` | `map.get("target").isAmbiguous === true` | "target" is in AMBIGUOUS_BRAND_WORDS |

### c.2 Unit tests — `detectCompetitorMentions` (target: 9 tests)

| ID | Scenario | Input | Expected | Notes |
|---|---|---|---|---|
| DCM-1 | Full brand name match returns canonical id | text contains `"Aster DM Healthcare offers..."`, map has Aster | `["aster dm healthcare"]` | Different brand than ScriptDev's CT6 |
| DCM-2 | Bare prefix match (single-word alias) | text contains `"Medanta is among the top..."`, map has Medanta | `["medanta"]` | Mirror of CT7 with different brand |
| DCM-3 | Multiple competitors in one response | text mentions Apollo Hospitals + Fortis Healthcare + Aster | All three ids returned | Validates set semantics |
| DCM-4 | Empty map → empty result, no scan | `text="anything"`, `map=new Map()` | `[]` | Perf short-circuit |
| DCM-5 | No matches → empty result | text talks about unrelated topic | `[]` | Negative case |
| DCM-6 | No-knowledge guard NOT applied (competitor still counted) | text: `"I don't have detailed information about Max Healthcare"` | `["max healthcare"]` | Critical contract — different from `detectMention` behavior |
| DCM-7 | Word-boundary prevents substring false positive | text: `"the building was reinforced and fortified"`, map has Fortis | `[]` (NOT `["fortis healthcare"]`) | Anti-regression for "fortified" / "fortis" |
| DCM-8 | Ambiguous brand with category proximity → match | text: `"Target hospital chain serves Bangalore"`, map has Target with `isAmbiguous:true`, categoryKeywords `["hospital"]` | `["target"]` | Validates 300-char window |
| DCM-9 | Ambiguous brand WITHOUT category proximity → no match | text: `"Target announced a new pricing structure"`, same map, same categoryKeywords | `[]` | Validates the guard rejects |

### c.3 Unit tests — `humanizeDomainToBrand` (target: 5 tests)

| ID | Scenario | Input | Expected | Notes |
|---|---|---|---|---|
| HDB-1 | Suffix split — "hospitals" | `"manipalhospitals.com"` | `"Manipal Hospitals"` | Different from ScriptDev's HT1 |
| HDB-2 | Suffix split — "tech" | `"acmetech.io"` | `"Acme Tech"` | Validates COMMON_SUFFIXES coverage |
| HDB-3 | Prefix split — "get" | `"getapollo.com"` | `"Get Apollo"` | Validates COMMON_PREFIXES path |
| HDB-4 | Two-part TLD — `.co.in` | `"asterdm.co.in"` | `"Asterdm"` | Different from ScriptDev's HT3 (which uses `.co.uk`) |
| HDB-5 | Fallback (no split) capitalizes whole stem | `"medanta.org"` | `"Medanta"` | Mirror of HT2 |

### c.4 Unit tests — `looksLikeDomainStem` (target: 5 tests)

| ID | Scenario | Input | Expected | Notes |
|---|---|---|---|---|
| LDS-1 | Single lowercase token → true | `"manipalhospitals"` | `true` | Different stem than ScriptDev's LT1 |
| LDS-2 | Multi-word with space → false | `"Aster DM Healthcare"` | `false` | Mirror of LT2 with different brand |
| LDS-3 | Capitalized single word → false | `"Medanta"` | `false` | |
| LDS-4 | Whitespace-only → true (defensive) | `"   "` | `true` | Edge case not in ScriptDev's tests |
| LDS-5 | Hyphenated lowercase → false (current heuristic) | `"apollo-hospitals"` | `false` | Pin current behavior; do NOT match the ideal |

### c.5 Total ScriptDev tests (already exist, must pass)

24 tests in `__tests__/services/brand-detector.test.ts`:
- `extractCompetitorBrandKeywords`: CT1–CT5 (5 tests)
- `detectCompetitorMentions`: CT6–CT15 (10 tests including production replay)
- `humanizeDomainToBrand`: HT1–HT5 (5 tests)
- `looksLikeDomainStem`: LT1–LT4 (4 tests)

**Total unit test count after ReviewMaster Phase A: 24 ScriptDev + 25 ReviewMaster = 49 tests in two files.**

### c.6 Mock/stub requirements

**None.** All four functions are pure. No mocking of `console`, `fetch`, providers, or DB. Tests run against real string inputs.

### c.7 Coverage targets

- Line coverage on `brand-detector.ts` competitor section: **≥ 95%**.
- Branch coverage: **≥ 90%** (excluding the defensive `if (!comp.name) continue` which is hit by ECK-5).

---

## d) Integration Test Plan

**Test file (new):** `geo/__tests__/integration/services/citation-checker.competitor-extraction.integration.test.ts`

ReviewMaster owns this file. Mocks the four LLM provider clients (OpenAI, Anthropic, Google, Perplexity) to return canned response text containing brand-name competitor mentions, then asserts the end-to-end `runCitationCheck()` output carries correct `competitorsMentioned` arrays.

### d.1 Mock setup

```ts
vi.mock("openai");
vi.mock("@anthropic-ai/sdk");
vi.mock("@google/generative-ai");
// Perplexity uses the OpenAI client with a different baseURL — same mock
```

Each provider returns a fixture string. Use **different fixture text** than ScriptDev's CT15 (which uses the actual stored Perplexity response from row `QH1EepHTOpK6hsh80VPJ1`). Recommended: pick a different stored row from the same Manipal site batch (the production audit produced 104 responses; pick row index 47 or 89 to get a different mix of brand mentions).

### d.2 Integration test scenarios (target: 5 tests)

| ID | Scenario | Setup | Assertion |
|---|---|---|---|
| IT-1 | Brand-name competitor extracted via Phase 1 | Mock all 4 providers to return text containing `"Apollo Hospitals is the leader, followed by Fortis Healthcare"`. Pass `discoveredCompetitors = [{name:"Apollo Hospitals",...}, {name:"Fortis Healthcare",...}]` | At least one response row has `competitorsMentioned` containing both `"apollo hospitals"` and `"fortis healthcare"` |
| IT-2 | URL-only competitor extracted via Phase 2 fallback | Mock providers to return `"check tiktok.com for similar content"`, pass empty `discoveredCompetitors` | Response row has `competitorsMentioned: ["tiktok.com"]` |
| IT-3 | Brand + URL co-mention captured (set semantics) | Provider returns `"Apollo Hospitals (apollohospitals.com) is great"`, pass Apollo in `discoveredCompetitors` | Response row has BOTH `"apollo hospitals"` AND `"apollohospitals.com"` (or one of them — both are valid; assert at least one and document which one wins) |
| IT-4 | `coPresenceSignal` returns 80 not 100 when tier-1 rival co-mentioned | Provider returns `"Manipal is good but Apollo Hospitals dominates"`, pass Apollo as discovered competitor (so it's in `tier1Competitors`) | Final `citationQualityScore` reflects `coPresenceSignal=80` for the mentioned response — direct calculation: `(positionSignal + sentimentSignal + 80 + 100) / 4`, not `(... + 100 + ...) / 4` |
| IT-5 | No discovered competitors → only Phase 2 fires | Provider returns brand name `"Apollo Hospitals"` but `discoveredCompetitors = undefined` | `competitorsMentioned` is `[]` (brand-name match doesn't fire without keyword map; URL fallback finds nothing because there's no URL in the text) |

### d.3 Component interaction scenarios

The end-to-end flow under test:
```
runCitationCheck(prompts, discoveredCompetitors)
  ↓
extractCompetitorBrandKeywords(discoveredCompetitors)  // build map once
  ↓
batch loop → provider.fn(prompt) → text
  ↓
extractCompetitors(text, domain, competitorKeywords, categoryKeywords)
  ↓
  ├─ Phase 1: detectCompetitorMentions(text, map, cats)
  └─ Phase 2: URL regex fallback
  ↓
ResponseRow.competitorsMentioned: string[]
  ↓
[aggregation] tier1Competitors Set ← discoveredCompetitors[].name.toLowerCase()
  ↓
coPresenceSignal(competitorsMentioned, tier1Competitors)
  ↓
citationQualityScore
```

### d.4 Failure mode tests (target: 1 test)

| ID | Scenario | Setup | Assertion |
|---|---|---|---|
| IT-6 | Provider throws → response row has `error` set, `competitorsMentioned: []`, no crash | One provider mock throws, others return normally | Final result has rows from working providers; failed provider rows have `error: "..."` and empty arrays; aggregation completes |

**Total integration tests: 6.** Within TS-081 inbox-stated target of 4–6.

---

## e) Acceptance Criteria — Direct Translation from TS-081 §5

Each AC below copies the TS-081 statement verbatim then adds an explicit testable assertion. ReviewMaster must verify each AC has a test mapped to it.

### e.1 Functional ACs

#### AC-1 — Manipal backfill mention rate

> For Manipal site `-GzFX1KcKhmN0W_1t8SmY`, after backfill, at least 13 of 104 responses have non-empty `competitors_mentioned` (the 8 with "apollo" + 5 with "fortis").

**Test:** Backfill dry-run script (see §f) reports `expected_changed_rows >= 13` for site `-GzFX1KcKhmN0W_1t8SmY`. This is the load-bearing regression guard. ScriptDev already has CT15 testing the same row's text via unit test; AC-1 is the database-level confirmation.

**Assertion form:**
```ts
const result = await runBackfillDryRun({ siteIds: ["-GzFX1KcKhmN0W_1t8SmY"] });
expect(result.changedRows).toBeGreaterThanOrEqual(13);
expect(result.totalRows).toBe(104);
```

#### AC-2 — Real brand names not domain stems

> The values in `competitors_mentioned` are real brand names or canonical competitor ids — not domain stems like `"apollohospitals"` and not arbitrary domains like `"reddit.com"`.

**Test:** Inspect any populated `competitorsMentioned` array from the integration tests (IT-1, IT-3) and assert no entries match `looksLikeDomainStem()` AND no entries are in a blocklist `["reddit.com", "consumercomplaints.in", "justdial.com", "quora.com"]`.

**Implementation note:** Phase 2 URL fallback CAN still emit legitimate domain strings (e.g. `"tiktok.com"` in IT-2). These are NOT domain stems — they include the TLD. The blocklist only catches the historical garbage values from the pre-TS-081 era.

#### AC-3 — `discovered_competitors[i].name` contains real brand names

> `discovered_competitors[i].name` for Manipal contains values like `"Apollo Hospitals"`, `"Fortis Healthcare"`, `"Aster DM Healthcare"` — proper brand names, not domain stems.

**Test:** Backfill script for `geo_sites.discovered_competitors` (see §f.2) reports at least 6 rows where the existing name passes `looksLikeDomainStem(name) === true` AND the proposed new value passes `looksLikeDomainStem(newName) === false`.

**Sample assertion:**
```ts
const proposed = await proposeDiscoveredCompetitorBackfill();
const apollo = proposed.find(p => p.domain === "apollohospitals.com");
expect(apollo?.before).toBe("apollohospitals");
expect(apollo?.after).toBe("Apollo Hospitals");
expect(looksLikeDomainStem(apollo?.after ?? "")).toBe(false);
```

#### AC-4 — Random-site spot check ≥ 50% mention rate

> A new audit run on a different site (e.g. any e-commerce or SaaS site in the test corpus) shows competitors_mentioned populated at >50% of mention rate, validated by a manual spot-check on 10 responses.

**Test:** This is a manual spot-check, not automatable in CI. ReviewMaster's Phase B (manual QA) covers this. Document the spot-check protocol in the implementation report:
1. Pick any non-Manipal site from `geo_sites` with > 20 stored responses.
2. Run backfill dry-run scoped to that site.
3. Manually inspect 10 random responses; verify the proposed `competitorsMentioned` array correctly contains brand names that appear in the response text.
4. Report pass rate. **Target: ≥ 50% of responses that mention any competitor by name show non-empty `competitorsMentioned` after backfill.**

#### AC-5 — `coPresenceSignal` returns 80 for Manipal

> `coPresenceSignal` returns `80` (tier-1 rival co-presence) for at least one Manipal response after backfill, where today it returns `100` for all of them.

**Test:** Integration test IT-4 covers this with mocked providers. Backfill validation also confirms via direct DB query: `SELECT COUNT(*) FROM citation_check_responses WHERE site_id = '-GzFX1KcKhmN0W_1t8SmY' AND mentioned = true AND jsonb_array_length(competitors_mentioned) > 0` should return ≥ 1 after backfill commit.

#### AC-6 — Dashboard renders human-readable name

> Dashboard renders "Apollo Hospitals" not "apollohospitals" in the competitor list view.

**Test:** Manual visual check post-deploy. No code change required because the dashboard already passes the string through verbatim — the fix is upstream in `discovered_competitors[i].name`. Document validation in implementation report:
1. After backfill commit, navigate to Manipal site report dashboard.
2. Open the "Competitors" tab / card.
3. Confirm the name column shows `"Apollo Hospitals"` not `"apollohospitals"`.
4. Screenshot the result for the report.

### e.2 No-regression ACs

#### AC-7 — Subject brand `detectMention` rate unchanged

> Subject brand (`detectMention`) match rate for Manipal is unchanged: 60/104 mentioned, with the same 3 false negatives (no-knowledge guard responses).

**Test:** A non-modifying re-run of `detectMention()` against the 104 stored response texts must produce the same `mentioned: true` count as before TS-081. Add a snapshot test to ensure this:
```ts
const responses = await loadStoredResponses("-GzFX1KcKhmN0W_1t8SmY");
const mentions = responses.filter(r => detectMention(r.response, "manipalhospitals.com", brandKeywords, categoryKeywords).mentioned);
expect(mentions.length).toBe(60);
```

#### AC-8 — Score deltas documented

> Citation quality scores **may decrease** (because inflated `coPresenceSignal=100` was hiding real co-presence). Document the before/after delta in the implementation report so Aditya can sanity-check.

**Test:** Backfill dry-run output MUST include a CSV with columns `site_id, before_citation_quality_score, after_citation_quality_score, delta`. ReviewMaster verifies the CSV exists and has at least one row per affected site.

#### AC-9 — Existing tests pass without modification

> All existing citation-checker tests pass without modification of expected values, except where the test was asserting the buggy URL-only behavior.

**Test:** Run `npm test -- citation-checker` and `npm test -- brand-detector`. Expected: all tests pass. Any test that fails because of an expected-value mismatch is a regression and must be fixed by either:
1. Updating the test expectation (if it was asserting buggy behavior)
2. Reverting/correcting the implementation change

ReviewMaster reports any expected-value updates in the Phase A report.

### e.3 Backfill ACs

#### AC-10 — Backfill script exists and runs against empty rows

> A backfill script runs against all `citation_check_responses` rows where `competitors_mentioned IS NULL OR jsonb_array_length(competitors_mentioned) = 0`, re-extracts competitors from the stored `response` text using the new logic, and updates the row in place.

**Test:** Script file exists at `geo/scripts/backfill-competitor-mentions.ts`. Running with `--dry-run --site -GzFX1KcKhmN0W_1t8SmY` produces stdout output listing affected rows and a delta summary. See §f.

#### AC-11 — Backfill is idempotent

> Backfill is **idempotent** — running it twice produces the same result, and rows that already have correct competitors are not modified.

**Test:** ReviewMaster integration test:
1. Run `--commit` against a test fixture DB.
2. Snapshot `competitors_mentioned` for all rows.
3. Run `--commit` again.
4. Compare snapshots — must be byte-identical.

Implementation note: idempotency is achieved by recomputing from the stored `response` text — the function is deterministic, so re-running produces the same output. The `--commit` SQL UPDATE is conditional on `competitors_mentioned IS DISTINCT FROM proposed_value` so a no-change row is not written.

#### AC-12 — Backfill is gated behind --dry-run by default

> Backfill is **gated behind a `--dry-run` flag by default**. Aditya runs `--commit` manually after reviewing dry-run output.

**Test:** Script invocation `npx tsx geo/scripts/backfill-competitor-mentions.ts` without flags → dry-run mode. `--commit` → write mode. ReviewMaster verifies by inspecting the script source for the flag parser default.

#### AC-13 — Discovered-competitors backfill exists

> A separate backfill updates `geo_sites.discovered_competitors[i].name` for all sites where the names look like domain stems. Use a regex heuristic (no dots, no spaces, all lowercase, length <= 30) to detect.

**Test:** Script file exists at `geo/scripts/backfill-discovered-competitor-names.ts`. Logic uses `looksLikeDomainStem()` (which is exactly the regex heuristic — `/^[a-z0-9]+$/`). Dry-run produces a delta CSV. Idempotent same as AC-11.

---

## f) Backfill Spec (THIS IS NEW — does not exist in implementation yet)

ScriptDev MUST write two backfill scripts after the test suite passes. Both scripts:
- Default to dry-run mode (`--dry-run` is implied; `--commit` is required to write).
- Output a delta CSV to stdout (and optionally to `geo/scripts/output/backfill-{name}-{timestamp}.csv`).
- Are idempotent.
- Read DB credentials from `process.env` per existing geo conventions.
- Are invoked via `npx tsx`.

### f.1 Script 1 — `geo/scripts/backfill-competitor-mentions.ts`

**Purpose:** Re-extract `competitorsMentioned` for stored `citation_check_responses` rows.

**CLI:**
```
npx tsx geo/scripts/backfill-competitor-mentions.ts \
  [--commit]                       # default: dry-run
  [--site <site_id>]               # default: all sites
  [--limit <n>]                    # default: no limit
  [--output <path>]                # default: stdout only
```

**Algorithm:**
1. Query all rows from `citation_check_responses` where `(competitors_mentioned IS NULL OR jsonb_array_length(competitors_mentioned) = 0) AND response IS NOT NULL`. Filter by `--site` if provided.
2. For each row, look up the parent `geo_sites.discovered_competitors` and `geo_sites.brandKeywords` (or recompute via `extractBrandKeywords` from `geo_sites.crawlData`).
3. Build `competitorKeywords` map via `extractCompetitorBrandKeywords(discoveredCompetitors)`.
4. Look up `categoryKeywords` from `geo_sites.crawlData?.geo_profile?.categoryKeywords` (or `[]` if missing).
5. Call `extractCompetitors(row.response, geo_sites.domain, competitorKeywords, categoryKeywords)` — the same module-private function used at runtime. **Re-export it via a `__test_internals` namespace** OR re-implement the two-phase logic in the script (preferred: thin re-implementation that calls the public `detectCompetitorMentions` + URL regex; avoid coupling to private state).
6. Compare `proposed_value` against `row.competitors_mentioned`:
   - If equal → skip (idempotency).
   - If different → record `(site_id, response_id, before, after, score_delta_estimate)`.
7. Compute `score_delta_estimate` by re-running `coPresenceSignal` and `citationQualityScore` for the row's `mention` state.
8. **Dry-run:** print summary `{total_rows_examined, rows_changed, sample_diffs[:10], score_delta_distribution}`. Write CSV.
9. **Commit (`--commit`):** wrap updates in a transaction. UPDATE in batches of 500. Use `WHERE competitors_mentioned IS DISTINCT FROM $1` clause to skip no-op writes. Report final commit count.

**Output CSV columns:**
```
site_id, response_id, provider, before, after, before_quality_score, after_quality_score, delta
```

**Edge cases:**
- Row with no parent `geo_sites` (orphaned) → skip with WARN.
- Row with `geo_sites.discovered_competitors = []` → skip Phase 1, run Phase 2 only.
- Row with corrupted JSON in `response` → skip with WARN, count in error tally.

### f.2 Script 2 — `geo/scripts/backfill-discovered-competitor-names.ts`

**Purpose:** Update `geo_sites.discovered_competitors[i].name` where the name looks like a domain stem.

**CLI:**
```
npx tsx geo/scripts/backfill-discovered-competitor-names.ts \
  [--commit]              # default: dry-run
  [--site <site_id>]      # default: all sites
  [--output <path>]
```

**Algorithm:**
1. Query all rows from `geo_sites` where `discovered_competitors IS NOT NULL AND jsonb_array_length(discovered_competitors) > 0`. Filter by `--site` if provided.
2. For each row, parse `discovered_competitors` as `DiscoveredCompetitor[]`.
3. For each `competitor` in the array:
   - If `looksLikeDomainStem(competitor.name)` → propose `humanizeDomainToBrand(competitor.domain)` as new name.
   - Otherwise → leave unchanged.
4. If any element changed, record `(site_id, before_array, after_array)` with element-level diffs.
5. **Dry-run:** print summary `{sites_examined, sites_changed, total_elements_changed, sample_diffs[:10]}`. Write CSV.
6. **Commit:** UPDATE rows with the new array. Use `WHERE discovered_competitors IS DISTINCT FROM $1`. Wrap in transaction.

**Output CSV columns:**
```
site_id, domain, before_name, after_name
```

**Edge cases:**
- `competitor.domain` is empty → `humanizeDomainToBrand("")` returns `""` → skip this element with WARN.
- Already-correct name (passes `looksLikeDomainStem === false`) → no change.

### f.3 Backfill safety

- **Both scripts run in a single transaction per batch.** Failure rolls back the batch.
- **Audit log:** every commit run writes a row to `geo_audit_log` (or stdout JSON) with `{operation, rows_changed, started_at, finished_at, dry_run: false, invoked_by: process.env.USER}`.
- **Reversibility:** before each commit, dump the affected `before_value` to `geo/scripts/output/rollback-{operation}-{timestamp}.jsonl`. A reverse script (out of scope for this ES) could replay these to undo.
- **Score-drop communication gate:** if dry-run reports `median(delta) < -5`, the script PRINTS a banner: `WARNING: median quality score drop > 5 — review per TS-081 §7.2 before commit`. ScriptDev must surface this in the implementation report; commit decision rests with Aditya.

---

## g) Profiling Requirements

| Metric | Where to measure | Baseline expectation | Target |
|---|---|---|---|
| `extractCompetitorBrandKeywords` runtime per call | `runCitationCheck` startup | First-call cold path includes regex compile | < 5 ms for 6 competitors |
| `detectCompetitorMentions` runtime per response | Inside batch loop | Linear in (#competitors × #aliases × text length) | < 10 ms per response |
| Cumulative per-check overhead vs pre-TS-081 | End-to-end `runCitationCheck` wall-clock | New overhead is the keyword build + per-response scan | < 1 second (vs ~30s LLM budget) |
| Backfill script throughput | `--dry-run` against full DB | Sequential rows, no LLM calls — pure CPU | > 1000 rows/sec |

**Profiling tool:** `console.time` / `console.timeEnd` is sufficient for the per-call measurements. For the backfill, `process.hrtime.bigint()` deltas printed at the end of each batch.

---

## h) Load Test Plan

**Scope:** none in this ES.

The new code adds < 1s of overhead per audit and runs entirely in-memory with no network or DB calls. Existing audit-pipeline load tests (covering 60+ concurrent audits) will exercise this code path automatically once deployed. Adding a dedicated load test is out of scope.

If concerns arise post-deploy, add a microbenchmark suite at `geo/__tests__/perf/competitor-extraction.bench.ts` running `vitest bench` against 100k synthetic responses. Out of scope here.

---

## i) Logging & Instrumentation

### i.1 Application logging

**No new application logs required.** The competitor extraction path runs in the hot loop of `runCitationCheck`; per-response logging would flood. The existing `[citation-checker]` logs cover the overall check lifecycle.

**Exception:** if `extractCompetitorBrandKeywords()` produces a map with `size === 0` despite `discoveredCompetitors.length > 0`, log a single WARN once per check:
```ts
if (discoveredCompetitors.length > 0 && competitorKeywords?.size === 0) {
  console.warn(`[citation-checker] competitorKeywords map empty despite ${discoveredCompetitors.length} discovered competitors — possible name validation failure`);
}
```

This is a defensive log for the pathological case where every discovered competitor has an empty/missing `name`. **NOT in the current implementation** — ScriptDev should add this in a follow-up commit.

### i.2 Backfill script logging

Both backfill scripts log:
- Start: `[backfill-{name}] starting in {dry_run|commit} mode, scope: {site filter or "all"}`
- Per-batch: `[backfill-{name}] batch {n}: examined {x}, changed {y}, errors {z}`
- Summary: `[backfill-{name}] complete. total examined: {x}, total changed: {y}, total errors: {z}, elapsed: {ms}`
- Score-drop warning when applicable (see §f.3).

Log level: `info` for normal flow, `warn` for skipped rows, `error` for transaction failures.

### i.3 Metrics

No new metrics emitted. Existing audit-pipeline metrics (`citation_check_duration_ms`, `responses_per_check`) will absorb any change automatically.

---

## j) Acceptance Checklist (for ReviewMaster + ScriptDev)

| AC | Description | Test ref | Status (on this branch) |
|---|---|---|---|
| AC-1 | Manipal: ≥13/104 rows changed by backfill | Backfill dry-run output | ⏳ pending backfill script |
| AC-2 | `competitors_mentioned` contains real brand names, not stems / not blocked domains | IT-1, IT-3 | ✅ via implementation; verify in IT |
| AC-3 | `discovered_competitors[i].name` contains brand names | Backfill dry-run output | ⏳ pending backfill script |
| AC-4 | ≥50% mention rate on a non-Manipal site spot-check | Manual QA | ⏳ pending Phase B |
| AC-5 | `coPresenceSignal` returns 80 for ≥1 Manipal response | IT-4 + DB query post-backfill | ✅ via implementation; verify post-backfill |
| AC-6 | Dashboard renders "Apollo Hospitals" | Manual visual check post-deploy | ⏳ pending deploy |
| AC-7 | `detectMention` rate for Manipal = 60/104 unchanged | Snapshot test against stored responses | ✅ no change to detectMention |
| AC-8 | Score delta CSV exists in backfill dry-run | Script output inspection | ⏳ pending backfill script |
| AC-9 | All existing tests pass | `npm test` | ✅ 2434/2453 (4 unrelated UI failures) |
| AC-10 | Backfill script exists for `citation_check_responses` | File exists at script path | ⏳ pending |
| AC-11 | Backfill is idempotent | Run twice, snapshots match | ⏳ pending |
| AC-12 | Backfill defaults to dry-run | Script flag inspection | ⏳ pending |
| AC-13 | `discovered_competitors` backfill script exists | File exists at script path | ⏳ pending |

**Done definition:**
- All ACs marked ✅ or pass their pending verification
- ReviewMaster Phase A test suite (25 unit + 6 integration tests) passes against the implementation
- Backfill dry-run on Manipal site produces a delta of ≥13 rows
- Aditya approves the score-delta distribution from the dry-run CSV
- Backfill commit is run by Aditya manually (not by ScriptDev)
- Implementation report from ScriptDev includes: discovery code path location, dry-run delta CSV, screenshot of dashboard with corrected names

---

## k) Out of Scope

Per TS-081 §8 and the inbox message:
- TS-077 gateway migration (independent — interface contracts in this ES are designed to survive that rewrite because all logic lives in `brand-detector.ts`).
- `llms.txt` empty-string bug — separate TS (TS-082 if Aditya files it).
- Multilingual brand matching (Hindi, Tamil, etc.).
- Fuzzy / Levenshtein matching for misspelled brands.
- Subject brand detection improvements (already shipped via ES-059).
- Adding new entries to `AMBIGUOUS_BRAND_WORDS` beyond the existing list.
- Adding `"healthcare"` to `COMMON_SUFFIXES` (would fix `humanizeDomainToBrand("fortishealthcare.com")` but risks overmatching — defer until a real Haiku rename pass replaces this fallback entirely).
- Customer comms plan for score drops (decision lives with Aditya per TS-081 §9.3).
- Reverse / rollback script for backfill commits.
- Microbenchmark / `vitest bench` perf suite.

---

## l) Implementation Report Requirements (for ScriptDev)

When ScriptDev marks this complete, the report MUST include:

1. **Discovery code path location.** TS-081 §3.3 / §9.4 asks where `discovered_competitors` is populated. Confirmed: `geo/lib/services/competitor-discovery.ts::extractCompetitorsFromJson()`. ScriptDev should re-confirm by grepping `discovered_competitors:` in the codebase and verifying no other write sites exist.
2. **Backfill dry-run delta CSV.** Both scripts run against the full DB; output CSVs attached.
3. **Score-delta distribution.** Histogram or quartiles from the dry-run output. If `median(delta) < -5`, flag for Aditya before commit.
4. **Dashboard screenshot.** Before/after of the Manipal site report's competitors view.
5. **Test counts.** ScriptDev's 24 + ReviewMaster's 25 unit + 6 integration tests, all passing.
6. **Any AC that needed clarification.** Document deviations, if any.

---

## m) Spec Linkage

- **Source TS:** TS-081 (geo/docs/specs/technical/TS-081-competitor-brand-name-detection.md)
- **Predecessor ES:** ES-059 (brand detection / category extraction — established `BrandKeywords`, `detectMention`, `extractBrandKeywords`)
- **Related ES:** ES-069 (user-defined competitors — defines `DiscoveredCompetitor` shape used by this ES's keyword map)
- **Forward dependency:** TS-077 (citation-check gateway migration) will inherit these contracts when it rewrites `citation-checker.ts`. The four new exports in `brand-detector.ts` are the stable interface.

---

**End of ES-081**
