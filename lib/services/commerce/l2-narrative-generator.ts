import type { CrawledProduct, CatalogSnapshot, CommerceScore } from "@/lib/types/commerce-report";
import type { CompetitorProbeResult } from "@/lib/services/commerce/competitor-prober";
import { type CurrencyInfo, USD } from "@/lib/services/commerce/currency-detector";

const SYSTEM_PROMPT = `You are an AI commerce analyst generating a competitive intelligence report for an ecommerce brand. Your report will be read by the brand owner or VP of ecommerce. They are not technical. They understand money, customers, and competitors.

You are working with real data from our audit pipeline. Every product name, price, score, and competitor status below is real — verified by our crawlers and probes. Your job is to interpret this data and generate the narrative sections of the report.

IMPORTANT CONSTRAINTS:
- Never use these words: ACP, endpoint, structured data, schema, infrastructure, protocol, API, JSON, markup, feed, token, webhook, middleware
- Talk about: money, customers, competitors, sales, products, AI shopping agents, ChatGPT, visibility
- PRICE HANDLING: Product prices must be shown in the MERCHANT'S LOCAL CURRENCY — do NOT convert to USD. The merchant currency is specified in the input below. If a price appears in a different denomination (e.g., paise instead of rupees), normalize it first: for INR, if the numeric value is > 5000 for a typical consumer product, divide by 100 (paise → rupees). Then display in the merchant's local currency with the correct symbol. Example: ₹37900 for a baby wash → divide by 100 → ₹379. Show as ₹379.
- ONLY use <strong> tags inside the subtitle.text and verdict.html fields. All other fields must be plain text with NO HTML tags.
- Be specific to this merchant — reference their actual products, their actual competitors, their actual revenue
- Never fabricate: ratings, review counts, inventory levels, certifications, exact weights without basis
- All output must be valid JSON matching the required schema exactly`;

export interface L2NarrativeResult {
  subtitle: {
    text: string;
    scenario: string;
  };
  verdict: {
    html: string;
    urgency_level: string;
  };
  enrichment: {
    product_name: string;
    before: Record<string, string | null>;
    after: Record<string, string>;
    fields_before: number;
    fields_after: number;
    fields_total: number;
  };
  simulation: {
    buyer_query: string;
    with_acp: {
      product_name: string;
      price: string;
      specs: string[];
      reason: string;
      bundle: {
        items: { name: string; price: string }[];
        total: string;
        aov_uplift_pct: string;
      } | null;
    };
    without_acp: {
      competitor_name: string;
      competitor_product: string;
      narrative: string;
    };
  };
  competitive_insight: {
    summary: string;
  };
}

interface NarrativeInput {
  merchantName: string;
  merchantDomain: string;
  vertical: string;
  platform: string;
  revenueEstimate: number;
  missedMonthly: number;
  score: CommerceScore;
  catalog: CatalogSnapshot;
  competitors: CompetitorProbeResult[];
  merchantMentionCount: number;
  currency?: CurrencyInfo;
}

