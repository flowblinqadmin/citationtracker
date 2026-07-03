import FirecrawlApp from "@mendable/firecrawl-js";
import type { CrawledProduct, CatalogSnapshot } from "@/lib/types/commerce-report";
import { currencyCodeToSymbol } from "@/lib/services/commerce/currency-detector";

const AGENT_CRITICAL_FIELDS = [
  "price",
  "description",
  "category",
  "sku",
  "brand",
  "availability",
  "images",
  "rating",
  "reviews",
  "material",
  "dimensions",
  "weight",
  "warranty",
  "compatibility",
];

const CONCURRENCY = 5;
const TARGET_PRODUCTS = 20;

// ─── URL FILTER: reject non-product pages before extraction ───

function isProductUrl(url: string): boolean {
  const lower = url.toLowerCase();
  const rejectPatterns = [
    '/blog/', '/news/', '/event/', '/events/', '/about/', '/contact/',
    '/category/', '/categories/', '/collections/', '/tags/',
    '/faq/', '/help/', '/support/', '/policy/', '/terms/',
    '/cart/', '/checkout/', '/account/', '/login/', '/register/',
    '/sitemap', '.xml', '.pdf', '/page/', '/author/',
    '/press/', '/media/', '/careers/', '/jobs/',
    '/privacy/', '/shipping/', '/returns/', '/warranty/',
    '/store-locator/', '/dealers/', '/wholesale/',
  ];
  if (rejectPatterns.some(p => lower.includes(p))) return false;

  // Accept URLs that look like product pages
  const productIndicators = [
    '/product/', '/products/', '/p/', '/item/', '/dp/',
    '/shop/', '/buy/', '/sku/',
  ];
  if (productIndicators.some(p => lower.includes(p))) return true;

  // Otherwise include — the extraction step will validate
  return true;
}

// Googlebot user agent — most sites allow this
const BOT_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function scoreProduct(attrs: Record<string, string | null>): {
  status: CrawledProduct["status"];
  density: number;
  missing: string[];
} {
  const missing: string[] = [];
  let filled = 0;

  for (const field of AGENT_CRITICAL_FIELDS) {
    if (attrs[field] && attrs[field]!.trim().length > 0) {
      filled++;
    } else {
      missing.push(field);
    }
  }

  const density = Math.round((filled / AGENT_CRITICAL_FIELDS.length) * 100);
  let status: CrawledProduct["status"];
  if (density >= 70) status = "visible";
  else if (density >= 40) status = "partial";
  else status = "invisible";

  return { status, density, missing };
}

const FIRECRAWL_JSON_SCHEMA = {
  type: "json" as const,
  schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      price: { type: "string" },
      sku: { type: "string" },
      category: { type: "string" },
      brand: { type: "string" },
      description: { type: "string" },
      availability: { type: "string" },
      images: { type: "string" },
      rating: { type: "string" },
      reviews: { type: "string" },
      material: { type: "string" },
      dimensions: { type: "string" },
      weight: { type: "string" },
      warranty: { type: "string" },
      compatibility: { type: "string" },
    },
    required: ["name"],
  },
  prompt: "Extract product data from this page. Return all available product attributes.",
};

// ─── FREE SCRAPER: fetch + parse HTML with bot UA ───

