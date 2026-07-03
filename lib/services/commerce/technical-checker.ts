import { detectPlatform, type PlatformDetectionResult } from "./platform-detector";

export interface TechnicalCheck {
  label: string;
  status: "pass" | "fail" | "warn";
  detail: string;
  duration: number;
}

export interface TechnicalResult {
  checks: TechnicalCheck[];
  summary: { passed: number; warned: number; failed: number; score: number };
  raw: {
    robotsTxt: string | null;
    schemasFound: string[];
    ttfbMs: number;
    hasFeed: boolean;
    hasAcp: boolean;
    hasUcp: boolean;
    hasAiTxt: boolean;
    platformDetected: string | null;
    platformConfidence: string;
    paymentStack: string[];
  };
  platform: PlatformDetectionResult;
}

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; FlowblinqAudit/1.0)",
  Accept: "text/html,application/xhtml+xml,*/*",
};

async function timedFetch(
  url: string,
  timeoutMs = 10000
): Promise<{ ok: boolean; status: number; text: string; ms: number; headers: Headers }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: FETCH_HEADERS,
      redirect: "follow",
    });
    clearTimeout(timer);
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ms: Date.now() - start, headers: res.headers };
  } catch {
    return { ok: false, status: 0, text: "", ms: Date.now() - start, headers: new Headers() };
  }
}

function parseBotDirective(
  robotsTxt: string,
  botName: string
): "allowed" | "blocked" | "no_directive" {
  if (!robotsTxt) return "no_directive";
  const lines = robotsTxt.split("\n").map((l) => l.trim());
  let inBotSection = false;
  let inWildcardSection = false;
  let botResult: "allowed" | "blocked" | null = null;
  let wildcardResult: "allowed" | "blocked" | null = null;

  for (const line of lines) {
    const uaMatch = line.match(/^User-agent:\s*(.+)/i);
    if (uaMatch) {
      const agent = uaMatch[1].trim();
      inBotSection = agent.toLowerCase() === botName.toLowerCase();
      inWildcardSection = agent === "*";
      continue;
    }

    if (inBotSection) {
      if (/^Disallow:\s*\/\s*$/i.test(line)) botResult = "blocked";
      else if (/^Allow:\s*/i.test(line)) botResult = "allowed";
      else if (/^Disallow:\s*$/i.test(line)) botResult = "allowed";
    }

    if (inWildcardSection && !botResult) {
      if (/^Disallow:\s*\/\s*$/i.test(line)) wildcardResult = "blocked";
      else if (/^Allow:\s*/i.test(line)) wildcardResult = "allowed";
    }
  }

  if (botResult) return botResult;
  if (wildcardResult) return wildcardResult;
  return "no_directive";
}

function extractJsonLdTypes(html: string): string[] {
  const types: string[] = [];
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item["@type"]) {
          const t = Array.isArray(item["@type"])
            ? item["@type"]
            : [item["@type"]];
          types.push(...t);
        }
      }
    } catch {
      // malformed JSON-LD
    }
  }
  return types;
}

function detectPaymentStack(html: string): string[] {
  const stacks: string[] = [];
  if (/stripe/i.test(html)) stacks.push("Stripe");
  if (/paypal/i.test(html)) stacks.push("PayPal");
  if (/shop\s?pay|shopify.*pay/i.test(html)) stacks.push("ShopPay");
  if (/braintree/i.test(html)) stacks.push("Braintree");
  if (/square/i.test(html)) stacks.push("Square");
  if (/authorize\.net/i.test(html)) stacks.push("Authorize.net");
  return stacks;
}

const FEED_PATHS = [
  "/feed.xml",
  "/products.json",
  "/sitemap_products.xml",
  "/feeds/products.xml",
  "/product-feed.xml",
  "/feeds/google_shopping.xml",
  "/google-shopping-feed.xml",
];

const ACP_PATHS = [
  "/checkout_sessions",
  "/api/checkout_sessions",
  "/acp/checkout",
];

