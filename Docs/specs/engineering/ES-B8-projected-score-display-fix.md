# ES-B8 — "Est. after fixes" UI must read DB authoritative `projected_score`

**Branch:** `fix/b8-projected-score-display-fix`
**Base:** `89a0afc` (forked from `e2e-comprehensive-suite`)
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate, NO Playwright per-spec.

---

## a) Overview

Shastri B8 evidence (nixon.com UAT, 2026-04-26):

- DB row `geo_site_view`: `projected_score=83`, `projected_boost=29`, `currentScore=54`.
- UI render: **"Score 54 / Est after fixes 54"** — the 83 is silently dropped.

Root cause: `app/sites/[id]/SitePageClient.tsx:597-602` ignores the DB-authoritative `site.projectedScore` and instead regex-extracts digits from the free-form `r.estimatedBoost` text on the top-3 recommendations. nixon's top-3 recommendations contain no digit characters → `top3Boost=0` → `estAfterFixes = liveScore + 0 = liveScore`. The 29-point projected lift computed and persisted by the pipeline never reaches the user.

This spec replaces the regex calc with a direct read from `site.projectedScore`.

---

## b) Root cause — three distinct problems with the current calc

`app/sites/[id]/SitePageClient.tsx:597-602`:

```ts
// Est. after fixes
const top3Boost = recs.slice(0, 3).reduce((sum, r) => {
  const n = parseInt(String(r.estimatedBoost).replace(/[^0-9-]/g, ""), 10);
  return sum + (isNaN(n) ? 0 : Math.abs(n));
}, 0);
const estAfterFixes = liveScore !== null ? Math.min(liveScore + top3Boost, 100) : null;
```

1. **Ignores authoritative DB field.** `site.projectedScore` is a first-class column on `geo_site_view` (`lib/db/schema.ts:254 → integer("projected_score")`), populated by the analyzer pipeline as the canonical post-fix projection. `site.projectedBoost` is its `(projected_score - currentScore)` companion (`schema.ts:255`). The component receives `projectedScore` as a typed prop (`app/sites/[id]/types.ts:57: projectedScore?: number | null;`) and `app/sites/[id]/page.tsx:125` already forwards it (`projectedScore: site.projectedScore ?? null`). The regex calc *recomputes* a value the system has already authoritatively persisted, and gets it wrong.

2. **Brittle parser on free-form text.** `r.estimatedBoost` is an arbitrary LLM-emitted string — sometimes `"+5 pts"`, sometimes `"could lift visibility ~10%"`, sometimes (nixon) prose with zero digits. The `parseInt(replace(/[^0-9-]/g, ""))` extracts the *first contiguous digit run* of the *concatenated* string after stripping non-digits — both fragile (`"v2.4 boost"` → `24`) and silent on the failure case (no digits → `0`).

3. **`Math.min(..., 100)` hides over-cap pathologies.** When the regex *does* catch digits — e.g. `"50% lift"` × 3 recs → `top3Boost=150` → `estAfterFixes=min(54+150, 100)=100` — the 100 cap silently masks the bad parse. The user sees a plausible-looking max projection that has no relationship to the analyzer's actual output. There is no log line on either the under-count or over-count branch, so the divergence has been silent since launch.

The fix: read `site.projectedScore` directly. Render no value when it's null. Delete the regex/top3Boost block entirely.

---

## c) Acceptance criteria

| ID | Criterion |
|---|---|
| **AC-B8-1** | `app/sites/[id]/SitePageClient.tsx` "Est. after fixes" render path MUST read `site.projectedScore` directly. The displayed value MUST equal `site.projectedScore` (rounded to nearest integer if non-integer; current schema is `integer` so a no-op `Math.round` defensive wrap is acceptable but not required). |
| **AC-B8-2** | When `site.projectedScore` is `null` or `undefined`, the "Est. after fixes" line MUST NOT render — no fallback to `liveScore`, no fallback to the legacy `top3Boost` regex calc, no placeholder. The conditional render at line 1404 (`{estAfterFixes !== null && <div ...>}`) becomes `{site.projectedScore != null && <div ...>Est. after fixes: {site.projectedScore}</div>}` (or equivalent). |
| **AC-B8-3** | The legacy `top3Boost` regex block at `app/sites/[id]/SitePageClient.tsx:597-602` MUST be **deleted entirely**. No `Math.min(liveScore + top3Boost, 100)` survives. No commented-out preservation. Grep test enforces: `rg "top3Boost|estimatedBoost.*replace.*[0-9]" app/sites/[id]/SitePageClient.tsx` returns zero matches post-fix. |
| **AC-B8-4** | Regression: the **nixon-class fixture** — top-3 recs whose `estimatedBoost` contains no digit characters, `currentScore=54`, `projectedScore=83` — MUST display `83` (was: `54`, the silent-drop bug). And the symmetric: the **digit-flooded fixture** — recs with `estimatedBoost="50%, 50%, 50%"`, `currentScore=54`, `projectedScore=72` — MUST display `72` (was: `100`, the over-cap masking bug). Both come from the DB field, not the regex. |

