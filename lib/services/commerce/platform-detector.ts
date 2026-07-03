export interface PlatformDetectionResult {
  platform: string | null;
  confidence: "high" | "medium" | "low";
  signals: string[];
}

interface PlatformSignature {
  name: string;
  checks: Array<{
    type: "header" | "html" | "meta";
    pattern: RegExp;
    signal: string;
  }>;
}

const PLATFORMS: PlatformSignature[] = [
  {
    name: "Shopify",
    checks: [
      { type: "html", pattern: /cdn\.shopify\.com/i, signal: "Shopify CDN detected" },
      { type: "html", pattern: /Shopify\.theme/i, signal: "Shopify theme JS object" },
      { type: "meta", pattern: /name=["']shopify/i, signal: "Shopify meta tag" },
      { type: "html", pattern: /\/collections\//i, signal: "Shopify collections URL pattern" },
    ],
  },
  {
    name: "Magento",
    checks: [
      { type: "header", pattern: /x-magento/i, signal: "X-Magento response header" },
      { type: "html", pattern: /\/pub\/static\//i, signal: "Magento pub/static path" },
      { type: "html", pattern: /Magento_/i, signal: "Magento JS module reference" },
      { type: "html", pattern: /mage\/cookies/i, signal: "Magento cookie handler" },
      { type: "html", pattern: /\/static\/version/i, signal: "Magento static versioning" },
    ],
  },
  {
    name: "Miva",
    checks: [
      { type: "html", pattern: /mm5\//i, signal: "Miva mm5/ path" },
      { type: "html", pattern: /MivaEvents/i, signal: "MivaEvents JS object" },
      { type: "html", pattern: /Miva_/i, signal: "Miva template reference" },
      { type: "header", pattern: /miva/i, signal: "Miva response header" },
    ],
  },
  {
    name: "BigCommerce",
    checks: [
      { type: "html", pattern: /bigcommerce\.com/i, signal: "BigCommerce reference" },
      { type: "html", pattern: /cdn\d+\.bigcommerce\.com/i, signal: "BigCommerce CDN" },
      { type: "html", pattern: /stencil/i, signal: "BigCommerce Stencil framework" },
    ],
  },
  {
    name: "WooCommerce",
    checks: [
      { type: "html", pattern: /woocommerce/i, signal: "WooCommerce reference" },
      { type: "html", pattern: /wc-block/i, signal: "WooCommerce block" },
      { type: "html", pattern: /wp-content\/plugins\/woocommerce/i, signal: "WooCommerce plugin path" },
      { type: "html", pattern: /\/wp-json\/wc\//i, signal: "WooCommerce REST API" },
    ],
  },
  {
    name: "NetSuite/SuiteCommerce",
    checks: [
      { type: "html", pattern: /netsuite/i, signal: "NetSuite reference" },
      { type: "html", pattern: /SuiteCommerce/i, signal: "SuiteCommerce reference" },
      { type: "html", pattern: /netsuitecdnprod/i, signal: "NetSuite CDN" },
    ],
  },
  {
    name: "Salesforce Commerce Cloud",
    checks: [
      { type: "html", pattern: /demandware/i, signal: "Demandware/SFCC reference" },
      { type: "html", pattern: /dwanalytics/i, signal: "SFCC analytics" },
      { type: "html", pattern: /dw\/shop/i, signal: "SFCC shop path" },
    ],
  },
];

export const PLATFORM_COPY: Record<string, string> = {
  Magento:
    "Great news — Magento stores see the fastest visibility improvements with FlowBlinq. Most go from audit to live in under 15 minutes.",
  Miva:
    "Miva merchants are underrepresented in AI commerce. That's a competitive advantage — you can be first in your category.",
  "NetSuite/SuiteCommerce":
    "NetSuite stores have rich product data that AI agents love, but it's locked behind your ERP. FlowBlinq bridges the gap.",
  BigCommerce:
    "BigCommerce has native AI features, but they don't cover all protocols. FlowBlinq adds ACP, UCP, and MCP coverage.",
  Shopify:
    "Shopify has built-in AI commerce features. FlowBlinq is designed for platforms that don't have native support. You may not need us — but run the audit to be sure.",
  WooCommerce:
    "WooCommerce has plugins for everything — except AI commerce protocols. FlowBlinq fills that gap.",
  "Salesforce Commerce Cloud":
    "SFCC has enterprise-grade infrastructure but limited AI commerce protocol support. FlowBlinq adds the missing layer.",
};

const DEFAULT_PLATFORM_COPY =
  "Custom platforms have the most to gain from AI commerce — and the hardest time getting there alone.";

export function getPlatformCopy(platform: string | null): string {
  if (!platform) return DEFAULT_PLATFORM_COPY;
  return PLATFORM_COPY[platform] || DEFAULT_PLATFORM_COPY;
}

export async function detectPlatform(
  url: string
): Promise<PlatformDetectionResult> {
  const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;

  let html = "";
  let headers: Record<string, string> = {};

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(normalizedUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FlowblinqAudit/1.0)",
        Accept: "text/html",
      },
      redirect: "follow",
    });

    clearTimeout(timeout);

    headers = Object.fromEntries(
      [...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])
    );
    html = await response.text();
  } catch (err) {
    return {
      platform: null,
      confidence: "low",
      signals: [`Failed to fetch: ${(err as Error).message}`],
    };
  }

  const headerString = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  let bestMatch: {
    name: string;
    matchCount: number;
    signals: string[];
  } | null = null;

  for (const platform of PLATFORMS) {
    const matchedSignals: string[] = [];

    for (const check of platform.checks) {
      const source = check.type === "header" ? headerString : html;
      if (check.pattern.test(source)) {
        matchedSignals.push(check.signal);
      }
    }

    if (matchedSignals.length > 0) {
      if (!bestMatch || matchedSignals.length > bestMatch.matchCount) {
        bestMatch = {
          name: platform.name,
          matchCount: matchedSignals.length,
          signals: matchedSignals,
        };
      }
    }
  }

  if (!bestMatch) {
    return {
      platform: null,
      confidence: "low",
      signals: ["No known platform signatures detected"],
    };
  }

  const confidence: "high" | "medium" | "low" =
    bestMatch.matchCount >= 3
      ? "high"
      : bestMatch.matchCount >= 2
        ? "medium"
        : "low";

  return {
    platform: bestMatch.name,
    confidence,
    signals: bestMatch.signals,
  };
}
