# ES-005-sample: Sample CSV Template for Bulk URL Audit

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `983927a`  

---

**Source:** TS-005-sample-csv-template.md
**Agent:** 2-SpecMaster
**Date:** 2026-02-28
**Priority:** LOW — no logic changes, static file only
**Branch:** `dev-an-m2-extended`
**Repo:** flowblinqadmin/geo (local: `/home/aditya/flowblinq/geo`)
**Lang:** TypeScript / TSX / static file

---

## a) Overview

### What This Covers

Two changes:

1. **New static file:** `geo/public/sample-bulk-audit.csv` — a downloadable example CSV showing
   the exact format expected by the bulk audit CSV parser.
2. **Frontend change:** `geo/app/page.tsx` — add a "Download sample CSV" anchor tag near the CSV
   upload dropzone.

### Reference

Source technical spec: `.agents/specs/technical/TS-005-sample-csv-template.md`

### Current Implementation State

**`geo/public/` (directory exists):** Contains static assets served at root. No sample CSV exists.

**`geo/app/page.tsx`:** Contains a CSV upload dropzone with drag-and-drop and a hidden `<input
type="file">`. The dropzone has label text but no download link. The link should be added below the
dashed upload box and before the pricing transparency line.

### Why

Users are uploading malformed CSVs — wrong column, missing protocol, incorrect headers. A
one-click sample file eliminates ambiguity at zero engineering cost.

---

## b) Implementation Requirements

### File 1: `geo/public/sample-bulk-audit.csv` (NEW)

**Exact content:**

```
url
https://example.com
https://example.com/about
https://example.com/pricing
https://example.com/blog
https://example.com/contact
```

Rules:
- Row 1: header `url` (skipped by CSV parser because `new URL("url")` throws — or after TS-006
  lands, `normalizeUrl("url")` returns null because "url" has no dot)
- Rows 2-6: five valid full `https://` URLs
- UTF-8 encoding, no BOM
- LF line endings (Unix) — the parser handles both CRLF and LF via `/\r?\n/`
- No trailing newline required but acceptable

**Note:** With TS-006 (URL normalization) in place, users can also write `example.com` in their
own CSVs without `https://`. The sample file still shows full URLs to set good expectations and
remain valid before TS-006 lands.

### File 2: `geo/app/page.tsx` — "Download sample CSV" link

Locate the CSV upload dropzone JSX. The dropzone is the `<div>` with `onDrop={handleCsvDrop}`
(line ~198). Insert the anchor tag immediately after the dropzone closing `</div>` and before the
pricing transparency / credit message.

**Anchor tag:**

```tsx
<a
  href="/sample-bulk-audit.csv"
  download
  className="text-xs text-zinc-400 underline hover:text-zinc-300"
>
  Download sample CSV
</a>
```

Constraints:
- `download` attribute: browser prompts save-as instead of navigating
- Must be visible in both authenticated and unauthenticated states (no conditional render)
- The link renders regardless of whether a CSV is currently loaded — it is persistent helper text
- No JavaScript required — pure static file served from Next.js `/public/`
- If the page uses inline styles (it does — see existing JSX in page.tsx), add `style` prop
  instead of `className` if Tailwind is not available in the component context. Check whether
  Tailwind classes work on this page. The existing page uses inline styles throughout — use inline
  style as fallback:

```tsx
<a
  href="/sample-bulk-audit.csv"
  download
  style={{ fontSize: "12px", color: "#666", textDecoration: "underline" }}
>
  Download sample CSV
</a>
```

Use whichever approach is consistent with surrounding JSX. The page.tsx currently uses inline
styles exclusively — **use inline styles**.

---

## c) Unit Test Plan

This change involves a static file and a single anchor tag. Formal unit tests are minimal.

**Test file:** `geo/app/page.test.tsx` (NEW, Vitest + React Testing Library if available)

If React Testing Library is not already set up in this project, skip the component test and rely
on the acceptance criteria manual check instead. Do not add a new test framework dependency for
this spec.