function extractFromHtml(html: string, url: string): Record<string, string | null> {
  const extract: Record<string, string | null> = {};

  // JSON-LD structured data (best source)
  const jsonLdMatches = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (jsonLdMatches) {
    for (const match of jsonLdMatches) {
      try {
        const content = match.replace(/<\/?script[^>]*>/gi, "").trim();
        const data = JSON.parse(content);
        const product = data["@type"] === "Product" ? data : data["@graph"]?.find((d: Record<string, unknown>) => d["@type"] === "Product") || null;
        if (product) {
          extract.name = product.name || null;
          extract.description = product.description || null;
          extract.sku = product.sku || product.mpn || product.gtin13 || null;
          extract.brand = typeof product.brand === "object" ? product.brand?.name : product.brand || null;
          extract.category = product.category || null;
          extract.images = Array.isArray(product.image) ? product.image[0] : product.image || null;
          extract.rating = product.aggregateRating?.ratingValue?.toString() || null;
          extract.reviews = product.aggregateRating?.reviewCount?.toString() || null;
          extract.material = product.material || null;
          extract.weight = product.weight?.value || product.weight || null;
          extract.dimensions = null;
          extract.warranty = null;
          extract.compatibility = null;

          // Price from offers
          const offers = product.offers;
          if (offers) {
            const offer = Array.isArray(offers) ? offers[0] : offers;
            if (offer?.price) {
              const sym = currencyCodeToSymbol(offer.priceCurrency || "USD");
              let rawPrice = parseFloat(String(offer.price));
              // Normalize INR paise: consumer products priced >5000 in INR are likely paise
              if ((offer.priceCurrency === "INR") && rawPrice > 5000) rawPrice = rawPrice / 100;
              extract.price = `${sym}${rawPrice % 1 === 0 ? Math.round(rawPrice).toLocaleString("en-IN") : rawPrice.toFixed(2)}`;
            } else {
              extract.price = null;
            }
            extract.availability = offer?.availability?.replace("https://schema.org/", "") || null;
          }
          break;
        }
      } catch {
        // Invalid JSON-LD, continue
      }
    }
  }

  // Fallback: meta tags + og tags
  if (!extract.name) {
    const ogTitle = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    extract.name = ogTitle?.[1] || titleTag?.[1]?.split(/[|\-–—]/)[0]?.trim() || null;
  }

  if (!extract.description) {
    const metaDesc = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
    const ogDesc = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    extract.description = ogDesc?.[1] || metaDesc?.[1] || null;
  }

  if (!extract.price) {
    const priceMatch = html.match(/["']price["']\s*:\s*["']?([\d.,]+)["']?/i);
    const currencyMatch = html.match(/["']priceCurrency["']\s*:\s*["']([A-Z]{3})["']/i);
    if (priceMatch) {
      const currencyCode = currencyMatch?.[1] || "USD";
      const sym = currencyCodeToSymbol(currencyCode);
      let rawPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
      if (currencyCode === "INR" && rawPrice > 5000) rawPrice = rawPrice / 100;
      extract.price = `${sym}${Math.round(rawPrice).toLocaleString("en-IN")}`;
    }
  }

  if (!extract.images) {
    const ogImage = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    if (ogImage) extract.images = ogImage[1];
  }

  // Set defaults for unfound fields
  for (const field of AGENT_CRITICAL_FIELDS) {
    if (!(field in extract)) extract[field] = null;
  }

  return extract;
}

async function freeScrapeProduct(url: string): Promise<CrawledProduct | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": BOT_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;

    const html = await res.text();
    if (html.length < 500) return null; // Likely a redirect/block page

    const extract = extractFromHtml(html, url);
    if (!extract.name) return null;

    const attrs: Record<string, string | null> = {};
    for (const field of AGENT_CRITICAL_FIELDS) {
      attrs[field] = extract[field] || null;
    }

    const { status, density, missing } = scoreProduct(attrs);

    return {
      name: extract.name!,
      url,
      price: extract.price || "N/A",
      sku: extract.sku || "",
      category: extract.category || "",
      description: extract.description || "",
      attributes: attrs,
      missingAttributes: missing,
      status,
      attributeDensity: density,
    };
  } catch {
    return null;
  }
}

async function freeBatchScrape(urls: string[]): Promise<CrawledProduct[]> {
  const products: CrawledProduct[] = [];
  const batches: string[][] = [];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    batches.push(urls.slice(i, i + CONCURRENCY));
  }

  for (const batch of batches) {
    const results = await Promise.allSettled(batch.map(freeScrapeProduct));
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        products.push(result.value);
      }
    }
  }

  return products;
}

