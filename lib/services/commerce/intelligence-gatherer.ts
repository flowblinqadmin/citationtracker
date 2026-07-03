/** Map common TLDs and country-code TLDs to region info */
const TLD_REGION_MAP: Record<string, { region: string; country: string; currency: string; currencySymbol: string }> = {
  ".in": { region: "India", country: "IN", currency: "INR", currencySymbol: "₹" },
  ".co.in": { region: "India", country: "IN", currency: "INR", currencySymbol: "₹" },
  ".uk": { region: "United Kingdom", country: "GB", currency: "GBP", currencySymbol: "£" },
  ".co.uk": { region: "United Kingdom", country: "GB", currency: "GBP", currencySymbol: "£" },
  ".ca": { region: "Canada", country: "CA", currency: "CAD", currencySymbol: "CA$" },
  ".au": { region: "Australia", country: "AU", currency: "AUD", currencySymbol: "A$" },
  ".com.au": { region: "Australia", country: "AU", currency: "AUD", currencySymbol: "A$" },
  ".de": { region: "Germany", country: "DE", currency: "EUR", currencySymbol: "€" },
  ".fr": { region: "France", country: "FR", currency: "EUR", currencySymbol: "€" },
  ".it": { region: "Italy", country: "IT", currency: "EUR", currencySymbol: "€" },
  ".es": { region: "Spain", country: "ES", currency: "EUR", currencySymbol: "€" },
  ".nl": { region: "Netherlands", country: "NL", currency: "EUR", currencySymbol: "€" },
  ".br": { region: "Brazil", country: "BR", currency: "BRL", currencySymbol: "R$" },
  ".com.br": { region: "Brazil", country: "BR", currency: "BRL", currencySymbol: "R$" },
  ".mx": { region: "Mexico", country: "MX", currency: "MXN", currencySymbol: "MX$" },
  ".jp": { region: "Japan", country: "JP", currency: "JPY", currencySymbol: "¥" },
  ".co.jp": { region: "Japan", country: "JP", currency: "JPY", currencySymbol: "¥" },
  ".kr": { region: "South Korea", country: "KR", currency: "KRW", currencySymbol: "₩" },
  ".sg": { region: "Singapore", country: "SG", currency: "SGD", currencySymbol: "S$" },
  ".ae": { region: "UAE", country: "AE", currency: "AED", currencySymbol: "AED" },
  ".sa": { region: "Saudi Arabia", country: "SA", currency: "SAR", currencySymbol: "SAR" },
  ".za": { region: "South Africa", country: "ZA", currency: "ZAR", currencySymbol: "R" },
  ".nz": { region: "New Zealand", country: "NZ", currency: "NZD", currencySymbol: "NZ$" },
  ".co.nz": { region: "New Zealand", country: "NZ", currency: "NZD", currencySymbol: "NZ$" },
  ".se": { region: "Sweden", country: "SE", currency: "SEK", currencySymbol: "kr" },
  ".no": { region: "Norway", country: "NO", currency: "NOK", currencySymbol: "kr" },
  ".dk": { region: "Denmark", country: "DK", currency: "DKK", currencySymbol: "kr" },
  ".ch": { region: "Switzerland", country: "CH", currency: "CHF", currencySymbol: "CHF" },
};

export function detectRegionFromUrl(url: string): { region: string; country: string; currency: string; currencySymbol: string } | null {
  try {
    const hostname = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.toLowerCase();
    // Check longer TLDs first (e.g. .co.in before .in)
    const sortedTlds = Object.keys(TLD_REGION_MAP).sort((a, b) => b.length - a.length);
    for (const tld of sortedTlds) {
      if (hostname.endsWith(tld)) {
        return TLD_REGION_MAP[tld];
      }
    }
    return null; // .com or unrecognized TLD — let Perplexity figure it out
  } catch {
    return null;
  }
}

export interface IntelligenceResult {
  merchant: {
    brandName: string;
    vertical: string;
    targetCustomer: string;
    coreCategorySummary: string;
    pricePositioning: string;
    primaryMarkets: string[];
  };
  queries: Array<{
    query: string;
    intent: string;
    whyItMatters: string;
  }>;
  verticalInsights: {
    keyPurchaseFactors: string[];
    dataComplexity: string;
    competitiveIntensity: string;
  };
  competitors: Array<{
    brandName: string;
    reason: string;
  }>;
  crawlSummary: {
    title: string;
    metaDescription: string;
    categories: string[];
    sampleProducts: string[];
    priceRange: string;
    productCount: number;
  };
}

