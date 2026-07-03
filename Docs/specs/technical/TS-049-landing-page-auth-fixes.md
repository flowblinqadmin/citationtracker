# TS-049: Landing Page — Auth Hydration + Pro User Flow Fixes

**Status:** Ready for ScriptDev
**Priority:** P1 (auth UX broken for returning pro users)
**Branch:** `feat/per-page-fixes`
**Scope:** 2 files

---

## Bug 7a: Hydration mismatch on landing page nav

Same pattern as TS-045 bug 2. `page.tsx:30-32`:

```typescript
const [isAuthenticated, setIsAuthenticated] = useState(() =>
  typeof window !== "undefined" && sessionStorage.getItem("geo-authed") === "1"
);
```

Server: `isAuthenticated = false` → renders `<a href="/auth/login">Sign in</a>`
Client: `isAuthenticated = true` (sessionStorage) → renders `<a href="/dashboard">Dashboard</a>`

### Fix

`page.tsx:30-32` — change to:
```typescript
const [isAuthenticated, setIsAuthenticated] = useState(false);
```

Move the sessionStorage check into the existing `useEffect` at line 41. The useEffect already sets `setIsAuthenticated(true)` after Supabase session check, but add a fast-path sessionStorage read before the async call:

```typescript
useEffect(() => {
  // Fast-path: restore UI from sessionStorage before async Supabase check
  if (sessionStorage.getItem("geo-authed") === "1") {
    setIsAuthenticated(true);
  }
  const supabase = createClient();
  supabase.auth.getSession().then(({ data }) => {
    // ... existing code unchanged ...
  });
}, []);
```

---

## Bug 7b: Button text says "Sending verification..." for authenticated users

`page.tsx:336`:
```typescript
{loading ? "Sending verification..." : csvUrls.length > 0 ? `Audit ${csvUrls.length} URLs` : "Get My AI Profile"}
```

For authenticated pro users, OTP is skipped — the button text should reflect that.

### Fix

Change line 336 to:
```typescript
{loading
  ? (isAuthenticated ? "Starting audit..." : "Sending verification...")
  : csvUrls.length > 0
    ? `Audit ${csvUrls.length} URLs`
    : "Get My AI Profile"}
```

---

## Bug 7c: Authenticated pro user gets routed to verify page for existing completed site

`api/sites/route.ts:218-220`: When domain+email already exists with `complete` status and `emailVerified: true`:

```typescript
if (existing.pipelineStatus === "complete") {
  if (existing.emailVerified) {
    return NextResponse.json({ id: existing.id, message: "Audit already complete" }, { status: 200 });
  }
  // ...sends OTP...
}
```

This returns no `skipVerify` or `accessToken`. The client at `page.tsx:155-163` then navigates to `/verify/{id}` — wrong for an authenticated user.

### Fix

`api/sites/route.ts:218-220` — for authenticated pro users with an existing complete site, return `skipVerify: true` and the existing `accessToken` so the client goes straight to results:

```typescript
if (existing.pipelineStatus === "complete") {
  if (existing.emailVerified) {
    // Authenticated pro user: skip verify, go straight to results
    const authEmail = req.headers.get("x-user-email")?.toLowerCase().trim();
    if (authEmail && authEmail === emailLower && existing.accessToken) {
      return NextResponse.json({
        id: existing.id,
        accessToken: existing.accessToken,
        message: "Audit already complete",
        skipVerify: true,
      }, { status: 200 });
    }
    // Unauthenticated or different user: still need to verify
    return NextResponse.json({ id: existing.id, message: "Audit already complete" }, { status: 200 });
  }
  // ... rest unchanged (sends OTP for unverified sites) ...
}
```

This ensures:
- Authenticated user whose email matches → `skipVerify: true` → client does `router.replace(/sites/{id})` → sees results directly
- Unauthenticated user → still goes to `/verify/` as before

---

## Acceptance Criteria

1. No hydration error on landing page when authenticated
2. Button shows "Starting audit..." (not "Sending verification...") for authenticated users
3. Authenticated pro user submitting existing domain → redirected straight to results page (no verify step)
4. Unauthenticated user flow unchanged

## Files to modify

| File | Change |
|------|--------|
| `app/page.tsx` | `useState(false)` + sessionStorage in useEffect; loading text conditional |
| `app/api/sites/route.ts` | Return `skipVerify + accessToken` for authenticated users with existing complete site |
