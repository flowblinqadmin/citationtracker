/**
 * signal-extractor.mjs — Extract ranking signals from merchant websites
 *
 * Uses Firecrawl to crawl merchant sites and extract signals that may
 * correlate with AI shopping surface visibility:
 *
 * 1. Schema.org structured data (Product, Organization, LocalBusiness, etc.)
 * 2. Review platform presence (Google Reviews, Trustpilot, BBB, etc.)
 * 3. Content freshness indicators
 * 4. Crawlability signals (robots.txt, llms.txt, sitemap)
 * 5. Technical signals (page speed proxy, mobile-friendly, HTTPS)
 * 6. Content quality signals (word count, FAQ presence, etc.)
 * 7. Social proof signals (social media links, review counts)
 */

// ── Signal categories ────────────────────────────────────────────────────────

export const SIGNAL_CATEGORIES = {
  schema: "Structured Data & Schema.org",
  reviews: "Review Platform Presence",
  freshness: "Content Freshness",
  crawlability: "Crawlability & AI Access",
  technical: "Technical Signals",
  content: "Content Quality",
  social: "Social Proof",
};

// ── Schema.org type detection ────────────────────────────────────────────────

const SCHEMA_TYPES = [
  "Product", "Offer", "AggregateOffer", "AggregateRating", "Review",
  "Organization", "LocalBusiness", "Store", "OnlineStore",
  "BreadcrumbList", "ItemList", "CollectionPage",
  "FAQPage", "HowTo", "Article", "BlogPosting",
  "Brand", "WebSite", "SearchAction", "SiteNavigationElement",
  "ImageObject", "VideoObject",
  "PostalAddress", "GeoCoordinates",
  "MerchantReturnPolicy", "OfferShippingDetails", "ShippingDeliveryTime",
];

const REVIEW_PLATFORMS = [
  { name: "google_reviews", patterns: ["google.com/maps", "g.page", "google reviews", "google business"] },
  { name: "trustpilot", patterns: ["trustpilot.com", "trustpilot"] },
  { name: "bbb", patterns: ["bbb.org", "better business bureau"] },
  { name: "yelp", patterns: ["yelp.com", "yelp reviews"] },
  { name: "shopper_approved", patterns: ["shopperapproved.com", "shopper approved"] },
  { name: "judge_me", patterns: ["judge.me"] },
  { name: "yotpo", patterns: ["yotpo.com", "yotpo"] },
  { name: "bazaarvoice", patterns: ["bazaarvoice.com", "bazaarvoice"] },
  { name: "stamped", patterns: ["stamped.io"] },
  { name: "power_reviews", patterns: ["powerreviews.com", "powerreviews"] },
  { name: "feefo", patterns: ["feefo.com"] },
  { name: "reviews_io", patterns: ["reviews.io"] },
];

// ── Extract signals from crawled page HTML/markdown ──────────────────────────

