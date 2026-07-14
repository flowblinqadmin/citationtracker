// Shared design tokens for the Citations UI. Source of truth is
// FlowBlinq_Citations_UI_Colour_Spec.pdf (2026-07) — Ink/Steel/Mid Grey/Blue
// Mist/Burnt Orange/Robinhood Green/Success Green/Error Red. Mirrored 1:1 in
// geo/app/dashboard/tracker/ui.ts (same key names) so the two surfaces stay
// visually one product across the geo.flowblinq.com path-routed boundary.
// The favicon (app/icon.svg) uses the old copper #c2652a — update alongside
// if/when this palette is applied there.
export const UI = {
  // Accent — Burnt Orange (was copper #c2652a).
  COPPER: "#FF6100",
  COPPER_BG: "#F5F3EF", // Warm Off-White — pill hover / pending-item / chip backgrounds

  // Surfaces
  BG: "#f5f5f7",
  CARD: "#ffffff", // White
  BORDER: "#E8EFFE", // Blue Mist
  BORDER_CSS: "1px solid #E8EFFE", // convenience for inline `border:` props
  HEADER_BG: "#FAF9F5",
  HEADER_BORDER: "rgba(0,0,0,0.06)", // geo dashboard header hairline
  REPLY_BG: "#fafafa", // subtle inset panel (geo dashboard alt surface)
  ON_ACCENT: "#F8FAFC", // Cloud White — text on a filled Burnt Orange background

  // Semantic. Meanings preserved:
  //   GREEN = Success Green — verified / brand-mentioned / positive (semantic success)
  //   BRAND_GREEN = Robinhood Green — brand-emphasis accent (tab underline, metric
  //     highlights, "brand in overview") — distinct from GREEN by design intent,
  //     see spec Evaluation #2 for the near-identical-greens caveat
  //   RED   = Error Red — dead / error / negative
  //   ORANGE= warning / no_mention hallucination guard (unchanged — distinct
  //     shade from the Burnt Orange accent, not covered by the colour spec)
  GREEN: "#22C55E",
  GREEN_BG: "#e8f5e9",
  BRAND_GREEN: "#21CD99",
  ORANGE: "#ff9500",
  RED: "#EF4444",
  RED_BG: "#fef2f2",
  RED_BORDER: "#fecaca",
  BLUE: "#0a84ff",

  // Text hierarchy
  TEXT: "#1A1A2E", // Ink
  T2: "#6B7280", // Mid Grey — labels, body copy
  T3: "#94A3B8", // Steel — metadata, counters, empty states
  NEUTRAL_BG: "#f5f5f4", // neutral chip background

  FONT: "var(--font-inter), system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const;