---

## d) Test strategy

### d.1 Vitest UTs — `app/sites/[id]/__tests__/SitePageClient.projected-score.test.tsx` (new file)

Three render tests using React Testing Library. Mock `site` prop minimally (the est-after-fixes block depends only on `site.projectedScore` after the fix; pre-fix it also depended on `recs[0..2].estimatedBoost`).

| ID | Scenario | Site fixture | Expected DOM |
|---|---|---|---|
| **U-B8-1** | DB-authoritative happy path | `{ projectedScore: 83, currentScore: 54, recommendations: [no-digit prose × 3] }` | `screen.getByText('Est. after fixes: 83')` present; **NOT** `54` adjacent to "Est. after fixes" |
| **U-B8-2** | Null → no render | `{ projectedScore: null, currentScore: 54, recommendations: [some recs] }` | `screen.queryByText(/Est\. after fixes/)` returns `null` (line not rendered at all) |
| **U-B8-3** | Null + recs-with-digits → still no fallback | `{ projectedScore: null, currentScore: 54, recommendations: [{estimatedBoost: "+5 pts"} × 3] }` | `screen.queryByText(/Est\. after fixes/)` returns `null`. Asserts the regex fallback path is truly removed (regression guard for AC-B8-3). |

Plus one static guard:

| **U-B8-4** | Source-grep regression | Static read of `SitePageClient.tsx` source via `fs.readFileSync` | Asserts `/top3Boost|estimatedBoost\s*\)\s*\.replace/` matches zero times. |

### d.2 No IT required

`site.projectedScore` already populates through `app/sites/[id]/page.tsx:125` and is typed in `types.ts:57`. The data path is unchanged; only the consumer's render logic flips. UTs at the component level are sufficient.

### d.3 Verification gate

Per pivot `waves-1to6-cd-pivot-2026-04-26`:

- `vitest run` → 4 UTs GREEN.
- Docker CI GREEN.
- **NO Playwright** — pure render-logic change, fully unit-testable.

---

## e) Wave 4 observability note

This is a textbook example of the **silent UI-layer fallback** pattern that Wave 4 (ES-wave-4-observability) targeted on the *server* side (B5 geo-crawler `selectTopUrlsWithGemini` silent returns; B6 content-generator JSON parse failures). The `top3Boost=0 → estAfterFixes=liveScore` collapse mirrors `geminiUrlCount=0 → return []` exactly: a degraded-but-non-error code path that produces a plausible-looking rendered output with no log signal.

**Recommendation:** flag for a Wave-4-extension TS to add a structured `console.warn(JSON.stringify({event:'ui_fallback_to_live_score', site_id, projected_score, ...}))` whenever the est-after-fixes render path observes `projectedScore == null` AND `recommendations.length > 0` (i.e. analyzer ran but didn't produce a projection). Out of scope for ES-B8; in scope for follow-up if the symptom recurs after this fix lands.

---

## f) Out of scope

- Pipeline-side `projected_score` derivation logic (analyzer / `lib/services/site-view-sync.ts`): unchanged — this spec trusts the persisted value.
- `projectedBoost` rendering (the +29 lift indicator in legacy `ResultsDashboardLegacy.tsx`): live UI is `SitePageClient.tsx`; legacy-component changes excluded per AC-27 `legacy-UI-component-refactored` policy.
- TrajectoryChart and other downstream uses of `projectedScore` in legacy file: out of scope.
- Refresh / live-poll behaviour for `site.projectedScore`: existing wiring at `page.tsx:125` already passes the latest server-side value.

---

## g) HolePoker pre-review checklist

- [ ] Confirm `site.projectedScore` is in props at SitePageClient — verified via `app/sites/[id]/types.ts:57` + `page.tsx:125`.
- [ ] Confirm DB column is `integer("projected_score")` — verified at `lib/db/schema.ts:254`.
- [ ] Confirm AC-B8-3 grep regex catches the deletion completely (no surviving fragments).
- [ ] Confirm AC-B8-2 "do not render" semantics aligns with product intent (vs e.g. "render dash" or "render currentScore as fallback").
- [ ] Confirm 0 product-code edits in this spec (design-only per dispatch §hard_constraints).
