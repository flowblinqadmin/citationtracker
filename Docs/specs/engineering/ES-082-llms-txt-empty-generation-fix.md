# ES-082 — `llms.txt` Empty-Generation Bug Fix

**Author:** SpecMaster (Agent 2)
**Source TS:** geo/docs/specs/technical/TS-082-llms-txt-empty-generation-fix.md
**Date:** 2026-04-09
**Priority:** P1 (downgraded from P0 — production query confirms 0 real customers affected; see TS-082 §9)
**Pipeline pace:** Normal — not a hotfix
**Downstream:** ReviewMaster (ES-NNN dev spec)

---

## a) Overview

### What this covers

Fix the silent empty-string corruption of `geo_sites.generated_llms_txt` produced by three independent defects that compound:

1. **Generation defect** — `generateLlmsTxt` short-prompt OpenAI call has too small a `max_completion_tokens` budget AND never throws on `finish_reason === "length"` with empty content. The model burns the budget on internal reasoning and emits zero output. The empty result is treated as valid.
2. **Retry defect** — `withRetry` in `app/api/pipeline/stage/route.ts` silently returns the failing result after exhausting attempts ("using best result"). Validation failures never surface.
3. **Serve route defect** — `GET /api/serve/[slug]/llms.txt` collapses two distinct error states (no row, empty content) into HTTP 404. `verify-connection` then misdiagnoses customer setups as "rewrite rule not installed" when our content is empty.

The fix has two delivery layers:

- **Direction A — immediate** — bump `max_completion_tokens` 2000 → 8000 on the short call, throw `LlmsGenerationLengthExhausted` on `finish_reason === "length"` + empty content, change `withRetry` to throw on every final-attempt validation failure regardless of `maxAttempts`, return 503 from the serve route when the row exists with empty content, ship a `regenerate-empty-llms-txt.ts` operator script per TS-082 §8.
- **Direction B — durable follow-up (same dispatch)** — restructure the short-call prompt to a flat numbered instruction list with all conditional sections pre-resolved in TypeScript, modeled after TS-082 §8 reference impl. This eliminates the reasoning trigger entirely, not just gives it more headroom.

Both directions ship in this engineering spec. ScriptDev produces them as two sequential diffs on the same branch so reviewers can audit Direction B independently.

### Source TS reference

`geo/docs/specs/technical/TS-082-llms-txt-empty-generation-fix.md` — read the full document. Key load-bearing sections:
- §2.2 — generation root cause (prompt-shape sensitivity, **NOT** token budget alone)
- §3 — 15 acceptance criteria (this ES translates each one to deliverables)
- §6 — open-question resolutions (Q1–Q4 all resolved 2026-04-09)
- §8 — reference implementation (proven working — Manipal hot-fix, 0 reasoning tokens, 6,452 chars output). **Use this verbatim** as the structural template for both Direction B and the regeneration script.

### Current implementation state

| Surface | File | Lines | State |
|---|---|---|---|
| Short-call generation | `geo/lib/services/content-generator.ts` | 145–289 (function), 257–276 (OpenAI call) | Buggy — `max_completion_tokens: 2000`, no `finish_reason` check, empty result returned silently |
| Retry helper | `geo/app/api/pipeline/stage/route.ts` | 148–167 | Buggy — silent fall-through on line 165–166: `console.warn("using best result"); return lastResult!` |
| `llms` chunk caller | `geo/app/api/pipeline/stage/route.ts` | 610–637 | Calls `withRetry` with `maxAttempts: 1`; comment at line 625 says "stage-level retry handles transient failures" — only true if the handler throws |
| Other `withRetry` callers | `geo/app/api/pipeline/stage/route.ts` | 640 (`generateBusinessJson`, maxAttempts=2), 742 (`assembleResults`, maxAttempts default=3) | Affected by §3.2 unified throw semantics — see AC-6 |
| Short serve route | `geo/app/api/serve/[slug]/llms.txt/route.ts` | 9–33 (whole file) | Buggy — line 15 returns 404 for both `!site` and `!site.generatedLlmsTxt` |
| Full serve route | `geo/app/api/serve/[slug]/llms-full.txt/route.ts` | 9–33 (whole file) | Same bug class — defensive fix per AC-9 |
| Verify-connection | `geo/app/api/sites/[id]/verify-connection/route.ts` | 67–124 (POST) | Branches on `result.status === 404` (line 100) — needs new branch for 503 from our serve URL |
| Site lookup | `geo/lib/serve-lookup.ts` | 24–75 | `isNotNull(geoSites[assetField])` (lines 45, 64) **passes** empty strings — they are non-NULL. Combined with `desc(createdAt)` step 2 returns the latest complete audit even if its content is empty. See ES §b.4 for the design call. |
| Existing pipeline test | `geo/__tests__/pipeline-stage-errors.test.ts` | 745–803 | Mocks `generateLlmsTxt` and asserts fan-in counters; does **not** test withRetry throw path |

### Out of scope (verbatim from TS-082 §4)

- TS-081 competitor brand-name detection (independent fix on the same branch, ES-081)
- Full `gpt-5.4-mini` reasoning-token instrumentation across all OpenAI call sites (separate TS)
- Migrating to a non-reasoning model (e.g. `gpt-4o-mini`) for short-form generation
- Cleanup of the 126 `ar@flowblinq.com` empty-llms test sites — those are the dead double-stringification bug from 2026-03-16, not TS-082's target (see TS-082 §9 Decisions Log)

---

## b) Implementation Requirements

### b.1 New typed errors

Create a new file `geo/lib/services/content-generator-errors.ts`:

```ts
/** Thrown when an OpenAI completion exhausts its token budget without emitting content. */
export class LlmsGenerationLengthExhausted extends Error {
  readonly finishReason: string;
  readonly completionTokens: number;
  readonly reasoningTokens: number;
  readonly maxCompletionTokens: number;
  readonly call: "short" | "full";
  constructor(args: {
    call: "short" | "full";
    finishReason: string;
    completionTokens: number;
    reasoningTokens: number;
    maxCompletionTokens: number;
  }) {
    super(
      `[generateLlmsTxt:${args.call}] OpenAI returned empty content with finish_reason="${args.finishReason}" ` +
      `(completion=${args.completionTokens}, reasoning=${args.reasoningTokens}, budget=${args.maxCompletionTokens}). ` +
      `Likely reasoning-burn — see TS-082 §2.2.`
    );
    this.name = "LlmsGenerationLengthExhausted";
    this.call = args.call;
    this.finishReason = args.finishReason;
    this.completionTokens = args.completionTokens;
    this.reasoningTokens = args.reasoningTokens;
    this.maxCompletionTokens = args.maxCompletionTokens;
  }
}

/** Thrown by `withRetry` when validation fails on the final attempt. */
export class RetryValidationExhausted extends Error {
  readonly label: string;
  readonly attempts: number;
  readonly failures: string[];
  constructor(label: string, attempts: number, failures: string[]) {
    super(`[withRetry] ${label} validation failed on final attempt ${attempts}: ${failures.join("; ")}`);
    this.name = "RetryValidationExhausted";
    this.label = label;
    this.attempts = attempts;
    this.failures = failures;
  }
}
```

Re-export both from `geo/lib/services/content-generator.ts` (top-level re-export, no logic change there) so callers in `app/api/pipeline/stage/route.ts` can `import { LlmsGenerationLengthExhausted, RetryValidationExhausted } from "@/lib/services/content-generator"`.

