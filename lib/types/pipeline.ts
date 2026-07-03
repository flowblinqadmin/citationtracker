/**
 * Shared pipeline types — used by both lib/db/schema.ts and lib/services/*.
 * Keeps schema free of circular imports from service modules.
 */

export interface DiscoveryDataJson {
  urls: string[];
  pageMap: Record<string, string>;
  hasLlmsTxt: boolean;
  hasUcp: boolean;
  hasSitemap: boolean;
  hasRobots: boolean;
  totalPages: number;
  discoveredPages?: number;
  wwwRedirectStatus?: "ok" | "missing" | "unknown";
  sitemapStale?: boolean;
  urlsNotInSitemap?: string[];
  existingLlmsTxt?: string;
  existingUcp?: string;
  [key: string]: unknown;
}

export interface CrawlDataJson {
  domain: string;
  pages: CrawledPageJson[];
  totalCrawled: number;
  failedUrls?: string[];
  creditLimitedUrls?: string[];
  [key: string]: unknown;
}

export interface CrawledPageJson {
  url: string;
  title: string;
  h1: string;
  content: string;
  pageType: string;
  schemaTypes: string[];
  faqContent: { question: string; answer: string }[];
  [key: string]: unknown;
}

export interface GeoScorecardJson {
  overallScore: number;
  pillars: { pillar: string; score: number; findings: string; [key: string]: unknown }[];
  topThreeImprovements: string[];
  [key: string]: unknown;
}

export interface SchemaBlockJson {
  name: string;
  type: string;
  jsonLd: Record<string, unknown>;
  instructions: string;
  pageTarget: string;
}

export interface RankedRecommendationJson {
  rank: number;
  title: string;
  description: string;
  impact: string;
  effort: string;
  pillar: string;
  specificAction: string;
  estimatedBoost: string;
}

export interface ChangeLogEntryJson {
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
}
