# TS-031 — Competitor Discovery: Robust Error Handling

**Date:** 2026-03-04
**Status:** Draft — pending SpecMaster ES conversion
**Priority:** P1 (bug, user-visible error)

---

## What

Fix the "Discovery error: Failed to execute 'json' on 'Response': Unexpected end of JSON input" crash that appears in the UI when clicking "Discover Competitors."

---

## Why (Root Cause)

In `app/components/citation-monitor.tsx`, the `runDiscovery()` function handles a non-OK HTTP response by calling `await res.json()` directly:

```typescript
if (!res.ok) {
  const body = await res.json() as { error?: string };  // ← throws on empty/HTML body
  ...
}
```

This throws when the server returns a non-2xx response with a non-JSON or empty body. This happens when:

1. **Unhandled exception in route before SSE stream starts** — the `competitor-discovery` route performs two synchronous DB operations (credit deduction, transaction insert) before setting up the SSE stream. If either throws (e.g., DB connection issue), Next.js returns a 500 with an HTML error page, not JSON. `res.json()` on HTML → "Unexpected end of JSON input".

2. **Vercel cold-start returning HTML error page** — on the first deployment of the new route, Vercel can return a temporary HTML 503/504 before the function is warm.

3. **Network termination** — the response body is dropped mid-stream; `res.json()` on an empty body throws the same error.

The same defensive gap exists in `runCheck()` at line ~76 in the same component (`citation-check` route), but that route is older and battle-tested. The gap is most acute for the new `competitor-discovery` route.

---

## Dependencies

- `app/components/citation-monitor.tsx` — client-side error handling in `runDiscovery()`
- `app/api/sites/[id]/competitor-discovery/route.ts` — SSE route (no server-side changes needed for this bug)

---

## Interfaces

### Change in `runDiscovery()` — error body parsing

**Before (broken):**
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
  } catch { /* body not parseable — use status code fallback */ }
  setDiscovery(s => ({ ...s, status: "error", error: errorMsg }));
  return;
}
```

This guarantees the error path never throws, regardless of response body format.

### Optional: null body guard

After the `!res.ok` guard, if `res.body` could be null, add:
```typescript
if (!res.body) {
  setDiscovery(s => ({ ...s, status: "error", error: "No response body" }));
  return;
}
const reader = res.body.getReader();
```
(Removes the `!` non-null assertion and handles `null` explicitly.)

---

## Acceptance Criteria

1. **AC-1** — When the server returns a non-2xx JSON response (e.g., 402 insufficient_credits), the UI displays the `error` field from the JSON body.
2. **AC-2** — When the server returns a non-2xx HTML response (e.g., 500 from an unhandled exception), the UI displays "HTTP 500" (or similar status-based fallback), not a thrown JavaScript exception.
3. **AC-3** — When the server returns a non-2xx response with an empty body, the UI displays "HTTP {status}" as the error message.
4. **AC-4** — When `res.body` is null and `res.ok` is true, the UI shows a graceful error, not a crash.
5. **AC-5** — Existing happy-path behavior (SSE stream parsed, competitors saved, pills displayed) is unchanged.
6. **AC-6** — All existing citation-monitor tests pass.

---

## Risks

- Low risk change — pure defensive error handling in the catch path.
- No behavior change on the happy path.
- No server-side changes required.

---

## Out of Scope

- Fixing unhandled exceptions in the route itself (credit deduction DB errors) — that is a separate hardening task.
- Applying the same defensive fix to `runCheck()` — can be done as a follow-on but is lower urgency.