// ─── FIRECRAWL SCRAPER (fallback, costs credits) ───

async function firecrawlBatchScrape(
  firecrawl: FirecrawlApp,
  urls: string[]
): Promise<CrawledProduct[]> {
  const products: CrawledProduct[] = [];
  const batches: string[][] = [];

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    batches.push(urls.slice(i, i + CONCURRENCY));
  }

  for (const batch of batches) {
    const results = await Promise.allSettled(
      batch.map((url) =>
        firecrawl.scrape(url, {
          formats: [FIRECRAWL_JSON_SCHEMA],
        })
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status !== "fulfilled" || !result.value) continue;

      const doc = result.value;
      const extract = (doc.json || {}) as Record<string, string | null>;
      if (!extract || typeof extract !== "object") continue;

      const name = extract.name || `Product ${products.length + 1}`;
      const attrs: Record<string, string | null> = {};

      for (const field of AGENT_CRITICAL_FIELDS) {
        attrs[field] = extract[field] || null;
      }

      const { status, density, missing } = scoreProduct(attrs);

      products.push({
        name,
        url: batch[j],
        price: extract.price || "N/A",
        sku: extract.sku || "",
        category: extract.category || "",
        description: extract.description || "",
        attributes: attrs,
        missingAttributes: missing,
        status,
        attributeDensity: density,
      });
    }
  }

  return products;
}

// ─── SITEMAP PRODUCT URL DISCOVERY (free fallback) ───

async function findProductUrlsFromSitemap(
  merchantUrl: string
): Promise<string[]> {
  const baseUrl = merchantUrl.startsWith("http")
    ? merchantUrl.replace(/\/$/, "")
    : `https://${merchantUrl.replace(/\/$/, "")}`;

  const sitemapCandidates = [
    `${baseUrl}/sitemap.xml`,
    `${baseUrl}/sitemap_products.xml`,
    `${baseUrl}/sitemap-products.xml`,
    `${baseUrl}/product-sitemap.xml`,
    `${baseUrl}/sitemap_index.xml`,
  ];

  const productPatterns = [
    /\/products?\//i,
    /\/shop\//i,
    /\/item\//i,
    /\/p\//i,
    /\/catalog\//i,
    /\/collections?\/[^/]+\/products?\//i,
    /\/dp\//i,
  ];

  for (const sitemapUrl of sitemapCandidates) {
    try {
      const res = await fetch(sitemapUrl, {
        headers: { "User-Agent": BOT_UA },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;

      const xml = await res.text();
      if (xml.length < 100) continue;

      // Check if it's a sitemap index — extract child sitemaps with "product" in the name
      const childSitemapMatches = xml.match(/<loc>([^<]*product[^<]*\.xml[^<]*)<\/loc>/gi);
      if (childSitemapMatches && childSitemapMatches.length > 0) {
        // It's an index — fetch the first product sitemap
        const childUrl = childSitemapMatches[0].replace(/<\/?loc>/g, "");
        try {
          const childRes = await fetch(childUrl, {
            headers: { "User-Agent": BOT_UA },
            signal: AbortSignal.timeout(8000),
          });
          if (childRes.ok) {
            const childXml = await childRes.text();
            const urls = [...childXml.matchAll(/<loc>([^<]+)<\/loc>/g)]
              .map((m) => m[1])
              .filter((u) => !u.endsWith(".xml") && isProductUrl(u));
            if (urls.length >= 3) {
              // Shuffle and take a sample
              const shuffled = urls.sort(() => Math.random() - 0.5);
              return shuffled.slice(0, TARGET_PRODUCTS);
            }
          }
        } catch {
          // Child sitemap fetch failed
        }
      }

      // Extract URLs from the sitemap
      const allUrls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1])
        .filter((u) => !u.endsWith(".xml"));

      // Filter for product-like URLs (apply isProductUrl too)
      const productUrls = allUrls.filter((u) =>
        productPatterns.some((p) => p.test(u)) && isProductUrl(u)
      );

      if (productUrls.length >= 3) {
        const shuffled = productUrls.sort(() => Math.random() - 0.5);
        return shuffled.slice(0, TARGET_PRODUCTS);
      }

      // If no product-pattern URLs but many URLs, take a sample (likely a flat site)
      if (allUrls.length >= 10) {
        const nonHomepage = allUrls.filter(
          (u) => new URL(u).pathname.length > 1 && isProductUrl(u)
        );
        if (nonHomepage.length >= 3) {
          const shuffled = nonHomepage.sort(() => Math.random() - 0.5);
          return shuffled.slice(0, TARGET_PRODUCTS);
        }
      }
    } catch {
      // Sitemap fetch failed, try next
    }
  }

  return [];
}

