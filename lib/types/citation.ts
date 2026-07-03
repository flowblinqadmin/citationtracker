export interface ProviderResult {
  provider:        string;
  model:           string;
  visibilityScore: number;   // 0-100: % of queries where brand mentioned
  avgPosition:     number | null;
  sentiment:       "positive" | "neutral" | "negative";
  mentionCount:    number;
  totalQueries:    number;
  samples:         PillarQASample[];  // cited Q&As for this provider (up to 5)
  /**
   * NEW-AI-06: set to true when every indirect query for this provider returned
   * an error (API failure, timeout, etc.). A `visibilityScore` of 0 combined
   * with `noData: true` means "we could not measure" — NOT "brand not cited".
   * Absent / false means a real measurement (including a genuine 0%).
   */
  noData?: boolean;
}

// ── Competitor intelligence (TS-030) ──────────────────────────────────────

export interface DiscoveredCompetitor {
  name: string;       // brand name, e.g. "TikTok"
  domain?: string;    // e.g. "tiktok.com"
  rank: number;       // avg position in AI ranked lists (1 = first)
  mentions: number;   // how many discovery prompts mentioned them
  category: "direct" | "adjacent";
}

export interface UserCompetitor {
  name: string;
  domain?: string;
  addedAt: string; // ISO 8601
}

export interface CompetitorCitationData {
  name: string;
  domain?: string;
  shareOfVoice: number;  // 0-100: % of citation check responses mentioning this competitor
  mentionCount: number;
  rankedAbove: number;   // 0-100: % of co-mention responses where competitor ranked above domain
  sentiment: "positive" | "neutral" | "negative";  // domain's position when both are mentioned
}

// ── Pillar Q&A samples (stored per-pillar in citationCheckScores) ──────────

export interface PillarQASample {
  question:   string;
  answer:     string | null;   // truncated to 2000 chars
  mentioned:  boolean;
  provider:   string;
  sentiment:  string | null;
  // Set on __direct__ samples only — compares AI answer against crawl truth
  accuracyLabel?: "accurate" | "partial" | "inaccurate" | null;
  accuracyNote?:  string | null;  // one-line explanation
}

export interface PillarQA {
  samples:       PillarQASample[];  // up to 2: prefer one mentioned + one not
  topCompetitor: string | null;     // most-mentioned competitor across pillar responses
}

// ── Citation check result (in-memory, returned from runCitationCheck) ─────

export interface CitationCheckResult {
  checkId:         string;
  scores: {
    overallVisibility:    number;   // % of ALL queries where domain mentioned
    indirectVisibility:   number;   // % of indirect queries where domain organically cited  [ES-027]
    brandKnowledge:       number;   // % of direct queries where domain mentioned            [ES-027]
    citationQualityScore: number;   // 0-100 composite across all positive mentions          [ES-027]
    bestProvider:         string | null;
    worstProvider:        string | null;
    avgPosition:          number | null;
    sentimentScore:       number;
    competitorData:       CompetitorCitationData[];  // replaces competitorVisibility [TS-030]
    pillarVisibility:     Record<string, number>;    // topic-based, indirect queries only
    pillarQA:             Record<string, PillarQA>;  // sample Q&A + top competitor per pillar
    // Tier 2-4 fields (TS-057) — optional for backward compat with older SSE payloads
    geoVisibility?:        GeoVisibility[];
    categoryVisibility?:   CategoryVisibility[];
    tierVisibility?:       TierVisibility[];
    avgImpressionShare?:   number | null;
    visibilityGapAnalysis?: VisibilityGapEntry[];
    locationCompetitors?:  LocationCompetitor[];
    categoryCompetitors?:  CategoryCompetitor[];
    dominanceMap?:         DominanceMap | null;
    realPromptDiscovery?:  RealPromptDiscovery[] | null;
    // ES-086 AC-22: set to true when the lazy tree re-extraction is deferred
    // because the per-instance semaphore is saturated. Dashboard reads this
    // flag to show "regenerating dimensional data" hint.
    treeReextractionDeferred?: boolean;
  };
  providerResults: ProviderResult[];
  promptsUsed:     string[];
  creditsUsed:     number;
  promptArchitectureVersion?: number;
}

