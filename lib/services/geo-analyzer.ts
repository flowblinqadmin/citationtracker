import { z } from "zod";
import type { CrawlData, DiscoveryData } from "./geo-crawler";
import { selectInventoryPages } from "./tree-extractor";
import type { CompetitiveIntel } from "./competitive-intel";
import type { GeoTree, GeoNode } from "@/lib/types/trees";
import { sanitizeForPrompt } from "@/lib/utils/sanitize-for-prompt";
import type { ContentStrategyReport } from "@/lib/types/content-strategy";
import { isLocalLLM, openAILikeBaseUrl, resolveOpenAIModel, openAIApiKey } from "@/lib/llm/openai-route";

const GeoScoreSchema = z.object({
  pillar: z.string(),
  pillarName: z.string(),
  score: z.number().min(0).max(100),
  findings: z.string(),
  recommendation: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
  impactedPages: z.array(z.string()).default([]),
});

const GeoScorecardSchema = z.object({
  overallScore: z.number().min(0).max(100),
  pillars: z.array(GeoScoreSchema),
  topThreeImprovements: z.array(z.string()).default([]),
});

// Char threshold for the (legacy) Flash→Pro upgrade. Both tiers now point at
// gemini-3.5-flash: 2026-06-10 model modernization. There is no STABLE Gemini
// 3.x Pro (3.x pro is preview-only and gemini-3-pro-preview now 404s), and
// 3.5-flash is frontier-class ("most intelligent for sustained performance")
// AND ~2× faster than the old 2.5-pro in JSON mode — strictly better for the
// timeout-bound large crawls the Pro tier existed to serve. The threshold +
// GEMINI_PRO_CHAR_LIMIT backstop are retained so a real Pro tier can be
// re-introduced cheaply once a stable Gemini 3.x Pro ships. Both share the same
// 1M-token (~4M char) window.
const FLASH_CHAR_LIMIT = 600_000;
const GEMINI_FLASH_MODEL = "gemini-3.5-flash";  // 1M token context, frontier-class, fast
const GEMINI_PRO_MODEL = "gemini-3.5-flash";    // large-crawl tier — same frontier model (see note above)

// FIX-025: Hard upper bounds so the "whole crawl in one Gemini call" prompt
// cannot silently overflow the model context window on large (Pro-tier) crawls.
// MAX_ANALYZER_PAGES caps how many pages are serialized into the prompt (the
// deterministic geographic scoring below still sees the full crawl).
// GEMINI_PRO_CHAR_LIMIT is a loud backstop assertion sized under Gemini 2.5
// Pro's 1,048,576-token (~4M char at ~4 chars/token) input window: 3.6M chars
// ≈ 900k tokens, leaving ~150k tokens of headroom for tokenization variance.
// (Both Flash and Pro share the same 1M-token window; the Flash→Pro switch above
// is for reasoning strength on large crawls, not extra context room.) Without
// these, a large crawl overflows the window and the model silently truncates the
// tail of the input — corrupting scores with no error.
const MAX_ANALYZER_PAGES = 200;
const GEMINI_PRO_CHAR_LIMIT = 3_600_000;