// ─── FIRECRAWL MAP FALLBACK ───

async function findProductUrlsFromFirecrawlMap(
  merchantUrl: string
): Promise<string[]> {
  const firecrawlKey = process.env.FIRECRAWL_API_KEY;
  if (!firecrawlKey) return [];

  try {
    const firecrawl = new FirecrawlApp({ apiKey: firecrawlKey });
    const result = await firecrawl.map(merchantUrl);

    if (!result.links || result.links.length === 0) {
      return [];
    }

    // Extract URL strings from SearchResultWeb objects
    const allLinks = result.links
      .map((link) => (typeof link === "string" ? link : link.url))
      .filter(Boolean) as string[];

    const productPatterns = [
      /\/products?\//i,
      /\/shop\//i,
      /\/item\//i,
      /\/p\//i,
      /\/catalog\//i,
      /\/dp\//i,
    ];

    const productUrls = allLinks.filter((u) =>
      productPatterns.some((p) => p.test(u)) && isProductUrl(u)
    );

    if (productUrls.length >= 3) {
      return productUrls.slice(0, TARGET_PRODUCTS);
    }

    // Fallback: take non-homepage, non-category links
    const candidates = allLinks.filter((u) => {
      try {
        const path = new URL(u).pathname;
        return path.length > 1 && isProductUrl(u);
      } catch {
        return false;
      }
    });

    return candidates.slice(0, TARGET_PRODUCTS);
  } catch (err) {
    console.error("Firecrawl map failed:", (err as Error).message);
    return [];
  }
}

// ─── PRODUCT URL DISCOVERY (Perplexity, free) ───