export async function runTechnicalChecks(
  merchantUrl: string
): Promise<TechnicalResult> {
  const normalizedUrl = merchantUrl.startsWith("http")
    ? merchantUrl
    : `https://${merchantUrl}`;
  const origin = new URL(normalizedUrl).origin;
  const checks: TechnicalCheck[] = [];

  // --- Check 1: DNS + TTFB ---
  const homepageResult = await timedFetch(normalizedUrl, 15000);
  const ttfbMs = homepageResult.ms;

  checks.push({
    label: "DNS Resolution",
    status: homepageResult.ok ? "pass" : "fail",
    detail: homepageResult.ok
      ? `Resolved in ${ttfbMs}ms`
      : `Failed to reach ${normalizedUrl}`,
    duration: ttfbMs,
  });

  // --- Check 2: SSL/TLS ---
  checks.push({
    label: "SSL/TLS Certificate",
    status: normalizedUrl.startsWith("https") && homepageResult.ok ? "pass" : "fail",
    detail:
      normalizedUrl.startsWith("https") && homepageResult.ok
        ? "HTTPS connection successful"
        : "HTTPS not available or failed",
    duration: 0,
  });

  // --- Check 3-6: Bot access ---
  const robotsResult = await timedFetch(`${origin}/robots.txt`, 8000);
  const robotsTxt = robotsResult.ok ? robotsResult.text : null;

  const bots = [
    { name: "GPTBot", label: "GPTBot Access" },
    { name: "Google-Extended", label: "Google-Extended Access" },
    { name: "ClaudeBot", label: "ClaudeBot Access" },
    { name: "PerplexityBot", label: "PerplexityBot Access" },
  ];

  for (const bot of bots) {
    if (!robotsTxt) {
      checks.push({
        label: bot.label,
        status: "warn",
        detail: `No robots.txt found — ${bot.name} access undetermined`,
        duration: robotsResult.ms,
      });
    } else {
      const directive = parseBotDirective(robotsTxt, bot.name);
      checks.push({
        label: bot.label,
        status:
          directive === "allowed"
            ? "pass"
            : directive === "blocked"
              ? "fail"
              : "warn",
        detail:
          directive === "allowed"
            ? `${bot.name}: Allowed`
            : directive === "blocked"
              ? `${bot.name}: Blocked (Disallow: /)`
              : `${bot.name}: No specific directive`,
        duration: robotsResult.ms,
      });
    }
  }

  // --- Check 7: Schema.org JSON-LD ---
  const schemas = extractJsonLdTypes(homepageResult.text);
  const hasProductSchema = schemas.some(
    (t) => t === "Product" || t === "ProductGroup"
  );
  checks.push({
    label: "Schema.org JSON-LD",
    status: hasProductSchema
      ? "pass"
      : schemas.length > 0
        ? "warn"
        : "fail",
    detail: hasProductSchema
      ? `Product schema found (${schemas.join(", ")})`
      : schemas.length > 0
        ? `Found schemas (${schemas.join(", ")}) but no Product type`
        : "No JSON-LD structured data found",
    duration: 0,
  });

  // --- Checks 8-11: UCP, ai.txt, Feed, ACP (parallel) ---
  const [ucpResult, aiTxtResult, ...feedResults] = await Promise.all([
    timedFetch(`${origin}/.well-known/ucp`, 5000),
    timedFetch(`${origin}/ai.txt`, 5000),
    ...FEED_PATHS.map((p) => timedFetch(`${origin}${p}`, 5000)),
  ]);

  // Check 8: UCP
  checks.push({
    label: "UCP Manifest",
    status: ucpResult.ok ? "pass" : "fail",
    detail: ucpResult.ok
      ? "UCP manifest found at /.well-known/ucp"
      : "No UCP manifest (/.well-known/ucp returned 404)",
    duration: ucpResult.ms,
  });

  // Check 9: ai.txt
  checks.push({
    label: "ai.txt",
    status: aiTxtResult.ok ? "pass" : "fail",
    detail: aiTxtResult.ok
      ? "ai.txt found"
      : "No ai.txt file found",
    duration: aiTxtResult.ms,
  });

  // Check 10: Product Feed
  const foundFeed = feedResults.find((r) => r.ok);
  checks.push({
    label: "Product Feed",
    status: foundFeed ? "pass" : "fail",
    detail: foundFeed
      ? `Product feed found`
      : "No product feed detected at common paths",
    duration: feedResults[0]?.ms || 0,
  });

  // Check 11: ACP Endpoints
  const acpResults = await Promise.all(
    ACP_PATHS.map((p) => timedFetch(`${origin}${p}`, 5000))
  );
  const foundAcp = acpResults.find(
    (r) => r.status > 0 && r.status !== 404
  );
  checks.push({
    label: "ACP Checkout Endpoints",
    status: foundAcp ? "pass" : "fail",
    detail: foundAcp
      ? `ACP endpoint responded (status ${foundAcp.status})`
      : "No ACP checkout endpoints found",
    duration: acpResults[0]?.ms || 0,
  });

  // Check 12: TTFB
  checks.push({
    label: "TTFB / Latency",
    status: ttfbMs < 300 ? "pass" : ttfbMs < 500 ? "warn" : "fail",
    detail: `Time to first byte: ${ttfbMs}ms${ttfbMs >= 500 ? " (slow)" : ttfbMs >= 300 ? " (moderate)" : " (fast)"}`,
    duration: ttfbMs,
  });

  // Platform detection
  const platform = await detectPlatform(merchantUrl);
  const paymentStack = detectPaymentStack(homepageResult.text);

  // Summary
  const passed = checks.filter((c) => c.status === "pass").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const score = Math.round((passed / checks.length) * 100);

  return {
    checks,
    summary: { passed, warned, failed, score },
    raw: {
      robotsTxt,
      schemasFound: schemas,
      ttfbMs,
      hasFeed: !!foundFeed,
      hasAcp: !!foundAcp,
      hasUcp: ucpResult.ok,
      hasAiTxt: aiTxtResult.ok,
      platformDetected: platform.platform,
      platformConfidence: platform.confidence,
      paymentStack,
    },
    platform,
  };
}