// ── Citation prompt tier & query type (ES-053 / C4) ──────────────────────────

export type CitationPromptTier = "buy" | "solve" | "learn";
export type CitationQueryType =
  | "definition"
  | "recommendation"
  | "comparison"
  | "evaluation"
  | "how-to"
  | "cost"
  | "landscape"
  | "use-case";

export type CitationPrompt = {
  type:       "indirect" | "direct";
  pillar:     string | null;        // retained for backward compat
  prompt:     string;
  // New fields (C4) — all nullable for backward compat
  geoId?:     string | null;
  categoryId?: string | null;
  tier?:      CitationPromptTier | null;
  queryType?: CitationQueryType | null;
};

// ── ES-054: Tier 2 Measurement Depth types ────────────────────────────────

export type GeoVisibility = {
  geoId: string;
  geoName: string;
  promptCount: number;
  mentionCount: number;
  visibility: number;   // mentionCount / promptCount * 100
};

export type CategoryVisibility = {
  categoryId: string;
  categoryName: string;
  promptCount: number;
  mentionCount: number;
  visibility: number;
};

export type TierVisibility = {
  tier: "buy" | "solve" | "learn";
  promptCount: number;
  mentionCount: number;
  visibility: number;
};

export type VisibilityGapEntry = {
  dimension: "geo" | "category" | "tier";
  id: string;
  name: string;
  visibility: number;
  gap: string;
  recommendation: string;
};

export type CrawlCoverageReport = {
  totalDiscovered: number;
  totalCrawled: number;
  coveragePercent: number;
  missingPageTypes: string[];
  blogPercent: number;
  structuralPercent: number;
  warnings: string[];
};

export type SSEEvent =
  | { type: "start";             data: { message: string } }
  | { type: "stage";             data: { stage: string; progress: number; message: string } }
  | { type: "prompt-generated";  data: { prompt: string; index: number; total: number; pillar: string | null; promptType: "indirect" | "direct" } }
  | { type: "analysis-start";    data: { provider: string; prompt: string; promptIndex: number; totalPrompts: number } }
  | { type: "partial-result";    data: { provider: string; prompt: string; mentioned: boolean; position: number | null; sentiment: string | null } }
  | { type: "analysis-complete"; data: { provider: string; prompt: string; status: "completed" | "failed" } }
  | { type: "progress";          data: { stage: string; progress: number; message: string } }
  | { type: "complete";          data: CitationCheckResult }
  | { type: "error";             data: { message: string } };

export type { CitationCheckScore } from "@/lib/db/schema";

// ── ES-056: Per-Location/Category Competitors ─────────────────────

export type CompetitorEntry = {
  domain: string;
  name: string;
  mentionCount: number;
  shareOfVoice: number;     // % of prompts in this geo/category where competitor appeared
  avgPosition: number;
  rankedAboveBrand: number; // % of co-mentions where competitor ranked higher
};

export type LocationCompetitor = {
  geoId: string;
  geoName: string;
  competitors: CompetitorEntry[];
};

export type CategoryCompetitor = {
  categoryId: string;
  categoryName: string;
  competitors: CompetitorEntry[];
};

// ── ES-056: Dominance Map ─────────────────────────────────────────

export type DominanceEntry = {
  geoId: string | null;       // null = global/all locations
  categoryId: string | null;  // null = all categories
  topBrand: string;           // domain that appeared most
  topBrandSOV: number;
  brandSOV: number;           // our domain's share of voice
  gap: number;                // topBrandSOV - brandSOV
};

export type DominanceMap = {
  entries: DominanceEntry[];
  computedAt: string;         // ISO-8601
  insights?: string[];        // FIX-1: generated by generateDominanceInsights()
};

// ── ES-056: Real Prompt Discovery ─────────────────────────────────

export type RealPromptSource = "paa" | "reddit" | "quora";

export type RealPromptDiscovery = {
  source: RealPromptSource;
  query: string;              // the actual user question
  context: string;            // surrounding text (truncated, 200 chars)
  url: string;                // source URL
};