const CRAWL_SYSTEM_PROMPT = `You are a merchant intelligence extractor. Given a URL, browse the website and return a structured JSON object. Be concise and factual. Do not explain your reasoning.

Extract the following:

{
  "brand_name": "string — the brand's name",
  "vertical": "string — one of: apparel, footwear, beauty, home_goods, electronics, automotive_parts, sporting_goods, food_beverage, jewelry, pet, healthcare, financial_services, hospitality, professional_services, software, education, other",
  "target_customer": "string — one sentence max (e.g. 'budget-conscious millennial women aged 18-35')",
  "price_positioning": "string — one of: budget, mid_market, premium, luxury",
  "top_markets": ["string", "string", "string"],
  "product_categories": ["string"],
  "sample_products": ["string"],
  "price_range": {
    "currency": "string — ISO 4217 code (e.g. USD, CAD, INR)",
    "min": number,
    "max": number
  },
  "competitors": ["string"]
}

Rules:
- Return only valid JSON. No markdown, no explanation, no preamble.
- If a field cannot be determined with confidence, use null.
- Infer markets from: domain TLD, currency displayed, shipping destination copy, hreflang tags, or language toggles.
- Competitors must be brands in the same vertical and price tier — not generic answers like "Amazon" unless the merchant is a marketplace.
- product_categories should reflect how the merchant organizes their catalog, not generic taxonomy.
- sample_products should be real product names or service names visible on the site, not category labels.
- Ensure that you are completely grounded and precise in your answers.
- Ensure competitors are indeed within the same price range, operate in the same market and provide similar products or services.
- competitors: minimum 3, maximum 5.

Examples:

Input: https://www.caudalie.com
{"brand_name":"Caudalie","vertical":"beauty","target_customer":"health-conscious women aged 30-55 seeking premium natural skincare with French heritage","price_positioning":"premium","top_markets":["France","United States","United Kingdom"],"product_categories":["Skincare","Body Care","Haircare","Sets & Gifts"],"sample_products":["Vinoperfect Radiance Serum","Premier Cru The Cream","Vinosource-Hydra S.O.S Thirst-Quenching Serum","Resveratrol-Lift Instant Firming Serum"],"price_range":{"currency":"USD","min":18,"max":320},"competitors":["Tatcha","Drunk Elephant","Clarins","Sisley Paris"]}

Input: https://www.revzilla.com
{"brand_name":"RevZilla","vertical":"automotive_parts","target_customer":"motorcycle enthusiasts aged 25-50 seeking gear, parts, and accessories across all riding styles","price_positioning":"mid_market","top_markets":["United States","Canada","Australia"],"product_categories":["Helmets","Jackets & Apparel","Motorcycle Parts","Luggage & Bags","Boots & Gloves"],"sample_products":["Shoei RF-1400 Helmet","Alpinestars Missile V2 Leather Jacket","Kriega R35 Backpack","Dainese Torque 3 Out Boots"],"price_range":{"currency":"USD","min":15,"max":1800},"competitors":["Cycle Gear","BikeBandit","Motosport","Twisted Throttle"]}

Input: https://www.myprotein.com
{"brand_name":"Myprotein","vertical":"sporting_goods","target_customer":"fitness-focused men and women aged 18-35 seeking affordable sports nutrition and activewear","price_positioning":"budget","top_markets":["United Kingdom","United States","Germany"],"product_categories":["Protein & Supplements","Vitamins & Wellness","Activewear","Snacks & Foods"],"sample_products":["Impact Whey Protein","Creatine Monohydrate","THE Pre-Workout","Pro Layer Shorts","High Protein Brownie"],"price_range":{"currency":"GBP","min":2,"max":85},"competitors":["Bulk","PhD Nutrition","Optimum Nutrition","Huel"]}`;

async function queryPerplexity(url: string): Promise<string> {
  if (!process.env.PERPLEXITY_API_KEY)
    throw new Error("No PERPLEXITY_API_KEY");

  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "system", content: CRAWL_SYSTEM_PROMPT },
        { role: "user", content: url },
      ],
      max_completion_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Perplexity API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

async function queryOpenAI(prompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("No OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: `You generate realistic purchase queries that real humans type into AI shopping assistants like ChatGPT, Claude, and Gemini. You write like a normal person — casual, conversational, with natural phrasing. Return ONLY valid JSON, no markdown fences, no extra text.`,
        },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 1500,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function extractJSON(text: string): string {
  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Try to find JSON object
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    return text.slice(braceStart, braceEnd + 1);
  }
  return text;
}

