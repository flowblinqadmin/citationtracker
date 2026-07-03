# ES-B9.1 — Middleware allow-list + dashboard error-handling + UI overflow

**Branch:** `fix/b9.1-middleware-and-dashboard`
**Base:** `d8cf322`
**Pivot:** `waves-1to6-cd-pivot-2026-04-26` — Vitest GREEN + Docker CI GREEN gate, NO Playwright per-spec.
**Parent:** ES-B9 (bulk-retry parity) — this is a follow-up surfacing latent gaps that masked the B9 ScriptDev impl as broken.

---

## a) Overview

UAT 2026-04-27 (Aditya): clicked "Rerun Audit" on dashboard and "Retry failed URLs" on bulk site report — both produced **no visible response**. ScriptDev-landed B9 retry-failed route is correct (Option γ); the failures are upstream / downstream of the route handler.

### a.1 Three distinct bugs

| # | Bug | Verified evidence |
|---|---|---|
| 1 | **Middleware blocks `/api/sites/[id]/retry-failed` at edge** | `middleware.ts:62` allows `regenerate` only; no entry for `retry-failed`. Default fallthrough at `:194` returns `NextResponse(null, {status:403})`. Shastri curl: `POST localhost:3030/api/sites/VI5WchNGUDJBiHALBwGM6/retry-failed` → 403 in 0.018s, empty body — route handler never reached. |
| 2 | **Dashboard `RowActions.handleRerunAudit` swallows non-{202,409,402} responses** | `app/dashboard/RowActions.tsx:53-71`: only branches on 202/409/402; **400 falls through silently**. Manipal site `VI5WchNGUDJBiHALBwGM6` has `audit_mode=bulk pipeline_status=complete failed_urls=41` → `/regenerate` returns 400 ("bulk audits cannot be regenerated") → no tooltip rendered → user sees nothing. Same shape at `DomainTableRow.tsx:271` (the `Failed — click to retry` button) — only checks `status === 202`. |
| 3 | **`bulkRetryError` div on report page renders off-screen** | `app/sites/[id]/SitePageClient.tsx:1459-1461` — `<div role="alert" style={{ fontSize: 12, color: RED, fontWeight: 500 }}>{bulkRetryError}</div>` has no `max-width` / `word-break` / overflow hint. Long error text from server (`"Bulk audits cannot be regenerated. Upload a new CSV..."`) overflows the parent flex container and is not visible without horizontal scroll. |

### a.2 Manipal site state pin (γ branch verification)

Manipal `VI5WchNGUDJBiHALBwGM6`: `audit_mode=bulk`, `pipeline_status=complete`, `failed_urls=41`. Per ES-B9 §c.5 AC-B9-10: this is the **α-paid path** (status='complete' + non-empty failedUrls → existing `bulk_crawl_reserve` charge; γ free-retry only triggers on `status='failed'`). Confirms ScriptDev's γ branch is correctly conditional — not a B9 regression. Bug 1 is the actual blocker.

---

## b) DO NOT TOUCH

`app/api/sites/[id]/retry-failed/route.ts` — γ credit-policy branch is correct per ES-B9 §c.5 AC-B9-10. **Zero edits to the route handler.** Only middleware + UI layers need fixing in this spec.

---

## c) Acceptance criteria (verbatim from Shastri dispatch)

