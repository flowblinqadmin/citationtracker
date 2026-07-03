# ES-Wave-5 — UX Polish (B4 + C1 + C2)

**Branch:** `fix/wave-5-ux-polish` (from `edf24af`).
**Source plan:** `docs/specs/orchestration/2026-04-26-bugfix-plan.md` §Wave 5.
**Source UAT:** `docs/uat/2026-04-26-issues.md` rows B4, C1, C2.
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate. No Playwright per-wave.
**Scope:** spec / design only. ScriptDev implements next.

---

## Overview

Three dashboard-UX polish issues:

- **B4 (HIGH)** — UAT report claimed `POST /api/sites/[id]/regenerate` returns HTTP 200 but `RowActions.handleRerunAudit` only triggers `onScanStart` on `res.status === 202`, leaving the optimistic-scan state unset and polling silent. **Spec-rigour finding (verified at branch tip `edf24af`):** the route ALREADY returns `{ status: 202 }` on both success paths (`app/api/sites/[id]/regenerate/route.ts:211` Pro-paid + `:267` free-rotation) AND `RowActions.tsx:57` already gates on `res.status === 202` and fires `onScanStart?.()` + `router.refresh()` (the latter from ES-wave-1 `712fc61`). The reported bug appears already-resolved on this branch — likely fixed during Wave 1 or earlier. B4 ACs become **regression guards** (pin the contract via UTs) rather than corrective fixes.
- **C1 (HIGH)** — `app/dashboard/DomainTableRow.tsx:85` polling effect early-returns when `!isActiveStatus(liveStatus) && !isOptimisticScan`. The `failed → re-audit → active` transition relies on `RowActions.onScanStart` flipping `isOptimisticScan=true` (set at `DomainTableRow.tsx:328`). Per the B4 verification above, that chain works. C1 ACs codify the contract + add a defensive guard: post-RowAction click, `isOptimisticScan` MUST stay true until liveStatus reaches a non-active terminal state (currently it does — line 95 `if (!isActiveStatus(data.pipelineStatus)) setIsOptimisticScan(false)`). Add a max-30s safety timeout in case the regenerate succeeds but the polling interval somehow misses the active window.
- **C2 (MED — SURFACE_TO_SHASTRI)** — React error #418 (hydration mismatch) reported in dashboard browser console after submit. **No reproducible path** in the UAT log; no stack trace; no specific component identified. Root-causing hydration mismatches without a stack trace requires investigation that exceeds the 45-60 min time-box. SURFACE to Shastri with three diagnosis paths so the next dispatch can scope the actual fix.

---

## B4 ACs — regenerate response code regression guard

| AC | Target (file:line on branch tip `edf24af`) | Contract | Verify |
|----|---------------------------------------------|----------|--------|
| **AC-B4-1** | `app/api/sites/[id]/regenerate/route.ts:211` Pro-paid success branch | EXISTS — returns `{ success: true, message, accessToken, creditsReserved, maxPages, creditsRemaining }, { status: 202 }`. NO edit. | Vitest UT pinning: mock the path, assert `res.status === 202` + body shape. |
| **AC-B4-2** | `app/api/sites/[id]/regenerate/route.ts:267` free-rotation success branch | EXISTS — returns `{ success: true, message, accessToken }, { status: 202 }`. NO edit. | Vitest UT. |
| **AC-B4-3** | `app/dashboard/RowActions.tsx:57` handleRerunAudit | EXISTS — `if (res.status === 202) { onScanStart?.(); router.refresh(); }`. NO edit. | Vitest UT (mock fetch → 202 → assert onScanStart called once + router.refresh called once). |
| **AC-B4-4** | NEW invariant: regenerate route MUST return 202 (NOT 200) on every success exit. Add a static-analysis grep guard scanning `app/api/sites/[id]/regenerate/route.ts` for any `NextResponse.json(...{ status: 200 })` pattern → flag if found. The asynchronous-create idiom requires 202 (Accepted, not 200 OK) because the pipeline runs out-of-band post-response. | Vitest UT (grep guard). |
| **AC-B4-5** | NEW invariant: any client caller of `/api/sites/[id]/regenerate` MUST handle 202 as the success status. Grep `app/**/*.tsx` + `app/**/*.ts` for `regenerate` URL string → for each match, verify the response handling treats 202 as success. Currently 1 caller (`RowActions.tsx:57`); a second caller exists in `SitePageClient.tsx:318` `handleRefreshScore` — also already checks `res.status === 202` (verified). Both correct on branch tip. | Vitest UT (grep guard + per-callsite UT). |

**B4 ScriptDev impl shape:**
1. Add the 5 UTs codifying the existing-correct contract. No product code edits.
2. AC-B4-4 + AC-B4-5 grep guards prevent future regression where someone changes the route to 200 or adds a new caller that mishandles the status.

