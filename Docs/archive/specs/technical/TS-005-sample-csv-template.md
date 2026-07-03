# TS-005: Sample CSV Template for Bulk URL Audit

> **Spec file** — auto-synced from `.agents/specs/` on 2026-03-02  
> **GitHub Issues:** n/a  
> **Delivery Commit:** `983927a`  

---

## What

Provide a downloadable sample CSV file that shows users the exact format expected by the bulk URL audit feature. Add a visible download link on the landing page near the CSV upload widget.

## Why

Users are uploading malformed CSVs — wrong column, protocol missing, headers formatted incorrectly. A sample file eliminates ambiguity and reduces support friction at zero cost.

---

## 1. Sample File

**Location:** `geo/public/sample-bulk-audit.csv`

**Content:**
```csv
url
https://example.com
https://example.com/about
https://example.com/pricing
https://example.com/blog
https://example.com/contact
```

Rules:
- Column header `url` in row 1 (skipped by parser — no valid protocol)
- One URL per row
- Only the first column is read if CSV has multiple columns
- No BOM, UTF-8 encoding, CRLF or LF line endings both fine

Note: With the URL normalization fix (TS-006), users can also write `example.com` or `www.example.com` without `https://` — the parser will normalize them. The sample file still shows full URLs to set good expectations.

---

## 2. Frontend Change

**File:** `geo/app/page.tsx`

Add a "Download sample CSV" anchor tag directly below the CSV upload dropzone label or helper text. Placement: below the dashed upload box, before the pricing transparency line.

```tsx
<a
  href="/sample-bulk-audit.csv"
  download
  className="text-xs text-zinc-400 underline hover:text-zinc-300"
>
  Download sample CSV
</a>
```

- Use `download` attribute so browser prompts save-as instead of navigating
- Must be visible in both authenticated and unauthenticated states
- No JS required — plain static file served from `/public/`

---

## Acceptance Criteria

1. Navigating to `/sample-bulk-audit.csv` downloads the file (HTTP 200, correct MIME)
2. "Download sample CSV" link is visible on the landing page near the upload area
3. Uploading the sample file without modification produces a valid 5-URL CSV payload
4. File works on Windows (CRLF), macOS (LF), and Excel-exported CSVs

---

## Dependencies

None. Independent of all other specs.

---

## Risks

None. Static file, no logic changes.