| ID | Criterion |
|---|---|
| **AC-B9.1-1** | `middleware.ts` `ALWAYS_ALLOWED` includes regex matching `/api/sites/[id]/retry-failed` (mirror `regenerate` regex shape: `/^\/api\/sites\/[^/]+\/retry-failed$/`). **Vitest IT:** anon + auth-cookie POST to `/api/sites/<id>/retry-failed` both PASS middleware (no 403); auth still enforced INSIDE the route handler (Bearer-token check at `route.ts:48-60` returns 401 unchanged). |
| **AC-B9.1-2** | `app/dashboard/RowActions.tsx` `handleRerunAudit` handles ALL non-2xx with visible tooltip. 400 → `response.error` text truncated to ~80 chars (display verbatim from server, not a generic string — surfaces "Bulk audits cannot be regenerated..." correctly). 5xx → `"Server error — try again"`. **Vitest UT:** mock fetch returning 400 with bulk-regenerate-blocked body → assert `rerunTooltip` set to truncated server error text (NOT swallowed silently). |
| **AC-B9.1-3** | `app/dashboard/DomainTableRow.tsx` `Failed — click to retry` button (line 266-283): when `row.auditMode==='bulk'`, call shared `canRetryBulk`-aware helper that POSTs `/retry-failed`; when not bulk, preserve existing `/regenerate`. **Vitest UT:** both branches — mock `row.auditMode='bulk'` → assert fetch called with `/retry-failed`; mock `row.auditMode='single'` → assert fetch called with `/regenerate`. |
| **AC-B9.1-4** | `app/dashboard/RowActions.tsx` `Rerun Audit` icon button: when row is bulk → `/retry-failed` via shared helper (same as AC-B9.1-3); single audits → `/regenerate`. **Vitest UT:** both branches against the same fetch-mock pattern as AC-B9.1-3. |
| **AC-B9.1-5** | Error tooltip/toast CSS: `max-width: min(80vw, 480px); word-break: break-word; white-space: normal;` positioned to not overflow left. Apply to **both** dashboard tooltip (`RowActions` `rerunTooltip` render path) AND `bulkRetryError` div (`SitePageClient.tsx:1459-1461`). **JSX render test:** assert computed inline style includes `max-width` token + `word-break: break-word`. |
| **AC-B9.1-6** | New IT `__tests__/integration/middleware-allowlist.test.ts` enumerates every `app/api/sites/[id]/*` route file (per `ls app/api/sites/[id]/`: `auth, citation-check, citation-history, citation-narrative, competitor-discovery, competitors, consent, download-report, info, pdf-report, regenerate, retry-failed, verify, verify-connection, verify-domain`) and asserts each has a corresponding `ALWAYS_ALLOWED` regex match. Catches future allow-list misses at CI. (Routes intentionally NOT in the allow-list — e.g. `competitor-discovery`, `competitors`, `pdf-report` if they require dashboard auth — should be enumerated in an explicit `INTENTIONALLY_AUTHED` allow-list inside the test, so adding a new public route is a single-line audit decision.) |

---

## d) Test strategy

### d.1 Vitest UTs

- `app/dashboard/__tests__/RowActions.test.tsx` (extend or new):
  - U-1: 400 from `/regenerate` → `rerunTooltip` set to truncated `data.error` text. Asserts AC-B9.1-2.
  - U-2: 500 from `/regenerate` → `rerunTooltip` set to `"Server error — try again"`. Asserts AC-B9.1-2.
  - U-3: bulk row `Rerun Audit` → fetch called with `/retry-failed`. Asserts AC-B9.1-4.
  - U-4: single row `Rerun Audit` → fetch called with `/regenerate`. Asserts AC-B9.1-4 (regression guard).
- `app/dashboard/__tests__/DomainTableRow.test.tsx` (extend or new):
  - U-5: bulk row + `liveStatus='failed'` → `Failed — click to retry` POSTs `/retry-failed`. Asserts AC-B9.1-3.
  - U-6: single row + `liveStatus='failed'` → POSTs `/regenerate`. Asserts AC-B9.1-3 (regression).
- JSX-style render test (component snapshot or computed-style assertion):
  - U-7: `RowActions` tooltip element computed style includes `max-width` + `word-break: break-word`. Asserts AC-B9.1-5.
  - U-8: `SitePageClient.tsx:1459` `bulkRetryError` div same. Asserts AC-B9.1-5.

### d.2 Vitest ITs

- `__tests__/integration/middleware-allowlist.test.ts` (NEW per AC-B9.1-6):
  - IT-1: anon POST to `/api/sites/<test-id>/retry-failed` → middleware passes through (status NOT 403; route returns 401 from its own auth check, which is the correct behaviour). Asserts AC-B9.1-1.
  - IT-2: enumerate `app/api/sites/[id]/*` route directory + assert each path matches at least one `ALWAYS_ALLOWED` regex OR appears in test-local `INTENTIONALLY_AUTHED` allow-list. Asserts AC-B9.1-6.

### d.3 Verification gate

Per pivot `waves-1to6-cd-pivot-2026-04-26`:
- `vitest run` → all 8 UTs + 2 ITs GREEN.
- Docker CI GREEN.
- **NO Playwright.**

---

## e) Out of scope

- ES-B9 retry-failed route handler (γ branch is correct — DO NOT TOUCH per §b).
- ES-B9 `canRetryBulk` shared helper (already specified at ES-B9 AC-B9-7).
- Server-side 5xx hardening on the retry route — covered by Wave 2 ES-wave-2 §B2.
- Per-row retry buttons inside the bulk results card — already specified at ES-B9 AC-B9-5.

---

## f) Ambiguity flag for HolePoker round-trip

**None.** All 6 ACs are verbatim from Shastri's dispatch with concrete file:line pins verified against branch tip `d8cf322`. Spec is unambiguous and ready for ScriptDev. (The optional clarification in AC-B9.1-6 — adding a test-local `INTENTIONALLY_AUTHED` enum so adding a public route is a single-line audit — is a SpecMaster note, not an ambiguity.)