### b.2 `generateLlmsTxt` — Direction A (immediate fix)

File: `geo/lib/services/content-generator.ts`, function at line 145.

**Change 1 — bump short-call budget (line 265):**

```ts
// Before:
max_completion_tokens: 2000,
// After:
max_completion_tokens: 8000,  // ES-082 §3.1 AC-3 — was 2000; bumped to match/exceed full call's 6000 headroom
```

**Change 2 — `finish_reason` guard immediately after the `Promise.all` resolves (insert between lines 276 and 278):**

```ts
const shortFinish = shortRes.choices[0]?.finish_reason ?? "unknown";
const shortContent = shortRes.choices[0]?.message?.content ?? "";
if (shortFinish === "length" && shortContent.trim().length === 0) {
  throw new LlmsGenerationLengthExhausted({
    call: "short",
    finishReason: shortFinish,
    completionTokens: shortRes.usage?.completion_tokens ?? 0,
    reasoningTokens: (shortRes.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0,
    maxCompletionTokens: 8000,
  });
}

const fullFinish = fullRes.choices[0]?.finish_reason ?? "unknown";
const fullContent = fullRes.choices[0]?.message?.content ?? "";
if (fullFinish === "length" && fullContent.trim().length === 0) {
  throw new LlmsGenerationLengthExhausted({
    call: "full",
    finishReason: fullFinish,
    completionTokens: fullRes.usage?.completion_tokens ?? 0,
    reasoningTokens: (fullRes.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0,
    maxCompletionTokens: 6000,
  });
}

let llmsTxt = shortContent;
let llmsFullTxt = fullContent;
```

(Replace the existing `let llmsTxt = …` / `let llmsFullTxt = …` reads with the variables already extracted above.)

**Change 3 — reasoning-token telemetry warning (defensive per TS-082 §5.1):**

After the `finish_reason` guards, add:

```ts
const shortReasoning = (shortRes.usage as any)?.completion_tokens_details?.reasoning_tokens ?? 0;
const shortCompletion = shortRes.usage?.completion_tokens ?? 0;
if (shortCompletion > 0 && shortReasoning / shortCompletion > 0.7) {
  console.warn(JSON.stringify({
    event: "llms_short_high_reasoning_share",
    domain,
    reasoning_tokens: shortReasoning,
    completion_tokens: shortCompletion,
    ratio: +(shortReasoning / shortCompletion).toFixed(2),
    note: "ES-082 §5.1 guard — reasoning share > 70% may foreshadow budget exhaustion",
  }));
}
```

(Same pattern for `fullRes` for symmetry.)

### b.3 `generateLlmsTxt` — Direction B (durable fix)

Direction B replaces the conditional-section prompt construction with a flat, pre-resolved instruction list. The structural template is TS-082 §8.2, adapted to retain pillar-aware customization but with **all conditional branching pre-baked in TypeScript** before the prompt string is constructed.

**Approach:** introduce a helper `buildShortPromptInstructions(domain, geoScorecard, pagesWithFaq, teamSection, ...)` that returns a flat array of numbered instruction strings. The final prompt is `instructions.map((s, i) => \`${i+1}. ${s}\`).join("\n")` interpolated into a fixed wrapper that mirrors §8.2 structure:

```ts
function buildShortLlmsTxtPrompt(args: {
  domain: string;
  context: string;
  improvements: string;
  geoScorecard: GeoScorecard;
  pagesWithFaq: string[];
  hasNamedTeam: boolean;
  hasEvidence: boolean;
  freshnessScore: number;
}): { system: string; user: string } {
  const system = `You generate llms.txt files following the llmstxt.org specification. ...`;
  // ↑ unchanged — same content as the current `llmsSystemPrompt` constant.

  const rules: string[] = [
    `Keep the H1 (# {Brand Name}) and the blockquote (> ...) on lines 1-3, sourced from the SITE DATA below.`,
    `Keep these sections in this order: ## About, ## Products/Services${args.pagesWithFaq.length > 0 ? ", ## FAQ" : ""}, ## Key Concepts${args.hasEvidence ? ", ## Evidence" : ""}${args.hasNamedTeam ? ", ## Team" : ""}, ## Content, ## Contact.`,
    `## About — 2-3 paragraphs, concrete and specific.${args.freshnessScore < 60 ? " If a founding year or product update date is in the source, include it explicitly." : ""}`,
    `## Products/Services — bullet list with real names from SITE DATA. One short description line each. No nested bullets.`,
    `## Key Concepts — define ${args.geoScorecard.pillars.find(p => p.pillar === "entity_definitions")?.score ?? 0 < 75 ? "5-8" : "3-5"} domain-specific terms. Each definition MUST start with "is" or "refers to".`,
    args.pagesWithFaq.length > 0
      ? `## FAQ — Do NOT inline Q&A pairs. Write one sentence: "Frequently asked questions are available at:" followed by a bullet list of these URLs:\n${args.pagesWithFaq.map(u => `   - ${u}`).join("\n")}`
      : null,
    args.hasNamedTeam
      ? `## Team — for each named person in SITE DATA, write: full name, exact title, one-sentence expertise summary, LinkedIn URL if found.`
      : null,
    args.hasEvidence
      ? `## Evidence — format stats as: "[Number/percentage] [claim] (Source: [name or URL])". Use only stats found in SITE DATA.`
      : null,
    `## Content — links to key blog posts with real titles from SITE DATA.`,
    `## Contact — only real emails and URLs from SITE DATA. Omit if none found. Do NOT invent.`,
    `Target length: 1500-3000 words.`,
    `Return ONLY the file content. No code fences. No explanations.`,
  ].filter((r): r is string => r !== null);

  const numbered = rules.map((r, i) => `${i + 1}. ${r}`).join("\n\n");

  const user = `Below is the site data for ${args.domain}. Produce a CONDENSED llms.txt following the llmstxt.org spec.

REQUIREMENTS:
${numbered}

Top GEO improvements needed: ${args.improvements}

SITE DATA:
${args.context}

Return ONLY the condensed llms.txt content. No code fences. No explanations.`;

  return { system, user };
}
```

**Why this works (from TS-082 §2.2 + §8.2):** the LLM never sees `if X then mention Y` language. All conditionals are resolved on the TypeScript side before the prompt is built. The model treats the request as transformation (= zero reasoning tokens in the Manipal experiment), not planning.

**Direction B vs Direction A combined:** with Direction B in place, the 8000-token budget from Direction A is overkill. **Keep both** — Direction A provides defense in depth if a future instruction makes the prompt grow accidentally.

**Constraint:** Direction B must produce a prompt that is **functionally equivalent** to the current short prompt in terms of pillar-aware customization. ScriptDev should diff the rendered prompt strings against the current behavior on a fixture site to ensure no semantic drift. This is verified by AC-13 (snapshot test on Manipal fixture).

### b.4 `withRetry` — unified throw semantics

File: `geo/app/api/pipeline/stage/route.ts`, function at lines 148–167.

**TS-082 Q2 resolution (load-bearing):** `withRetry` MUST throw on every final-attempt validation failure, regardless of `maxAttempts`. No special-casing.

**Replacement:**

```ts
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  check: (result: T) => { passed: boolean; failures: string[] },
  maxAttempts = 3
): Promise<T> {
  let lastFailures: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    const { passed, failures } = check(result);
    if (passed) {
      if (attempt > 1) console.warn(`[stage] ${label} passed on attempt ${attempt}`);
      return result;
    }
    lastFailures = failures;
    console.warn(`[stage] ${label} check failed (attempt ${attempt}/${maxAttempts}): ${failures.join("; ")}`);
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
  // ES-082 §3.2 AC-4/5/6 — unified throw on final-attempt validation failure.
  // Replaces the previous silent fall-through "using best result" path which corrupted data.
  throw new RetryValidationExhausted(label, maxAttempts, lastFailures);
}
```

**JSDoc to add above the function:**

```ts
/**
 * Retries `fn()` up to `maxAttempts` times, calling `check()` after each attempt.
 *
 * @throws {RetryValidationExhausted} when the validator fails on the final attempt
 *   (regardless of `maxAttempts`). Callers must allow this throw to propagate so
 *   the stage-level retry / markFailed logic can handle it. Catching and swallowing
 *   the throw at the call site WILL persist invalid data — see TS-082 §2.3 for
 *   the production incident this prevents.
 *
 * @see ES-082 §3.2 AC-4/5/6
 */