function buildProductBlock(products: CrawledProduct[]): string {
  return products
    .map((p, i) => {
      const available = Object.entries(p.attributes)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}(${v})`)
        .join(", ");

      return `${i + 1}. Name: ${p.name}
   Price: ${p.price}
   SKU: ${p.sku || "not found"}
   Status: ${p.status.toUpperCase()}
   Score: ${p.attributeDensity}/100
   Missing attributes: [${p.missingAttributes.join(", ")}]
   Available: ${available}`;
    })
    .join("\n\n");
}

function buildCompetitorBlock(
  competitors: CompetitorProbeResult[],
  merchantName: string,
  merchantMentionCount: number,
  productCategory: string
): string {
  if (competitors.length === 0) {
    return `No competitor data available from L1 audit.\n\n${merchantName} was mentioned ${merchantMentionCount} time${merchantMentionCount === 1 ? "" : "s"}.`;
  }

  const lines = competitors.map((c) => {
    return `- ${c.name} (${c.domain})
  Mentioned ${c.l1MentionCount} times by AI agents
  Platform: ${c.platform}
  AI Store Status: ${c.acpStatus}${c.acpStatus === "BUILDING" ? " (Shopify native rollout)" : ""}
  Has product feed: ${c.hasProductFeed ? "yes" : "no"}
  Has AI checkout: ${c.hasAcpEndpoint ? "yes" : "no"}`;
  });

  return `When AI agents were asked about ${productCategory}:
${lines.join("\n\n")}

${merchantName} was mentioned ${merchantMentionCount} time${merchantMentionCount === 1 ? "" : "s"}.`;
}

function buildWorstProduct(products: CrawledProduct[]): CrawledProduct {
  const sorted = [...products].sort((a, b) => a.attributeDensity - b.attributeDensity);
  return sorted[0];
}

function buildBestProduct(products: CrawledProduct[]): CrawledProduct {
  const sorted = [...products].sort((a, b) => b.attributeDensity - a.attributeDensity);
  return sorted[0];
}

function buildEnrichmentBeforeBlock(worst: CrawledProduct): string {
  const fields: Record<string, string | null> = {};
  // Include all attributes
  for (const [key, val] of Object.entries(worst.attributes)) {
    fields[key] = val;
  }
  // Add name, price, sku if not in attributes
  if (!fields.name) fields.title = worst.name;
  if (!fields.price) fields.price = worst.price || null;
  if (!fields.sku) fields.sku = worst.sku || null;

  return JSON.stringify(fields, null, 2);
}

function buildUserPrompt(input: NarrativeInput): string {
  const {
    merchantName,
    merchantDomain,
    vertical,
    platform,
    revenueEstimate,
    missedMonthly,
    score,
    catalog,
    competitors,
    merchantMentionCount,
    currency = USD,
  } = input;

  const products = catalog.sampleProducts;
  const worst = buildWorstProduct(products);
  const best = buildBestProduct(products);
  const visibleCount = products.filter((p) => p.status === "visible").length;
  const partialCount = products.filter((p) => p.status === "partial").length;
  const invisibleCount = products.filter((p) => p.status === "invisible").length;
  const total = products.length;
  const visiblePct = Math.round((visibleCount / total) * 100);
  const partialPct = Math.round((partialCount / total) * 100);
  const invisiblePct = Math.round((invisibleCount / total) * 100);

  const productCategory = vertical;

  // Find primary competitor (most mentions)
  const primaryCompetitor = competitors.length > 0
    ? competitors.reduce((a, b) => (a.l1MentionCount > b.l1MentionCount ? a : b))
    : null;

  return `Generate the narrative sections for this AI Commerce Readiness report.

=== MERCHANT ===
Name: ${merchantName}
Domain: ${merchantDomain}
Vertical: ${vertical}
Platform: ${platform}
Merchant Currency: ${currency.code} (symbol: ${currency.symbol}, rate: ${currency.rate} per USD)
Annual Revenue Estimate: $${revenueEstimate.toLocaleString()} USD
Monthly Missed Revenue Estimate: $${missedMonthly.toLocaleString()} USD

=== SCORES ===
Data Readiness: ${score.overall}/100
Infrastructure Readiness: 0/100
Effective Score: 0/100
(Effective = Data × Infra / 100. Zero infra = zero effective.)

Subscores:
${score.subScores.map((s) => `- ${s.label}: ${s.value}%`).join("\n")}

=== ${total} CRAWLED PRODUCTS ===
${buildProductBlock(products)}

Worst-scoring product: ${worst.name} (${worst.attributeDensity}/100)
Best-scoring product: ${best.name} (${best.attributeDensity}/100)

Catalog breakdown:
- ${visiblePct}% visible (${visibleCount}/${total})
- ${partialPct}% partial (${partialCount}/${total})
- ${invisiblePct}% invisible (${invisibleCount}/${total})

=== COMPETITORS (from L1 AI visibility audit) ===
${buildCompetitorBlock(competitors, merchantName, merchantMentionCount, productCategory)}

=== REQUIRED OUTPUT ===
Generate a JSON object with these exact keys:

{
  "subtitle": {
    "text": "2 sentences, 35-50 words. This is the HOOK — emotional, specific, makes them feel the pain. Wrap the dollar amount in <strong> tags. Sentence 1: Name the competitor and the dollar amount (<strong>$${missedMonthly.toLocaleString()}/mo</strong>). Sentence 2: Reference their specific products (use actual product names from the crawl) that are invisible to AI agents. Be vivid — describe what happens when a customer asks ChatGPT and ${merchantName} doesn't show up. Example: '${primaryCompetitor?.name || "Competitors"} is capturing <strong>$${missedMonthly.toLocaleString()}/mo</strong> in AI-driven sales that should be yours — while ${merchantName}\\'s [product], [product], and [product] sit completely invisible to ChatGPT, Perplexity, and every AI shopping agent directing real purchase decisions right now.'",
    "scenario": "competitor_live|competitor_building|competitor_in_sov|no_competitors|site_blocked"
  },

  "verdict": {
    "html": "Exactly 2-3 SHORT sentences with <strong> tags for bold. This is the ANALYSIS — different from the subtitle. DO NOT repeat the subtitle. The subtitle hooks with emotion. The verdict explains the WHY and WHAT TO DO. Sentence 1: Explain what's happening — ${merchantName} has ${catalog.visible} visible products out of ${catalog.totalCrawled}, which means AI agents can only work with X% of the catalog. Sentence 2: Name the gap — competitors like ${primaryCompetitor?.name || "competitors"} are on ${primaryCompetitor?.platform || "Shopify"} where AI commerce is being built in, while ${merchantName} is on ${platform} where it's not coming. Sentence 3: The ask — this is fixable in weeks, not months, and ${merchantName}'s product data is already ${score.overall}% ready. DO NOT repeat dollar amounts from the subtitle. Keep it under 80 words.",
    "urgency_level": "critical|high|moderate"
  },

  "enrichment": {
    "product_name": "${worst.name}",
    "before": ${buildEnrichmentBeforeBlock(worst)},
    "after": {
      "FOR EACH FIELD: provide the enriched value. Must conform to AI commerce product feed spec. For ${vertical}: include vertical-specific fields. If value cannot be determined from context, use 'requires merchant input'. NEVER fabricate ratings or review counts.": "instruction"
    },
    "fields_before": ${Object.values(worst.attributes).filter((v) => v).length},
    "fields_after": 14,
    "fields_total": 14
  },

  "simulation": {
    "buyer_query": "A realistic question a customer would type into ChatGPT. Must be about a product ${merchantName} actually sells — use ${best.name} as context. Must include a specific constraint (budget, vehicle model, skin type, use case). Must be natural language, not generic.",
    "with_acp": {
      "product_name": "${best.name}",
      "price": "Normalize ${best.price} to the merchant's local currency (${currency.code}, symbol ${currency.symbol}). Handle paise if INR. Output with ${currency.symbol} prefix.",
      "specs": ["2-3 real specs from the crawled data above"],
      "reason": "Why this product matches the buyer's query. Reference real attributes.",
      "bundle": {
        "items": [{"name": "real product from the ${total} crawled", "price": "real price from crawl in merchant's local currency (${currency.code}), handle paise normalization if needed"}],
        "total": "bundle total",
        "aov_uplift_pct": "percentage increase vs single product"
      }
    },
    "without_acp": {
      "competitor_name": "${primaryCompetitor?.name || "competitor"}",
      "competitor_product": "plausible competing product name",
      "narrative": "2 sentences. The agent can't see ${merchantName}'s products. It recommends ${primaryCompetitor?.name || "a competitor"} instead. The customer buys there. ${merchantName} never knew they were looking."
    }
  },

  "competitive_insight": {
    "summary": "Exactly 2 sentences. Sentence 1: Name each competitor and their status — who's on Shopify (getting AI commerce automatically), who's ahead in mentions. Sentence 2: What this means for ${merchantName} on ${platform} — they need to act because it won't come to them. No fluff. Under 60 words."
  }
}

CRITICAL: Output valid JSON only. No markdown wrapping. No explanation outside the JSON. The output must parse with JSON.parse() with zero modification.`;
}

async function callAnthropic(userPrompt: string): Promise<L2NarrativeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("No ANTHROPIC_API_KEY");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || "";

  // Strip markdown code fences if present
  const cleaned = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  return JSON.parse(cleaned) as L2NarrativeResult;
}

async function callOpenAIFallback(userPrompt: string): Promise<L2NarrativeResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("No OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      max_completion_tokens: 4000,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  return JSON.parse(text) as L2NarrativeResult;
}

export async function generateL2Narrative(
  input: NarrativeInput
): Promise<L2NarrativeResult> {
  const userPrompt = buildUserPrompt(input);

  // Primary: Claude Sonnet 4.5
  try {
    return await callAnthropic(userPrompt);
  } catch (err) {
    console.error("Anthropic call failed, falling back to OpenAI:", (err as Error).message);
  }

  // Fallback: GPT-4.1
  return await callOpenAIFallback(userPrompt);
}
