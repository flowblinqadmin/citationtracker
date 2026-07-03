// ── Types migrated from ResultsDashboard.tsx ──────────────────────────────────

export interface GeoScore {
  pillar: string;
  pillarName: string;
  score: number;
  findings: string;
  recommendation: string;
  priority: string;
  impactedPages: string[];
}

export interface GeoScorecard {
  overallScore: number;
  pillars: GeoScore[];
  topThreeImprovements: string[];
}

export interface SchemaBlock {
  name: string;
  type: string;
  jsonLd: object;
  instructions: string;
  pageTarget: string;
}

export interface RankedRec {
  rank?: number;
  title: string;
  description?: string;
  impact?: string;
  effort?: string;
  pillar: string;
  specificAction?: string;
  estimatedBoost: string;
  priority: string;
}

export interface DiffData {
  snapshotAt?: string;
  scoreDelta?: number;
  previousScore?: number;
  currentScore?: number;
  previousLlmsTxtLength?: number;
  currentLlmsTxtLength?: number;
}

export interface SiteData {
  id: string;
  domain: string;
  slug?: string;
  pipelineStatus: string | null;
  pipelineError: string | null;
  geoScorecard: unknown;
  executiveSummary: string | null;
  rankedRecommendations?: RankedRec[];
  projectedScore?: number | null;
  projectedBoost?: number | null;
  generatedLlmsTxt: string | null;
  generatedLlmsFullTxt: string | null;
  generatedBusinessJson: unknown;
  generatedSchemaBlocks: unknown;
  discoveryData: unknown;
  platformDetected: string | null;
  pageCount: number;
  manualRunsThisMonth: number | null;
  crawlCount: number | null;
  lastCrawlAt: string | null;
  nextCrawlAt: string | null;
  createdAt: string | null;
  diff?: DiffData | null;
  changeLog?: ChangeLogEntry[] | null;
  domainVerified?: boolean;
  verifyToken?: string | null;
  tier: "free" | "paid";
  credits: number;
  baselineScore: number | null;
  improvementDelta: number | null;
  baselineScorecard?: unknown;
  pillarDeltas?: Array<{
    pillar: string;
    before: number | null;
    after: number;
    delta: number | null;
  }>;
  token: string;
  auditMode?: string | null;
  bulkUrlCount?: number | null;
  perPageResults?: unknown;
  perPageFixes?: unknown;
  implementationStatus?: unknown;
  reportZipUrl?: string | null;
  failedUrls?: string[];
  creditLimitedUrls?: string[];
  crawlData?: unknown;
  citationNarrative?: string | null;
  subscriptionTier?: string | null;
}

export interface ChangeLogEntry {
  runAt: string;
  overallScore: number;
  projectedScore: number;
  crawlQuality: {
    goodPages: number;
    errorPages: number;
    coverageScore: number;
    blockedByAntiBot: boolean;
    usable: boolean;
  };
  pillarScores: Record<string, number>;
}

// ── New types added for ES-062 rebuild ────────────────────────────────────────

export type TabId = "overview" | "competitive" | "action-plan" | "scorecard" | "recommendations" | "pages" | "fix-html" | "history" | "setup";

export interface TeamDomainSwitcherEntry {
  id: string;
  domain: string;
  geoScorecard: { overallScore?: number } | null;
  // Round 3 TS fix (2026-04-10): was `crawlData: { pages?: unknown[] } | null`
  // which cascaded `unknown` into the switcher's JSX map callback and tripped
  // "Type 'unknown' is not assignable to type 'ReactNode'" at the conditional
  // render. The client only ever needs the count, not the actual page array,
  // so this flattens to a plain `pageCount: number`. SSR populates from
  // geo_site_view.page_count which already stores the same value.
  pageCount: number;
}

export interface SiteDataExtended extends SiteData {
  discoveredCompetitors?: import("@/lib/types/citation").DiscoveredCompetitor[];
  userCompetitors?: import("@/lib/types/citation").UserCompetitor[];
  competitorBlocklist?: string[];
  brandKeywords?: unknown;
  extractedCategories?: unknown;
}
