const REVENUE_MIDPOINTS: Record<string, number> = {
  "<$5M": 2_500_000,
  "$5-20M": 12_500_000,
  "$20-50M": 35_000_000,
  "$50-150M": 100_000_000,
  "$150M+": 200_000_000,
};

const CATEGORY_DEFAULTS: Record<string, number> = {
  "auto parts": 25_000_000,
  automotive: 25_000_000,
  powersports: 15_000_000,
  health: 10_000_000,
  supplements: 10_000_000,
  marine: 12_000_000,
  boating: 12_000_000,
  fashion: 20_000_000,
  apparel: 20_000_000,
  home: 15_000_000,
  garden: 15_000_000,
  industrial: 30_000_000,
  b2b: 30_000_000,
};

const DEFAULT_REVENUE = 15_000_000;

export interface RevenueOpportunity {
  low: number;
  high: number;
  gap_percent: number;
  methodology: string;
}

export function calculateRevenueOpportunity(
  overallScore: number,
  revenueEstimate?: string | null,
  category?: string | null
): RevenueOpportunity {
  let annualRevenue = DEFAULT_REVENUE;

  if (revenueEstimate && REVENUE_MIDPOINTS[revenueEstimate]) {
    annualRevenue = REVENUE_MIDPOINTS[revenueEstimate];
  } else if (category) {
    const lower = category.toLowerCase();
    for (const [key, val] of Object.entries(CATEGORY_DEFAULTS)) {
      if (lower.includes(key)) {
        annualRevenue = val;
        break;
      }
    }
  }

  const gapPercent = Math.max(0, 100 - overallScore);
  const aiCommerceRate = 0.01; // 1% of revenue addressable by AI commerce
  const missedOpportunity = annualRevenue * aiCommerceRate * (gapPercent / 100);

  return {
    low: Math.round(missedOpportunity * 0.5),
    high: Math.round(missedOpportunity * 2),
    gap_percent: gapPercent,
    methodology: `Based on ${formatCurrency(annualRevenue)} estimated annual revenue × 1% AI commerce opportunity × ${gapPercent}% visibility gap. Source: Amazon Rufus generating $12B in annualized AI-referred sales.`,
  };
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(0)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount}`;
}

export { formatCurrency };
