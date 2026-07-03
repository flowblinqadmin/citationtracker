# TS-052: CI Failures — TypeScript Type Mismatch + Vitest Supabase Mock

**Status:** Ready for ScriptDev
**Priority:** P0 (blocks PR merge)
**Branch:** `dev-an-latest`
**Scope:** 3 files

---

## Failure 1: TypeScript — CrawledPage vs CrawlPage headings type mismatch

**Error:**
```
app/api/pipeline/stage/route.ts(737,103): error TS2345:
  Argument of type 'CrawlData' is not assignable to parameter of type 'CrawlData'.
  Types of property 'pages' are incompatible.
    Type 'CrawledPage[]' is not assignable to type 'CrawlPage[]'.
      Type 'CrawledPage' is not assignable to type 'CrawlPage'.
        Types of property 'headings' are incompatible.
          Type '{ level: number; text: string; }[]' is not assignable to type 'string[]'.
```

**Root cause:** Two different `CrawlData`/`CrawlPage` types exist:
- `lib/services/geo-crawler.ts` defines `CrawledPage` with `headings: { level: number; text: string; }[]`
- `lib/services/page-fix-generator.ts` defines its own `CrawlPage` with `headings: string[]`

After Rao's main changes updated the crawler type, the page-fix-generator's type no longer matches at `pipeline/stage/route.ts:737` where crawler output is passed to the fix generator.

**Fix:** Update `page-fix-generator.ts`'s `CrawlPage` type to match the crawler's actual `CrawledPage` type:
```typescript
// In page-fix-generator.ts, change:
headings: string[]
// To:
headings: { level: number; text: string; }[]
```

Then update any code in page-fix-generator.ts that uses `headings` as strings to handle the object format (e.g., `heading.text` instead of `heading`).

Alternatively, if the fix generator only needs the text: accept the object type and extract `.text` where needed.

---

## Failure 2: Vitest — AuthNavButton calls createClient() without env vars

**Error:**
```
Error: @supabase/ssr: Your project's URL and API key are required to create a Supabase client!
  at createBrowserClient (node_modules/@supabase/ssr/...)
  at createClient (lib/supabase/client.ts:44:10)
  at app/sites/[id]/ResultsDashboard.tsx:128:7
```

**Affected tests:** `paywall-ui.test.tsx` (3 unhandled rejections), plus likely `citation-monitor*.test.tsx`

**Root cause:** Our TS-045 fix moved the `sessionStorage.getItem()` check into the `useEffect` body in `AuthNavButton`. The `useEffect` calls `import("@/lib/supabase/client")` → `createClient()`. In CI Docker, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are not set → Supabase SDK throws.

**Fix:** The tests that render `ResultsDashboard` need Supabase client mocked. Add to the test file's setup or vi.mock:

```typescript
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      signOut: () => Promise.resolve(),
    },
  }),
}));
```

Check which test files fail (the CI log shows `paywall-ui.test.tsx` — check if `citation-monitor*.test.tsx` also needs it). Add the mock to each failing test file, or to a shared test setup if one exists.

Also check `Dockerfile.test` — it may need `ENV NEXT_PUBLIC_SUPABASE_URL=http://localhost` and `ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=test` as fallback env vars for tests that don't mock.

---

## Acceptance Criteria

1. `npx tsc --noEmit` passes with zero errors
2. `vitest run` passes — no unhandled rejections from Supabase client
3. All 1183+ tests still passing
4. CI on `dev-an-latest` goes green (TypeScript + Vitest + Vercel deploy)

## Files to modify

| File | Change |
|------|--------|
| `lib/services/page-fix-generator.ts` | Update `CrawlPage.headings` type to `{ level: number; text: string; }[]` |
| `__tests__/paywall-ui.test.tsx` | Add `vi.mock("@/lib/supabase/client")` |
| Other failing test files | Same Supabase mock if needed |
