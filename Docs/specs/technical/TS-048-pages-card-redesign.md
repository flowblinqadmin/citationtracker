# TS-048: Page-by-Page Section — Redesign from Table to Card Accordion

**Status:** Ready for ScriptDev
**Priority:** P1 (design consistency)
**Branch:** `feat/per-page-fixes`
**Scope:** 1 file, 1 component

---

## What

The "Page-by-Page Analysis" section uses a dark HTML `<table>` layout that looks inconsistent with the rest of the report page. Redesign it to use the same card-based accordion pattern as the "All Recommendations" section.

## Design Reference — All Recommendations (lines 1881-1963)

The target pattern:

```
<div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
  {items.map((item) => (
    <div key={...} style={{
      background: CARD,                    // "#1c1917"
      border: `1px solid ${BORDER}`,       // "rgba(0,0,0,0.07)"
      borderRadius: "10px",
      overflow: "hidden",
    }}>
      {/* Clickable header row */}
      <div
        onClick={toggle}
        style={{
          display: "flex", alignItems: "center", gap: "12px",
          padding: "14px 18px",
          cursor: "pointer",
          background: isExpanded ? CARD_ALT : CARD,
        }}
        onMouseOver={...hover effect...}
        onMouseOut={...}
      >
        {/* Left: rank/label */}
        {/* Center: title (flex: 1) */}
        {/* Right: chips/badges + expand arrow */}
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div style={{ padding: "16px 18px 18px", borderTop: `1px solid ${BORDER}` }}>
          ...content...
        </div>
      )}
    </div>
  ))}
</div>
```

Key design tokens (already defined as constants in the file):
- `CARD` = "#1c1917"
- `CARD_ALT` = "#292524"
- `BORDER` = "rgba(0,0,0,0.07)"
- `TEXT` = "#f5f5f5"
- `TEXT_2` = "#a3a3a3"
- `TEXT_3` = "#737373"
- `GREEN` = "#16a34a"
- `AMBER` = "#d97706"
- `RED` = "#dc2626"

## Current PageByPageSection Layout (lines 573-670)

Replace:
- `<SectionCard style={{ padding: "0" }}>` wrapper
- `<table>/<thead>/<tbody>/<tr>/<td>` structure
- Dark table rows with `#1a1a1a` borders
- Table header row (URL | Fix Count | arrow)

With:
- Card list with `gap: "6px"` (same as recommendations)
- Each page = one card with header row + expandable detail
- Filter bar stays above the card list (keep as-is, lines 575-583)
- Pagination stays below (keep as-is)

## Card Header Row Design

Each card's header should show:

```
[URL (truncated, blue link)]  [fix count badge]  [health badge]  [impl progress]  [▼]
```

- **URL**: `flex: 1`, truncated with ellipsis, blue link (`#60a5fa`), `fontSize: "13px"` — same as current
- **Fix count badge**: Same colored badge as current (green/amber/red based on count)
- **Health badge**: Show `overallPageHealth` from `perPageResults` if available. Map the corresponding entry by URL. Use `good` → green, `needs-work` → amber, `poor` → red. Style like the impact chip in recommendations: `fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "100px"`.
- **Implementation progress**: `{impl.implementedCount}/{impl.totalFixes} done` if available, `fontSize: "11px", color: TEXT_3`
- **Expand arrow**: `▲/▼`, `fontSize: "12px", color: TEXT_3`

## Expanded Detail Design

Keep the same content as current (lines 616-659) but use the recommendation-style container:
- `padding: "16px 18px 18px"`
- `borderTop: 1px solid ${BORDER}`
- Each fix category (Title, Meta Description, H1, Heading Structure, Pillar Fixes, Schema) as labeled blocks
- Keep the `→ suggested fix` formatting and `✓ Done` badges
- Keep the pillar fix badges and "Site-side change" labels

## What NOT to change

- Filter bar (lines 575-583) — keep as-is, just move it above the card list
- Pagination controls — keep as-is
- Free-tier gating (lines 547-567) — keep as-is
- The "no data" empty state (lines 568-571) — keep as-is
- Expanded detail content (Title/Meta/H1/Heading/Pillar/Schema fixes) — keep all the same content, just re-wrap in the card pattern

---

## Acceptance Criteria

1. PageByPageSection uses card accordion layout matching All Recommendations
2. No `<table>/<thead>/<tbody>/<tr>/<td>` elements remain
3. Each page card has: URL, fix count badge, health badge, impl progress, expand arrow
4. Expanded detail shows same fix information as before
5. Filter bar and pagination still work
6. Hover effect on non-expanded cards (matching recommendations)
7. Visual consistency with the rest of the page

## Files to modify

| File | Change |
|------|--------|
| `app/sites/[id]/ResultsDashboard.tsx` | Rewrite `PageByPageSection` paid-tier render (lines 573-670) from table to card accordion |
