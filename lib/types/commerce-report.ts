export interface CrawledProduct {
  name: string;
  url: string;
  price: string;
  sku: string;
  category: string;
  description: string;
  attributes: Record<string, string | null>;
  missingAttributes: string[];
  status: "visible" | "partial" | "invisible";
  attributeDensity: number;
}

export interface CatalogSnapshot {
  totalCrawled: number;
  visible: number;
  partial: number;
  invisible: number;
  sampleProducts: CrawledProduct[];
}

export interface EnrichmentField {
  key: string;
  before: string | null;
  after: string;
}

export interface EnrichmentPreview {
  productName: string;
  missingCount: number;
  totalFields: number;
  fields: EnrichmentField[];
}

export interface SimulationProduct {
  name: string;
  price: string;
  reason: string;
}

export interface AgentSimulation {
  title: string;
  query: string;
  products: SimulationProduct[];
  excludedExplanation: string;
}

export interface CommerceSubScore {
  label: string;
  value: number;
  level: "high" | "medium" | "low";
}

export interface CommerceScore {
  overall: number;
  subScores: CommerceSubScore[];
}

export interface CompetitorScore {
  name: string;
  score: number;
  isTarget: boolean;
}

export interface RevenueScenario {
  label: string;
  type: "conservative" | "moderate" | "aggressive";
  totalRevenue: string;
  gmv: string;
  aovUplift: string;
  newCustomers: string;
  assumption: string;
}

export interface RevenueImpact {
  methodology: string;
  scenarios: RevenueScenario[];
  aovInsight: string;
  baseRevenueMillion?: number;
}

export interface AgenticPulseStat {
  label: string;
  value: string;
  source: string;
}

export interface SovGapPlatformResult {
  platform: string;
  mentioned: boolean;
  position: number | null;
  topCompetitor: string | null;
  snippet: string;
}

export interface SovGapQuery {
  query: string;
  platforms: SovGapPlatformResult[];
  brandMentioned: boolean;
}

export interface SovGapData {
  brandSov: number;
  topCompetitorName: string;
  topCompetitorSov: number;
  queries: SovGapQuery[];
}

export interface GapItem {
  label: string;
  value: number;
  description: string;
}

export interface TimelineStep {
  period: string;
  description: string;
}

export interface GapSection {
  items: GapItem[];
  timeline: TimelineStep[];
}

// ─── New L2 Redesign types ───

export interface CompetitorProbeData {
  name: string;
  domain: string;
  platform: string;
  acpStatus: "LIVE" | "BUILDING" | "NONE";
  hasProductFeed: boolean;
  hasAcpEndpoint: boolean;
  l1MentionCount: number;
}

export interface L2Enrichment {
  productName: string;
  before: Record<string, string | null>;
  after: Record<string, string>;
  fieldsBefore: number;
  fieldsAfter: number;
  fieldsTotal: number;
}

export interface L2Simulation {
  buyerQuery: string;
  withAcp: {
    productName: string;
    price: string;
    specs: string[];
    reason: string;
    bundle: {
      items: { name: string; price: string }[];
      total: string;
      aovUpliftPct: string;
    } | null;
  };
  withoutAcp: {
    competitorName: string;
    competitorProduct: string;
    narrative: string;
  };
}

export interface L2Competitors {
  alertType: string;
  alertHtml: string;
  competitors: CompetitorProbeData[];
  merchant: {
    name: string;
    platform: string;
    acpStatus: string;
  };
}

export interface MerchantCurrency {
  code: string;
  symbol: string;
  rate: number;
}

export interface CommerceReportData {
  merchantCurrency?: MerchantCurrency;
  hero: {
    brandName: string;
    vertical: string;
    subtitle: string;
    scenario: string;
  };
  score: CommerceScore;
  verdict: {
    html: string;
    urgencyLevel: string;
  };
  catalog: CatalogSnapshot;
  sovGap: SovGapData | null;
  enrichment: L2Enrichment | null;
  simulation: L2Simulation | null;
  competitors: L2Competitors;
  competitiveInsight: string;
  revenue: RevenueImpact;
  pulse: AgenticPulseStat[];
  gap: GapSection;
  generatedAt: string;

  // Keep old fields for backward compat during transition (nullable)
  simulations?: AgentSimulation[] | null;
}
