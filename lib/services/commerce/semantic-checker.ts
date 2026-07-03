import OpenAI from "openai";

export interface SemanticResult {
  productUrl: string;
  current: {
    title: string;
    description: string;
    attributeCount: number;
    attributes: string[];
  };
  enriched: {
    title: string;
    description: string;
    attributeCount: number;
    addedAttributes: string[];
    agentVerdictBefore: string;
    agentVerdictAfter: string;
  };
  score: number;
}

async function safeFetch(
  url: string,
  timeoutMs = 10000
): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; FlowblinqAudit/1.0)",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function findProductUrlFromSitemap(sitemapXml: string): string | null {
  const regex = /<loc>([^<]+)<\/loc>/gi;
  let match;
  while ((match = regex.exec(sitemapXml)) !== null) {
    const url = match[1];
    if (/\/products?\/|\/p\/|\/shop\/[^/]+\/[^/]+|\/item\//i.test(url)) {
      return url;
    }
  }
  return null;
}

function findProductUrlFromHtml(html: string, baseUrl: string): string | null {
  const patterns = [
    /href=["'](\/products?\/[^"'#?]+)/gi,
    /href=["'](\/p\/[^"'#?]+)/gi,
    /href=["'](\/shop\/[^"'#?]+)/gi,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      try {
        return new URL(match[1], baseUrl).href;
      } catch {
        continue;
      }
    }
  }
  return null;
}

interface JsonLdProduct {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

function extractProductJsonLd(html: string): JsonLdProduct | null {
  const regex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (
          item["@type"] === "Product" ||
          (Array.isArray(item["@type"]) && item["@type"].includes("Product"))
        ) {
          return item;
        }
      }
    } catch {
      // skip
    }
  }
  return null;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim().slice(0, 200) : "";
}

function extractMetaDescription(html: string): string {
  const match = html.match(
    /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)/i
  );
  return match ? match[1].trim().slice(0, 500) : "";
}

function countAttributes(product: JsonLdProduct): {
  count: number;
  attributes: string[];
} {
  const attributes: string[] = [];
  const skip = new Set(["@context", "@type", "@id"]);

  function walk(obj: Record<string, unknown>, prefix = "") {
    for (const [key, value] of Object.entries(obj)) {
      if (skip.has(key)) continue;
      const label = prefix ? `${prefix}.${key}` : key;
      if (
        value !== null &&
        value !== undefined &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        walk(value as Record<string, unknown>, label);
      } else if (value !== null && value !== undefined && value !== "") {
        attributes.push(label);
      }
    }
  }

  walk(product);
  return { count: attributes.length, attributes };
}

export async function checkSemanticQuality(
  merchantUrl: string
): Promise<SemanticResult> {
  const normalizedUrl = merchantUrl.startsWith("http")
    ? merchantUrl
    : `https://${merchantUrl}`;
  const origin = new URL(normalizedUrl).origin;

  // Find a product page
  const [sitemapXml, homepageHtml] = await Promise.all([
    safeFetch(`${origin}/sitemap.xml`, 8000),
    safeFetch(normalizedUrl, 10000),
  ]);

  let productUrl: string | null = null;
  if (sitemapXml) productUrl = findProductUrlFromSitemap(sitemapXml);
  if (!productUrl && homepageHtml)
    productUrl = findProductUrlFromHtml(homepageHtml, normalizedUrl);

  if (!productUrl) {
    return {
      productUrl: normalizedUrl,
      current: {
        title: "Could not find product page",
        description: "",
        attributeCount: 0,
        attributes: [],
      },
      enriched: {
        title: "",
        description: "",
        attributeCount: 0,
        addedAttributes: [],
        agentVerdictBefore:
          "No product data available. Cannot recommend.",
        agentVerdictAfter:
          "With enriched data, AI agents could confidently recommend your products.",
      },
      score: 0,
    };
  }

  // Fetch and analyze product page
  const productHtml = await safeFetch(productUrl, 10000);
  if (!productHtml) {
    return {
      productUrl,
      current: {
        title: "Could not fetch product page",
        description: "",
        attributeCount: 0,
        attributes: [],
      },
      enriched: {
        title: "",
        description: "",
        attributeCount: 0,
        addedAttributes: [],
        agentVerdictBefore: "Page not accessible. Skipping.",
        agentVerdictAfter: "With accessible, enriched data, AI agents could recommend this product.",
      },
      score: 5,
    };
  }

  const jsonLd = extractProductJsonLd(productHtml);
  const pageTitle = extractTitle(productHtml);
  const pageDescription = extractMetaDescription(productHtml);

  const currentTitle = jsonLd?.name || pageTitle;
  const currentDescription =
    (jsonLd?.description as string) || pageDescription;
  const { count: currentAttrCount, attributes: currentAttrs } = jsonLd
    ? countAttributes(jsonLd)
    : { count: 0, attributes: [] };

  // Use LLM to generate enriched version
  const openai = new OpenAI();
  const completion = await openai.chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.5,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an AI commerce data enrichment expert. Given current product structured data from an e-commerce site, generate what a fully enriched version would look like.

Return JSON:
{
  "enrichedTitle": "Full descriptive title with brand, product type, and primary use case",
  "enrichedDescription": "2-3 sentence description with specific technical specs",
  "currentAttributes": ["list of attribute keys currently present"],
  "addedAttributes": ["list of NEW attribute keys that should be added"],
  "currentAttributeCount": number,
  "enrichedAttributeCount": number,
  "agentVerdictBefore": "What an AI shopping agent would say about this product with current data (skeptical, incomplete)",
  "agentVerdictAfter": "What an AI shopping agent would say with enriched data (confident, specific recommendation)"
}`,
      },
      {
        role: "user",
        content: `Analyze this product and generate enrichment data:

URL: ${productUrl}
Current title: ${currentTitle}
Current description: ${currentDescription?.slice(0, 500)}
Current structured data attributes: ${JSON.stringify(currentAttrs)}
Current attribute count: ${currentAttrCount}`,
      },
    ],
  });

  const enrichment = JSON.parse(
    completion.choices[0].message.content || "{}"
  );

  const enrichedAttrCount = enrichment.enrichedAttributeCount || currentAttrCount * 3;
  const score = Math.min(
    100,
    Math.round((currentAttrCount / Math.max(enrichedAttrCount, 1)) * 100)
  );

  return {
    productUrl,
    current: {
      title: currentTitle,
      description: currentDescription || "",
      attributeCount: currentAttrCount,
      attributes: currentAttrs,
    },
    enriched: {
      title: enrichment.enrichedTitle || currentTitle,
      description: enrichment.enrichedDescription || "",
      attributeCount: enrichedAttrCount,
      addedAttributes: enrichment.addedAttributes || [],
      agentVerdictBefore:
        enrichment.agentVerdictBefore ||
        "Insufficient data to recommend with confidence.",
      agentVerdictAfter:
        enrichment.agentVerdictAfter ||
        "Strong match. Recommending with confidence.",
    },
    score,
  };
}
