# TS-051: Fast Redirect for Existing Domain — Skip API Round-Trip

**Status:** Ready for ScriptDev
**Priority:** P1 (slow UX for returning pro users)
**Branch:** `feat/per-page-fixes`
**Scope:** 2 files

---

## Bug

When an authenticated pro user submits a domain that already has a completed report, the flow is:
1. Click "Get My AI Profile" → shows "Starting audit..."
2. POST to `/api/sites` (slow — DB queries, team lookup, etc.)
3. API returns `{ id, accessToken, skipVerify: true }`
4. Client does `router.replace(/sites/{id})`
5. Server renders the site page (another DB query)

This feels slow because there are multiple round-trips for something the client could resolve locally. The user expects instant navigation to the existing report.

## Fix

**Two-part approach:**

### Part 1: Prefetch team domains on page load (page.tsx)

The `useEffect` at line 41-58 already fetches `/api/teams/me` for credit balance. Add a parallel fetch of `/api/teams/domains` to get the user's existing sites:

```typescript
const [teamDomains, setTeamDomains] = useState<Array<{ domain: string; siteId: string; pipelineStatus: string }>>([]);

useEffect(() => {
  const supabase = createClient();
  supabase.auth.getSession().then(({ data }) => {
    const user = data.session?.user ?? null;
    if (user) {
      sessionStorage.setItem("geo-authed", "1");
      setIsAuthenticated(true);
      setEmail(user.email ?? "");
      // Fetch credits and domains in parallel
      fetch("/api/teams/me").then((r) => r.json()).then((d) => {
        setCreditBalance(d.team?.creditBalance ?? 0);
      }).catch(() => {});
      fetch("/api/teams/domains").then((r) => r.json()).then((d) => {
        setTeamDomains(d.domains ?? []);
      }).catch(() => {});
    } else {
      sessionStorage.removeItem("geo-authed");
      setIsAuthenticated(false);
    }
  }).catch(() => {});
}, []);
```

### Part 2: Check domains before submitting (handleSubmit)

At the top of `handleSubmit`, before calling `POST /api/sites`, check if the normalized domain matches an existing site:

```typescript
async function handleSubmit(e: React.FormEvent) {
  e.preventDefault();
  if (!email.trim()) { toast.error("Please enter your email"); return; }
  if (csvUrls.length === 0 && !url.trim()) { toast.error("Please enter a website URL or upload a CSV"); return; }

  // Fast path: authenticated user with existing complete report for this domain
  if (isAuthenticated && csvUrls.length === 0 && url.trim()) {
    const normalizedInput = normalizeDomain(normalizeUrl(url.trim()) ?? "");
    if (normalizedInput) {
      const existing = teamDomains.find(
        (d) => d.domain === normalizedInput && d.pipelineStatus === "complete"
      );
      if (existing) {
        // Direct redirect — no API call needed
        const token = sessionStorage.getItem(`geo-token-${existing.siteId}`);
        if (token) {
          router.replace(`/sites/${existing.siteId}?token=${token}`);
          return;
        }
        // No cached token — need to get one from the API, but at least we know it exists
        // Fall through to the normal POST path which will return skipVerify + accessToken
      }
    }
  }

  setLoading(true);
  // ... rest of existing handleSubmit unchanged ...
}
```

### Part 3: Cache accessToken on every successful site load

To make the fast path work (we need the token in sessionStorage), ensure that every time we navigate to a site, we store the token. Check if `SitePageClient` or the site page already does this.

Looking at `page.tsx:158`: `sessionStorage.setItem(\`geo-token-${data.id}\`, data.accessToken)` — this already happens in handleSubmit when `skipVerify` is true. So tokens ARE cached for sites visited via the form.

For sites visited from the dashboard, the token should also be cached. Check the dashboard page — if it links to `/sites/{id}?token={token}`, the site page should cache it too.

### Import needed

`normalizeDomain` is already imported in `page.tsx` — check import line. If not, add: `import { normalizeDomain } from "@/lib/utils";`

Actually, looking at the current imports in `page.tsx:7`: `import { normalizeUrl } from "@/lib/utils";` — `normalizeDomain` is not imported. Need to add it, or inline the domain extraction:

```typescript
const normalizedInput = new URL(normalizeUrl(url.trim()) ?? "https://x").hostname.replace(/^www\./, "");
```

This avoids adding an import. Use this approach.

---

## Acceptance Criteria

1. Authenticated user submits a domain they already have a completed report for → redirected to report page without "Starting audit..." delay
2. If the domain exists but is still processing → falls through to normal POST flow
3. If no token cached → falls through to POST flow (gets token from API)
4. CSV/bulk flow unchanged (no fast-path for bulk)
5. Unauthenticated user flow unchanged
6. Domains are prefetched on page load for authenticated users (parallel with credit fetch)

## Files to modify

| File | Change |
|------|--------|
| `app/page.tsx` | Add `teamDomains` state, fetch `/api/teams/domains` in useEffect, fast-path check in handleSubmit |

## Note

No API changes needed — `GET /api/teams/domains` already returns `{ domain, siteId, pipelineStatus }`.
