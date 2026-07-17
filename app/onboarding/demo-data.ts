// Fictional demo dataset for the onboarding "explore the demo report" panel.
// Entirely invented — no real brand, no fetches. Numbers chosen to read as a
// plausible mid-visibility brand so the demo feels real without overpromising.
export const DEMO_BRAND = "Meridian Coffee";
export const DEMO_DOMAIN = "meridiancoffee.com";

/** Tracked-prompt share: brand vs its named competitors (fractions sum ≈ 1). */
export interface DemoVoiceRow {
  name: string;
  domain: string;
  share: number; // 0..1
  isBrand?: boolean;
}

export const DEMO_VOICE: DemoVoiceRow[] = [
  { name: "Meridian Coffee", domain: "meridiancoffee.com", share: 0.28, isBrand: true },
  { name: "Blue Harbor Roasters", domain: "blueharbor.com", share: 0.24 },
  { name: "Northwind Beans", domain: "northwindbeans.com", share: 0.19 },
  { name: "Copper Kettle Co.", domain: "copperkettle.co", share: 0.15 },
  { name: "Solstice Coffee", domain: "solsticecoffee.io", share: 0.09 },
  { name: "Others", domain: "", share: 0.05 },
];

/** Per-platform coverage: did each engine mention the brand? */
export interface DemoCoverageRow {
  platform: string; // openai | perplexity | google | anthropic
  mentioned: boolean;
  mentionRate: number; // 0..1 across the demo prompts
}

export const DEMO_COVERAGE: DemoCoverageRow[] = [
  { platform: "openai", mentioned: true, mentionRate: 0.62 },
  { platform: "perplexity", mentioned: true, mentionRate: 0.5 },
  { platform: "google", mentioned: false, mentionRate: 0.12 },
  { platform: "anthropic", mentioned: true, mentionRate: 0.38 },
];

/** Top cited sources across the demo run. */
export interface DemoSourceRow {
  page: string;
  domain: string;
  count: number;
  isBrand?: boolean;
  isTracked?: boolean; // a tracked publicity URL that got cited
  platforms: string[];
}

export const DEMO_SOURCES: DemoSourceRow[] = [
  { page: "meridiancoffee.com/about", domain: "meridiancoffee.com", count: 7, isBrand: true, platforms: ["openai", "anthropic"] },
  { page: "roastreview.com/best-single-origin-2026", domain: "roastreview.com", count: 6, isTracked: true, platforms: ["openai", "perplexity", "anthropic"] },
  { page: "blueharbor.com/beans", domain: "blueharbor.com", count: 5, platforms: ["perplexity", "google"] },
  { page: "reddit.com/r/coffee/best-roasters", domain: "reddit.com", count: 4, platforms: ["openai", "google"] },
  { page: "northwindbeans.com/shop", domain: "northwindbeans.com", count: 3, platforms: ["google"] },
];

/** The prompts the demo run covered (8), with per-prompt outcome. */
export const DEMO_PROMPTS = [
  "What is Meridian Coffee?",
  "Is Meridian Coffee a reputable coffee roaster?",
  "What are the best single-origin coffee brands?",
  "Which coffee roasters ship nationwide?",
  "Meridian Coffee vs Blue Harbor Roasters",
  "What are the biggest specialty coffee brands?",
  "Best sustainable coffee brands 2026",
  "How does Meridian Coffee source its beans?",
];

/** The single tracked-URL "cited" row shown as a win. */
export const DEMO_TRACKED_HIT = {
  url: "https://roastreview.com/best-single-origin-2026",
  page: "roastreview.com/best-single-origin-2026",
  citedBy: ["openai", "perplexity", "anthropic"],
  count: 6,
};

export const DEMO_BRAND_MENTION_RATE = 0.41; // across all prompts×platforms
export const DEMO_SOAV = 0.28;
export const DEMO_TOTAL_CITATIONS = 25;
