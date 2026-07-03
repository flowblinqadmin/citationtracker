# ES-031 — Competitor Discovery: Robust Error Handling

**Date:** 2026-03-04
**Priority:** P1 (user-visible bug)
**Technical Spec:** TS-031-competitor-discovery-error-handling.md
**Status:** READY — dispatch to ReviewMaster

---

## a) Overview

Single-file client-side bug fix in `app/components/citation-monitor.tsx`. The `runDiscovery()` function calls `res.json()` directly on non-OK HTTP responses. When the server returns a 500 with an HTML body (unhandled exception in the competitor-discovery route before the SSE stream starts), this throws `"Unexpected end of JSON input"`, which surfaces to the user as an opaque crash rather than a readable error message.

**Fix:** replace `res.json()` with `res.text()` + try-JSON.parse + HTTP-status-code fallback. Also remove the `!` non-null assertion on `res.body`.

No server-side changes. No other files change.

---

## b) Implementation Requirements

### File: `geo/app/components/citation-monitor.tsx`

#### Change 1 — lines 171–175: fix non-OK error body parsing

**Before (line 172 — broken):**
```typescript
if (!res.ok) {
  const body = await res.json() as { error?: string };
  setDiscovery(s => ({ ...s, status: "error", error: body.error ?? `HTTP ${res.status}` }));
  return;
}
```

**After (robust):**
```typescript
if (!res.ok) {
  let errorMsg = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text) as { error?: string };
      errorMsg = parsed.error ?? errorMsg;
    }
  } catch { /* body not parseable — keep status code fallback */ }
  setDiscovery(s => ({ ...s, status: "error", error: errorMsg }));
  return;
}
```

#### Change 2 — line 177: remove `!` non-null assertion on `res.body`

**Before:**
```typescript
const reader = res.body!.getReader();
```

**After:**
```typescript
if (!res.body) {
  setDiscovery(s => ({ ...s, status: "error", error: "No response body" }));
  return;
}
const reader = res.body.getReader();
```

These are the only two changes. The `runCheck()` function has the same `res.json()` pattern at line 75 and `res.body!` at line 80 — those are **out of scope** per TS-031.

---

## c) Unit Test Plan

**File:** `geo/__tests__/citation-monitor.test.tsx` (new or extend existing)

**Framework:** Vitest + React Testing Library. Mock `fetch` globally with `vi.fn()`.

### Test cases

| ID | Name | Setup | Expected |
|----|------|-------|----------|
| ED-1 | 402 JSON error body → UI shows `error` field | `fetch` resolves with `{ ok: false, status: 402, text: () => '{"error":"insufficient_credits"}' }` | Error state shows "insufficient_credits" |
| ED-2 | 500 HTML body → UI shows "HTTP 500" | `fetch` resolves with `{ ok: false, status: 500, text: () => '<html>Internal Server Error</html>' }` | Error state shows "HTTP 500" (not a thrown exception) |
| ED-3 | Non-2xx empty body → UI shows "HTTP 503" | `fetch` resolves with `{ ok: false, status: 503, text: () => '' }` | Error state shows "HTTP 503" |
| ED-4 | `res.body` is null → UI shows "No response body" | `fetch` resolves with `{ ok: true, status: 200, body: null }` | Discovery state shows error "No response body" |
| ED-5 | Happy path unchanged — SSE stream parsed correctly | `fetch` resolves with readable SSE stream returning `start` + `complete` events | Discovery state transitions correctly; competitors stored |
| ED-6 | Existing citation-monitor tests pass | Run full test suite for the file | All pre-existing tests pass without modification |

### Mock helper

```typescript
function mockFetchResponse(opts: {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  body?: ReadableStream | null;
}) {
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok: opts.ok,
    status: opts.status,
    text: opts.text ?? (() => Promise.resolve("")),
    body: opts.body ?? null,
  } as Response);
}
```

**Coverage target:** All 3 error-path branches in the new `!res.ok` block (JSON parse success, JSON parse failure/HTML, empty body) plus the null-body guard.

---

## d) Integration Test Plan

No dedicated integration test required. ED-5 (happy path unchanged) plus the existing E2E citation-monitor tests cover integration. The fix is purely defensive error handling.

---

## e) Profiling

No performance impact — the change only affects the error path.

---

## f) Load Test

Not applicable.

---

## g) Logging & Instrumentation

No new logging required. The existing outer `catch` at line 194 already logs errors to the `discovery` state. The new inner `try/catch` is silent by design (body not parseable → use status code fallback, no log needed).

---

## h) Acceptance Criteria

| AC | Criterion | Test |
|----|-----------|------|
| AC-1 | Non-2xx JSON response → UI shows `error` field from JSON body | ED-1 |
| AC-2 | Non-2xx HTML response → UI shows "HTTP {status}", no thrown exception | ED-2 |
| AC-3 | Non-2xx empty body → UI shows "HTTP {status}" | ED-3 |
| AC-4 | `res.body === null` with `res.ok` → UI shows "No response body" gracefully | ED-4 |
| AC-5 | Happy-path SSE stream parsing unchanged | ED-5 |
| AC-6 | All existing citation-monitor tests pass | ED-6 |