```

### b.5 Caller updates for the unified throw

Three call sites — none require structural changes, but each needs documentation that the throw path is now expected:

| Line | Caller | maxAttempts | Action |
|---|---|---|---|
| 612 | `generateLlmsTxt` (`llms` chunk) | `1` | Remove the misleading "stage-level retry handles transient failures" comment at line 625. Replace with: `// ES-082: throws RetryValidationExhausted on validation failure → propagates to outer try/catch in POST() which calls markFailed() which triggers stage-level retry via the existing retryStage path.` |
| 640 | `generateBusinessJson` (`business` chunk) | `2` | Add comment: `// ES-082: throws on final-attempt failure (was silent fall-through pre-ES-082).` |
| 742 | `assembleResults` (`assemble` stage) | `3` (default) | Add comment: `// ES-082: throws on final-attempt failure. assembleResults validator currently returns boolean — see TS-082 §5.4 risk; ScriptDev MUST verify checkExecutiveSummary returns the {passed, failures} shape, OR adapt the call.` |

**ScriptDev note 1 (load-bearing):** the `assembleResults` call at line 742 currently passes `(r) => checkExecutiveSummary(r.executiveSummary)` as the check. `checkExecutiveSummary` (per the existing test mock at line 76) returns a boolean, **not** the `{passed, failures}` shape that `withRetry` expects. The current code is buggy — it's been "passing" only because `withRetry` silently fell through. With the throw change, this call site will throw on every attempt because the destructuring `{ passed, failures } = check(result)` will yield `passed = undefined` and the `if (passed)` branch will never fire.

**Required adapter at the call site (line 742):**

```ts
withRetry(
  "assembleResults",
  () => assembleResults(domain, crawlData, geoScorecard, generatedContent, researchData, isPaidUser),
  (r) => {
    const ok = checkExecutiveSummary(r.executiveSummary);
    return { passed: ok, failures: ok ? [] : ["executive summary failed checkExecutiveSummary"] };
  }
)
```

This is mandatory — without it the change to `withRetry` will break the assemble stage on every run. **AC-16 covers this** (added below).

### b.6 Serve route — 503 path

Files: `geo/app/api/serve/[slug]/llms.txt/route.ts` and `geo/app/api/serve/[slug]/llms-full.txt/route.ts`.

**Replacement for `llms.txt/route.ts`:**

```ts
import { NextRequest, NextResponse } from "next/server";
import { resolveSiteForServing } from "@/lib/serve-lookup";
import { logCrawl } from "@/lib/log-crawl";

interface RouteContext {
  params: Promise<{ slug: string }>;
}

const EMPTY_GENERATION_BODY =
  "Generation pending or failed — please re-run the audit from your dashboard.";

export async function GET(req: NextRequest, { params }: RouteContext) {
  try {
    const { slug } = await params;

    const site = await resolveSiteForServing(slug, "generatedLlmsTxt");

    // Distinguish three states (ES-082 §3.3 AC-7):
    //   404 — no row at all, or row exists with NULL field (legacy / never-generated)
    //   503 — row exists with empty-string field (Manipal-class generation failure)
    //   200 — row exists with non-empty content
    if (!site) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }

    const value = site.generatedLlmsTxt;
    if (value == null) {
      return new NextResponse("Not found", {
        status: 404,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (value.length === 0) {
      void logCrawl(req, site.id, slug, "llms_txt_empty");
      return new NextResponse(EMPTY_GENERATION_BODY, {
        status: 503,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Retry-After": "600",
          "X-Generator": "FlowBlinq GEO",
          "Cache-Control": "no-store",
        },
      });
    }

    void logCrawl(req, site.id, slug, "llms_txt");

    return new NextResponse(value, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
        "X-Generator": "FlowBlinq GEO",
      },
    });
  } catch (err) {
    console.error("GET serve llms.txt error:", err);
    return new NextResponse("Internal server error", { status: 500 });
  }
}
```

**Same treatment for `llms-full.txt/route.ts`** — substitute `generatedLlmsFullTxt` and `llms_full_txt_empty` log type. Per AC-9, this is defensive symmetry — currently no full-text empty cases exist.

**Design call — `resolveSiteForServing` and empty fallback:** the existing `resolveSiteForServing` filter at `geo/lib/serve-lookup.ts:45` is `isNotNull(geoSites[assetField])`. Empty strings are non-null and pass the filter. Combined with `desc(createdAt).limit(1)`, the function returns the latest complete audit even if its content is empty.

Two viable behaviors:

| Option | Behavior | Trade-off |
|---|---|---|
| **A — keep current "always latest"** | If the latest complete audit has empty content, return 503. The 503 surfaces the bug and prompts re-audit. | Customers lose their previously-good content during the broken window. |
| **B — fall back to most recent non-empty** | Amend `resolveSiteForServing` to filter for non-empty (`length(field) > 0`) in steps 2–3, falling through to step 4 (exact match) only if no non-empty audit exists. | Older good content masks the broken latest audit; bug becomes invisible. Conflicts with TS-082's diagnostic intent. |

**SpecMaster decision: Option A.** The whole point of TS-082 is to surface this state, not paper over it. The 503 with `Retry-After: 600` and the explicit body text gives the customer (and our verify-connection) a clear signal. A bug that doesn't surface keeps biting.

**No change to `resolveSiteForServing`** — it stays as-is. The route does the empty-vs-null discrimination locally on the returned `site` object. Recorded under AC-7 below.

### b.7 `verify-connection` — 503 branch

File: `geo/app/api/sites/[id]/verify-connection/route.ts`, function `POST` lines 67–124.

**New branch in the `!result.ok` ladder (insert between current lines 99 and 100):**