export function extractSignalsFromPage(url, html, markdown) {
  const lower = (html || "").toLowerCase();
  const md = (markdown || "").toLowerCase();
  const combined = lower + " " + md;

  const signals = {};

  // 1. Schema.org structured data
  signals.schemaTypes = [];
  for (const type of SCHEMA_TYPES) {
    const jsonLdPattern = new RegExp(`"@type"\\s*:\\s*"${type}"`, "gi");
    const microdataPattern = new RegExp(`itemtype="[^"]*${type}"`, "gi");
    const rdfa = new RegExp(`typeof="[^"]*${type}"`, "gi");
    if (jsonLdPattern.test(lower) || microdataPattern.test(lower) || rdfa.test(lower)) {
      signals.schemaTypes.push(type);
    }
  }
  signals.hasProductSchema = signals.schemaTypes.includes("Product");
  signals.hasOfferSchema = signals.schemaTypes.includes("Offer") || signals.schemaTypes.includes("AggregateOffer");
  signals.hasReviewSchema = signals.schemaTypes.includes("Review") || signals.schemaTypes.includes("AggregateRating");
  signals.hasOrgSchema = signals.schemaTypes.includes("Organization") || signals.schemaTypes.includes("LocalBusiness");
  signals.hasFAQSchema = signals.schemaTypes.includes("FAQPage");
  signals.hasBreadcrumbs = signals.schemaTypes.includes("BreadcrumbList");
  signals.hasSearchAction = signals.schemaTypes.includes("SearchAction");
  signals.hasMerchantReturn = signals.schemaTypes.includes("MerchantReturnPolicy");
  signals.hasShippingDetails = signals.schemaTypes.includes("OfferShippingDetails");
  signals.schemaCount = signals.schemaTypes.length;
  signals.schemaScore = Math.min(100, signals.schemaCount * 8); // 0-100 scaled

  // 2. Review platforms
  signals.reviewPlatforms = [];
  for (const platform of REVIEW_PLATFORMS) {
    if (platform.patterns.some(p => combined.includes(p.toLowerCase()))) {
      signals.reviewPlatforms.push(platform.name);
    }
  }
  signals.reviewPlatformCount = signals.reviewPlatforms.length;
  signals.hasAnyReviews = signals.reviewPlatformCount > 0 || signals.hasReviewSchema;

  // Inline review count detection
  const reviewCountMatch = combined.match(/(\d[\d,]*)\s*reviews?/i);
  signals.estimatedReviewCount = reviewCountMatch
    ? parseInt(reviewCountMatch[1].replace(/,/g, ""), 10)
    : 0;

  // Star rating detection
  const ratingMatch = combined.match(/(\d(?:\.\d)?)\s*(?:out of|\/)\s*5\s*(?:stars?)?/i);
  signals.averageRating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

  // 3. Content freshness
  const currentYear = new Date().getFullYear();
  signals.mentionsCurrentYear = combined.includes(String(currentYear));
  signals.mentionsPriorYear = combined.includes(String(currentYear - 1));
  const datePattern = /(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+(\d{4})/gi;
  const dates = [...combined.matchAll(datePattern)].map(m => parseInt(m[1], 10));
  signals.mostRecentYear = dates.length > 0 ? Math.max(...dates) : null;
  signals.freshnessScore = signals.mentionsCurrentYear ? 100 : signals.mentionsPriorYear ? 60 : 20;

  // 4. Crawlability signals
  signals.hasCanonicalTag = lower.includes('rel="canonical"') || lower.includes("rel='canonical'");
  signals.hasMetaDescription = lower.includes('name="description"') || lower.includes("name='description'");
  signals.hasOpenGraph = lower.includes('property="og:');
  signals.hasTwitterCard = lower.includes('name="twitter:');
  signals.noindexPresent = lower.includes('name="robots"') && lower.includes("noindex");

  // 5. Technical signals
  signals.isHTTPS = url.startsWith("https://");
  signals.hasViewport = lower.includes('name="viewport"');
  signals.hasHreflang = lower.includes("hreflang");
  signals.hasAmpVersion = lower.includes("amphtml") || lower.includes("amp-");

  // 6. Content quality
  const wordCount = (markdown || "").split(/\s+/).filter(w => w.length > 0).length;
  signals.wordCount = wordCount;
  signals.hasFAQContent = md.includes("faq") || md.includes("frequently asked") || md.includes("common questions");
  signals.hasComparisonContent = md.includes("vs") || md.includes("compare") || md.includes("alternative");
  signals.hasPricingContent = md.includes("$") || md.includes("price") || md.includes("cost");
  signals.hasShippingInfo = md.includes("shipping") || md.includes("delivery") || md.includes("free shipping");
  signals.hasReturnPolicy = md.includes("return") || md.includes("refund") || md.includes("guarantee");
  signals.contentScore = Math.min(100, Math.round(
    (wordCount > 500 ? 20 : wordCount > 200 ? 10 : 0) +
    (signals.hasFAQContent ? 20 : 0) +
    (signals.hasPricingContent ? 15 : 0) +
    (signals.hasShippingInfo ? 15 : 0) +
    (signals.hasReturnPolicy ? 15 : 0) +
    (signals.hasComparisonContent ? 15 : 0)
  ));

  // 7. Social proof
  signals.hasFacebook = combined.includes("facebook.com") || combined.includes("fb.com");
  signals.hasInstagram = combined.includes("instagram.com");
  signals.hasTwitter = combined.includes("twitter.com") || combined.includes("x.com");
  signals.hasYouTube = combined.includes("youtube.com");
  signals.hasTikTok = combined.includes("tiktok.com");
  signals.socialChannelCount = [
    signals.hasFacebook, signals.hasInstagram, signals.hasTwitter,
    signals.hasYouTube, signals.hasTikTok,
  ].filter(Boolean).length;

  return signals;
}

// ── Extract site-level signals (robots.txt, llms.txt, sitemap) ───────────────

export async function extractSiteLevelSignals(domain) {
  const signals = {};
  const baseUrl = `https://${domain}`;

  // Check robots.txt
  try {
    const res = await fetch(`${baseUrl}/robots.txt`, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const text = await res.text();
      signals.hasRobotsTxt = true;
      signals.robotsTxtLength = text.length;
      signals.blocksGPTBot = text.toLowerCase().includes("gptbot") && text.toLowerCase().includes("disallow");
      signals.blocksCCBot = text.toLowerCase().includes("ccbot") && text.toLowerCase().includes("disallow");
      signals.blocksGoogleBot = /user-agent:\s*\*[\s\S]*?disallow:\s*\//im.test(text) ||
        (text.toLowerCase().includes("googlebot") && text.toLowerCase().includes("disallow: /"));
      signals.blocksPerplexityBot = text.toLowerCase().includes("perplexitybot") && text.toLowerCase().includes("disallow");
      signals.blocksAnthropicBot = text.toLowerCase().includes("anthropic") && text.toLowerCase().includes("disallow");
      signals.allowsAIBots = !signals.blocksGPTBot && !signals.blocksCCBot && !signals.blocksPerplexityBot;
    } else {
      signals.hasRobotsTxt = false;
      signals.allowsAIBots = true; // No robots.txt = allow all
    }
  } catch {
    signals.hasRobotsTxt = null; // Could not check
    signals.allowsAIBots = null;
  }

  // Check llms.txt
  try {
    const res = await fetch(`${baseUrl}/llms.txt`, { signal: AbortSignal.timeout(10_000) });
    signals.hasLlmsTxt = res.ok;
    if (res.ok) {
      const text = await res.text();
      signals.llmsTxtLength = text.length;
    }
  } catch {
    signals.hasLlmsTxt = null;
  }

  // Check sitemap
  try {
    const res = await fetch(`${baseUrl}/sitemap.xml`, { signal: AbortSignal.timeout(10_000) });
    signals.hasSitemap = res.ok;
    if (res.ok) {
      const text = await res.text();
      const urlCount = (text.match(/<loc>/g) || []).length;
      signals.sitemapUrlCount = urlCount;
    }
  } catch {
    signals.hasSitemap = null;
  }

  return signals;
}

// ── Crawl a merchant using Firecrawl and extract signals ─────────────────────

export async function crawlAndExtractSignals(domain) {
  const FIRECRAWL_KEY = process.env.FIRECRAWL_API_KEY;
  if (!FIRECRAWL_KEY) throw new Error("FIRECRAWL_API_KEY required");

  console.log(`  Crawling ${domain}...`);

  // Step 1: Site-level signals (parallel with crawl)
  const siteLevelPromise = extractSiteLevelSignals(domain);

  // Step 2: Crawl top pages using Firecrawl scrape (homepage + a few key pages)
  const pagesToCheck = [
    `https://${domain}`,
    `https://${domain}/about`,
    `https://${domain}/products`,
    `https://${domain}/shop`,
    `https://${domain}/contact`,
  ];

  const pageSignals = [];
  for (const pageUrl of pagesToCheck) {
    try {
      const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FIRECRAWL_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: pageUrl,
          formats: ["markdown", "rawHtml"],
          timeout: 15000,
          onlyMainContent: false,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.data) {
          const signals = extractSignalsFromPage(
            pageUrl,
            data.data.rawHtml || "",
            data.data.markdown || "",
          );
          pageSignals.push({ url: pageUrl, ...signals });
        }
      }
    } catch (e) {
      console.log(`    Failed to crawl ${pageUrl}: ${e.message}`);
    }
    // Rate limit Firecrawl
    await new Promise(r => setTimeout(r, 500));
  }

  // Step 3: Merge page signals into site-level summary
  const siteLevel = await siteLevelPromise;

  // Aggregate: use max/union across pages
  const allSchemaTypes = [...new Set(pageSignals.flatMap(p => p.schemaTypes || []))];
  const allReviewPlatforms = [...new Set(pageSignals.flatMap(p => p.reviewPlatforms || []))];
  const maxWordCount = Math.max(0, ...pageSignals.map(p => p.wordCount || 0));
  const maxReviewCount = Math.max(0, ...pageSignals.map(p => p.estimatedReviewCount || 0));
  const bestRating = pageSignals.map(p => p.averageRating).filter(r => r !== null).sort((a, b) => b - a)[0] || null;
  const maxSchemaScore = Math.max(0, ...pageSignals.map(p => p.schemaScore || 0));
  const maxContentScore = Math.max(0, ...pageSignals.map(p => p.contentScore || 0));
  const maxFreshnessScore = Math.max(0, ...pageSignals.map(p => p.freshnessScore || 0));

  // Boolean OR across pages
  const booleanSignals = {};
  for (const key of [
    "hasProductSchema", "hasOfferSchema", "hasReviewSchema", "hasOrgSchema",
    "hasFAQSchema", "hasBreadcrumbs", "hasSearchAction", "hasMerchantReturn",
    "hasShippingDetails", "hasFAQContent", "hasComparisonContent",
    "hasPricingContent", "hasShippingInfo", "hasReturnPolicy",
    "hasFacebook", "hasInstagram", "hasTwitter", "hasYouTube", "hasTikTok",
    "hasCanonicalTag", "hasMetaDescription", "hasOpenGraph", "hasTwitterCard",
    "hasViewport", "hasHreflang",
  ]) {
    booleanSignals[key] = pageSignals.some(p => p[key]);
  }

  const socialChannelCount = [
    booleanSignals.hasFacebook, booleanSignals.hasInstagram, booleanSignals.hasTwitter,
    booleanSignals.hasYouTube, booleanSignals.hasTikTok,
  ].filter(Boolean).length;

  return {
    domain,
    crawledPages: pageSignals.length,
    ...siteLevel,
    schemaTypes: allSchemaTypes,
    schemaCount: allSchemaTypes.length,
    schemaScore: maxSchemaScore,
    reviewPlatforms: allReviewPlatforms,
    reviewPlatformCount: allReviewPlatforms.length,
    estimatedReviewCount: maxReviewCount,
    averageRating: bestRating,
    freshnessScore: maxFreshnessScore,
    contentScore: maxContentScore,
    maxWordCount,
    socialChannelCount,
    ...booleanSignals,
    pageDetails: pageSignals,
  };
}
