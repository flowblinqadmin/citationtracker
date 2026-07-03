# ES-Wave-4 — Observability (B5 + B6 + G2)

**Branch:** `fix/wave-4-observability` (from `ef97ebe`).
**Source plan:** `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 4.
**Source UAT:** `docs/uat/2026-04-26-issues.md` rows B5, B6, G2.
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate. No Playwright per-wave.
**Scope:** spec / design only. ScriptDev implements next.
**No Shastri SURFACE expected** — all three issues are well-bounded log/event/UI emissions.

---

## Overview

Three silent-failure observability gaps surfaced in 2026-04-26 UAT:

- **B5 (MED)** — `lib/services/geo-crawler.ts:653-673` `selectTopUrlsWithGemini` swallows errors silently. The `try { ... fetch + parse } catch { return null; }` at line 672 has NO logging. The `if (!res.ok) return null;` at line 665 and `if (!Array.isArray(parsed)) return null;` at line 669 are equivalent silent fallbacks. For walmart's 83k-URL discovery, the prompt likely exceeded Gemini 2.5 Flash's input budget; the function fell back to the deterministic priority-sort path with zero operator visibility into WHY the LLM call failed.
- **B6 (MED)** — `lib/services/content-generator.ts:33-40` `safeParse` ALREADY emits `console.warn("[content-generator] LLM response failed schema validation:", ...)` at line 37. The gap is that the warn is unstructured (free-form string + ZodError dump) — not a parseable structured event suitable for metric aggregation. UAT observed 4+ occurrences during walmart at JSON parse positions 12215 / 12614 / 12666 / 14732 (likely max_tokens cutoff before the LLM finished writing JSON). Need a structured `{event:'llm_json_parse_failure', position, response_length, audit_run_id, ...}` event so per-audit fail counts can be aggregated and operators can spot pattern.
- **G2 (HIGH)** — `app/sites/[id]/SitePageClient.tsx:386-388` `handleMapCompetitors` early-returns on `!res.ok || !res.body` with NO error toast, NO `console.error`, NO user-visible feedback. User clicks Map Competitors → nothing happens → silent failure → no diagnosis hook. Same anti-pattern as B5; surface a toast or inline error containing the server-provided error text.

---

## B5 ACs — geo-crawler logging

| AC | Target (file:line on branch tip `ef97ebe`) | Contract | Verify |
|----|---------------------------------------------|----------|--------|
| **AC-B5-1** | `lib/services/geo-crawler.ts:672` `} catch { return null; }` | Replace with `} catch (err) { console.warn('[geo-crawler] selectTopUrlsWithGemini exception:', err instanceof Error ? err.message : String(err), { domain, urlCount: urls.length }); return null; }`. Returns `null` unchanged (caller's deterministic fallback path is preserved); ADDS a structured warn line so operators can correlate fallback events with input shape. | Vitest UT |
| **AC-B5-2** | `lib/services/geo-crawler.ts:665` `if (!res.ok) return null;` | Replace with `if (!res.ok) { console.warn('[geo-crawler] selectTopUrlsWithGemini non-2xx:', { status: res.status, statusText: res.statusText, domain, urlCount: urls.length }); return null; }`. Logs which HTTP status triggered the fallback (4xx vs 5xx tells operator whether quota/auth or upstream outage). | Vitest UT |
| **AC-B5-3** | `lib/services/geo-crawler.ts:669` `if (!Array.isArray(parsed)) return null;` | Replace with `if (!Array.isArray(parsed)) { console.warn('[geo-crawler] selectTopUrlsWithGemini non-array response:', { domain, urlCount: urls.length, parsedType: typeof parsed, parsedKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 10) : undefined }); return null; }`. Distinguishes "Gemini returned valid JSON but not an array" from the surrounding fetch/parse failure paths. | Vitest UT |
| **AC-B5-4** | NEW — small enrichment of `selectTopUrlsWithGemini`: log a single `console.info` on entry with `{ domain, urlCount: urls.length }` so operators can see the input cardinality even when the function succeeds. Useful for the "input too large" diagnosis path (urls.length > 50_000 → likely token-limit territory). | Vitest UT |
| **AC-B5-5** | URL-list chunking for `urls.length > 50_000` is **DEFERRED to a separate TS** (TS-NNN once scoped). This ES does NOT implement chunking; it only ensures that when chunking would have helped, the operator can SEE in logs that the input was huge and fell back. Note in the migration runner / runbook: walmart-scale inputs (>50k) are expected to fall back to deterministic sort until chunking lands. | Doc note |

**B5 ScriptDev impl shape:**
1. Add the 3 `console.warn` lines + 1 `console.info` per AC-B5-1..4 to `selectTopUrlsWithGemini`.
2. No callsite changes — function still returns `null` on failure; caller's existing deterministic fallback path is unchanged.
3. AC-B5-5 is a comment in the function header citing the deferred chunking TS-ID.

**B5 UAT shape:** induce a Gemini failure (mock fetch to throw / return 503 / return non-array JSON) → run `selectTopUrlsWithGemini` against a fixture URL list → assert exactly one `console.warn` with the matching prefix + structured fields. Mock the success path → assert `console.info` entry log fires once.

**B5 AC count: 5.**

---

## B6 ACs — LLM JSON parse-failure structured event

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-B6-1** | `lib/services/content-generator.ts:33-40` `safeParse` function | Replace the existing `console.warn("[content-generator] LLM response failed schema validation:", ...)` with a structured event emission: `console.warn(JSON.stringify({ event: "llm_json_parse_failure", source: "content-generator.safeParse", position: parsePositionFromError(err), response_length: (raw ?? "").length, raw_excerpt: (raw ?? "").slice(0, 200), error_class: err instanceof z.ZodError ? "ZodError" : err instanceof SyntaxError ? "SyntaxError" : "Unknown", error_message: err instanceof Error ? err.message : String(err), audit_run_id: getAuditRunIdFromContext() ?? null, timestamp: new Date().toISOString() }));`. The `parsePositionFromError` helper extracts the byte position from `SyntaxError` messages of the form "Unexpected token X in JSON at position N"; returns `null` on no-match. The `getAuditRunIdFromContext` helper reads from a contextual store (e.g. AsyncLocalStorage) if one exists in the codebase OR from a passed-in opts argument (signature change requires caller updates — see AC-B6-3). | Vitest UT |
| **AC-B6-2** | NEW helper `parsePositionFromError(err: unknown): number | null` co-located in `lib/services/content-generator.ts` (or extracted to `lib/observability/json-parse-position.ts` if used elsewhere). | Regex against `SyntaxError.message` for the canonical V8/Node form `at position (\d+)`. Returns the integer position or `null` on miss. Pure function — Vitest UT covers happy path + non-SyntaxError input + missing-position SyntaxError. | Vitest UT |
| **AC-B6-3** | `safeParse` signature extended (BACKWARD COMPATIBLE — optional 4th arg): `function safeParse<T>(schema: z.ZodType<T>, raw: string | null | undefined, fallback: T, opts?: { auditRunId?: string; source?: string }): T`. Callers MAY pass `auditRunId` to enrich the structured event; default omits it (event has `audit_run_id: null`). Callers identified by grep of existing `safeParse(` invocations — update each to pass the auditRunId where known (typically the geo_sites.id of the current pipeline run). | grep + Vitest UT per caller (1-2 callsites likely) |
| **AC-B6-4** | NEW — per-audit fail-count aggregation: a tiny in-process counter (a `Map<auditRunId, count>`) gets incremented on every `llm_json_parse_failure` emission with non-null `auditRunId`. At pipeline complete, the counter total is logged as `{ event: "audit_llm_parse_failure_summary", audit_run_id, total_count }` and the counter entry deleted. NO DB write (in-process only) — logs are the metric surface; downstream log shipper (if any) can aggregate. | Vitest UT (drive 5 parse failures for one auditRunId → assert summary event has `total_count: 5`; drive 0 failures for another → assert no summary emitted OR summary with total_count: 0 emitted at audit complete) |
| **AC-B6-5** | NEW — log `event` field convention: every observability emission added in this ES uses `console.warn(JSON.stringify({event: ..., ...}))` (single-line JSON for log-shipper friendliness). NEVER `console.warn("text", obj)` — log shippers can't reliably parse the second arg. AC-B6-1 + AC-B5-1/2/3 all conform. Add a 1-line comment at each emission site noting the convention. | Vitest grep guard — scan emissions added by this ES for the `JSON.stringify({event:` pattern; flag any `console.warn(<string>, <obj>)` two-arg pattern in the new code |

**B6 ScriptDev impl shape:**
1. AC-B6-2: write `parsePositionFromError`. Pure function, easy unit test.
2. AC-B6-3: extend `safeParse` signature (optional opts arg).
3. AC-B6-1: rewrite the `console.warn` body to emit the structured event.
4. AC-B6-4: add the in-process counter + summary emission (likely a small `lib/observability/audit-failure-counter.ts` module with `incrementParseFailure(auditRunId)` + `flushSummary(auditRunId)` exports).
5. AC-B6-5: grep guard UT to enforce the `JSON.stringify({event:` convention going forward.

**B6 UAT shape:** mock LLM to return malformed JSON (truncated mid-object) → call `safeParse` 5 times within one auditRunId context → assert 5 structured events emitted with non-null position + correct error_class='SyntaxError' → trigger pipeline-complete summary → assert summary event with `total_count: 5`.

**B6 AC count: 5.**

---

## G2 ACs — Map Competitors error surface

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-G2-1** | `app/sites/[id]/SitePageClient.tsx:386-388` `handleMapCompetitors` early-return on `!res.ok || !res.body` | Replace silent return with: extract server error text via `const errText = await res.text().catch(() => null)` (handles non-text bodies); set a new state variable `competitorError: string | null` to a meaningful message — server text if non-empty + reasonable, else fallback `"Couldn't start competitor scan — try again"`; render the error inline (e.g. small red text under the Map Competitors button) OR via existing toast infrastructure if one is wired up; auto-clear after 4-6s via `setTimeout`. The `setCompetitorScanActive(false)` call stays. | React component test (Vitest + RTL) |
| **AC-G2-2** | NEW state declaration adjacent to `competitorScanActive`: `const [competitorError, setCompetitorError] = useState<string | null>(null);`. Convention matches existing `refreshError`/`downloadError` declarations elsewhere in the file (e.g. line 313 `const [refreshError, setRefreshError] = useState<string | null>(null);` shape — verify file-local convention before authoring). | grep + Vitest UT |
| **AC-G2-3** | NEW render: where the Map Competitors button is rendered (search for `competitorScanActive` use-site to find the button), add a sibling `{competitorError && <div role="alert" style={...}>{competitorError}</div>}` block. The `role="alert"` matches the §b.15.4 / AC-22 ES-e2e-fixtures convention for error surfaces (so e2e specs can target it). Use the existing red-text style from the file's other error renders for consistency (likely the `RED` constant or similar). | React component test |
| **AC-G2-4** | Also catch the `try { fetch ... reader-loop } catch (err)` outer block (currently `catch { /* ignore */ }` at the end of `handleMapCompetitors` — verify line range): set `competitorError` from the catch err message + log `console.warn('[handleMapCompetitors] error:', err);`. Same auto-clear behaviour. | Vitest UT (mock fetch to throw → assert error UI rendered + console.warn called) |
| **AC-G2-5** | Apply the same error-surface pattern to `handleRunCitations` and `handleDownloadZip` if they have analogous silent-return paths. Grep for `catch { /* ignore */ }` and `if (!res.ok || !res.body) { ... return; }` patterns under `app/sites/[id]/SitePageClient.tsx` — each needs an error-state + render. SCOPE LIMIT: only the patterns that match exactly; do NOT refactor the whole file. | grep + per-handler Vitest UT |

**G2 ScriptDev impl shape:**
1. Audit the file for silent-error patterns (`catch { /* ignore */ }`, `if (!res.ok ...) return`).
2. Add a state variable per handler that needs an error surface (`competitorError`, plus equivalents for citations/download per AC-G2-5).
3. Add the inline `<div role="alert">` render block beside each affected button.
4. Add `console.warn('[handler-name] error:', err)` in each catch.
5. Component test asserting the UI surfaces the error string.

**G2 UAT shape:** mock `/api/sites/[id]/competitor-discovery` to return 401 → click Map Competitors → assert `[role="alert"]` container appears with non-empty text containing either the server message or the fallback. After 4-6s, assert the error auto-clears.

**G2 AC count: 5.**

---

## Test strategy

**Vitest UTs:**
- B5: 4 UTs covering each of the 4 emissions (3 catch/return paths + 1 entry log).
- B6: 5 UTs covering the structured event + position parser + opts arg + counter aggregation + grep guard.
- G2: 5 UTs / RTL component tests covering the 4 emissions on Map Competitors + the AC-G2-5 sibling-handler audit.

**Vitest ITs (Docker CI):**
- B5 IT: drive `selectTopUrlsWithGemini` against a mocked Gemini that returns a 503 → assert one log line with the structured shape lands in the captured stdout.
- B6 IT: drive `safeParse` through a content-generator code path with a malformed LLM response fixture → assert structured event emitted + counter increments.

**No Playwright per pivot.** A consolidated UAT post-Wave-6 may add a Playwright spec for G2 if a deterministic 401-trigger fixture is wired up; not blocking Wave 4 landing.

---

## Verification gate (pivot-aligned)

Wave 4 lands when:
1. Vitest GREEN — all UTs from §B5/§B6/§G2 pass.
2. Docker CI GREEN — ITs against the containerised local Supabase pass.
3. **No Playwright globalSetup requirement** per pivot.
4. Existing Phase A retired/live wave + prior Wave commits remain intact.

---

## Out of scope

- **URL-list chunking for >50k inputs** (B5) — deferred to a separate TS once scoped.
- **Log shipper / metric backend wiring** (e.g. Sentry, Datadog) — observability hooks land HERE; the downstream aggregation pipeline is a separate ops TS.
- **Toast infrastructure rewrite** (G2) — if no toast library is wired, AC-G2-3 uses the inline `<div role="alert">` pattern; introducing a toast lib is a separate ES.
- **Audit-run-id contextual store** (e.g. AsyncLocalStorage) — if not present, AC-B6-3 uses an opts arg threaded through callers. Adding an ALS store is a separate ES.
- **Server-side metric counters** (DB-backed `audit_failure_metrics` table) — in-process counter (AC-B6-4) is the minimum viable surface; persistent metric tables can be a follow-up if log aggregation is insufficient.
- **B7-B9 / G3+ / C series** — not Wave 4 scope.