async function findTopProductUrls(
  merchantUrl: string,
  brandName: string
): Promise<string[]> {
  const perplexityKey = process.env.PERPLEXITY_API_KEY;
  if (!perplexityKey) {
    console.warn("No PERPLEXITY_API_KEY — skipping product discovery");
    return [];
  }

  try {
    const hostname = new URL(
      merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`
    ).hostname;

    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You are a product research assistant. Return ONLY a JSON array of product page URLs. No explanation, no markdown, just the JSON array.",
          },
          {
            role: "user",
            content: `Find the top 20 most popular or best-selling individual product pages on ${hostname} (${brandName}).
I need the FULL URLs to individual product pages (not category pages, not the homepage).
Look for their best sellers, featured products, top-rated items, or most popular products.
Return exactly a JSON array of URL strings like: ["https://${hostname}/product/example-1", "https://${hostname}/product/example-2"]
Only include URLs from ${hostname}. Return 15-20 URLs.`,
          },
        ],
        max_completion_tokens: 2000,
        temperature: 0.1,
      }),
    });

    if (!res.ok) {
      console.error("Perplexity product discovery failed:", res.status);
      return [];
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";

    const match = content.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const urls = JSON.parse(match[0]) as string[];
    return urls
      .filter((u: string) => {
        try {
          return new URL(u).hostname.includes(hostname.replace("www.", "")) && isProductUrl(u);
        } catch {
          return false;
        }
      })
      .slice(0, TARGET_PRODUCTS);
  } catch (err) {
    console.error("Perplexity product discovery error:", (err as Error).message);
    return [];
  }
}

// ─── MAIN EXPORT ───

export async function crawlCatalog(
  merchantUrl: string,
  brandName?: string
): Promise<{ success: true; data: CatalogSnapshot } | { success: false; error: string }> {
  const normalizedUrl = merchantUrl.startsWith("http")
    ? merchantUrl
    : `https://${merchantUrl}`;

  try {
    // Step 1: Find product URLs (Perplexity → Sitemap → Firecrawl Map)
    console.warn("Step 1a: Finding top products via Perplexity...");
    let productUrls = await findTopProductUrls(
      normalizedUrl,
      brandName || new URL(normalizedUrl).hostname
    );
    console.warn(`Perplexity found ${productUrls.length} URLs`);

    if (productUrls.length < 3) {
      console.warn("Step 1b: Perplexity insufficient, trying sitemap...");
      const sitemapUrls = await findProductUrlsFromSitemap(normalizedUrl);
      console.warn(`Sitemap found ${sitemapUrls.length} URLs`);
      if (sitemapUrls.length > productUrls.length) {
        productUrls = sitemapUrls;
      }
    }

    if (productUrls.length < 3) {
      console.warn("Step 1c: Sitemap insufficient, trying Firecrawl map...");
      const mapUrls = await findProductUrlsFromFirecrawlMap(normalizedUrl);
      console.warn(`Firecrawl map found ${mapUrls.length} URLs`);
      if (mapUrls.length > productUrls.length) {
        productUrls = mapUrls;
      }
    }

    if (productUrls.length < 3) {
      return {
        success: false,
        error: `Could only find ${productUrls.length} product pages for this site. Try a different URL.`,
      };
    }

    console.warn(`Found ${productUrls.length} product URLs total`);

    // Step 2: Try free scraper first (Googlebot UA)
    console.warn("Step 2: Scraping with free scraper (Googlebot UA)...");
    let products = await freeBatchScrape(productUrls);
    console.warn(`Free scraper got ${products.length} products`);

    // Step 3: If free scraper got <50% of URLs, supplement with Firecrawl
    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    if (products.length < productUrls.length * 0.5 && firecrawlKey) {
      console.warn("Free scraper insufficient, supplementing with Firecrawl...");
      const scrapedUrls = new Set(products.map((p) => p.url));
      const remainingUrls = productUrls.filter((u) => !scrapedUrls.has(u));

      if (remainingUrls.length > 0) {
        const firecrawl = new FirecrawlApp({ apiKey: firecrawlKey });
        const firecrawlProducts = await firecrawlBatchScrape(
          firecrawl,
          remainingUrls.slice(0, 10) // Cap at 10 to save credits
        );
        console.warn(`Firecrawl got ${firecrawlProducts.length} additional products`);
        products = [...products, ...firecrawlProducts];
      }
    }

    if (products.length < 3) {
      return {
        success: false,
        error: `Could only extract data from ${products.length} products. The site may be blocking scrapers.`,
      };
    }

    const visible = products.filter((p) => p.status === "visible").length;
    const partial = products.filter((p) => p.status === "partial").length;
    const invisible = products.filter((p) => p.status === "invisible").length;

    const sampleProducts = [
      ...products.filter((p) => p.status === "invisible"),
      ...products.filter((p) => p.status === "partial"),
      ...products.filter((p) => p.status === "visible"),
    ].slice(0, 10);

    return {
      success: true,
      data: {
        totalCrawled: products.length,
        visible,
        partial,
        invisible,
        sampleProducts,
      },
    };
  } catch (err) {
    console.error("Catalog crawl failed:", (err as Error).message);
    return {
      success: false,
      error: "Failed to crawl catalog. The site may be blocking automated access.",
    };
  }
}