**B4 UAT shape:** click Re-audit on the dashboard → spy on the network response → assert status code is 202 → assert the dashboard row immediately shows the optimistic-scanning state (not stuck in pre-click status). Already passing on branch tip per spec-rigour verification.

**B4 AC count: 5.**

---

## C1 ACs — polling start optimistic + max-30s safety

| AC | Target | Contract | Verify |
|----|--------|----------|--------|
| **AC-C1-1** | `app/dashboard/DomainTableRow.tsx:85` polling-start condition | EXISTS — `if (!isActiveStatus(liveStatus) && !isOptimisticScan) return;`. NO edit. | Vitest UT pinning the early-return when neither flag is true. |
| **AC-C1-2** | `app/dashboard/DomainTableRow.tsx:328` `onScanStart={() => setIsOptimisticScan(true)}` prop wiring | EXISTS — onScanStart from RowActions flips isOptimisticScan true. NO edit. | RTL component test (mock RowActions + assert state transition). |
| **AC-C1-3** | `app/dashboard/DomainTableRow.tsx:94-97` polling-end condition | EXISTS — `if (!isActiveStatus(data.pipelineStatus)) { setIsOptimisticScan(false); router.refresh(); }`. NO edit. | Vitest UT pinning the `isOptimisticScan(false)` reset on terminal state. |
| **AC-C1-4** | NEW — max-30s safety timeout. If `isOptimisticScan` is true for > 30s without `liveStatus` ever transitioning to an active value (i.e. the regenerate succeeded but the next poll missed the active window — tight race), forcibly clear `isOptimisticScan` AND `router.refresh()` so the row reflects the actual server state. Implementation: `useEffect` with a 30s timeout that fires when `isOptimisticScan` becomes true; cleared if `liveStatus` becomes active OR component unmounts OR isOptimisticScan goes false. | Vitest RTL test (advance fake timers 30s → assert isOptimisticScan reset + router.refresh called). |
| **AC-C1-5** | NEW invariant: the `isOptimisticScan` state machine has exactly 3 transitions: (a) false → true via `onScanStart` (RowActions click); (b) true → false via polling observing `!isActiveStatus(data.pipelineStatus)`; (c) true → false via AC-C1-4 max-30s safety. NO other transition. Document in comment block above the polling effect. | Comment + grep guard (no other `setIsOptimisticScan(true)` outside line 328 wiring; no other `setIsOptimisticScan(false)` outside the polling block + AC-C1-4 timeout). |

**C1 ScriptDev impl shape:**
1. Add the AC-C1-4 useEffect with `setTimeout(() => { setIsOptimisticScan(false); router.refresh(); }, 30_000)` + cleanup.
2. Document the 3-transition state machine in the polling effect's preceding comment per AC-C1-5.
3. UTs pin the existing transitions (AC-C1-1/2/3) + the new safety (AC-C1-4).

**C1 UAT shape:** force a regenerate that succeeds server-side but where the dashboard polling somehow misses the active window (e.g. mock the GET /api/sites/[id] to return `pipeline_status: 'complete'` immediately) → assert isOptimisticScan auto-clears within 30s + dashboard row reflects complete state without manual refresh.

**C1 AC count: 5.**

---

## C2 — Hydration mismatch (React error #418) — SURFACE_TO_SHASTRI

### Investigation status

Per the time-box (45-60 min total for Wave 5) and dispatch instruction "investigate root cause; if simple fix exists, author AC; if requires DaVinci redesign, mark SURFACE_TO_SHASTRI", initial investigation:

- **No reproducible path** in `docs/uat/2026-04-26-issues.md` — only "Uncaught Error: Minified React error #418 in browser console after submit". No stack trace, no minified-error-decoder URL, no specific component, no DOM diff.
- **React error #418 = hydration mismatch** ("Hydration failed because the initial UI does not match what was rendered on the server"). Common causes: `Date.now()` / `Math.random()` / locale-dependent formatting in render; client-only state (e.g. `localStorage`) read in initial render; conditional rendering based on `typeof window`.
- **Dashboard-side candidates** (without instrumentation): `app/dashboard/page.tsx` (server component) + `app/dashboard/RowActions.tsx` + `app/dashboard/DomainTableRow.tsx` (both client). Each row computes `domainMonogramColor(row.domain)` (deterministic, safe). The polling `useEffect` runs client-only (safe — no SSR mismatch). The Wave 1 `router.refresh()` may be a contributing factor (refresh during a click handler can race with React's reconciliation).
- **Cannot root-cause without:** a) the de-minified stack trace from the dev build (current error is from prod build); b) a reliable reproduction (which submit → dashboard navigation triggers it?); c) the DOM diff React logs in dev mode (`Warning: Text content did not match. Server: "X" Client: "Y"`).

