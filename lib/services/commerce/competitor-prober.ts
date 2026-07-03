import type { SovResult } from "@/lib/services/commerce/sov-checker";

export interface CompetitorProbeResult {
  name: string;
  domain: string;
  platform: string;
  acpStatus: "LIVE" | "BUILDING" | "NONE";
  hasProductFeed: boolean;
  hasAcpEndpoint: boolean;
  l1MentionCount: number;
}

interface CompetitorInput {
  name: string;
  domain: string;
  mentionCount: number;
}

const PROBE_TIMEOUT = 5000;

async function probeFetch(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        Accept: "text/html,application/json,*/*",
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      redirect: "follow",
    });
    return res;
  } catch {
    return null;
  }
}

function detectPlatform(
  headers: Headers,
  body: string
): string {
  // Shopify
  const shopifyHeaders = ["x-shopid", "x-shopify-stage", "x-sorting-hat-shopid"];
  for (const h of shopifyHeaders) {
    if (headers.get(h)) return "Shopify";
  }
  if (body.includes("cdn.shopify.com") || body.includes("myshopify.com")) return "Shopify";

  // BigCommerce
  if (headers.get("x-bc-store-version") || body.includes("bigcommerce.com")) return "BigCommerce";

  // Magento / Adobe Commerce
  if (
    body.includes("Magento") ||
    body.includes("Adobe Commerce") ||
    body.includes("/static/version") ||
    body.includes("mage/cookies")
  ) return "Magento";

  // WooCommerce
  if (body.includes("wp-content/plugins/woocommerce") || body.includes("woocommerce")) return "WooCommerce";

  // Miva
  if (body.includes("Miva Merchant") || body.includes("mm5/") || body.includes("miva")) return "Miva";

  // NetSuite / SuiteCommerce
  if (body.includes("SuiteCommerce") || body.includes("netsuite.com")) return "NetSuite";

  return "unknown";
}

async function probeCompetitor(competitor: CompetitorInput): Promise<CompetitorProbeResult> {
  const domain = competitor.domain.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const baseUrl = `https://${domain}`;

  // Run all probes in parallel
  const [acpRes, feedRes, homepageRes] = await Promise.all([
    // Probe 1: ACP endpoint
    probeFetch(`${baseUrl}/.well-known/agent-commerce`),
    // Probe 2: Product feed
    probeFetch(`${baseUrl}/products.json`),
    // Probe 3: Homepage for platform detection
    probeFetch(baseUrl),
  ]);

  const hasAcpEndpoint = acpRes?.ok === true;
  const hasProductFeed = feedRes?.ok === true;

  // Detect platform from homepage
  let platform = "unknown";
  let body = "";
  if (homepageRes?.ok) {
    body = await homepageRes.text().catch(() => "");
    platform = detectPlatform(homepageRes.headers, body);
  }

  // If we didn't detect from homepage but feed returned 200, likely Shopify
  if (platform === "unknown" && hasProductFeed) {
    platform = "Shopify";
  }

  // Classification
  let acpStatus: "LIVE" | "BUILDING" | "NONE";
  if (hasAcpEndpoint) {
    acpStatus = "LIVE";
  } else if (platform === "Shopify") {
    acpStatus = "BUILDING";
  } else {
    acpStatus = "NONE";
  }

  return {
    name: competitor.name,
    domain,
    platform,
    acpStatus,
    hasProductFeed,
    hasAcpEndpoint,
    l1MentionCount: competitor.mentionCount,
  };
}

export function extractCompetitorsFromSov(
  sovData: SovResult | null,
  brandName: string
): CompetitorInput[] {
  if (!sovData?.results) return [];

  const mentionMap = new Map<string, { count: number; domain: string }>();

  for (const result of sovData.results) {
    for (const platform of result.platforms) {
      for (const mention of platform.mentions) {
        if (
          mention.mentioned &&
          mention.brand.toLowerCase() !== brandName.toLowerCase()
        ) {
          const existing = mentionMap.get(mention.brand);
          if (existing) {
            existing.count++;
          } else {
            // Try to extract domain from the mention if available
            const domain = (mention as unknown as Record<string, unknown>).domain as string || "";
            mentionMap.set(mention.brand, { count: 1, domain });
          }
        }
      }
    }
  }

  return [...mentionMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([name, data]) => ({
      name,
      domain: data.domain || `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.com`,
      mentionCount: data.count,
    }));
}

export async function probeCompetitors(
  competitors: CompetitorInput[]
): Promise<CompetitorProbeResult[]> {
  if (competitors.length === 0) return [];

  const results = await Promise.allSettled(
    competitors.slice(0, 5).map(probeCompetitor)
  );

  return results
    .filter((r): r is PromiseFulfilledResult<CompetitorProbeResult> => r.status === "fulfilled")
    .map((r) => r.value);
}

export function buildCompetitorAlert(
  probeResults: CompetitorProbeResult[],
  merchantName: string,
  merchantPlatform: string,
  vertical: string,
  productCategory: string
): { alertType: string; alertHtml: string } {
  // Find highest-severity competitor
  const liveCompetitor = probeResults.find((c) => c.acpStatus === "LIVE");
  const buildingCompetitor = probeResults.find((c) => c.acpStatus === "BUILDING");

  if (liveCompetitor) {
    return {
      alertType: "competitor_live",
      alertHtml: `⚠ ${liveCompetitor.name} already has an AI store. When a customer asks ChatGPT for ${productCategory || vertical}, ${liveCompetitor.name} can complete the sale. You can't. Every day you wait, they capture more of your customers.`,
    };
  }

  if (buildingCompetitor) {
    return {
      alertType: "competitor_building",
      alertHtml: `${buildingCompetitor.name} is building an AI store right now. They're on Shopify — AI commerce is rolling out to them automatically. You're on ${merchantPlatform}. It's not coming to you unless you act.`,
    };
  }

  return {
    alertType: "none_live",
    alertHtml: `Nobody in ${vertical} has an AI store yet. The first brand to go live becomes the default recommendation when customers ask AI agents for ${productCategory || vertical}. You have a window — but Shopify merchants get this for free soon.`,
  };
}
