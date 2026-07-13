// Shared design tokens for the Citations UI. Mirrors geo's dashboard palette
// (copper accent, Apple-system semantics, Inter) 1:1 — the citations app is
// path-routed under geo.flowblinq.com and users cross between the two, so the
// two surfaces must look like one product. Canonical source:
//   geo/app/dashboard/page.tsx  +  geo/app/dashboard/tracker/ui.ts
// The favicon (app/icon.svg) already uses COPPER #c2652a — this keeps the whole
// UI in step with the brand mark.
export const UI = {
  // Accent (copper) — was amber #b45309 before alignment.
  COPPER: "#c2652a",
  COPPER_BG: "#fff7ed", // soft copper tint for chips/highlights (matches geo)

  // Surfaces
  BG: "#f5f5f7", // geo dashboard background (was parchment #faf8f5)
  CARD: "#ffffff",
  BORDER: "#e5e5ea",
  BORDER_CSS: "1px solid #e5e5ea", // convenience for inline `border:` props
  HEADER_BG: "#FAF9F5",
  HEADER_BORDER: "rgba(0,0,0,0.06)", // geo dashboard header hairline
  REPLY_BG: "#fafafa", // subtle inset panel (geo dashboard alt surface)

  // Semantic — Apple-system palette, matching geo. Meanings preserved:
  //   GREEN = verified / brand-mentioned / positive
  //   RED   = dead / error / negative
  //   ORANGE= warning / no_mention hallucination guard
  GREEN: "#34c759",
  GREEN_BG: "#e8f5e9",
  ORANGE: "#ff9500",
  RED: "#ff3b30",
  RED_BG: "#fef2f2",
  RED_BORDER: "#fecaca",
  BLUE: "#0a84ff",

  // Text hierarchy
  TEXT: "#1d1d1f",
  T2: "#86868b", // muted / secondary
  T3: "#aeaeb2", // faint / tertiary
  NEUTRAL_BG: "#f5f5f4", // neutral chip background

  FONT: "var(--font-inter), system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
} as const;