async function callGemini(prompt: string, systemInstruction?: string): Promise<string> {
  // Local LLM short-circuit: route through OpenAI-compatible gateway (LM Studio / gemma)
  // when LLM_LOCAL=1 so the full pipeline can run without Gemini credentials.
  if (isLocalLLM()) {
    const messages: Array<{ role: string; content: string }> = [];
    if (systemInstruction) messages.push({ role: "system", content: systemInstruction });
    messages.push({ role: "user", content: prompt });

    const res = await fetch(`${openAILikeBaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openAIApiKey()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: resolveOpenAIModel("gemini-3.5-flash"),
        // 32768 mirrors the prod budget below — gemma (the local reasoning model)
        // spends thinking tokens from the same allowance, so 16000 starved the
        // visible JSON in local prod-sim runs (same failure class as the live
        // gemini-2.5 incident). Keep them in lockstep.
        max_completion_tokens: 32768,
        messages,
      }),
    });
    const data = await res.json() as { choices?: { message: { content: string } }[]; error?: { message: string } };
    if (!res.ok) throw new Error(`[geo-analyzer] Local LLM error (${res.status}): ${data.error?.message}`);
    return data.choices?.[0]?.message?.content ?? "";
  }

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!geminiKey) throw new Error("[geo-analyzer] GEMINI_API_KEY not set");

  // FIX-025: Loud guard against silent context-window overflow. Gemini 2.5 Pro's
  // 1,048,576-token (~4M char) input window is the ceiling; once the assembled
  // prompt exceeds GEMINI_PRO_CHAR_LIMIT (set below that window with headroom) the
  // model silently truncates the tail of the input, corrupting scores with no
  // thrown error. Surface it loudly so it can be alerted on rather than failing
  // invisibly. analyzeGeoGaps caps pages before assembly, so this is a backstop
  // that should not fire in practice.
  if (prompt.length > GEMINI_PRO_CHAR_LIMIT) {
    console.error(
      `[geo-analyzer] Prompt is ${Math.round(prompt.length / 1000)}k chars, EXCEEDING the ${Math.round(GEMINI_PRO_CHAR_LIMIT / 1000)}k-char Gemini Pro budget. The model will truncate input and scores may be unreliable — investigate oversized per-page schema/content.`,
    );
  }

  const model = prompt.length > FLASH_CHAR_LIMIT ? GEMINI_PRO_MODEL : GEMINI_FLASH_MODEL;
  console.warn(`[geo-analyzer] Using ${model} (prompt ${Math.round(prompt.length / 1000)}k chars / ~${Math.round(prompt.length / 4000)}k tokens)`);

  const { GoogleGenerativeAI } = await import("@google/generative-ai");
  const genAI = new GoogleGenerativeAI(geminiKey);
  const genModel = genAI.getGenerativeModel({
    model,
    ...(systemInstruction ? { systemInstruction } : {}),
    generationConfig: {
      responseMimeType: "application/json",
      // gemini thinking tokens count against maxOutputTokens. At 16000 the
      // model's reasoning starved the visible JSON twice in a row (2026-06-10
      // live incident: ~6k/9k chars vs a 15k-char healthy scorecard). 3.5-flash
      // (2026-06-10 modernization) thinks MORE than 2.5-flash (~601 vs ~370
      // thought tokens observed), so the generous budget matters even more.
      // 32,768 guarantees ≥8k tokens of headroom for the scorecard itself.
      maxOutputTokens: 32768,
      temperature: 0.1,
    } as any,
  });

  const result = await genModel.generateContent(prompt);
  return result.response.text();
}

export interface GeoScore {
  pillar: string;
  pillarName: string;
  score: number;
  findings: string;
  recommendation: string;
  priority: "critical" | "high" | "medium" | "low";
  impactedPages: string[];
}

export interface GeoScorecard {
  overallScore: number;
  pillars: GeoScore[];
  topThreeImprovements: string[];
}

const GEO_PILLARS = [
  { id: "metadata_freshness",      name: "Metadata Freshness",           typicalRange: "40–75" },
  { id: "semantic_html",           name: "Semantic HTML Structure",       typicalRange: "20–60" },
  { id: "structured_data",         name: "Structured Data (Schema.org)",  typicalRange: "0–30" },
  { id: "entity_definitions",      name: "Entity Definitions",            typicalRange: "25–50" },
  { id: "faq_coverage",            name: "FAQ Coverage",                  typicalRange: "5–20" },
  { id: "evidence_statistics",     name: "Evidence & Statistics",         typicalRange: "20–50" },
  { id: "content_structure",       name: "Content Structure",             typicalRange: "25–55" },
  { id: "author_authority",        name: "Author Authority (E-E-A-T)",    typicalRange: "0–40" },
  { id: "internal_linking",        name: "Internal Linking",              typicalRange: "30–60" },
  { id: "content_freshness",       name: "Content Freshness",             typicalRange: "10–35" },
  { id: "multi_format",            name: "Multi-Format Content",          typicalRange: "15–45" },
  { id: "licensing_signals",       name: "AI Licensing Signals",          typicalRange: "0–5" },
  { id: "contact_trust",           name: "Contact & Trust Signals",       typicalRange: "15–40" },
  { id: "competitive_positioning", name: "Competitive Positioning",       typicalRange: "10–40" },
  { id: "offering_clarity",        name: "Offering Clarity",              typicalRange: "40–70" },
  { id: "cta_structure",           name: "CTA Structure",                 typicalRange: "30–70" },
  { id: "geographic_signals",      name: "Geographic Signals",            typicalRange: "0–40" },
];

const GEO_PILLAR_WEIGHTS: Record<string, number> = {
  author_authority:        4.9,
  content_freshness:       4.7,
  structured_data:         4.6,
  faq_coverage:            4.5,
  contact_trust:           4.3,
  semantic_html:           4.2,
  content_structure:       4.1,
  evidence_statistics:     4.0,
  internal_linking:        3.8,
  metadata_freshness:      3.7,
  entity_definitions:      3.6,
  offering_clarity:        3.5,
  multi_format:            3.2,
  cta_structure:           3.0,
  competitive_positioning: 2.8,
  licensing_signals:       2.5,
  geographic_signals:      2.5,
};

// ── ES-054: Geographic Signals scoring (C7 — deterministic, no LLM) ────────

/**
 * Walk a GeoTree and count city-level nodes that have at least one evidence URL.
 * Used by scoreGeographicSignals to credit sites whose ES-086 tree extraction
 * found real geographic coverage even if their URL structure or schema markup
 * doesn't match the deterministic per-page signals (1-7).
 */
function countCitiesInGeoTree(tree: GeoTree | null | undefined): number {
  if (!tree?.root) return 0;
  let count = 0;
  function walk(node: GeoNode | undefined): void {
    if (!node || typeof node !== "object") return;
    if (node.level === "city" && Array.isArray(node.evidence) && node.evidence.length > 0) {
      count++;
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) walk(child);
    }
  }
  walk(tree.root);
  return count;
}

/**
 * Score geographic signals across crawl data. Deterministic — no LLM call.
 * Returns a GeoScore to be injected as the 17th pillar in the scorecard.
 *
 * Issue-C fix (2026-04-09): the per-page URL regex at Signal 6 only matches
 * `/(locations|offices|branches)/` and misses sites that use city sub-paths
 * like `/bangalore/`, `/delhi/` (very common pattern for healthcare and retail
 * brand chains). The geoTree parameter was previously declared but unused
 * dead code. This fix wires it to a NEW Signal 8 that counts city-level nodes
 * with evidence URLs in the populated tree (built by extract-trees stage).
 *
 * Without this fix, multi-location brands like Manipal Hospitals scored 0 on
 * geographic_signals despite operating in 5+ Indian cities, because their URL
 * pattern is `/bangalore/...` not `/locations/...`.
 */
export function scoreGeographicSignals(
  crawlData: { pages: Array<{ url: string; existingSchema?: string | string[]; contactInfo?: string | string[]; content?: string; pageType?: string }> },
  geoTree?: GeoTree | null,
): GeoScore {
  let score = 0;
  const signals: string[] = [];
  const pages = crawlData.pages;

  // Helper to normalize existingSchema to string (handles both string and string[])
  const schemaStr = (p: typeof pages[number]) => {
    const s = p.existingSchema;
    return Array.isArray(s) ? s.join(" ") : (s ?? "");
  };

  // Helper to normalize contactInfo to string
  const contactStr = (p: typeof pages[number]) => {
    const c = p.contactInfo;
    return Array.isArray(c) ? c.join(" ") : (c ?? "");
  };

  // Signal 1: LocalBusiness schema (20 pts)
  const hasLocalBusiness = pages.some(p =>
    schemaStr(p).includes("LocalBusiness")
  );
  if (hasLocalBusiness) {
    score += 20;
    signals.push("LocalBusiness schema detected");
  }

  // Signal 2: GeoCoordinates in schema (15 pts)
  const hasGeoCoordinates = pages.some(p =>
    schemaStr(p).includes("GeoCoordinates")
  );
  if (hasGeoCoordinates) {
    score += 15;
    signals.push("GeoCoordinates in schema");
  }

  // Signal 3: PostalAddress in schema (15 pts)
  const hasPostalAddress = pages.some(p =>
    schemaStr(p).includes("PostalAddress")
  );
  if (hasPostalAddress) {
    score += 15;
    signals.push("PostalAddress in schema");
  }

  // Signal 4: areaServed in schema (10 pts)
  const hasAreaServed = pages.some(p =>
    schemaStr(p).includes("areaServed")
  );
  if (hasAreaServed) {
    score += 10;
    signals.push("areaServed in schema");
  }

  // Signal 5: Address in visible content on >= 3 pages (15 pts)
  // Must match a street address, postal code, or address-keyword context to avoid
  // false positives from phone numbers, dates, or version strings.
  const pagesWithAddress = pages.filter(p => {
    const info = contactStr(p);
    return (
      /\d+\s+\w+\s+(st|street|rd|road|ave|avenue|blvd|dr|drive|ln|lane|way|place|suite|ste|floor|fl)\b/i.test(info) ||
      /\b\d{5,6}\b/.test(info) ||
      (/address|location|office|branch/i.test(info) && /\d/.test(info))
    );
  });
  if (pagesWithAddress.length >= 3) {
    score += 15;
    signals.push(`Address on ${pagesWithAddress.length} pages`);
  }

  // Signal 6: Location-specific pages (15 pts)
  const locationPages = pages.filter(p =>
    /\/(locations|offices|branches)\//i.test(p.url)
  );
  if (locationPages.length > 0) {
    score += 15;
    signals.push(`${locationPages.length} location pages`);
  }

  // Signal 7: Geo meta tags (10 pts)
  const hasGeoMeta = pages.some(p =>
    /geo\.(region|placename)/i.test(p.content ?? "")
  );
  if (hasGeoMeta) {
    score += 10;
    signals.push("Geo meta tags detected");
  }

  // Signal 8 (Issue-C fix): GeoTree city evidence (up to 25 pts)
  // Reads the ES-086-populated geo_tree to credit sites whose tree extraction
  // found real geographic coverage backed by evidence URLs. This catches
  // multi-location brands using city sub-paths (e.g. /bangalore/) that the
  // /(locations|offices|branches)/ regex at Signal 6 doesn't match.
  const cityCount = countCitiesInGeoTree(geoTree);
  if (cityCount > 0) {
    const cityPoints = cityCount === 1 ? 10 : cityCount <= 5 ? 18 : 25;
    score += cityPoints;
    signals.push(`Geographic coverage extracted from crawl: ${cityCount} ${cityCount === 1 ? "city" : "cities"}`);
  }

  // Cap at 100
  score = Math.min(score, 100);

  // Priority: low score = most to fix = critical; high score = already good = low priority
  const priority: "critical" | "high" | "medium" | "low" =
    score < 20 ? "critical" : score < 50 ? "high" : score < 80 ? "medium" : "low";

  const findings = signals.length > 0
    ? `Geographic signals detected: ${signals.join(", ")}. Score: ${score}/100.`
    : "No geographic signals detected. This site has no location-specific structured data or content.";

  const recommendation = score >= 80
    ? "Geographic signals are strong. Maintain current structured data and location pages."
    : score >= 40
      ? "Add more location-specific pages and ensure PostalAddress schema is on all location pages."
      : "Add LocalBusiness schema, GeoCoordinates, and create dedicated location pages for each service area.";

  return {
    pillar: "geographic_signals",
    pillarName: "Geographic Signals",
    score,
    findings,
    recommendation,
    priority,
    impactedPages: locationPages.map(p => p.url).slice(0, 5),
  };
}

export async function analyzeGeoGaps(
  crawlData: CrawlData,
  competitiveIntel: CompetitiveIntel,
  discoveryData?: Pick<DiscoveryData, "hasLlmsTxt" | "hasUcp" | "hasSitemap" | "ownLlmsTxt" | "ownSchemaJson" | "ownBusinessJson" | "sitemapStale" | "urlsNotInSitemap" | "flowblinqGeneratedSchemaBlocks" | "installedFromFlowblinq" | "wwwRedirectStatus" | "llmsTxtFetchFailed">,
  previousScorecard?: GeoScorecard,
  contentStrategyScores?: ContentStrategyReport | null,
  geoTree?: GeoTree | null,
): Promise<GeoScorecard> {
  // FIX-025: Hard page cap before prompt assembly. The geo-analyzer serializes
  // the entire crawl into ONE Gemini call; without an upper bound a large
  // (Pro-tier) crawl can overflow the model context window and get silently
  // truncated mid-JSON, corrupting scores. selectInventoryPages (reused from
  // tree-extractor) applies deterministic, per-type-balanced selection so the
  // prompt stays within the window while preserving cross-pillar coverage.
  // NOTE: deterministic geographic scoring below still receives the FULL
  // crawlData — only the LLM prompt is capped.
  const analyzerPages = selectInventoryPages(crawlData.pages, MAX_ANALYZER_PAGES);
  if (analyzerPages.length < crawlData.pages.length) {
    console.warn(
      `[geo-analyzer] Capped LLM prompt pages: ${crawlData.pages.length} crawled → ${analyzerPages.length} sent (MAX_ANALYZER_PAGES=${MAX_ANALYZER_PAGES})`,
    );
  }

  // Content budget per page scales with crawl size.
  // Structural signals (headings, schema, FAQs) are always kept in full —
  // they're what drives most GEO scoring pillars.
  // Body content gets reduced for article/blog pages on large crawls since
  // individual article text adds little scoring signal but balloons the prompt.
  const pageCount = analyzerPages.length;
  const contentBudget = (p: { pageType: string }) => {
    if (pageCount <= 20) return 2000;
    if (p.pageType === "blog" || p.pageType === "article") return pageCount > 50 ? 300 : 600;
    return pageCount > 50 ? 800 : 1200;
  };

  const crawlSummary = JSON.stringify({
    domain: crawlData.domain,
    totalPages: crawlData.totalCrawled,
    pages: analyzerPages.map((p) => ({
      url: p.url,
      pageType: p.pageType,
      title: sanitizeForPrompt(p.title, 200),
      h1: sanitizeForPrompt(p.h1, 200),
      headings: (p.headings ?? []).map((h) => ({ level: h.level, text: sanitizeForPrompt(h.text, 200) })),
      hasStructuredData: p.hasStructuredData,
      existingSchema: p.existingSchema,
      // Issue-L (2026-04-10): parsed JSON-LD block bodies (field-level detail,
      // truncated to depth 2 / 150-char strings / 12 blocks per page) so the
      // LLM can evaluate schema quality — field completeness, nested
      // structures — not just presence of @type. Without this the LLM could
      // only confirm types were present and structured_data stayed capped ~88.
      schemaBlocks: p.schemaBlocks ?? [],
      faqContent: (p.faqContent ?? []).map((f) => ({
        question: sanitizeForPrompt(f.question, 300),
        answer: sanitizeForPrompt(f.answer, 500),
      })),
      testimonials: (p.testimonials ?? []).map((t) => sanitizeForPrompt(t, 300)),
      certifications: (p.certifications ?? []).map((c) => sanitizeForPrompt(c, 200)),
      contactInfo: (Array.isArray(p.contactInfo) ? p.contactInfo : []).map((ci) => sanitizeForPrompt(ci, 200)),
      content: sanitizeForPrompt(p.content, contentBudget(p)),
    })),
  }, null, 2);

  // Include customer's own published GEO files — ground truth for licensing/structured data scoring
  const schemaBlocks = discoveryData?.flowblinqGeneratedSchemaBlocks as Array<{type: string; name: string}> | null | undefined;
  const schemaBlockTypes = schemaBlocks?.map(b => b.type).filter(Boolean) ?? [];

  const geoFilesSection = discoveryData ? `
GEO FILES PUBLISHED BY THIS SITE:
- llms.txt present: ${discoveryData.llmsTxtFetchFailed ? "INDETERMINATE (fetch failed — do not penalize)" : discoveryData.hasLlmsTxt ? "YES" : "NO"}
- UCP endpoint present: ${discoveryData.hasUcp ? "YES" : "NO"}
${discoveryData.ownLlmsTxt ? `- llms.txt content (first 1000 chars):\n${discoveryData.ownLlmsTxt.slice(0, 1000)}` : ""}
${discoveryData.ownBusinessJson ? `- business.json present: YES (structured business profile published)` : ""}
${discoveryData.ownSchemaJson ? `- schema.json present: YES (structured schema published)` : ""}
${schemaBlockTypes.length > 0 ? `- FlowBlinq-generated schema blocks ready to install: ${schemaBlockTypes.join(", ")} (${schemaBlockTypes.length} total blocks)` : ""}
${discoveryData.installedFromFlowblinq ? "- NOTE: Customer has FlowBlinq integration ACTIVE on the live site — llms.txt, schema blocks, and citation infrastructure are published and verified. Credit licensing_signals and structured_data accordingly (integration is in place, not merely generated)." : ""}
${(schemaBlockTypes.length > 0 && !discoveryData.installedFromFlowblinq) ? "- NOTE: FlowBlinq has GENERATED the schema blocks listed above for this customer, but they have NOT been installed on the live site yet. Score reflects the site AS-IS — do NOT credit the generated-but-unpublished assets." : ""}
${discoveryData.hasSitemap === false ? `- SITEMAP MISSING: No sitemap.xml was found at ${crawlData.domain}/sitemap.xml. This is a MAJOR GEO issue — AI crawlers (GPTBot, ClaudeBot, PerplexityBot) rely on sitemaps to discover and index all pages. Without a sitemap, AI engines can only find pages linked from the homepage. Score metadata_freshness no higher than 40. Include this as a critical finding with a specific fix: generate and publish a sitemap.xml at the root domain.` : ""}
${discoveryData.sitemapStale ? `- SITEMAP IS OUTDATED: ${discoveryData.urlsNotInSitemap?.length} page(s) found via navigation that are NOT in the sitemap: ${discoveryData.urlsNotInSitemap?.slice(0, 5).join(", ")}. Flag this in metadata_freshness findings.` : ""}
${discoveryData.wwwRedirectStatus === "missing" ? `- WWW REDIRECT MISSING: The non-www version of this domain (http/https without www) loads as a separate site instead of redirecting to the canonical www version. This creates duplicate content, splits link equity, and harms AI discoverability. Flag this as a critical finding in metadata_freshness with a specific recommendation to add a 301 redirect from the non-www domain to www.` : ""}

IMPORTANT: If the site has published llms.txt, business.json, or schema.json, score licensing_signals and structured_data HIGHER — these are explicit AI-readability signals.
` : "";

  const previousScoresSection = previousScorecard ? `
PREVIOUS SCORES (from last audit — use to detect genuine improvement):
${previousScorecard.pillars.map(p => `- ${p.pillar}: ${p.score} (recommendation was: "${p.recommendation.substring(0, 120)}")`).join("\n")}

If the current crawl data shows the site has implemented a recommended fix, score that pillar HIGHER.
If the current crawl data shows no meaningful change, keep the score in the same range as before.
Do NOT blindly repeat the previous score — re-evaluate based on evidence.
` : "";

  const pillarScoringGuide = `PILLAR SCORING GUIDE
Each pillar shows: weight/5 | typical score range | 95+ benchmark site | what earns 95+ | what earns ~50

- author_authority (weight 4.9 | typical 0–40)
  95+ benchmark: healthline.com — every article has a named author AND a named medical reviewer, both with credential pages, Person schema with sameAs to LinkedIn/institutional profiles, and a published editorial policy page.
  ~50: blog with "Staff Writer" bylines, no credentials, no author page, no Person schema.
  IMPORTANT (December 2025 update): Google's "authenticity score" now evaluates whether content demonstrates genuine expertise vs. being created primarily for rankings. Clear author identification with credentials is essentially mandatory for ALL competitive queries — not just health/finance (YMYL). Sites without named authors with verifiable credentials face measurable ranking disadvantage.
  Score 95+ only if: named author + named expert reviewer + credential schema + editorial policy all present.

- content_freshness (weight 4.7 | typical 10–35)
  95+ benchmark: ahrefs.com/blog — explicit "Updated [Month Year]" in heading, dateModified in Article JSON-LD updated on every revision, genuine content change (not just date-bump), Last-Modified HTTP header accurate.
  ~50: publish date exists but dateModified matches datePublished; content never touched since original publish.
  Score 95+ only if: visible update date + dateModified newer than datePublished + content genuinely changed.

- structured_data (weight 4.6 | typical 0–30)
  95+ benchmark: developers.google.com/search — multi-schema stacking per page type: Article + BreadcrumbList + FAQPage where applicable, Organization + WebSite on homepage, all validated with zero errors.
  ~50: WordPress with Yoast-installed Organization schema on homepage only, no Article schema on posts.
  EVALUATE the PARSED schemaBlocks array on each page — not just existingSchema type names. Check FIELD COMPLETENESS: Organization should have name + url + sameAs (social profiles) + address + contactPoint + logo; FAQPage should have mainEntity array with Question + acceptedAnswer pairs; BreadcrumbList should have itemListElement with position + item; Article should have author + datePublished + dateModified + publisher. Blocks that present only @type + 1-2 skeleton fields are "skeleton schemas" and should cap the pillar around 70 regardless of how many types are stacked.
  Score 95+ only if: correct schema type per page + multi-schema stacking + fields meaningfully filled (not skeleton stubs) + consistent across the site.

- faq_coverage (weight 4.5 | typical 5–20)
  95+ benchmark: investopedia.com — FAQ sections embedded on every content page (not just a standalone /faq), questions match user search queries, answers are complete and authoritative.
  ~50: a single /faq page covering company questions only, questions are feature explanations not user queries.
  NOTE: As of June 2025, Google FAQ rich results are limited to government and health authority sites only. FAQPage schema still helps AI systems parse Q&A content, but do NOT promise FAQ rich results in recommendations unless the site is a government or health authority. Score this pillar based on FAQ content quality and coverage, not just schema presence.
  Score 95+ only if: FAQ sections on content pages + questions phrased as user queries + complete answers.

- contact_trust (weight 4.3 | typical 15–40)
  95+ benchmark: stripe.com — physical HQ address in footer on every page, 3+ named contact routes (support/sales/press), trust certifications linked to audit documentation, contactPoint in Organization schema.
  ~50: generic contact form, no physical address, trust badges as images with no documentation links.
  Score 95+ only if: physical address + phone/email + certifications linked to docs + contactPoint in schema.

- semantic_html (weight 4.2 | typical 20–60)
  95+ benchmark: web.dev — all six landmark elements (header/nav/main/article/section/footer), strict single H1 matching page title and schema name, no heading level skips, inline semantics (time/abbr/cite/code) used contextually.
  ~50: div soup with class="header" equivalents, H tags used for visual sizing not structure, multiple H1s on some pages.
  Score 95+ only if: all landmark elements present + single H1 + no heading skips + inline semantic elements used.

- content_structure (weight 4.1 | typical 25–55)
  95+ benchmark: investopedia.com — "Key Takeaways" box before body text, sections of 150–400 words each anchored by descriptive H2/H3, "The Bottom Line" closing paragraph, table of contents on long pages.
  ~50: long intro that doesn't answer anything, 400–700 word paragraphs with no internal breaks, generic conclusion.
  Score 95+ only if: answer in first 100 words + summary box near top + chunked sections + explicit conclusion.

- evidence_statistics (weight 4.0 | typical 20–50)
  95+ benchmark: ahrefs.com/blog — every statistical claim hyperlinked inline to primary source, precise numbers ("76% of AI Overview citations" not "most"), at least one proprietary data point original to the site.
  ~50: "studies show X is important" with no named study, no link, no number.
  Score 95+ only if: inline hyperlinked citations + precise numbers + at least one original/proprietary data point.

- internal_linking (weight 3.8 | typical 30–60)
  95+ benchmark: nerdwallet.com — 8–15 contextual internal links per article with descriptive anchor text, explicit pillar pages that cluster pages link back to with consistent anchor text, no orphan pages.
  ~50: occasional "you might also like" widget, no pillar page, average 2–3 internal links per post.
  Score 95+ only if: 6+ contextual links per page + pillar/cluster architecture + descriptive anchor text.

- metadata_freshness (weight 3.7 | typical 40–75)
  95+ benchmark: reuters.com — every page has unique meta description under 155 chars, Last-Modified HTTP header reflects actual editorial update time, sitemap <lastmod> matches dateModified in JSON-LD, no 404s in sitemap.
  ~50: all pages share same meta description, no Last-Modified header, sitemap generated months ago.
  Score 95+ only if: unique meta descriptions + accurate dateModified + live sitemap + Last-Modified header present.

- entity_definitions (weight 3.6 | typical 25–50)
  95+ benchmark: investopedia.com/terms — 30,000+ dedicated term pages, each opens with a 1-sentence extractable plain-English definition, DefinedTerm schema with alternateName, cross-links to related terms forming a knowledge graph.
  ~50: industry jargon used without definition, no glossary, no "what is X" pages.
  Score 95+ only if: dedicated definition pages per entity + extractable 1-sentence opening definition + schema + cross-links.

- offering_clarity (weight 3.5 | typical 40–70)
  95+ benchmark: stripe.com/pricing — exact per-transaction pricing (no "contact sales"), every fee itemized, one-sentence product value proposition on every product page stating what it does and who it's for, feature lists with specific counts not vague benefits.
  ~50: "We help businesses grow" hero, "contact us for pricing", features listed as benefit statements without specifics.
  Score 95+ only if: public pricing with exact numbers + specific feature counts + one-sentence value prop per product page.

- multi_format (weight 3.2 | typical 15–45)
  95+ benchmark: hubspot.com/blog — major guides include embedded video + downloadable asset + semantic HTML table + infographic with descriptive alt text. Video content has on-page transcript. All infographics describe data in alt text, not just "infographic".
  ~50: text-only post with stock photos, comparison content as bullets not tables, no video, no downloads.
  Score 95+ only if: 2+ non-text formats per major page + all images have descriptive alt text + tables use semantic HTML.

- cta_structure (weight 3.0 | typical 30–70)
  95+ benchmark: linear.app — single unambiguous primary CTA per page, CTA label changes contextually to match section content ("Start planning sprints for free" after the sprint planning feature section), clear visual hierarchy when multiple CTAs needed.
  ~50: three competing CTAs above the fold all same size and color, generic "Sign up" regardless of page context.
  Score 95+ only if: one primary CTA per page + contextually matched label + clear primary/secondary visual hierarchy.

- competitive_positioning (weight 2.8 | typical 10–40)
  95+ benchmark: asana.com/compare — dedicated /compare/ subdirectory with one page per competitor, each has a feature comparison table with specific numeric claims, a customer quote from a migrated user, FAQ section, single CTA.
  ~50: no competitor content, or a single generic "why choose us" page with no named competitors and vague benefits.
  Score 95+ only if: /compare/ or /vs/ subdirectory + per-competitor pages + feature tables with specific numeric claims.

- licensing_signals (weight 2.5 | typical 0–5)
  95+ benchmark: anthropic.com + vercel.com — /llms.txt published at root with structured content manifest, /llms-full.txt available, robots.txt has named AI bot directives (GPTBot, ClaudeBot, PerplexityBot) separate from the general * rule, business.json at canonical URL.
  ~50: robots.txt with User-agent: * only, no llms.txt, no AI-specific directives.
  Score 60+ just for having a valid llms.txt (only ~784 sites globally have implemented it). Score 95+ only if: llms.txt + llms-full.txt + AI-specific robots.txt directives + business.json.

SCORING RULES:
- Score relative to these benchmarks. A site at the HIGH end of its typical range scores 60–75.
- A site that significantly exceeds typical but falls short of the 95+ benchmark scores 75–90.
- Only score 90+ for implementations that match or exceed the benchmark site described above.
- A site with NO implementation of a pillar scores at or below the LOW end of its typical range.
- Do not give round numbers (30, 50, 70) — be precise based on evidence (32, 47, 68).`;

  // ── System prompt: role, methodology, benchmarks, output format ──────────────
  const pillarIds = GEO_PILLARS.filter(p => p.id !== "geographic_signals").map(p => p.id);

  const systemPrompt = `You are an SEO and GEO (Generative Engine Optimization) auditor. Score websites across 16 pillars measuring both traditional search engine optimization AND how well AI systems (ChatGPT, Perplexity, Gemini, Google AI Overviews) can discover, parse, and cite the site's content.

<scoring_methodology>
Score each pillar 0-100 relative to best-in-class benchmarks:
- 0-20: No implementation of this signal
- 20-40: Minimal/accidental implementation
- 40-60: Partial implementation, significant gaps
- 60-75: Good implementation, minor gaps
- 75-90: Strong, approaching best-in-class
- 90-100: Matches or exceeds the named benchmark

Use precise scores (32, 47, 68) not round numbers (30, 50, 70).
</scoring_methodology>

<google_guidance>
Google's official position (May 2025): "There are no additional requirements to appear in AI Overviews or AI Mode, nor other special optimizations necessary." Traditional SEO best practices are the foundation for AI search visibility. Sites that rank well in traditional search are the same sites that appear in AI-generated answers.

Key Google signals: unique valuable content, great page experience, crawlability, structured data matching visible content, multimodal content (images + video), E-E-A-T (Experience, Expertise, Authoritativeness, Trustworthiness), Core Web Vitals.

The GEO layer (llms.txt, entity definitions, citation optimization) adds incremental visibility with non-Google AI (ChatGPT, Perplexity, Claude) but does NOT replace the SEO foundation.
</google_guidance>

<scoring_guide>
${pillarScoringGuide}
</scoring_guide>

<research_facts>
Reference these in recommendations where applicable:
- Expert quotes boost AI visibility by 41% (Princeton GEO, KDD 2024)
- Inline statistics with citations boost by 33% (Princeton GEO, KDD 2024)
- Citing external sources boosts by 28% (Princeton GEO, KDD 2024)
- 44.2% of AI citations come from the first 30% of page content (Growth Memo, 2026)
- FAQ content on pages averages 4.9 AI citations vs 4.4 without (SE Ranking, 2025). Note: Google FAQ rich results now limited to government/health sites, but FAQ content still helps AI extraction.
- Pages with FAQ sections average 4.9 citations vs 4.4 without (SE Ranking, 2025)
- Explicit concept definitions cited 32% more by Perplexity
- 85% of AI Overview citations from content < 2 years old
- Only 12.4% of domains have schema.org markup
- Answer-first paragraphs in 200-500 word chunks perform best
- Multi-schema stacking (Article + FAQ + Breadcrumb) = 2x more citations
</research_facts>

<output_format>
Return ONLY valid JSON. The "pillar" field MUST use these exact snake_case IDs: ${pillarIds.join(", ")}

Do NOT use display names like "Metadata Freshness" or numbers like "1" in the pillar field. Return exactly 16 pillar entries, one per ID.

For topThreeImprovements: be specific to THIS site — name exact page counts, exact fixes, and cite research evidence.

You MUST return a JSON OBJECT (not an array) with this exact top-level structure:
{
  "overallScore": 42,
  "pillars": [
    {
      "pillar": "structured_data",
      "pillarName": "Structured Data (Schema.org)",
      "score": 8,
      "findings": "hasStructuredData is false for all 12 pages. No Organization, Article, or Product schema.",
      "recommendation": "Add Organization + WebSite on homepage, Article on blog posts, Product on product pages.",
      "priority": "critical",
      "impactedPages": ["https://example.com/", "https://example.com/blog/post-1"]
    }
  ],
  "topThreeImprovements": ["First improvement with specific page counts and research citation.", "Second improvement.", "Third improvement."]
}
</output_format>`;

  // ── User prompt: crawl data + context (data at top, task at bottom) ─────────
  const prompt = `<crawl_data>
${crawlSummary}
</crawl_data>
${geoFilesSection}
<competitive_context>
- Industry${competitiveIntel.groundTruthIndustry?.confidence === "high" ? " (confirmed via site's own schema.org structured data — use this exactly)" : " (inferred from site content)"}: ${competitiveIntel.groundTruthIndustry?.industry ?? sanitizeForPrompt(competitiveIntel.industryContext ?? "", 200)}
- Brand perception: ${sanitizeForPrompt(competitiveIntel.brandPerception ?? "", 200)}
- Competitors with llms.txt: ${(competitiveIntel.competitorGeoStatus ?? []).filter(c => c.hasLlmsTxt).map(c => sanitizeForPrompt(c.domain, 100)).join(", ") || "none"}
</competitive_context>

${contentStrategyScores ? `<content_strategy_signals>
- Quotation density: ${contentStrategyScores.quotations.avgPerPage.toFixed(1)} per page. ${contentStrategyScores.quotations.pagesWithQuotes}/${contentStrategyScores.quotations.pagesTotal} pages have attributed quotes.
- Statistics density: ${contentStrategyScores.statistics.avgPerPage.toFixed(1)} per page. ${contentStrategyScores.statistics.pagesWithStats}/${contentStrategyScores.statistics.pagesTotal} include sourced data points.
- External citation density: ${contentStrategyScores.citations.avgPerPage.toFixed(1)} per page. ${contentStrategyScores.citations.pagesWithCitations}/${contentStrategyScores.citations.pagesTotal} link to authoritative sources.
</content_strategy_signals>
` : ""}${previousScoresSection ? `<previous_scores>\n${previousScoresSection}\n</previous_scores>` : ""}

Score all 16 pillars based on evidence in the crawl data. Cite exact pages, content, and issues in findings. Keep findings and recommendations concise (2-3 sentences each).`;

  const raw = await callGemini(prompt, systemPrompt);
  // NEW-AI-04: strip markdown fences and wrap parse in try/catch so a truncated
  // or fenced LLM response doesn't hard-fail the entire audit.
  let parsed: GeoScorecard;
  try {
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    parsed = GeoScorecardSchema.parse(JSON.parse(stripped)) as GeoScorecard;
  } catch (parseErr) {
    // 2026-06-10 revision of NEW-AI-04: do NOT return a zero scorecard here.
    // A zero scorecard completes the audit with a customer-visible 0/100 for a
    // site that may genuinely score 70+ (live incident 2026-06-10: flowblinq.com
    // real score 72 → shown 0 on a truncated Gemini response). Throw instead so
    // the stage fails, QStash retries, and persistent failure surfaces as a
    // failed audit rather than silently wrong data. Fence-stripping retained.
    console.error(`[geo-analyzer] Failed to parse scorecard JSON (NEW-AI-04): ${parseErr}. Raw length: ${raw.length}. Throwing so the stage retries.`);
    throw new Error(`[geo-analyzer] Could not parse scorecard JSON from LLM response (raw length ${raw.length}): ${parseErr}`);
  }

  // Normalize pillar id — GPT sometimes returns:
  //   "pillar": "metadata_freshness"  (correct)
  //   "pillar": "Metadata Freshness"  (pillarName instead of id)
  //   "pillar": "1" through "16"      (1-based array index — most common failure)
  const nameToId = new Map(GEO_PILLARS.map((p) => [p.name.toLowerCase(), p.id]));
  const idSet = new Set(GEO_PILLARS.map((p) => p.id));

  const normalizedPillars = (parsed.pillars ?? []).map((p, i) => {
    let canonicalId = p.pillar;

    if (!idSet.has(canonicalId)) {
      // Try matching by pillarName
      const byName = nameToId.get(p.pillarName?.toLowerCase());
      if (byName) {
        canonicalId = byName;
      } else {
        // Try treating pillar as 1-based numeric index
        const idx = parseInt(canonicalId, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= GEO_PILLARS.length) {
          canonicalId = GEO_PILLARS[idx - 1].id;
        } else {
          // Last resort: use position in returned array
          canonicalId = GEO_PILLARS[i % GEO_PILLARS.length].id;
        }
      }
    }

    // Issue-E fix: always use the canonical pillarName from GEO_PILLARS, NOT
    // the LLM's display name. The LLM (Gemini) decorates display names with
    // semantic expansions ("Author Authority & E-E-A-T", "Metadata & Sitemap
    // Freshness") that vary run-to-run and confuse customers reading the
    // dashboard. The canonical names live in GEO_PILLARS and are stable.
    // Pillar `pillar` (snake_case id) is already canonicalized above; this
    // forces the display name to match.
    const canonicalName = GEO_PILLARS.find(g => g.id === canonicalId)?.name || canonicalId;
    return { ...p, pillar: canonicalId, pillarName: canonicalName };
  });

  // Deduplicate by canonical pillar id (keep highest score if duped)
  const pillarMap = new Map<string, GeoScore>();
  for (const p of normalizedPillars) {
    const existing = pillarMap.get(p.pillar);
    if (!existing || p.score > existing.score) {
      pillarMap.set(p.pillar, p);
    }
  }

  // Backfill only truly missing pillars — if GPT failed to return one
  // Use score: 50 (neutral) not 0, to avoid tanking the overall score with unassessed pillars
  // Exclude geographic_signals — it's scored deterministically below
  for (const pillar of GEO_PILLARS) {
    if (pillar.id === "geographic_signals") continue;
    if (!pillarMap.has(pillar.id)) {
      console.warn(`[geo-analyzer] Pillar missing from GPT response, backfilling: ${pillar.id}`);
      pillarMap.set(pillar.id, {
        pillar: pillar.id,
        pillarName: pillar.name,
        score: 50,
        findings: "Could not be assessed from available crawl data.",
        recommendation: "Run a fresh crawl with more pages to enable full scoring.",
        priority: "medium",
        impactedPages: [],
      });
    }
  }

  // ES-054 C7 + Issue-C fix: Inject 17th pillar — deterministic geographic signals score.
  // Now reads the ES-086-populated geo_tree (Signal 8) to credit multi-location brands
  // whose URL pattern doesn't match the legacy /(locations|offices|branches)/ regex.
  const geoPillar = scoreGeographicSignals(crawlData, geoTree);
  pillarMap.set("geographic_signals", geoPillar);

  parsed.pillars = Array.from(pillarMap.values());

  // Always recompute overallScore as a rounded weighted average — never trust the LLM's raw number
  // (it may return floats like 73.1 or a simple mean instead of a weighted average)
  const totalWeight = parsed.pillars.reduce((sum, p) => sum + (GEO_PILLAR_WEIGHTS[p.pillar] ?? 3.0), 0);
  const weightedSum = parsed.pillars.reduce((sum, p) => sum + p.score * (GEO_PILLAR_WEIGHTS[p.pillar] ?? 3.0), 0);
  parsed.overallScore = Math.round(weightedSum / totalWeight);

  // Grounding pass: cross-reference pillar scores against hard crawl evidence,
  // correct via LLM, and deterministically clamp if correction still fails.
  const corrections = await groundAndCorrectScorecard(parsed, crawlData, discoveryData);
  if (corrections.length > 0) {
    console.warn(`[geo-analyzer] Grounding corrections applied: ${corrections.length} pillar${corrections.length !== 1 ? "s" : ""} corrected`);
    // Recompute overallScore with corrected pillar scores
    const correctedTotalWeight = parsed.pillars.reduce((sum, p) => sum + (GEO_PILLAR_WEIGHTS[p.pillar] ?? 3.0), 0);
    const correctedWeightedSum = parsed.pillars.reduce((sum, p) => sum + p.score * (GEO_PILLAR_WEIGHTS[p.pillar] ?? 3.0), 0);
    parsed.overallScore = Math.round(correctedWeightedSum / correctedTotalWeight);
  }

  // Attach corrections metadata for hallucination risk tracking (read by pipeline route)
  (parsed as any)._groundingCorrections = corrections;

  return parsed;
}

// ── Grounding types ───────────────────────────────────────────────────────────

export interface GroundingCorrection {
  pillar: string;
  originalScore: number;
  correctedScore: number;
  reason: string;
}

interface GroundingFlag {
  pillar: string;
  originalScore: number;
  evidenceSummary: string;
  cap: number;
  deterministicFindings: string;
}

// ── groundAndCorrectScorecard ─────────────────────────────────────────────────

/**
 * Cross-references pillar scores against hard evidence from crawl data.
 * Mutates `scorecard` in place. Returns a log of corrections made.
 *
 * Flow:
 *   1. Deterministic check — flag pillars whose scores are unsupported by evidence.
 *   2. If flags exist → one LLM correction call for just those pillars.
 *   3. If LLM-corrected scores still fail the check → deterministic clamp.
 */
export async function groundAndCorrectScorecard(
  scorecard: GeoScorecard,
  crawlData: CrawlData,
  discoveryData?: Pick<DiscoveryData, "hasLlmsTxt" | "hasUcp" | "hasSitemap" | "ownLlmsTxt" | "ownSchemaJson" | "ownBusinessJson" | "sitemapStale" | "urlsNotInSitemap" | "flowblinqGeneratedSchemaBlocks" | "installedFromFlowblinq" | "wwwRedirectStatus"> | undefined,
): Promise<GroundingCorrection[]> {
  const corrections: GroundingCorrection[] = [];

  // ── Step 1: Deterministic evidence checks ──────────────────────────────────

  const flags = detectGroundingFlags(scorecard, crawlData, discoveryData);

  if (flags.length === 0) return corrections;

  // ── Step 2: LLM correction call for flagged pillars ────────────────────────

  const llmCorrectedPillars = await attemptLlmCorrection(flags, scorecard, crawlData, discoveryData);

  // Merge LLM corrections back into scorecard
  if (llmCorrectedPillars) {
    for (const flag of flags) {
      const llmResult = llmCorrectedPillars[flag.pillar];
      if (llmResult && typeof llmResult.score === "number") {
        const pillar = scorecard.pillars.find((p) => p.pillar === flag.pillar);
        if (pillar) {
          pillar.score = Math.round(Math.min(100, Math.max(0, llmResult.score)));
          if (llmResult.findings && typeof llmResult.findings === "string") {
            pillar.findings = llmResult.findings;
          }
        }
      }
    }
  }

  // ── Step 3: Re-check — deterministically clamp any still-failing pillars ───

  const remainingFlags = detectGroundingFlags(scorecard, crawlData, discoveryData);

  for (const flag of remainingFlags) {
    const pillar = scorecard.pillars.find((p) => p.pillar === flag.pillar);
    if (!pillar) continue;

    const originalScore = pillar.score;
    pillar.score = Math.min(pillar.score, flag.cap);
    pillar.findings = flag.deterministicFindings;

    corrections.push({
      pillar: flag.pillar,
      originalScore,
      correctedScore: pillar.score,
      reason: flag.evidenceSummary,
    });
  }

  // Also record corrections for pillars that were fixed by the LLM (not clamped)
  for (const flag of flags) {
    const alreadyClamped = remainingFlags.some((r) => r.pillar === flag.pillar);
    if (alreadyClamped) continue; // already in corrections list above

    const pillar = scorecard.pillars.find((p) => p.pillar === flag.pillar);
    if (pillar && pillar.score !== flag.originalScore) {
      corrections.push({
        pillar: flag.pillar,
        originalScore: flag.originalScore,
        correctedScore: pillar.score,
        reason: `LLM corrected based on evidence: ${flag.evidenceSummary}`,
      });
    }
  }

  return corrections;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function detectGroundingFlags(
  scorecard: GeoScorecard,
  crawlData: CrawlData,
  discoveryData?: Pick<DiscoveryData, "hasLlmsTxt" | "hasUcp" | "hasSitemap" | "ownLlmsTxt" | "ownSchemaJson" | "ownBusinessJson" | "sitemapStale" | "urlsNotInSitemap" | "flowblinqGeneratedSchemaBlocks" | "installedFromFlowblinq" | "wwwRedirectStatus"> | undefined,
): GroundingFlag[] {
  const flags: GroundingFlag[] = [];
  const pages = crawlData.pages;

  for (const pillar of scorecard.pillars) {
    switch (pillar.pillar) {
      case "structured_data": {
        const pagesWithSchema = pages.filter((p) => p.hasStructuredData === true).length;
        if (pillar.score > 60 && pagesWithSchema === 0) {
          flags.push({
            pillar: "structured_data",
            originalScore: pillar.score,
            evidenceSummary: `Score is ${pillar.score} but 0 of ${pages.length} crawled pages have structured data (hasStructuredData === false on all pages).`,
            cap: 15,
            deterministicFindings: `No structured data found on any of the ${pages.length} crawled page${pages.length !== 1 ? "s" : ""}. All pages returned hasStructuredData: false.`,
          });
        }
        break;
      }

      case "faq_coverage": {
        const pagesWithFaq = pages.filter((p) => p.faqContent && p.faqContent.length > 0).length;
        if (pillar.score > 40 && pagesWithFaq === 0) {
          flags.push({
            pillar: "faq_coverage",
            originalScore: pillar.score,
            evidenceSummary: `Score is ${pillar.score} but 0 of ${pages.length} crawled pages contain any FAQ content.`,
            cap: 10,
            deterministicFindings: `No FAQ content detected on any of the ${pages.length} crawled page${pages.length !== 1 ? "s" : ""}. faqContent is empty for all pages.`,
          });
        }
        break;
      }

      case "licensing_signals": {
        const hasLlmsTxt = discoveryData?.hasLlmsTxt === true;
        const hasUcp = discoveryData?.hasUcp === true;
        if (pillar.score > 50 && !hasLlmsTxt && !hasUcp) {
          flags.push({
            pillar: "licensing_signals",
            originalScore: pillar.score,
            evidenceSummary: `Score is ${pillar.score} but neither llms.txt nor UCP endpoint was found (hasLlmsTxt: false, hasUcp: false).`,
            cap: 5,
            deterministicFindings: "No AI licensing signals found. This site has no llms.txt file and no UCP endpoint. AI crawlers have no explicit content manifest to reference.",
          });
        }
        break;
      }

      case "contact_trust": {
        const pagesWithContact = pages.filter(
          (p) => Array.isArray(p.contactInfo) && p.contactInfo.some((ci) => ci && ci.trim().length > 0),
        ).length;
        if (pillar.score > 60 && pagesWithContact === 0) {
          flags.push({
            pillar: "contact_trust",
            originalScore: pillar.score,
            evidenceSummary: `Score is ${pillar.score} but no contact information was found on any of the ${pages.length} crawled pages.`,
            cap: 20,
            deterministicFindings: `No contact information (email, phone, address) was detected on any of the ${pages.length} crawled page${pages.length !== 1 ? "s" : ""}. contactInfo is empty for all pages.`,
          });
        }
        break;
      }

      case "content_freshness": {
        const datePattern = /\b(20\d{2}|19\d{2})\b|updated|published|last modified/i;
        const pagesWithDates = pages.filter((p) => datePattern.test(p.content ?? "")).length;
        if (pillar.score > 60 && pagesWithDates === 0) {
          flags.push({
            pillar: "content_freshness",
            originalScore: pillar.score,
            evidenceSummary: `Score is ${pillar.score} but no date patterns (year numbers, "updated", "published") were found in any page content.`,
            cap: 25,
            deterministicFindings: `No date signals detected in any of the ${pages.length} crawled page${pages.length !== 1 ? "s" : ""}. No year numbers, "updated", or "published" text found in page content.`,
          });
        }
        break;
      }
    }
  }

  return flags;
}

async function attemptLlmCorrection(
  flags: GroundingFlag[],
  scorecard: GeoScorecard,
  crawlData: CrawlData,
  discoveryData?: Pick<DiscoveryData, "hasLlmsTxt" | "hasUcp" | "hasSitemap" | "ownLlmsTxt" | "ownSchemaJson" | "ownBusinessJson" | "sitemapStale" | "urlsNotInSitemap" | "flowblinqGeneratedSchemaBlocks" | "installedFromFlowblinq" | "wwwRedirectStatus"> | undefined,
): Promise<Record<string, { score: number; findings: string }> | null> {
  const evidenceLines: string[] = [];

  // Structured data evidence
  const pagesWithSchema = crawlData.pages.filter((p) => p.hasStructuredData === true).length;
  evidenceLines.push(`- structured_data: ${pagesWithSchema}/${crawlData.pages.length} pages have structured data`);

  // FAQ evidence
  const pagesWithFaq = crawlData.pages.filter((p) => p.faqContent && p.faqContent.length > 0).length;
  evidenceLines.push(`- faq_coverage: ${pagesWithFaq}/${crawlData.pages.length} pages have FAQ content`);

  // Licensing evidence
  evidenceLines.push(`- licensing_signals: llms.txt=${discoveryData?.hasLlmsTxt ?? false}, ucp=${discoveryData?.hasUcp ?? false}`);

  // Contact evidence
  const pagesWithContact = crawlData.pages.filter(
    (p) => Array.isArray(p.contactInfo) && p.contactInfo.some((ci) => ci && ci.trim().length > 0),
  ).length;
  evidenceLines.push(`- contact_trust: ${pagesWithContact}/${crawlData.pages.length} pages have contact info`);

  // Freshness evidence
  const datePattern = /\b(20\d{2}|19\d{2})\b|updated|published|last modified/i;
  const pagesWithDates = crawlData.pages.filter((p) => datePattern.test(p.content ?? "")).length;
  evidenceLines.push(`- content_freshness: ${pagesWithDates}/${crawlData.pages.length} pages have date signals`);

  const flagLines = flags.map(
    (f) =>
      `- ${f.pillar}: current score ${f.originalScore}, evidence shows: ${f.evidenceSummary}`,
  );

  const pillarScores = flags
    .map((f) => {
      const p = scorecard.pillars.find((s) => s.pillar === f.pillar);
      return p ? `  "${f.pillar}": { "score": ${p.score}, "findings": ${JSON.stringify(p.findings)} }` : null;
    })
    .filter(Boolean)
    .join(",\n");

  const correctionPrompt = `You are reviewing GEO audit pillar scores. The following scores appear inconsistent with hard crawl evidence. Revise ONLY the flagged pillars.

HARD EVIDENCE FROM CRAWL:
${evidenceLines.join("\n")}

FLAGGED PILLARS (scores inconsistent with evidence):
${flagLines.join("\n")}

CURRENT SCORES FOR FLAGGED PILLARS:
{
${pillarScores}
}

Return a JSON object with revised scores and findings for ONLY the flagged pillars. Use precise scores, not round numbers. Scores must be consistent with the evidence above.

Format:
{
  "<pillar_id>": { "score": <number>, "findings": "<1-2 sentence finding grounded in the evidence>" }
}`;

  try {
    const raw = await callGemini(correctionPrompt);
    // NEW-AI-04: strip markdown fences before parsing (mirrors primary scorecard parse)
    const stripped = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(stripped) as Record<string, { score: number; findings: string }>;
    return parsed;
  } catch {
    // If correction call fails, fall through to deterministic clamp
    return null;
  }
}
