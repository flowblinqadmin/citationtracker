# ES-011: HOTFIX — Restore Pro Gate on Single-Audit Path

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `233ac6c`  

---

**Source:** TS-011-single-audit-pro-gate-hotfix.md
**Agent:** 2-SpecMaster
**Date:** 2026-03-01
**Priority:** P0 — PRODUCTION ISSUE. Live on Vercel now.
**Downstream:** ScriptDev (agent 6) — fast-track
**GitHub Issue:** (hotfix — no separate issue, merge directly to main)
**Branch:** `main` (hotfix directly — no feature branch)

---

## a) Overview

### What This Covers

Restore the Pro account gate on the single-audit path that was dropped during a rebase conflict resolution on 2026-02-28 (commit `507ab9f`, Adithya Rao). The gate was previously present verbatim; it needs to be re-inserted at the exact same location.

**Without this gate:** any authenticated user can loop `POST /api/sites` with different URLs and receive unlimited free crawls. The credit system is currently enforced only on the bulk path.

### Current Implementation State

- **File:** `geo/app/api/sites/route.ts`
- **Single-audit path starts at:** line ~160 (`if (!url || !email)` check)
- **Rate limit check:** lines 179–182 (`isInternalEmail` defined line 178, `emailLimit` checked line 180)
- **Gate MISSING between:** line 182 (end of rate limit block) and line 184 (`const domain = normalizeDomain(...)`)
- **All required imports already in scope:** `db`, `teamMembers`, `eq` (from drizzle-orm), `isInternalEmail` — **no new imports needed**
- **Test file:** `geo/__tests__/api-routes.test.ts` — the 402 free-tier gate test was removed during the same rebase; must be restored

---

## b) Implementation Requirements

### Change 1 — Insert gate block in `geo/app/api/sites/route.ts`

**Exact insertion point:** After the closing brace of the rate limit block (currently line 182), before `const domain = normalizeDomain(normalizedUrl)` (currently line 184).

**Insert verbatim:**
```typescript
    // Free-tier single audits temporarily paused — Pro accounts only
    if (!isInternalEmail) {
      const [proMember] = await db.select().from(teamMembers).where(eq(teamMembers.email, emailLower));
      if (!proMember) {
        return NextResponse.json(
          { error: "Free audits are temporarily paused. Sign up for a Pro account to run an audit." },
          { status: 402 }
        );
      }
    }
```

**No new imports required.** `db`, `teamMembers`, `eq`, `emailLower`, `isInternalEmail` are all already in scope at this point in the handler.

**After insertion, the sequence reads:**
```
rate limit check (lines 179–182)
↓
[INSERTED] Pro gate: teamMembers lookup → 402 if not found (for non-internal emails)
↓
const domain = normalizeDomain(normalizedUrl)  ← unchanged line 184
```

---

### Change 2 — Restore unit test in `geo/__tests__/api-routes.test.ts`

Add the following test case inside the existing `describe("POST /api/sites")` block, after the existing rate-limit test:

```typescript
  it("returns 402 for non-Pro email on single-audit path", async () => {
    // Rate limit passes
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });

    // DB: teamMembers returns empty (no Pro account)
    const selectChain = makeSelectChain([]);
    vi.mocked(db.select).mockReturnValue(selectChain as ReturnType<typeof db.select>);

    const req = new NextRequest("http://localhost/api/sites", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com", email: "free@gmail.com" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await postSites(req);
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toContain("temporarily paused");
  });

  it("allows Pro user through single-audit gate", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });

    // DB: first select → teamMembers returns a row (Pro account exists)
    // Subsequent selects → geoSites returns empty (no existing site)
    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      callCount++;
      if (callCount === 1) return makeSelectChain([{ id: "team-1", email: "pro@company.com", teamId: "team-1" }]) as ReturnType<typeof db.select>;
      return makeSelectChain([]) as ReturnType<typeof db.select>;
    });
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "mock-site-id" }]) }) } as unknown as ReturnType<typeof db.insert>);

    const req = new NextRequest("http://localhost/api/sites", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com", email: "pro@company.com" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await postSites(req);
    // Should NOT be 402 — Pro gate passes, proceeds to OTP flow (200)
    expect(res.status).not.toBe(402);
  });

  it("bypasses Pro gate for internal @flowblinq.com email", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 4, resetAt: Date.now() + 60000 });

    // DB: teamMembers NOT called for internal emails — no mock needed
    // geoSites returns empty
    vi.mocked(db.select).mockReturnValue(makeSelectChain([]) as ReturnType<typeof db.select>);
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "mock-site-id" }]) }) } as unknown as ReturnType<typeof db.insert>);

    const req = new NextRequest("http://localhost/api/sites", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com", email: "dev@flowblinq.com" }),
      headers: { "Content-Type": "application/json" },
    });

    const res = await postSites(req);
    // Internal email bypasses gate — should not be 402
    expect(res.status).not.toBe(402);
  });
```

**Note on `makeSelectChain`:** This helper is already defined in `api-routes.test.ts` (line 59+). Use it as-is.

---

## c) Unit Test Plan

Three tests (see Change 2 above):

| Test | Input | Expected |
|------|-------|----------|
| Non-Pro 402 | `email: "free@gmail.com"`, teamMembers returns `[]` | `status 402`, body contains `"temporarily paused"` |
| Pro user passes | `email: "pro@company.com"`, teamMembers returns one row | `status !== 402` |
| Internal email bypasses | `email: "dev@flowblinq.com"` | `status !== 402`, teamMembers select NOT called |

All external deps mocked via `vi.mock` (already in place). No new mocks required.

---

## d) Integration Test Plan

Manual verification post-deploy (ScriptDev runs this before merging to main):

1. `POST /api/sites` with non-Pro email → must return 402 with error message containing "temporarily paused"
2. `POST /api/sites` with Pro email (exists in `teamMembers`) → must return 200 and proceed to OTP flow
3. `POST /api/sites` with `@flowblinq.com` email → must bypass gate and proceed normally

Staging environment (ES-008 docker-compose.dev.yml) is the preferred test target before main push.

---

## e) Profiling Requirements

None. This is a single DB lookup added to the hot path — `teamMembers` lookup by email is indexed. Latency impact < 5ms at p99.

---

## f) Load Test Plan

Not applicable for this hotfix.

---

## g) Logging & Instrumentation

No new logging required. The 402 response is sufficient signal. If abuse monitoring is desired later, a `warn` log on 402 with the IP and email (hashed) can be added — defer to a follow-on issue.

---

## h) Acceptance Criteria

- [ ] Gate block inserted verbatim at exact location (after rate limit, before `normalizeDomain`)
- [ ] Non-Pro user gets `402` with `"temporarily paused"` message on `POST /api/sites`
- [ ] Pro user (row in `teamMembers`) proceeds normally
- [ ] `@flowblinq.com` emails bypass the gate (isInternalEmail path unchanged)
- [ ] Three unit tests added to `__tests__/api-routes.test.ts` and all pass
- [ ] Full test suite passes (`npm test` → all 743 tests pass)
- [ ] Hotfix committed directly to `main`
- [ ] Vercel auto-deploy completes and production returns 402 for a test non-Pro submission

---

## ScriptDev Notes

- **Do not create a feature branch.** Commit directly to `main`.
- **Two file changes only:** `app/api/sites/route.ts` (1 block inserted) and `__tests__/api-routes.test.ts` (3 tests added).
- **No imports to add.** All symbols are already in scope.
- **Run `npm test` before committing.** All 743 tests must pass.
- **Commit message:** `hotfix: restore Pro gate on single-audit path (TS-011)`