### SURFACE_TO_SHASTRI options

Three diagnosis paths to scope the next dispatch. Spec authors all three; Shastri/Aditya picks based on operator-time budget.

| Option | Action | Effort | Risk | Outcome |
|--------|--------|--------|------|---------|
| **(I) Reproduce in dev build → de-minify stack** | Operator runs `npm run build && npm run start` locally → click through dashboard re-audit flow → capture the de-minified React warning in the browser console (dev mode shows the actual server-vs-client text diff). With the diff, root cause is usually obvious in <30 min. | LOW (operator time only — 30 min). | LOW. | Deterministic root cause; spec-able fix in a follow-up TS-NNN. |
| **(II) Add ErrorBoundary + log-to-server hook on dashboard** | Wrap `app/dashboard/page.tsx` children in a React `<ErrorBoundary>` that POSTs the error + componentStack to a new `/api/dashboard/log-error` endpoint. Run for 24h in prod → collect real-world hydration failures with stack traces → root cause from aggregated logs. | MEDIUM (~2h impl + 24h wait). | LOW. | Population-level signal (catches multiple hydration sources if they exist). |
| **(III) Defensive client-only patches** | Apply standard hydration-mismatch defences without root-causing first: (a) wrap any time/locale-dependent render in `useEffect` (post-mount only); (b) wrap any `localStorage`/`sessionStorage` reads in `useEffect`; (c) `suppressHydrationWarning` on any element where the mismatch is intentional (last-resort). | HIGH (4-6h refactor sweep). | MEDIUM (could mask the actual bug; suppressHydrationWarning is a code smell). | May fix the symptom without understanding the cause. NOT RECOMMENDED unless (I) and (II) both fail. |

**Recommended for SHASTRI:** **Option (I)** — de-minifying the stack is the cheapest-by-far diagnosis path. 30 min of operator time produces a deterministic root cause. Authoring a fix from there is a separate TS once the cause is known.

**SURFACE payload to Shastri:**
> C2 React error #418 (hydration mismatch) on dashboard — no reproducible path or stack trace in UAT log; cannot root-cause within Wave 5 time-box. Three diagnosis-path options in ES-wave-5-ux-polish.md §C2: (I) reproduce in dev build to de-minify stack [RECOMMENDED, ~30 min operator time], (II) ErrorBoundary + server-log endpoint [MEDIUM, ~2h+24h], (III) defensive patches [HIGH, NOT recommended]. Awaits ratify before authoring the fix TS-NNN.

### C2 ACs (placeholder — final ACs depend on chosen diagnosis path)

- **AC-C2-1** (any option): once the root cause is identified, the fix is implemented in a separate TS-NNN. Wave 5 spec does NOT pre-author it.
- **AC-C2-2** (option II only): `app/dashboard/page.tsx` wraps children in `<ErrorBoundary>` that POSTs to `/api/dashboard/log-error`; new route accepts the payload + console.warns it for log-shipper aggregation; ErrorBoundary fallback UI matches existing dashboard error styling.
- **AC-C2-3** (any option): regression test once root cause is known — Vitest RTL test mounting the affected component + asserting hydration completes without warnings.

**C2 AC count: 3 placeholders. ScriptDev waits for Shastri ratify.**

---

## Test strategy

**Vitest UTs:**
- B4: 5 UTs (route status pinning + RowActions handler pinning + grep guards).
- C1: 4 UTs + 1 RTL test (state-machine transitions + 30s safety timeout).
- C2: 0 UTs in this ES (deferred to follow-up TS once root cause known).

**Vitest ITs (Docker CI):**
- B4 IT: drive `POST /api/sites/[id]/regenerate` against a seeded paid site → assert response.status === 202 + body shape.
- C1 IT: optional — drive a full re-audit cycle from RowActions click → assert dashboard row transitions through optimistic-scanning → live-active → terminal without manual refresh.

**No Playwright per pivot.**

---

## Verification gate (pivot-aligned)

Wave 5 lands when:
1. Vitest GREEN — UTs from §B4 + §C1 pass.
2. Docker CI GREEN — ITs pass.
3. **No Playwright globalSetup** per pivot.
4. C2 SURFACE acknowledged by Shastri; fix TS authored separately. Wave 5 lands without C2 fix because the issue lacks a reproducible path; landing the regression-guard ACs for B4 + C1 still ships value.

---

## Out of scope

- **C2 actual fix** — separate TS once Shastri picks a diagnosis path and the root cause is identified.
- **DaVinci redesign for re-audit affordance** — current dashboard re-audit UX is functional; redesign is product judgment, not a Wave 5 bug-fix.
- **Supabase Realtime subscription for dashboard updates** — alternative to polling; significant refactor; separate ES if pursued.
- **C3+ / D series** — not Wave 5 scope.
