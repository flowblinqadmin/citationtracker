import type {
  RevenueImpact,
  RevenueScenario,
  AgenticPulseStat,
} from "@/lib/types/commerce-report";
import { type CurrencyInfo, USD, fmtLocal } from "@/lib/services/commerce/currency-detector";

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
  electronics: 25_000_000,
  beauty: 15_000_000,
  food: 20_000_000,
};

function estimateRevenue(
  revenueEstimate?: string | null,
  category?: string | null
): number {
  if (revenueEstimate && REVENUE_MIDPOINTS[revenueEstimate]) {
    return REVENUE_MIDPOINTS[revenueEstimate];
  }
  if (category) {
    const lower = category.toLowerCase();
    for (const [key, val] of Object.entries(CATEGORY_DEFAULTS)) {
      if (lower.includes(key)) return val;
    }
  }
  return 15_000_000;
}

export function computeRevenueImpact(
  revenueEstimate?: string | null,
  category?: string | null,
  vertical?: string | null,
  currency: CurrencyInfo = USD
): RevenueImpact {
  const annualRevenue = estimateRevenue(revenueEstimate, category);
  const fmt = (usdAmount: number) => fmtLocal(usdAmount, currency);
  const revLabel = fmtLocal(annualRevenue, currency);

  // AOV per customer stays in USD for the customer count estimate
  // (500 USD avg order value assumption)
  const scenarios: RevenueScenario[] = [
    {
      label: "Conservative",
      type: "conservative",
      totalRevenue: fmt(Math.round(annualRevenue * 0.012 * 1.4)),
      gmv: fmt(Math.round(annualRevenue * 0.012)),
      aovUplift: "+40%",
      newCustomers: `~${Math.round((annualRevenue * 0.012) / 500).toLocaleString()}`,
      assumption: "1.2% of revenue shifts to agentic",
    },
    {
      label: "Moderate",
      type: "moderate",
      totalRevenue: fmt(Math.round(annualRevenue * 0.03 * 1.65)),
      gmv: fmt(Math.round(annualRevenue * 0.03)),
      aovUplift: "+65%",
      newCustomers: `~${Math.round((annualRevenue * 0.03) / 500).toLocaleString()}`,
      assumption: "3% of revenue shifts to agentic",
    },
    {
      label: "Aggressive",
      type: "aggressive",
      totalRevenue: fmt(Math.round(annualRevenue * 0.07 * 1.95)),
      gmv: fmt(Math.round(annualRevenue * 0.07)),
      aovUplift: "+95%",
      newCustomers: `~${Math.round((annualRevenue * 0.07) / 500).toLocaleString()}`,
      assumption: "7% of revenue shifts to agentic",
    },
  ];

  const methodology = `Based on ${vertical || "merchant"}'s estimated ${revLabel} annual revenue and current AI commerce growth rates (693% YoY AI-referred traffic, Adobe Analytics 2025).`;

  const aovInsight = `The agent simulation above demonstrates the core economics: AI agents cross-reference your entire catalog for compatibility, generating <strong>intelligent bundle recommendations</strong> that dramatically increase average order value. Human shoppers browse. <strong>AI agents build complete systems.</strong>`;

  return {
    methodology,
    scenarios,
    aovInsight,
    baseRevenueMillion: annualRevenue / 1_000_000,
  };
}

export function computeAgenticPulse(
  annualRevenue?: number,
  currency: CurrencyInfo = USD
): AgenticPulseStat[] {
  const rev = annualRevenue || 15_000_000;
  const missedPerMonth = fmtLocal(Math.round((rev * 0.03) / 12), currency);

  return [
    {
      label: "AI-referred traffic growth",
      value: "693%",
      source: "Adobe Analytics, 2025 Holiday Season",
    },
    {
      label: "AI commerce market size by 2030",
      value: "$5T",
      source: "Gartner, 2025 Agentic Commerce Forecast",
    },
    {
      label: "Consumers who trust AI product recommendations",
      value: "41%",
      source: "Salesforce State of Commerce, 2025",
    },
    {
      label: "Your estimated missed revenue per month",
      value: missedPerMonth,
      source: "Based on your revenue estimate × industry AI commerce rate",
    },
  ];
}