```ts
} else if (result.status === 503) {
  detail = `Your site is correctly proxying to our serve URL, but our generated llms.txt file is currently empty for this site. Please re-run the audit from your dashboard. (We're aware of this and tracking it as a generation issue, not a setup issue on your end.)`;
} else if (result.status === 404) {
  // ... existing 404 branch unchanged
```

**Order matters** — 503 must come before the 404 / 429 / 403 / generic branches because the existing ladder uses `if/else if` on `result.status`.

**No change** to `proxyFetch` — it already returns the upstream HTTP status verbatim. The 503 will propagate through Tier 1 (direct fetch) without retry to Tier 2/3 because the existing `if (res.status !== 429 && res.status !== 403)` allow-list **passes** 503 through (line 24 / 39).

**ScriptDev note 2:** confirm the `proxyFetch` 503 propagation in a unit test (`AC-15` integration test covers the end-to-end path; this confirms the proxy step explicitly).

### b.8 Operator script — `regenerate-empty-llms-txt.ts`

File to create: `geo/scripts/regenerate-empty-llms-txt.ts`

**Reference:** TS-082 §8 (canonical implementation). Use the §8.2 prompt verbatim for the OpenAI call. Use §8.3 for validation gates. Use §8.4 for the UPDATE statement (idempotency invariant must be preserved). Use §8.5 for post-UPDATE verification.

**CLI surface:**

```
Usage: tsx geo/scripts/regenerate-empty-llms-txt.ts [options]

Options:
  --site <site-id>     Regenerate one specific site only
  --domain <domain>    Regenerate all empty-llms sites for a single domain
  --owner <email>      Regenerate all empty-llms sites for a single owner
  --commit             Actually write to the database (default: dry-run)
  --max <n>            Maximum number of sites to process (default: unlimited)
  --help               Show this help

Examples:
  # Dry-run: list all candidates, don't change anything
  tsx geo/scripts/regenerate-empty-llms-txt.ts

  # Dry-run for one specific site
  tsx geo/scripts/regenerate-empty-llms-txt.ts --site -GzFX1KcKhmN0W_1t8SmY

  # Actually fix Manipal
  tsx geo/scripts/regenerate-empty-llms-txt.ts --site -GzFX1KcKhmN0W_1t8SmY --commit
```

**Selection query (default — no filter flags):**

```sql
SELECT id, domain, slug, owner_email
FROM geo_sites
WHERE pipeline_status = 'complete'
  AND (generated_llms_txt IS NULL OR length(generated_llms_txt) = 0)
  AND generated_llms_full_txt IS NOT NULL
  AND length(generated_llms_full_txt) >= 1000
ORDER BY updated_at DESC
LIMIT $maxLimit
```

**Critical exclusions in the selection query:**
- `generated_llms_full_txt IS NOT NULL AND length >= 1000` — only sites where we have a valid source document. The 126 `ar@flowblinq.com` test sites with empty full-text are excluded automatically.
- `pipeline_status = 'complete'` — never touch in-flight pipelines.

**Dry-run output format (default):**

```
[dry-run] Found 1 site(s) eligible for regeneration:

  -GzFX1KcKhmN0W_1t8SmY  manipalhospitals.com   (owner: customer@example.com)
    full_text length: 16,404
    short_text length: 0

To actually regenerate, re-run with --commit.
```

**Commit-mode flow per site:**

1. SELECT the row (re-fetch — minimize race window with normal pipeline).
2. Sanity-gate the source: `fullText.length >= 1000 && fullText.startsWith("# ")` per TS-082 §8.1. Skip with `[skip] sanity-gate` if not met.
3. Call OpenAI per TS-082 §8.2 (verbatim system + user prompt, model `gpt-5.4-mini`, `max_completion_tokens: 6000`, `temperature: 0.1`).
4. Apply validation gates per TS-082 §8.3. On any validation failure, throw `LlmsValidationError` (define inline in script — does NOT need to be exported from `content-generator.ts`).
5. Apply sanitization per TS-082 §8.3 (strip code fences).
6. UPDATE per TS-082 §8.4 with the idempotency `WHERE` clause:
   ```sql
   UPDATE geo_sites
   SET generated_llms_txt = $sanitized,
       updated_at = NOW()
   WHERE id = $siteId
     AND domain = $domain
     AND (generated_llms_txt IS NULL OR length(generated_llms_txt) = 0)
   RETURNING id, length(generated_llms_txt) AS new_len, updated_at
   ```
   If `result.length === 0`, log `[skip] already has content or domain mismatch` and continue.
7. Post-UPDATE verification per TS-082 §8.5 — fetch `https://geo.flowblinq.com/api/serve/{slug}/llms.txt` and assert HTTP 200. If non-200, log warning but do not roll back.
8. Print summary per site: `[ok] {siteId} {domain} → {new_len} chars`.

**At-end summary:**

```
─── regenerate-empty-llms-txt summary ───
  Eligible:    {n}
  Regenerated: {n_ok}
  Skipped:     {n_skipped}  (already-fixed, race conditions, sanity-gate failures)
  Failed:      {n_failed}   (OpenAI errors, validation failures)
  Mode:        {dry-run | commit}
```

**Constraint:** credentials sourced from `.env.local` via `process.env.OPENAI_API_KEY` and the existing `db` instance from `@/lib/db`. **Never inline credentials.** TS-082 §6 Q3 retired the standalone `manual-fix-manipal-llms.mjs` script for exactly this reason.

**Constraint (AC-12):** no scheduled / automated invocation. This script is operator-only. Do not add a cron entry, do not import it from any pipeline code, do not link it from CI. Place a `// OPERATOR-ONLY — do not invoke from application code` comment at the top of the file.

### b.9 Files summary

| Action | Path | LOC est. |
|---|---|---|
| **CREATE** | `geo/lib/services/content-generator-errors.ts` | ~60 |
| **CREATE** | `geo/scripts/regenerate-empty-llms-txt.ts` | ~250 |
| **MODIFY** | `geo/lib/services/content-generator.ts` | +60, -10 (Direction A: 3 changes; Direction B: new helper + replace prompt construction in `generateLlmsTxt`) |
| **MODIFY** | `geo/app/api/pipeline/stage/route.ts` | +15, -5 (`withRetry` rewrite + 1 caller adapter for `assembleResults` + 3 call-site comments) |
| **MODIFY** | `geo/app/api/serve/[slug]/llms.txt/route.ts` | rewrite (~50) |
| **MODIFY** | `geo/app/api/serve/[slug]/llms-full.txt/route.ts` | rewrite (~50) |
| **MODIFY** | `geo/app/api/sites/[id]/verify-connection/route.ts` | +5, 0 (insert 503 branch) |

**No DDL changes.** No schema migration. No new dependencies.

---

## c) Unit Test Plan

### c.1 New test file — `geo/__tests__/services/content-generator.llms-txt.test.ts`

| # | Test | Setup | Assertion |
|---|---|---|---|
| U1 | Returns valid result on happy path | Mock OpenAI to return non-empty content with `finish_reason: "stop"` for both calls | `result.llmsTxt.length > 200`, starts with `# `, has `> ` blockquote |
| U2 | Throws `LlmsGenerationLengthExhausted` on short call empty + length | Mock short call to return `{ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 8000, completion_tokens_details: { reasoning_tokens: 8000 } } }`. Mock full call to return valid content. | Throws `LlmsGenerationLengthExhausted` with `call === "short"`, `finishReason === "length"`, `reasoningTokens === 8000` |
| U3 | Throws `LlmsGenerationLengthExhausted` on full call empty + length | Inverse of U2 | Throws with `call === "full"` |
| U4 | Does NOT throw when content is empty but `finish_reason !== "length"` | Mock short call to return `content: ""` with `finish_reason: "stop"` (model genuinely returned empty) | Does not throw — returns empty string. (Direction A only handles the length-exhaustion case; other empty-content paths are caught by the validator in the chunk handler.) |
| U5 | Does NOT throw when content is non-empty even if `finish_reason === "length"` | Mock short call to return non-empty content with `finish_reason: "length"` (model hit budget mid-output but still emitted text) | Does not throw — returns content. The error is **only** for the empty-and-length combo. |
| U6 | Emits `llms_short_high_reasoning_share` warning when reasoning > 70% of completion | Mock with `completion_tokens: 1000, reasoning_tokens: 800` (80% ratio) | `console.warn` called with JSON containing `event: "llms_short_high_reasoning_share"` and `ratio: 0.8` |
| U7 | Does NOT emit reasoning warning when ratio ≤ 70% | Mock with `completion_tokens: 1000, reasoning_tokens: 700` (70% ratio) | `console.warn` not called for the high-share event |
| U8 | Direction B prompt is flat (no `if X then` language) | Call internal `buildShortLlmsTxtPrompt` (export via `__test_internals` if module-private) with a fixture `geoScorecard` and assert the rendered `user` string contains no substrings: `"if "`, `"IF "`, `"unless"`, `"otherwise"`. | All assertions pass |
| U9 | Direction B prompt — Manipal fixture snapshot | Use the saved Manipal `crawlData` + `geoScorecard` fixture (committed under `__tests__/fixtures/manipal-site.json`); call `buildShortLlmsTxtPrompt`; snapshot the rendered user prompt | Snapshot match (initial snapshot generated by ScriptDev during impl, committed) |
| U10 | Direction B preserves pillar-aware customization | Two fixture scorecards: one with `entity_definitions = 50` (low), one with `entity_definitions = 90` (high). Call `buildShortLlmsTxtPrompt` for each. | Low scorecard's prompt contains `5-8`, high scorecard's contains `3-5` |
| U11 | Direction B includes Team section IF named team present | Two fixtures: `hasNamedTeam: true` and `false` | First contains `## Team`, second omits it entirely (no `## Team` substring) |
| U12 | Direction B includes Evidence section IF stats present | Two fixtures: `hasEvidence: true` and `false` | First contains `## Evidence`, second omits it |
| U13 | Direction B includes FAQ section IF pages with FAQs present | `pagesWithFaq: ["/x", "/y"]` and `[]` | First contains `## FAQ` and bullet URLs; second omits |
| U14 | Direction A bumped max_completion_tokens to 8000 | Mock OpenAI client to capture the create() call args; call `generateLlmsTxt` | Captured short-call args have `max_completion_tokens: 8000` |

**Mock requirements:**
- OpenAI client — use `vi.mock("openai", ...)` with a controllable `chat.completions.create` mock.
- `crawlData` and `geoScorecard` fixtures — see §c.3.
- `console.warn` — spy via `vi.spyOn(console, "warn")`.

**Coverage target:** 100% of `generateLlmsTxt` lines, 100% of new helper `buildShortLlmsTxtPrompt`, 100% of new error class branches.

### c.2 New test file — `geo/__tests__/pipeline-stage.with-retry.test.ts`

(Separate file from `pipeline-stage-errors.test.ts` to keep the existing 831-line test file untouched and avoid merge friction with parallel work on the same file.)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U15 | Returns result on first-attempt success | `fn` resolves to valid result, `check` returns `{ passed: true, failures: [] }` | Returns the result, `fn` called exactly once |
| U16 | Returns result after one retry | First call: validator fails. Second call: validator passes. `maxAttempts: 3` | Returns the second result, `fn` called twice, `console.warn` called once for the failed attempt + once for the "passed on attempt 2" message |
| U17 | **Throws `RetryValidationExhausted` after `maxAttempts: 1` exhausted** | `fn` resolves to invalid result. `check` returns `{ passed: false, failures: ["too short"] }`. `maxAttempts: 1` | Throws `RetryValidationExhausted` with `attempts === 1`, `failures === ["too short"]`, `label === "test-label"`. **No silent return.** |
| U18 | Throws `RetryValidationExhausted` after `maxAttempts: 3` exhausted | `fn` always returns invalid. `maxAttempts: 3` | Throws after 3 calls. `attempts === 3` |
| U19 | Throws on `maxAttempts: 2` exhausted | Same pattern, `maxAttempts: 2` | Throws after 2 calls. `attempts === 2` |
| U20 | Each retry waits the documented backoff | Use fake timers (`vi.useFakeTimers`). First attempt fails. Capture timing of second invocation. | Second invocation occurs at least 1000 ms after first failure (current behavior is `1000 * attempt` ms) |
| U21 | Throw includes the failures from the **final** attempt only | First attempt: failures `["a"]`. Second: failures `["b", "c"]`. `maxAttempts: 2` | Throws with `failures: ["b", "c"]` (most recent), not aggregated |

### c.3 New fixture file — `geo/__tests__/fixtures/manipal-site.json`

Contains a redacted snapshot of the Manipal site row used by U9 and IT2. Fields:

- `id`, `domain` (`manipalhospitals.com`), `slug`
- `crawlData` — the actual crawl data structure that produced the bug. Source from production via a one-shot extraction by ScriptDev. Redact PII (owner_email, customer-private fields).
- `geoScorecard` — the scorecard from the same row.
- `generated_llms_full_txt` — the 16,404-char working full-text. Trim to first 5,000 chars for the fixture (enough to exercise the Direction B prompt builder; full version not needed for unit tests).

**ScriptDev note 3:** if extracting from production is gated, fall back to a synthetic fixture that mirrors the structure (5+ pillars, 5+ pages, FAQ pairs on 2+ pages). U9's snapshot must then be regenerated from the synthetic — flag in the PR description.

### c.4 New test file — `geo/__tests__/scripts/regenerate-empty-llms-txt.test.ts`

| # | Test | Setup | Assertion |
|---|---|---|---|
| U22 | Dry-run mode does NOT call db.update | Mock `db.select` to return one eligible row. Call script main with `commit: false`. | `db.update` mock not called. stdout contains `[dry-run]` and the candidate site. |
| U23 | Commit mode calls db.update with sanitized content | Mock `db.select` (eligible row), mock OpenAI (returns valid content), call with `commit: true`. | `db.update` called once with the sanitized content. |
| U24 | Sanity-gate skips sites with `full_text < 1000 chars` | Mock eligible row with `generated_llms_full_txt: "# Short"` (8 chars). | `[skip] sanity-gate` logged. `db.update` not called. OpenAI not called. |
| U25 | Idempotent: re-running on already-fixed site is a no-op | Mock the UPDATE to return `result.length === 0` (race condition: row already has content). | `[skip] already has content` logged. No error. Script exits 0. |
| U26 | Validation gate rejects too-short output | Mock OpenAI to return `"# X\n> Y"` (length 8). | `LlmsValidationError("too short")` logged. UPDATE not called. |
| U27 | Validation gate rejects missing H1 | Mock OpenAI to return content without `# ...` line. | `LlmsValidationError("missing H1")` logged. |
| U28 | Validation gate rejects missing blockquote | Mock OpenAI to return content with H1 but no `> ` line. | `LlmsValidationError("missing blockquote")` logged. |
| U29 | Validation gate rejects missing sections | Mock OpenAI to return content with H1 + `>` but no `## ` lines. | `LlmsValidationError("no sections")` logged. |
| U30 | Sanitization strips code fences | Mock OpenAI to return ` ```markdown\n# X\n> Y\n## Z\n... \n``` `. | The sanitized value passed to UPDATE has no leading/trailing fence. |
| U31 | `--site <id>` filter restricts SELECT to that site | Pass `--site abc123`. | The select call has `where(eq(geoSites.id, "abc123"))`. |
| U32 | `--max <n>` caps the SELECT LIMIT | Pass `--max 5`. | The select call has `.limit(5)`. |
| U33 | OpenAI failure does not roll back UPDATE on other sites | Mock 3 sites; second OpenAI call throws. | Sites 1 and 3 get UPDATEs; site 2 logs `[failed]`. Summary shows `regenerated: 2, failed: 1`. |
| U34 | Default mode (no flags) is dry-run | Run with no flags. | `db.update` not called even with eligible rows. |

**Coverage target:** 100% lines, 100% branches in `regenerate-empty-llms-txt.ts`.

### c.5 New test file — `geo/__tests__/api/serve/llms-txt-route.test.ts`

| # | Test | Setup | Assertion |
|---|---|---|---|
| U35 | Returns 200 with body when site has non-empty content | Mock `resolveSiteForServing` → `{ id, generatedLlmsTxt: "# X\n> Y\n## Z" }` | Status 200, `Content-Type: text/plain; charset=utf-8`, body matches |
| U36 | Returns 404 when `resolveSiteForServing` returns `null` | Mock → `null` | Status 404, body `"Not found"` |
| U37 | Returns 404 when site exists with `generatedLlmsTxt: null` | Mock → `{ id, generatedLlmsTxt: null }` | Status 404 |
| U38 | **Returns 503 when site exists with `generatedLlmsTxt: ""`** | Mock → `{ id, generatedLlmsTxt: "" }` | Status 503, `Retry-After: 600`, body matches `"Generation pending or failed..."` |
| U39 | Sets `Cache-Control: no-store` on 503 | Same as U38 | Header present and `no-store` |
| U40 | Logs `llms_txt_empty` crawl type on 503 | Spy on `logCrawl` | Called with `assetType: "llms_txt_empty"` |
| U41 | 503 response is not cacheable in tests asserting browser caching | Same as U38 | `Cache-Control` is `no-store`, **not** `public, max-age=3600` |

### c.6 New test file — `geo/__tests__/api/serve/llms-full-txt-route.test.ts`

Mirror tests U35–U41 for the full route with `generatedLlmsFullTxt` and `llms_full_txt_empty`.

### c.7 New test file — `geo/__tests__/api/sites/verify-connection.test.ts` (or extend existing if present)

| # | Test | Setup | Assertion |
|---|---|---|---|
| U42 | Returns customer-facing 503 message when proxy returns 503 | Mock `proxyFetch` → `{ ok: false, status: 503, body: "...", method: "direct" }` | Response body `connected: false`, `detail` matches the new 503 message text |
| U43 | Returns existing 404 message when proxy returns 404 | Mock `proxyFetch` → `{ ok: false, status: 404, ... }` | `detail` matches existing 404 message |
| U44 | 503 branch matched before 404 / 429 / 403 | Mock with `status: 503` | The 503 detail is returned, not any other branch |

### c.8 Coverage / mock requirements summary

- **Total new unit tests: 44 (U1–U44)**
- **New fixture files: 1 (`manipal-site.json`)**
- **New test files: 6**
- **OpenAI mock pattern:** capture-arg + scripted-response style. Use `vi.fn()` per test, not module-level state.
- **DB mock pattern:** copy from `geo/__tests__/pipeline-stage-errors.test.ts:46-53` (chainable mock).
- **Coverage target:** 100% of new code, 100% of modified branches in existing files.

---

## d) Integration Test Plan

### d.1 New test file — `geo/__tests__/integration/pipeline/llms-empty-generation.integration.test.ts`

These tests use the real `db` (test schema) and the real `withRetry` function but mock OpenAI at the SDK boundary.

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT1 | End-to-end: empty short generation throws → stage marked failed | Insert a `geo_sites` row with full crawl data. Mock OpenAI short call to return empty + `finish_reason: "length"`. POST `/api/pipeline/stage` with `stage: generate-chunk, chunkType: llms`. | Response 200 with `{ ok: true }` (errors are caught by markFailed). DB row has `pipeline_status = 'failed'` and an error log. `generated_llms_txt` is **NOT** set to empty string — the previous value (or NULL) is preserved. Stage-level retry counter incremented. |
| IT2 | Manipal fixture replay: full pipeline succeeds with Direction B prompt | Insert fixture row from `manipal-site.json`. Mock OpenAI to use the **real** §8.2 prompt logic (not a canned response) — pass through to a recorded fixture response that mirrors the 6,452-char Manipal output. Run `generate-chunk[llms]`. | Stage succeeds. `generated_llms_txt` populated with non-empty content. Validators pass. No `RetryValidationExhausted` thrown. |
| IT3 | `generateBusinessJson` validation failure now throws | Mock business JSON to return `{ a: 1 }` (fewer than 4 keys → validator fails). 2 attempts both fail. | After 2nd attempt, `withRetry` throws `RetryValidationExhausted`. The stage handler propagates the throw. POST returns 200, DB has `pipeline_status = 'failed'`, no `generated_business_json` partial write. |
| IT4 | `assembleResults` adapter — successful path | Insert row with valid generatedContent. Mock `assembleResults` to return valid output and `checkExecutiveSummary` to return true. | Adapter wraps the boolean correctly: `{ passed: true, failures: [] }`. Stage succeeds. |
| IT5 | `assembleResults` adapter — failure path | Mock `checkExecutiveSummary` to return `false` for 3 attempts. | Adapter returns `{ passed: false, failures: ["executive summary failed checkExecutiveSummary"] }` each attempt. After 3rd, throws `RetryValidationExhausted`. Stage marked failed. |
| IT6 | Existing happy-path tests in `pipeline-stage-errors.test.ts` still pass | Run existing 831-line test file as a regression check (no new tests added there) | No regressions. **Required pre-merge gate.** |

### d.2 New test file — `geo/__tests__/integration/api/serve-llms-503.integration.test.ts`

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT7 | Serve route returns 503 for empty content (real DB) | Insert a `geo_sites` row with `pipeline_status = 'complete'`, `generated_llms_txt = ''`, `generated_llms_full_txt = '# valid content'`. Hit `GET /api/serve/{slug}/llms.txt`. | Status 503, `Retry-After: 600`, body matches |
| IT8 | Serve route returns 200 for non-empty content (regression) | Insert row with non-empty content. | Status 200, body matches |
| IT9 | Serve route returns 404 when row doesn't exist | Hit with a slug that has no matching row. | Status 404 |
| IT10 | Verify-connection end-to-end: detects 503 from proxy | Insert eligible site. Mock `proxyFetch` to return 503 from upstream. POST `/api/sites/{id}/verify-connection`. | Response `connected: false`, detail is the new 503 message. |
| IT11 | Verify-connection end-to-end: still detects 404 (regression) | Mock proxy to return 404. | Detail is the existing 404 message — verifies the 503 branch did not break the 404 path. |

### d.3 Operator script integration test

| # | Test | Setup | Assertion |
|---|---|---|---|
| IT12 | `regenerate-empty-llms-txt.ts` end-to-end against test DB | Insert 3 rows: (a) eligible with valid full-text, (b) ineligible (full-text < 1000), (c) already-fixed (non-empty short-text). Run script with `--commit`. | Row (a) gets a non-empty `generated_llms_txt`. Rows (b) and (c) untouched. Summary: `regenerated: 1, skipped: 2, failed: 0`. |
| IT13 | `regenerate-empty-llms-txt.ts` race condition: parallel pipeline writes content first | Insert eligible row. Between SELECT and UPDATE, another process UPDATEs `generated_llms_txt` to non-empty (simulate via test hook). Re-run script. | Idempotency `WHERE` clause matches 0 rows. Script logs `[skip] already has content`. No error, exit 0. |

### d.4 Total integration tests: 13 (IT1–IT13)

**Required infrastructure:** test DB (existing Vitest integration setup), real `db` instance, mocked OpenAI at the SDK boundary, real `proxyFetch` mocked at the `fetch` boundary.

---

## e) Profiling Requirements

### e.1 What to measure

| Metric | Surface | Tool | Baseline | Tolerance |
|---|---|---|---|---|
| `generateLlmsTxt` total wall-clock | content-generator.ts | Existing pipeline stage timing logs (`console.warn` JSON events) | Current p50: 3–5 s; current p99: ~10 s | p50 ≤ 8 s post-fix (TS-082 AC-3 explicit: ≤ 50% regression allowed) |
| `generateLlmsTxt` short-call OpenAI latency | content-generator.ts | OpenAI SDK response time | Current ~3 s | ≤ 6 s post-fix |
| Reasoning-token share on short call | content-generator.ts | New `llms_short_high_reasoning_share` warning | Direction B target: ratio < 0.3 | Alert if ratio > 0.7 (already wired) |
| `withRetry` aggregate stage time on failure path | pipeline/stage/route.ts | Stage timing logs | New behavior — 1×–3× backoff before throw | No timeout regressions; total time stays under STAGE_TIMEOUT_MS (105 s) |
| `regenerate-empty-llms-txt.ts` per-site time | scripts/regenerate-empty-llms-txt.ts | `console.time` / `console.timeEnd` per site | Manipal hot-fix took ~12 s end-to-end | ≤ 30 s per site (operator-only, no SLA) |

### e.2 Baseline expectations (production data — TS-082 §8.6)

The Manipal hot-fix experiment on 2026-04-08 produced this baseline for the Direction B prompt:

| Metric | Value |
|---|---|
| `model` | `gpt-5.4-mini` |
| `max_completion_tokens` | 6000 |
| `completion_tokens` | 1,362 |
| `reasoning_tokens` | **0** |
| `finish_reason` | `stop` |
| Output length | 6,452 chars |
| Total OpenAI latency | ~12 s |

After Direction B lands, the production short-call should converge on `reasoning_tokens` near 0 and `completion_tokens` in the 1,000–2,000 range. **If reasoning_tokens > 500 on Direction B, that is a regression — open an incident.**

### e.3 Profiling tools

- **Local:** existing pipeline stage timing logs (already-emitted JSON warnings).
- **Production:** existing Vercel function logs + the new `llms_short_high_reasoning_share` warning. No new infrastructure required.
- **Manual benchmark:** ScriptDev should run `tsx geo/scripts/regenerate-empty-llms-txt.ts --site -GzFX1KcKhmN0W_1t8SmY --commit` against the staging DB once after impl lands and post the timing + token usage in the PR description for verification.

---

## f) Load Test Plan

**Not applicable.** TS-082 fixes a bug in a code path that runs once per audit, not on a hot serving path. The serve route changes (adding a 503 branch) introduce no new latency — they replace one branch with three, all O(1).

**One light validation:**

| # | Scenario | Setup | Success criteria |
|---|---|---|---|
| L1 | Serve route p50 latency under empty load (regression sanity) | Locally hit `GET /api/serve/{slug}/llms.txt` 100 times against a test row | p50 ≤ 50 ms (current baseline ~30 ms; the new branching adds < 1 ms in practice) |

No sustained-load or concurrency testing is in scope. This bug does not affect throughput.

---

## g) Logging & Instrumentation

### g.1 New log events

| Event | Level | Source | Payload | Purpose |
|---|---|---|---|---|
| `llms_generation_length_exhausted` | error | content-generator.ts (in error path before throw) | `{ event, domain, call: "short"|"full", finish_reason, completion_tokens, reasoning_tokens, max_completion_tokens }` | Surface the exact failure mode that TS-082 fixes; alert source for residual cases |
| `llms_short_high_reasoning_share` | warn | content-generator.ts (defensive guard) | `{ event, domain, reasoning_tokens, completion_tokens, ratio, note }` | Early warning before silent corruption resumes (TS-082 §5.1) |
| `withRetry_validation_exhausted` | error | pipeline/stage/route.ts (`withRetry` before throw) | `{ event, label, attempts, failures, max_attempts }` | Distinguish validation failures from transient errors in stage logs |
| `serve_llms_txt_empty_503` | warn | app/api/serve/[slug]/llms.txt/route.ts | `{ event, slug, site_id, asset: "llms_txt"|"llms_full_txt" }` | Track customer-facing 503 incidence; should trend to zero post-fix |
| `regenerate_llms_txt_summary` | info | scripts/regenerate-empty-llms-txt.ts | `{ event, mode: "dry"|"commit", eligible, regenerated, skipped, failed }` | Operator audit trail |

All events JSON-encoded via `console.warn(JSON.stringify({ ... }))` per the existing stage logging convention (see `route.ts:750` for a reference example).

### g.2 Existing logs to preserve

- `[stage] generateLlmsTxt check failed (attempt 1/1): llmsTxt too short` — already exists at line 162; new throw path does not remove it. Both fire on a failed attempt.
- `[stage] generateLlmsTxt still failing after 1 attempts — using best result` — **DELETE this line** when removing the silent fall-through. It's actively misleading post-fix.

### g.3 Metric counters (manual via existing log queries)

No new metric infrastructure. The events above are queryable via the existing Vercel log search:

- Pre-fix `serve_llms_txt_empty_503` count over time → should trend down toward zero
- `llms_generation_length_exhausted` count → should be near zero (residual fires only on prompt drift)
- `llms_short_high_reasoning_share` count → should be near zero post-Direction B

### g.4 Log levels

- `error` — `llms_generation_length_exhausted`, `withRetry_validation_exhausted` (these mean a real failure surfaced)
- `warn` — `llms_short_high_reasoning_share`, `serve_llms_txt_empty_503` (defensive / customer-visible)
- `info` — `regenerate_llms_txt_summary` (operator-only audit trail)

---

## h) Acceptance Criteria

**Translation of TS-082 §3 acceptance criteria, plus 1 additional AC discovered during recon (AC-16).**

### h.1 Generation (TS-082 §3.1)

- [ ] **AC-1:** `generateLlmsTxt` for any site that successfully generates `llms-full.txt` ALSO produces a non-empty `llmsTxt` ≥ 200 chars. **Verified by:** U1, U9, U10–U13, IT2.
- [ ] **AC-2:** When OpenAI returns empty content with `finish_reason === "length"`, `generateLlmsTxt` throws `LlmsGenerationLengthExhausted` (typed, importable from `@/lib/services/content-generator`). **Verified by:** U2, U3, IT1.
- [ ] **AC-3:** The bumped `max_completion_tokens: 8000` does not regress p50 by more than 50% (current ~3–5 s, tolerance 8 s). Verified by manual benchmark posted in PR description per §e.3. **Verified by:** §e profiling step + PR comment.

### h.2 Retry semantics (TS-082 §3.2)

- [ ] **AC-4:** When `withRetry` is called with `maxAttempts: 1` and the validator fails, it **throws** `RetryValidationExhausted` (does not return). The thrown error includes `failures`, `attempts`, and `label`. **Verified by:** U17.
- [ ] **AC-5:** Existing `llms` chunk caller handles the throw via the existing markFailed/stage-level-retry mechanism — no catch+swallow. The misleading "stage-level retry handles transient failures" comment at line 625 is replaced with the corrected comment per §b.5. **Verified by:** IT1, code review (the comment change).
- [ ] **AC-6:** Callers with `maxAttempts ≥ 2` ALSO throw on final failure (not gated to maxAttempts === 1). Documented in JSDoc per §b.4. **Verified by:** U18, U19, IT3.

### h.3 Serve route (TS-082 §3.3)

- [ ] **AC-7:** `GET /api/serve/{slug}/llms.txt` returns:
  - **404** when the site row does not exist OR has `generatedLlmsTxt === null` (legacy / never-generated)
  - **503** with `Retry-After: 600` and body `"Generation pending or failed — please re-run the audit from your dashboard."` when the site row exists but `generatedLlmsTxt === ""`
  - **200** when `generatedLlmsTxt` is non-empty (current behavior)
  - **Note:** `resolveSiteForServing` is **NOT amended** — see §b.6 design call. Empty-vs-null discrimination happens locally in the route.
  - **Verified by:** U35–U41, IT7–IT9.
- [ ] **AC-8:** `app/api/sites/[id]/verify-connection/route.ts` recognizes the 503 response and returns: *"Your site is correctly proxying to our serve URL, but our generated llms.txt file is currently empty for this site. Please re-run the audit from your dashboard. (We're aware of this and tracking it as a generation issue, not a setup issue on your end.)"* **Verified by:** U42–U44, IT10–IT11.
- [ ] **AC-9:** Same 503 / 404 / 200 treatment applied to `/api/serve/[slug]/llms-full.txt` (defensive; currently no full-text empty cases). **Verified by:** §c.6 mirror tests.

### h.4 Backfill / regeneration (TS-082 §3.4)

- [ ] **AC-10:** `geo/scripts/regenerate-empty-llms-txt.ts` exists, implements the §b.8 surface, uses TS-082 §8 reference impl verbatim for prompt + validation + UPDATE logic. Credentials sourced from `.env.local`, never inlined. **Verified by:** U22–U34, IT12.
- [ ] **AC-11:** Script is idempotent (`WHERE ... AND length = 0` clause) and gated behind `--commit`. Default is dry-run that prints candidates and exits 0 without writing. **Verified by:** U22, U25, U34, IT13.
- [ ] **AC-12:** Script is **operator-only**. No cron entry, no import from application code, no CI invocation. The file has the `// OPERATOR-ONLY — do not invoke from application code` comment at the top. **Verified by:** code review + a grep test that asserts no application file imports the script.

### h.5 Test coverage (TS-082 §3.5)

- [ ] **AC-13:** Unit test for `generateLlmsTxt` against a Manipal-style fixture (real fixture from production, redacted). Asserts non-empty output. **Verified by:** U1, U9, fixture file `__tests__/fixtures/manipal-site.json`.
- [ ] **AC-14:** Unit test for `withRetry` with `maxAttempts: 1` and a failing validator — must throw, must not return. **Verified by:** U17.
- [ ] **AC-15:** Integration test for the serve route 503 path — insert a site row with empty `generatedLlmsTxt`, hit the route, assert HTTP 503 + `Retry-After` header. **Verified by:** IT7.

### h.6 New AC discovered during recon

- [ ] **AC-16 (NEW):** `assembleResults` call site at `pipeline/stage/route.ts:742` is adapted so the validator returns `{ passed, failures }` (not raw boolean). Without this adapter, the unified-throw change makes `withRetry` throw on every assemble attempt because `passed` would be `undefined`. **Verified by:** IT4 (success path) and IT5 (failure path).

### h.7 Cross-cutting checks

- [ ] **AC-17:** All existing tests in `geo/__tests__/pipeline-stage-errors.test.ts` (831 lines) pass without modification — regression gate. **Verified by:** IT6 / CI.
- [ ] **AC-18:** No new dependencies added to `package.json`.
- [ ] **AC-19:** No DDL migrations.
- [ ] **AC-20:** Direction A and Direction B are committed as **two sequential commits** on the same branch so reviewers can audit them independently. Direction A first, Direction B second. The branch must build and all tests pass at both commits. **Verified by:** PR commit history check.
- [ ] **AC-21:** PR description includes: (a) the manual benchmark output from §e.3 against staging Manipal fixture, (b) confirmation that `llms_short_high_reasoning_share` did not fire in the benchmark, (c) confirmation that `regenerate-empty-llms-txt.ts --commit` is NOT scheduled.

### h.8 Done definition

The spec is **done** when:

1. All 21 ACs are checked.
2. ReviewMaster Phase A delivers test scaffolding for all 44 unit + 13 integration tests.
3. ScriptDev's PR has both Direction A and Direction B commits.
4. CI passes (incl. existing pipeline-stage-errors regression).
5. Manual benchmark in PR description confirms `reasoning_tokens` near 0 on Direction B.
6. No `regenerate-empty-llms-txt.ts` cron / scheduled invocation exists.

---

## Notes for downstream agents

### For ReviewMaster (Phase A)

1. **Test file count: 6 new files + 1 fixture file** — see §c table. Match the structure exactly so impl can land them in one commit.
2. **Use different fixtures than ScriptDev's** — same convention as ES-081. Your unit tests should not share fixture identifiers with whatever ScriptDev imports in source. Specifically: do not use the literal site ID `-GzFX1KcKhmN0W_1t8SmY` in any UT fixture; use a clean test ID like `manipal-fixture-rm`.
3. **Direction B prompt builder is module-private until ScriptDev exports it.** For U8–U13 you will need a `__test_internals` export from `content-generator.ts`. Specify this in your delivery — ScriptDev will need to add the export.
4. **U17 is load-bearing** — it asserts `maxAttempts: 1` throws. If this test is not RED before ScriptDev's fix, the spec is wrong. Verify the RED state first.
5. **IT1 is the smoke test for the entire fix** — it must go from RED (silent persist of empty) to GREEN (markFailed called, no empty persist).
6. **IT6 (regression gate) is mandatory** — running the existing 831-line `pipeline-stage-errors.test.ts` unchanged is non-negotiable.

### For CostMaster

1. **Files (CREATE):** 2 (`content-generator-errors.ts`, `regenerate-empty-llms-txt.ts`)
2. **Files (MODIFY):** 5 (content-generator.ts, pipeline/stage/route.ts, both serve routes, verify-connection)
3. **Test files (CREATE):** 6 + 1 fixture
4. **Total LOC est.:** ~600 (impl) + ~800 (tests) = ~1400
5. **No new dependencies, no DDL, no new env vars.**
6. **Branch:** new branch `fix/llms-txt-empty-generation` (NOT shared with ES-081's `fix/competitor-brand-name-extraction`)
7. **Sequential commits required (AC-20):** Direction A commit first, Direction B commit second.
8. **Lang:** `typescript`

### For CoFounder

1. **Spec ready for ReviewMaster + CostMaster dispatch.** No open questions remain — TS-082 §6 already resolved Q1–Q4.
2. **AC-16 was added by SpecMaster during recon** — it covers the `assembleResults` validator-shape mismatch that the unified-throw change exposes. Heads-up that this is a real bug currently masked by `withRetry`'s silent fall-through.
3. **Design call recorded:** §b.6 — `resolveSiteForServing` is NOT amended. Option A (always-latest) chosen over Option B (fall back to most recent non-empty). Reason: TS-082's diagnostic intent is to surface the bug, not paper over it. Override here if you disagree.

---

**End of ES-082**