If RTL is available:

| Test | Expected |
|------|----------|
| "Download sample CSV" link is rendered | `screen.getByRole("link", { name: /download sample csv/i })` is present |
| Link has correct `href` | `href="/sample-bulk-audit.csv"` |
| Link has `download` attribute | `element.getAttribute("download")` is not null |
| Link is visible when no CSV loaded | Renders unconditionally |
| Link is visible when CSV is loaded | Still renders |

**CSV file format test** (Vitest, no browser needed):

```typescript
import { readFileSync } from "fs";

describe("sample-bulk-audit.csv", () => {
  const content = readFileSync(
    path.join(__dirname, "../../public/sample-bulk-audit.csv"),
    "utf-8"
  );

  it("has url header in first row", () => {
    const lines = content.split(/\r?\n/).filter(Boolean);
    expect(lines[0]).toBe("url");
  });

  it("has 5 valid https URLs in rows 2-6", () => {
    const lines = content.split(/\r?\n/).filter(Boolean).slice(1);
    expect(lines.length).toBe(5);
    for (const line of lines) {
      expect(() => new URL(line)).not.toThrow();
      expect(line.startsWith("https://")).toBe(true);
    }
  });

  it("is valid UTF-8 with no BOM", () => {
    expect(content.charCodeAt(0)).not.toBe(0xFEFF); // no BOM
  });
});
```

**Test file path:** `geo/app/api/sites/sample-csv.test.ts` (or co-located with public assets test
suite if one exists).

### Coverage target

N/A — no logic code. Test suite validates file integrity and link presence.

---

## d) Integration Test Plan

**Scenario 1: CSV file is HTTP 200 with correct MIME type**

Use a test HTTP server or Next.js test utilities to request `GET /sample-bulk-audit.csv`.

```
Expected:
  Status: 200
  Content-Type: text/csv  (or text/plain — either acceptable for static file)
  Body: starts with "url\n" or "url\r\n"
```

**Scenario 2: Uploading the sample file produces a valid 5-URL payload**

1. Simulate loading the sample CSV file content through the `handleCsvUpload` function.
2. Assert: `csvUrls` state contains 5 URLs.
3. Assert: none of the URLs is the header row `"url"`.
4. Assert: all 5 are valid `https://example.com/*` URLs.

This can be a simple unit test on `handleCsvUpload` by calling the FileReader mock with the
sample file content.

**Scenario 3: File works with Windows line endings (CRLF)**

Replace LF with CRLF in the file content and pass through `handleCsvUpload`. Assert: still 5 URLs
parsed correctly. (The CSV parser uses `/\r?\n/` split — already handles CRLF.)

---

## e) Profiling Requirements

Not applicable. This is a static file served directly by Next.js/Vercel CDN. No server-side
computation involved.

---

## f) Load Test Plan

Not applicable. Static file delivery is handled by Vercel's CDN with automatic caching headers.
Vercel serves static files from `/public/` at the edge with no serverless function invocation.

---

## g) Logging & Instrumentation

Not applicable. No server-side code added. Static file requests appear in Vercel access logs
automatically.

---

## h) Acceptance Criteria

- [ ] `GET /sample-bulk-audit.csv` returns HTTP 200 with a CSV body starting with `url` on the first line
- [ ] Clicking "Download sample CSV" on the landing page triggers a browser file-save dialog (not navigation)
- [ ] Link is visible on the landing page near the CSV upload dropzone in both authenticated and unauthenticated states
- [ ] Uploading the sample file without modification produces a valid 5-URL CSV payload (`csvUrls.length === 5`)
- [ ] The header row `url` is not included in the parsed URL list
- [ ] File works on Windows (CRLF), macOS/Linux (LF), and Excel-exported CSVs
- [ ] No JavaScript required for the download — link works with JS disabled
- [ ] Static file is served from Vercel CDN (no serverless function invocation for the download)
