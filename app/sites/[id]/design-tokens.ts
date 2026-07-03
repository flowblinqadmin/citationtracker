// Shared design tokens. Mirrors the inline constants in app/dashboard/page.tsx
// so pipeline-studio (and other admin views) can import a single source of truth.
//
// Union of cleo-overhaul's color palette + analytics-enrichment's utility functions.
// Composed during M-4 of the 2026-05-11 Rao-stack integration to preserve both intents.

export const COPPER       = "#c2652a";
export const COPPER_LIGHT = "#d4803e";
export const COPPER_BG    = "#fff7ed";
export const BG           = "#f5f5f7";
export const CARD         = "#fff";
export const BORDER       = "#e5e5ea";
export const HEADER_BG    = "#FAF9F5";
export const GREEN        = "#34c759";
export const ORANGE       = "#ff9500";
export const RED          = "#ff3b30";
export const PINK         = "#ff2d55";
export const TEXT         = "#1d1d1f";
export const T2           = "#86868b";
export const T3           = "#aeaeb2";

export const FONT_STACK = "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Type scale used by some admin tools.
export const TYPE = {
  micro: { fontSize: 11, lineHeight: "16px" },
  caption: { fontSize: 12, lineHeight: "18px" },
  body: { fontSize: 13, lineHeight: "20px" },
  title: { fontSize: 16, lineHeight: "22px", fontWeight: 600 },
  heading: { fontSize: 20, lineHeight: "28px", fontWeight: 700 },
} as const;

// ── Utility helpers (from analytics-enrichment PR-A) ──────────────────────────
// Used by the extracted SitePageClient components (ActionSidebar, OverviewTab,
// HeroMetrics, ScorecardTab, etc.). The components are unimported under R1
// integration but TypeScript still compiles their references, so these stay live.

export function scoreColor(s: number): string {
  return s >= 75 ? GREEN : s >= 50 ? ORANGE : RED;
}

export function scoreTier(s: number): "Good" | "Fair" | "Weak" | "Poor" {
  if (s >= 75) return "Good";
  if (s >= 50) return "Fair";
  if (s >= 25) return "Weak";
  return "Poor";
}

export function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
