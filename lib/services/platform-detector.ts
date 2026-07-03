export type Platform =
  | "shopify"
  | "woocommerce"
  | "magento"
  | "bigcommerce"
  | "miva"
  | "netsuite"
  | "wordpress"
  | "webflow"
  | "ghost"
  | "hubspot"
  | "wix"
  | "squarespace"
  | "framer"
  | "custom"
  | "unknown";

interface PlatformSignature {
  platform: Platform;
  patterns: string[];
  headerPatterns?: string[];
}

const PLATFORM_SIGNATURES: PlatformSignature[] = [
  // Ecommerce platforms
  {
    platform: "shopify",
    patterns: ["cdn.shopify.com", "myshopify.com", "shopify-analytics", "Shopify.theme"],
    headerPatterns: ["x-shopify-stage", "x-shopid"],
  },
  {
    platform: "woocommerce",
    patterns: ["woocommerce", "wc-blocks", "/wp-content/plugins/woocommerce"],
  },
  {
    platform: "magento",
    patterns: ["mage/", "Magento_", "X-Magento", "/static/version"],
    headerPatterns: ["x-magento-cache-id", "x-magento-tags"],
  },
  {
    platform: "bigcommerce",
    patterns: ["bigcommerce.com", "cdn11.bigcommerce.com", "bigcommerce-analytics"],
    headerPatterns: ["x-bc-storefront"],
  },
  {
    platform: "miva",
    patterns: ["mivamerchant", "miva-js", "mmt-merchant"],
  },
  {
    platform: "netsuite",
    patterns: ["netsuite.com", "NetSuite.com", "nlcorp.app.netsuite"],
    headerPatterns: ["ns-proxy"],
  },
  // CMS / Website platforms
  {
    platform: "wordpress",
    patterns: [
      "wp-content",
      "wp-includes",
      "wp-json",
      "/wp-login.php",
      "wordpress.org",
    ],
  },
  {
    platform: "webflow",
    patterns: [
      "webflow.com",
      "webflow.js",
      "data-wf-page",
      "data-wf-site",
      "wf-form",
    ],
  },
  {
    platform: "ghost",
    patterns: [
      "ghost.io",
      "ghost-sdk",
      "ghost-api",
      "content/ghost",
      "data-ghost",
    ],
  },
  {
    platform: "hubspot",
    patterns: [
      "hs-scripts.com",
      "hubspot.com",
      "hs-analytics",
      "hbspt",
      "hs-cta",
    ],
  },
  {
    platform: "wix",
    patterns: [
      "wix.com",
      "wixstatic.com",
      "wix-thunderbolt",
      "_wixCIDX",
    ],
  },
  {
    platform: "squarespace",
    patterns: [
      "squarespace.com",
      "sqsp",
      "squarespace-cdn",
      "sqs-video",
    ],
  },
  {
    platform: "framer",
    patterns: [
      "framer.com",
      "framerusercontent.com",
      "framer-motion",
    ],
  },
];

export async function detectPlatform(url: string): Promise<Platform> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "FlowBlinqGEO/1.0 (platform-detection)" },
    });

    clearTimeout(timeoutId);

    const html = await response.text();
    const headerStr = JSON.stringify(Object.fromEntries(response.headers.entries())).toLowerCase();
    const content = html.toLowerCase();

    for (const sig of PLATFORM_SIGNATURES) {
      const contentMatch = sig.patterns.some((p) =>
        content.includes(p.toLowerCase())
      );
      const headerMatch = sig.headerPatterns?.some((p) =>
        headerStr.includes(p.toLowerCase())
      ) ?? false;

      if (contentMatch || headerMatch) {
        return sig.platform;
      }
    }

    return "unknown";
  } catch {
    return "unknown";
  }
}

export function classifySiteType(platform: Platform): "ecommerce" | "content" | "saas" | "unknown" {
  const ecommercePlatforms: Platform[] = ["shopify", "woocommerce", "magento", "bigcommerce", "miva", "netsuite"];
  const contentPlatforms: Platform[] = ["wordpress", "ghost", "hubspot"];
  const noCodePlatforms: Platform[] = ["webflow", "wix", "squarespace", "framer"];

  if (ecommercePlatforms.includes(platform)) return "ecommerce";
  if (contentPlatforms.includes(platform)) return "content";
  if (noCodePlatforms.includes(platform)) return "saas";
  return "unknown";
}