export async function gatherIntelligence(
  merchantUrl: string,
  merchantName: string
): Promise<IntelligenceResult> {
  const normalizedUrl = merchantUrl.startsWith("http")
    ? merchantUrl
    : `https://${merchantUrl}`;

  // ── Step 1: Perplexity crawls the site (live web access) ──
  const rawCrawl = await queryPerplexity(normalizedUrl);
  const crawlJson = extractJSON(rawCrawl);

  const fallback = {
    merchant: {
      brandName: merchantName,
      vertical: "Unknown",
      targetCustomer: "Unknown",
      coreCategorySummary: `Store at ${normalizedUrl}`,
      pricePositioning: "mid-range",
      primaryMarkets: [],
    },
    queries: [
      { query: `best ${merchantName} alternatives`, intent: "broad_discovery", whyItMatters: "Tests basic brand awareness" },
      { query: `where to find products like ${merchantName}`, intent: "broad_discovery", whyItMatters: "Tests category visibility" },
    ],
    verticalInsights: { keyPurchaseFactors: [], dataComplexity: "medium", competitiveIntensity: "medium" },
    competitors: [],
    crawlSummary: { title: merchantName, metaDescription: "", categories: [], sampleProducts: [], priceRange: "Unknown", productCount: 0 },
  };

  let crawlData: Record<string, unknown>;
  try {
    crawlData = JSON.parse(crawlJson);
  } catch {
    console.error("Failed to parse Perplexity crawl response:", rawCrawl.slice(0, 500));
    return fallback;
  }

  // Map flat schema → internal shape
  const priceRange = crawlData.price_range as { currency?: string; min?: number; max?: number } | null;
  const priceRangeStr = priceRange
    ? `${priceRange.currency || ""} ${priceRange.min ?? ""}–${priceRange.max ?? ""}`.trim()
    : "Unknown";

  const rawCompetitors = (crawlData.competitors as string[] | null) || [];
  const competitors = rawCompetitors.map((name: string) => ({ brandName: name, reason: "" }));

  const categories = (crawlData.product_categories as string[] | null) || [];
  const sampleProducts = (crawlData.sample_products as string[] | null) || [];
  const topMarkets = (crawlData.top_markets as string[] | null) || [];

  const merchant = {
    brandName: (crawlData.brand_name as string) || merchantName,
    vertical: (crawlData.vertical as string) || "Unknown",
    targetCustomer: (crawlData.target_customer as string) || "Unknown",
    coreCategorySummary: categories.slice(0, 3).join(", ") || `Store at ${normalizedUrl}`,
    pricePositioning: (crawlData.price_positioning as string) || "mid-range",
    primaryMarkets: topMarkets,
  };
  if (!merchant.primaryMarkets) merchant.primaryMarkets = [];

  const verticalInsights = { keyPurchaseFactors: [], dataComplexity: "medium" as const, competitiveIntensity: "medium" as const };

  const crawlSummary = {
    title: merchant.brandName,
    metaDescription: "",
    categories,
    sampleProducts,
    priceRange: priceRangeStr,
    productCount: 0,
  };

  // ── Step 2: ChatGPT generates natural human queries from crawl data ──
  const primaryMarket = merchant.primaryMarkets[0] || "United States";
  const queryPrompt = `You are a real person shopping online in ${primaryMarket}. Based on the store info below, generate exactly 8 purchase queries you'd type into ChatGPT or Claude when looking for products like these.

STORE CONTEXT:
- Brand: ${merchant.brandName}
- Sells: ${merchant.coreCategorySummary}
- Vertical: ${merchant.vertical}
- Target customer: ${merchant.targetCustomer}
- Categories: ${(crawlSummary.categories || []).join(", ")}
- Sample products: ${(crawlSummary.sampleProducts || []).join(", ")}
- Primary market: ${primaryMarket}
- Price range: ${crawlSummary.priceRange}

RULES:
1. NEVER mention the brand name "${merchant.brandName}" or any of its proprietary product names (${(crawlSummary.sampleProducts || []).slice(0, 5).join(", ")}). Use generic product TYPES instead — e.g. "peptide lip balm" not "Peptide Lip Treatment", "ceramide face essence" not "Glazing Milk"
2. EVERY query MUST include "${primaryMarket}" naturally — you live in ${primaryMarket}. For the US, say "in the US" not "in United States". For India, say "in India". Use natural phrasing.
3. Write EXACTLY like a real human typing into ChatGPT — lowercase ok, casual, slightly messy. Real people don't write "best daily cleanser for glowing skin" — they write "good face wash that actually makes my skin glow?"
4. Max 20 words per query
5. Be SPECIFIC to the product types this store sells — not generic skincare/beauty queries. Reference specific features like ingredients, textures, formats from the categories.
6. ONE need per query, not a shopping list

DISTRIBUTION:
- 3 discovery queries: "best [product type] for [use case] in ${primaryMarket}"
- 2 specific product queries: "[product type] with [specific ingredient/feature] in ${primaryMarket}"
- 2 buying scenario queries: "I need [product type] for [situation], in ${primaryMarket}"
- 1 category landscape query: "best [stores/brands] for [category] in ${primaryMarket}"

Return JSON:
{
  "queries": [
    {
      "query": "the actual query text",
      "intent": "discovery | product_search | use_case | category_landscape",
      "whyItMatters": "why this tests the brand's AI visibility"
    }
  ]
}`;

  let queries: IntelligenceResult["queries"] = [];
  try {
    const rawQueries = await queryOpenAI(queryPrompt);
    const queriesJson = extractJSON(rawQueries);
    const parsed = JSON.parse(queriesJson);
    queries = parsed.queries || [];
  } catch (err) {
    console.error("ChatGPT query generation failed:", (err as Error).message);
    // Fallback: basic queries with region
    queries = [
      { query: `best ${merchant.vertical} products in ${primaryMarket}`, intent: "discovery", whyItMatters: "Tests basic category visibility" },
      { query: `where to buy ${(crawlSummary.categories?.[0] || "products").toLowerCase()} online in ${primaryMarket}`, intent: "discovery", whyItMatters: "Tests purchase intent visibility" },
    ];
  }

  return {
    merchant,
    queries,
    verticalInsights,
    competitors,
    crawlSummary,
  };
}
