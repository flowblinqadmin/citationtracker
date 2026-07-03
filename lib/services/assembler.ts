import type { CrawlData } from "./geo-crawler";
import type { GeoScorecard } from "./geo-analyzer";
import type { GeneratedContent, SchemaBlock } from "./content-generator";
import type { CompetitiveIntel } from "./competitive-intel";
import { callClaude } from "@/lib/claude";

export interface RankedRecommendation {
  rank: number;
  title: string;
  description: string;
  impact: "critical" | "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
  pillar: string;
  specificAction: string;
  estimatedBoost: string;
  evidence: string | null;  // ES-054: research backing, e.g. "+41% visibility (Princeton GEO)"
}

export interface AssemblyResult {
  executiveSummary: string;
  rankedRecommendations: RankedRecommendation[];
  projectedScore: number;
}

const IMPACT_SCORES = { critical: 4, high: 3, medium: 2, low: 1 };

// ES-054: Evidence database — hardcoded research citations, keyed by pillar ID
const EVIDENCE_DATABASE: Record<string, { evidence: string; source: string }> = {
  author_authority:        { evidence: "+41% visibility", source: "Princeton GEO (KDD 2024)" },
  evidence_statistics:     { evidence: "+33% visibility", source: "Princeton GEO (KDD 2024)" },
  internal_linking:        { evidence: "+28% visibility", source: "Princeton GEO (KDD 2024)" },
  content_structure:       { evidence: "44.2% of citations from first 30% of content", source: "Growth Memo (2026)" },
  faq_coverage:            { evidence: "4.9 avg citations vs 4.4 without", source: "SE Ranking (2025)" },
  offering_clarity:        { evidence: "~61% AI coverage vs ~13% for >3K words", source: "houtini-ai research" },
};

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

export interface ContentCheckResult {
  passed: boolean;
  failures: string[];
}

export function checkGeneratedContent(generatedContent: GeneratedContent): ContentCheckResult {
  const failures: string[] = [];

  // llmsTxt checks
  const llms = generatedContent.llmsTxt;
  if (!llms || llms.length < 200) failures.push("llmsTxt too short");
  else {
    if (!/^# .+/m.test(llms)) failures.push("llmsTxt missing title (# heading)");
    if (!/^> .+/m.test(llms)) failures.push("llmsTxt missing summary (> blockquote)");
    if (!/## Key Concepts/i.test(llms)) failures.push("llmsTxt missing Key Concepts section");
    if (!/## Products|## Services|## Coverage|## Topics|## Content/i.test(llms)) failures.push("llmsTxt missing Products/Services/Coverage section");
    if (llms.split("\n").length < 20) failures.push("llmsTxt too thin (under 20 lines)");
  }

  // businessJson checks
  const bj = generatedContent.businessJson as Record<string, unknown>;
  const geo = (bj?.geo_profile ?? {}) as Record<string, unknown>;
  const services = Array.isArray(geo.services) ? geo.services as string[] : [];
  const topics = Array.isArray(geo.topics) ? geo.topics as string[] : [];
  const coverageAreas = Array.isArray(geo.coverage_areas) ? geo.coverage_areas as string[] : [];
  const contentCategories = Array.isArray(geo.content_categories) ? geo.content_categories as string[] : [];
  const offeringsCount = services.length + topics.length + coverageAreas.length + contentCategories.length;
  if (Object.keys(bj ?? {}).length < 4) failures.push("businessJson has fewer than 4 top-level keys");
  if (typeof geo.description !== "string" || (geo.description as string).length < 30) failures.push("businessJson missing or short description");
  if (offeringsCount < 2) failures.push("businessJson fewer than 2 services/topics extracted");

  // schemaBlocks checks
  const blocks = generatedContent.schemaBlocks;
  if (!blocks || blocks.length < 3) failures.push(`schemaBlocks only ${blocks?.length ?? 0} blocks (need ≥3)`);
  else {
    const hasOrg = blocks.some((b) => b.type === "Organization" || b.name === "Organization");
    if (!hasOrg) failures.push("schemaBlocks missing Organization block");
  }

  return { passed: failures.length === 0, failures };
}

export function checkExecutiveSummary(summary: string): ContentCheckResult {
  const failures: string[] = [];
  if (!summary || summary.length < 200) failures.push("executiveSummary too short or empty");
  if (summary.length > 0 && !summary.includes("\n")) failures.push("executiveSummary appears to be a single paragraph (expected 3)");
  return { passed: failures.length === 0, failures };
}

/**
 * Compute a projected score based on what was actually generated.
 *
 * For each pillar, we apply a realistic boost only when the generated assets
 * directly address what the scorer measures for that pillar. Boosts are capped
 * so projected scores never exceed what the pillar scoring guide benchmarks allow
 * for "assets installed but site content unchanged."
 *
 * The result is a weighted average of projected pillar scores — same formula
 * the analyzer uses — so it's directly comparable to the current score.
 */
export function computeProjectedScore(
  geoScorecard: GeoScorecard,
  generatedContent: GeneratedContent
): number {
  const schemaTypes = new Set(generatedContent.schemaBlocks.map((b) => b.type));
  const llmsTxt = generatedContent.llmsTxt ?? "";
  const llmsFullTxt = generatedContent.llmsFullTxt ?? "";
  const bizJson = generatedContent.businessJson as Record<string, unknown>;
  const geoProfile = (bizJson?.geo_profile ?? {}) as Record<string, unknown>;

  // Detect what was actually generated
  const hasOrganizationSchema  = schemaTypes.has("Organization");
  const hasBreadcrumbSchema    = schemaTypes.has("BreadcrumbList");
  const hasFaqPageSchema       = schemaTypes.has("FAQPage");
  const hasArticleSchema       = schemaTypes.has("Article");
  const hasPersonSchema        = schemaTypes.has("Person");
  const hasDefinedTermSchema   = schemaTypes.has("DefinedTerm");
  const hasRobotsTxtBlock      = schemaTypes.has("RobotsTxt");
  const hasSpeakableSchema     = schemaTypes.has("WebPage") &&
    generatedContent.schemaBlocks.some((b) => b.type === "WebPage" && b.name?.toLowerCase().includes("speakable"));
  const hasLlmsTxt             = llmsTxt.length > 200;
  const hasLlmsFullTxt         = llmsFullTxt.length > 200;
  const hasKeyConceptsDefs     = /## Key Concepts/i.test(llmsTxt) &&
    (llmsTxt.includes("is a") || llmsTxt.includes("refers to"));
  const hasTeamSection         = /## Team/i.test(llmsTxt) || /## Team/i.test(llmsFullTxt);
  const hasPersonProfiles      = Array.isArray(geoProfile.author_profiles) &&
    (geoProfile.author_profiles as unknown[]).length > 0;
  const hasEditorialStandards  = typeof geoProfile.editorial_standards === "object" &&
    geoProfile.editorial_standards !== null;
  const hasEvidenceSection     = /## Evidence/i.test(llmsFullTxt);
  const hasBusinessJson        = Object.keys(bizJson ?? {}).length >= 4;

  // Per-pillar asset ceilings — calibrated to the scoring guide's benchmarks for
  // what our generated assets specifically deliver, without requiring site content changes.
  //
  // Scoring guide bands:
  //   95+  = matches the named benchmark site exactly (e.g. anthropic.com for licensing_signals)
  //   75–90 = significantly exceeds typical range, falls short of benchmark
  //   60–75 = high end of typical range
  //
  // We set ceilings at the highest score our assets can credibly reach:
  // - licensing_signals: we generate ALL four signals the guide requires for 95+ (llms.txt +
  //   llms-full.txt + business.json + named AI bot robots.txt directives). Ceiling = 95.
  // - structured_data: we generate the full multi-schema stack (Org + Breadcrumb + FAQPage +
  //   Article + DefinedTerm + Speakable). The guide's 95+ benchmark requires zero validation
  //   errors — we can't guarantee that without site-side install. Ceiling = 88.
  // - faq_coverage: FAQPage schema on every page with FAQ content is most of what's rewarded.
  //   Questions phrased as user queries still depend on site content. Ceiling = 85.
  // - entity_definitions: DefinedTerm schema + extractable Key Concepts covers schema and
  //   definition format. Dedicated term pages still needed for full credit. Ceiling = 80.
  // - author_authority: Person schema amplifies named authors but can't create them. If the
  //   site has no named people, schema alone has minimal effect. Ceiling = 68.
  // - contact_trust: contactPoint in Org schema + editorial_standards covers schema signals.
  //   Physical HQ address and 3+ contact routes still need to be on the site. Ceiling = 78.
  // - evidence_statistics: Evidence section in llms-full.txt surfaces existing stats. Inline
  //   hyperlinked citations on actual pages still required for full credit. Ceiling = 75.
  // - metadata_freshness: last_updated in business.json + dates in llms.txt. Last-Modified
  //   HTTP headers and per-page dateModified remain site-side. Ceiling = 78.
  // - content_structure: answer-first About section in llms.txt. Actual page structure
  //   (Key Takeaways, Bottom Line) unchanged by our assets. Ceiling = 72.
  // - Pillars with no asset coverage: ceiling = current score (no regression, no false uplift).
  const PILLAR_CEILINGS: Record<string, number> = {
    licensing_signals:   95,  // we deliver ALL four signals the guide requires for 95+
    structured_data:     88,  // full multi-schema stack; zero-error guarantee needs site install
    faq_coverage:        85,  // FAQPage per page; question phrasing is site content
    entity_definitions:  80,  // DefinedTerm + Key Concepts; dedicated term pages still needed
    contact_trust:       78,  // contactPoint schema; physical address is site content
    metadata_freshness:  78,  // business.json last_updated; HTTP headers are site-side
    evidence_statistics: 75,  // Evidence section in llms-full.txt; inline citations site-side
    author_authority:    68,  // Person schema amplifies existing authors; can't invent them
    content_structure:   72,  // answer-first llms.txt About; page structure unchanged
  };

  const pillarBoosts: Record<string, number> = {};

  // ── structured_data (weight 4.6) ────────────────────────────────────────────
  // Scoring guide: 95+ = multi-schema stacking per page type, zero validation errors.
  // ~50 = Organization on homepage only.
  // Quality: which schema types are present (stacking = multiplicative signal).
  // Coverage: how many page types have correct schema (blog→Article, FAQ pages→FAQPage).
  {
    const articleCount = generatedContent.schemaBlocks.filter((b) => b.type === "Article").length;
    const faqSchemaCount = generatedContent.schemaBlocks.filter((b) => b.type === "FAQPage").length;
    let boost = 0;
    // Foundation layer — sitewide schema
    if (hasOrganizationSchema) boost += 6;   // Organization is baseline; missing = ~50 band
    if (hasBreadcrumbSchema)   boost += 4;   // Breadcrumb required for multi-schema stacking
    if (hasSpeakableSchema)    boost += 2;   // Speakable = AI assistant parsing signal
    // Per-page schema — coverage drives the score above the 60–75 band
    if (faqSchemaCount >= 1)   boost += 5;   // Any FAQPage schema moves out of ~50 band
    if (faqSchemaCount >= 3)   boost += 3;   // 3+ pages = systematic, not one-off
    if (articleCount >= 1)     boost += 3;   // Article schema on blog posts
    if (articleCount >= 5)     boost += 3;   // Coverage across most blog content
    // Schema depth — DefinedTerm is additive evidence of schema sophistication
    if (hasDefinedTermSchema)  boost += 3;
    pillarBoosts["structured_data"] = boost;
  }

  // ── licensing_signals (weight 2.5) ──────────────────────────────────────────
  // Scoring guide: 60+ just for valid llms.txt. 95+ = llms.txt + llms-full.txt +
  // named AI bot directives + business.json. Each sub-signal is independently scored.
  // Quality: llms.txt must have structured sections (About, Key Concepts, Contact).
  // Coverage: does it represent the full business or just a stub?
  {
    // llms.txt quality — scored on structural completeness, not just existence
    const llmsLineCount = llmsTxt.split("\n").filter((l: string) => l.trim()).length;
    const llmsHasSections = hasLlmsTxt &&
      /## About/i.test(llmsTxt) &&
      /## Key Concepts/i.test(llmsTxt) &&
      /## Products|## Services/i.test(llmsTxt);
    const llmsHasContact = hasLlmsTxt && /## Contact/i.test(llmsTxt);

    let boost = 0;
    if (hasLlmsTxt && llmsLineCount >= 10)  boost += 8;   // minimal valid llms.txt
    if (llmsHasSections)                     boost += 7;   // structured sections = quality signal
    if (llmsHasContact)                      boost += 3;   // contact section = completeness
    // llms-full.txt — comprehensive version adds independent scoring signal
    if (hasLlmsFullTxt)                      boost += 8;   // llms-full.txt = distinct from llms.txt
    // business.json — machine-readable vendor profile
    if (hasBusinessJson)                     boost += 5;
    // Named AI bot directives — the final piece for 95+
    if (hasRobotsTxtBlock)                   boost += 9;   // named GPTBot/ClaudeBot/PerplexityBot
    pillarBoosts["licensing_signals"] = boost;
  }

  // ── entity_definitions (weight 3.6) ─────────────────────────────────────────
  // Scoring guide: 95+ = dedicated term pages + extractable 1-sentence opening definition
  // + DefinedTerm schema + cross-links. ~50 = jargon used without definition.
  // Quality: "is a / refers to" format is the extractable pattern AI bots prefer.
  // Coverage: number of terms defined — 1–2 = weak, 5+ = systematic glossary signal.
  {
    // Count how many terms use the extractable format in Key Concepts
    const conceptMatches = llmsTxt.match(/\*\*[^*]+\*\*[:\s]+(?:is (?:a |an |the )|refers to )/gi) ?? [];
    const extractableCount = conceptMatches.length;
    // Count DefinedTerm schema blocks generated
    const definedTermCount = generatedContent.schemaBlocks.filter((b) => b.type === "DefinedTerm").length;

    let boost = 0;
    // Quality: extractable definition format
    if (extractableCount >= 1)  boost += 4;   // any extractable definition
    if (extractableCount >= 3)  boost += 4;   // 3+ = consistent pattern, not one-off
    if (extractableCount >= 5)  boost += 3;   // 5+ = approaching glossary-level coverage
    // Schema: DefinedTerm blocks provide machine-readable structured knowledge
    if (definedTermCount >= 1)  boost += 5;   // any DefinedTerm schema
    if (definedTermCount >= 3)  boost += 4;   // 3+ = systematic, matches scoring guide examples
    pillarBoosts["entity_definitions"] = boost;
  }

  // ── faq_coverage (weight 4.5) ────────────────────────────────────────────────
  // Scoring guide: 95+ = FAQ sections on every content page + FAQPage schema +
  // questions phrased as user queries. ~50 = single /faq page, no schema.
  // Quality: are answers substantial (40+ words) and questions user-phrased?
  // Coverage: how many content pages have FAQPage schema vs total content pages.
  {
    const faqBlocks = generatedContent.schemaBlocks.filter((b) => b.type === "FAQPage");
    const faqBlockCount = faqBlocks.length;
    // Quality check: count FAQ pairs with answers that look substantial (proxy: answer length in schema)
    const totalFaqPairs = faqBlocks.reduce((sum: number, b: SchemaBlock) => {
      const main = (b.jsonLd as Record<string, unknown>)?.mainEntity;
      return sum + (Array.isArray(main) ? main.length : 0);
    }, 0);

    let boost = 0;
    // Coverage: pages with FAQPage schema
    if (faqBlockCount >= 1)  boost += 6;   // any FAQPage schema = out of ~50 band
    if (faqBlockCount >= 3)  boost += 5;   // 3+ pages = not just the /faq page
    if (faqBlockCount >= 6)  boost += 4;   // systematic across content pages
    // Quality: number of Q&A pairs structured in schema (more pairs = more AI citation surface)
    if (totalFaqPairs >= 5)  boost += 4;
    if (totalFaqPairs >= 15) boost += 3;
    pillarBoosts["faq_coverage"] = boost;
  }

  // ── author_authority (weight 4.9) ────────────────────────────────────────────
  // Scoring guide: 95+ = named author + named expert reviewer + credential schema +
  // editorial policy. ~50 = "Staff Writer", no credentials, no Person schema.
  // Quality: Person schema with sameAs LinkedIn is the machine-readable credential signal.
  // Coverage: does every article have an attributed author, or just a team page?
  // NOTE: this pillar fundamentally requires named people to exist on the site.
  // Schema amplifies but cannot invent authors — boosts are modest without real people.
  {
    const personBlocks = generatedContent.schemaBlocks.filter((b) => b.type === "Person");
    const personCount = personBlocks.length;
    // Quality: do Person blocks have sameAs (LinkedIn) = credential signal
    const personWithLinkedIn = personBlocks.filter((b: SchemaBlock) => {
      const jld = b.jsonLd as Record<string, unknown>;
      const sameAs = jld?.sameAs;
      return Array.isArray(sameAs) ? sameAs.some((s: unknown) => String(s).includes("linkedin")) :
        typeof sameAs === "string" && sameAs.includes("linkedin");
    }).length;

    let boost = 0;
    if (personCount >= 1)          boost += 5;   // any Person schema
    if (personCount >= 2)          boost += 3;   // multiple people = team, not just founder
    if (personWithLinkedIn >= 1)   boost += 4;   // LinkedIn sameAs = verifiable credential signal
    if (hasPersonProfiles)         boost += 3;   // structured profiles in business.json
    if (hasTeamSection)            boost += 3;   // named team in llms.txt (AI-readable)
    // Editorial standards: certification extraction signals review process
    if (hasEditorialStandards) {
      const certs = (geoProfile.editorial_standards as Record<string, unknown>)?.certifications;
      const hasCerts = Array.isArray(certs) && (certs as unknown[]).length > 0;
      boost += hasCerts ? 3 : 1;  // actual certs found vs just the field present
    }
    pillarBoosts["author_authority"] = boost;
  }

  // ── contact_trust (weight 4.3) ───────────────────────────────────────────────
  // Scoring guide: 95+ = physical address + 3+ contact routes + certifications
  // linked to docs + contactPoint in schema.
  // Quality: contactPoint in Organization schema is the machine-readable signal.
  // Coverage: how many contact routes are represented in the schema.
  {
    const orgBlock = generatedContent.schemaBlocks.find((b) => b.type === "Organization");
    const orgJld = (orgBlock?.jsonLd ?? {}) as Record<string, unknown>;
    const hasContactPoint = Boolean(orgJld?.contactPoint);
    const hasSameAs = Array.isArray(orgJld?.sameAs) && (orgJld.sameAs as unknown[]).length >= 2;
    const certs = (geoProfile.editorial_standards as Record<string, unknown> | undefined)?.certifications;
    const certCount = Array.isArray(certs) ? (certs as unknown[]).length : 0;

    let boost = 0;
    if (hasOrganizationSchema)  boost += 3;   // Organization schema exists
    if (hasContactPoint)        boost += 5;   // contactPoint = machine-readable contact route
    if (hasSameAs)              boost += 3;   // 2+ social profiles = multiple contact surfaces
    if (hasBusinessJson)        boost += 3;   // structured vendor profile
    if (certCount >= 1)         boost += 4;   // certifications extracted from site
    if (certCount >= 2)         boost += 2;   // multiple certifications = stronger trust signal
    pillarBoosts["contact_trust"] = boost;
  }

  // ── evidence_statistics (weight 4.0) ─────────────────────────────────────────
  // Scoring guide: 95+ = every stat hyperlinked to primary source + precise numbers +
  // at least one proprietary data point. ~50 = "studies show X" with no citation.
  // Quality: "Source:" attribution in Evidence section = the machine-readable citation format.
  // Coverage: how many distinct stats with attribution.
  {
    // Count sourced stat lines in Evidence section (format: "X% ... (Source: ...)")
    const evidenceSection = llmsFullTxt.match(/## Evidence[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
    const sourcedStats = (evidenceSection.match(/\(Source:/gi) ?? []).length;
    const preciseNumbers = (evidenceSection.match(/\d+\.?\d*\s*%|\$[\d,]+|\d+[xX]\s/g) ?? []).length;

    let boost = 0;
    if (hasEvidenceSection)      boost += 4;   // Evidence section exists
    if (sourcedStats >= 1)       boost += 4;   // any sourced stat = quality signal
    if (sourcedStats >= 3)       boost += 3;   // 3+ sourced stats = systematic
    if (preciseNumbers >= 2)     boost += 2;   // precise numbers (%, $, X multiplier)
    if (hasLlmsFullTxt)          boost += 2;   // llms-full.txt surfacing evidence to AI bots
    pillarBoosts["evidence_statistics"] = boost;
  }

  // ── metadata_freshness (weight 3.7) ──────────────────────────────────────────
  // Scoring guide: 95+ = unique meta descriptions + accurate dateModified + live
  // sitemap + Last-Modified header. Our assets contribute: last_updated in
  // business.json + year signals in llms.txt.
  // Quality: a specific date (not just a year) in llms.txt = stronger freshness signal.
  {
    const hasYear = hasLlmsTxt && /20\d\d/.test(llmsTxt);
    const hasSpecificDate = hasLlmsTxt && /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+20\d\d|20\d\d-\d{2}-\d{2}/i.test(llmsTxt);
    const bizLastUpdated = (generatedContent.businessJson as Record<string, unknown>)?.last_updated;
    const hasLastUpdated = typeof bizLastUpdated === "string" && bizLastUpdated.length > 0;

    let boost = 0;
    if (hasYear)          boost += 3;   // any year in llms.txt = basic recency signal
    if (hasSpecificDate)  boost += 3;   // specific month+year or ISO date = stronger signal
    if (hasLastUpdated)   boost += 3;   // last_updated in business.json = machine-readable freshness
    pillarBoosts["metadata_freshness"] = boost;
  }

  // ── content_structure (weight 4.1) ───────────────────────────────────────────
  // Scoring guide: 95+ = answer in first 100 words + summary box + chunked sections +
  // explicit conclusion. Our assets contribute: answer-first About in llms.txt.
  // Quality: does the About section actually lead with the answer, not a preamble?
  {
    const aboutSection = llmsTxt.match(/## About[\s\S]*?(?=\n##|$)/i)?.[0] ?? "";
    // A strong answer-first opening names what the company does in the first sentence
    const firstSentence = aboutSection.split(/[.!?]/)[0] ?? "";
    const isAnswerFirst = firstSentence.length > 20 && firstSentence.length < 200;

    let boost = 0;
    if (isAnswerFirst)                          boost += 3;   // About section leads with the answer
    if (/## Key Concepts/i.test(llmsTxt))       boost += 2;   // structured concepts = AI parse signal
    pillarBoosts["content_structure"] = boost;
  }

  // Pillars with no meaningful asset coverage — no boost applied:
  // semantic_html     — requires site HTML changes
  // internal_linking  — requires editorial linking decisions
  // multi_format      — requires video/infographic/table production
  // cta_structure     — requires page design changes
  // competitive_positioning — requires /compare/ pages with content
  // content_freshness — requires actual content updates with visible dates

  // Recompute weighted average with projected pillar scores
  let totalWeight = 0;
  let weightedSum = 0;

  for (const pillar of geoScorecard.pillars) {
    const weight = GEO_PILLAR_WEIGHTS[pillar.pillar] ?? 3.0;
    const rawBoost = pillarBoosts[pillar.pillar] ?? 0;
    const ceiling = PILLAR_CEILINGS[pillar.pillar] ?? pillar.score; // no ceiling = no change
    // Assets can only improve a pillar, never lower it.
    // Per-pillar ceiling reflects how high our generated assets can credibly push each score.
    const projectedPillarScore = Math.max(pillar.score, Math.min(ceiling, pillar.score + rawBoost));
    totalWeight += weight;
    weightedSum += projectedPillarScore * weight;
  }

  const projectedFromPillars = Math.min(100, Math.round(weightedSum / totalWeight));

  // Guard: projected score must always be >= current overall score.
  // Some older records have a stored overallScore that doesn't match the weighted average
  // of their own pillars (scored before the recomputation fix). We never show a regression.
  return Math.max(geoScorecard.overallScore, projectedFromPillars);
}

export async function assembleResults(
  domain: string,
  crawlData: CrawlData,
  geoScorecard: GeoScorecard,
  generatedContent: GeneratedContent,
  researchData?: CompetitiveIntel,
  isPaidUser?: boolean
): Promise<AssemblyResult> {
  // Rank recommendations by impact — exclude unassessed/ghost pillars
  const rankedRecommendations: RankedRecommendation[] = geoScorecard.pillars
    .filter((p) => p.score < 80 && p.findings !== "Not assessed" && p.findings !== "Could not be assessed from available crawl data.")
    .sort((a, b) => {
      // Primary: weight × gap (research-backed importance × room to improve)
      const aWeightedGap = (GEO_PILLAR_WEIGHTS[a.pillar] ?? 3.0) * (100 - a.score);
      const bWeightedGap = (GEO_PILLAR_WEIGHTS[b.pillar] ?? 3.0) * (100 - b.score);
      if (bWeightedGap !== aWeightedGap) return bWeightedGap - aWeightedGap;
      // Tiebreak: GPT-assigned priority label
      return IMPACT_SCORES[b.priority] - IMPACT_SCORES[a.priority];
    })
    .slice(0, 10)
    .map((p, i) => {
      const ev = EVIDENCE_DATABASE[p.pillar];
      return {
        rank: i + 1,
        title: p.pillarName,
        description: p.findings,
        impact: p.priority,
        effort: p.score < 30 ? "high" : p.score < 60 ? "medium" : "low",
        pillar: p.pillar,
        specificAction: p.recommendation,
        estimatedBoost: getBoostEstimate(p.pillar),
        evidence: ev ? `${ev.evidence} (${ev.source})` : null,
      };
    });

  const criticalPillars = geoScorecard.pillars.filter((p) => p.priority === "critical").map((p) => p.pillarName);
  const faqCount = crawlData.pages.flatMap((p) => p.faqContent).length;
  const hasStructuredData = crawlData.pages.some((p) => p.hasStructuredData);
  const projectedScore = computeProjectedScore(geoScorecard, generatedContent);

  const competitors = researchData?.topCompetitors ?? [];
  const competitorStatus = researchData?.competitorGeoStatus ?? [];
  const competitivePosition = researchData?.competitivePosition ?? "";
  const competitorsWithAi = competitorStatus.filter((c) => c.hasLlmsTxt || c.hasStructuredData).map((c) => c.domain);
  const competitorsBlind = competitorStatus.filter((c) => !c.hasLlmsTxt && !c.hasStructuredData).map((c) => c.domain);

  // Generate executive summary
  const summaryPrompt = `Write a 3-paragraph executive summary for a GEO audit of ${domain}. The reader is the business owner — not a developer, not a marketer.

<data>
Score: ${geoScorecard.overallScore}/100 → projected ${projectedScore}/100 with FlowBlinq
Pages audited: ${crawlData.pages.length} | Q&A pairs found: ${faqCount}
AI-readable signals: ${hasStructuredData ? "partial" : "none"}
Critical gaps: ${criticalPillars.join(", ") || "none identified"}
Top fixes: ${geoScorecard.topThreeImprovements.join("; ")}
Competitors with AI presence: ${competitorsWithAi.length ? competitorsWithAi.join(", ") : "none yet"}
Competitors without: ${competitorsBlind.length ? competitorsBlind.join(", ") : "unknown"}
Position: ${competitivePosition || "not assessed"}
</data>

<research_evidence>
Research-backed evidence for recommendations:
- Expert quotes boost visibility by 41% (Princeton GEO, KDD 2024)
- Statistics and data boost by 33% (Princeton GEO, KDD 2024)
- Citing external sources boosts by 28% (Princeton GEO, KDD 2024)
- 44.2% of AI citations come from the first 30% of page content (Growth Memo, 2026)
- Pages with FAQ sections average 4.9 citations vs 4.4 without (SE Ranking, 2025)

Reference specific evidence when making recommendations.
</research_evidence>

<paragraph_instructions>
PARAGRAPH 1 — Current state
What ${geoScorecard.overallScore}/100 means in plain terms: how often (or rarely) this business shows up when someone asks ChatGPT or Perplexity about their category. Name 1-2 specific gaps. Mention pages audited.

PARAGRAPH 2 — Competitive context
Use the competitive data. State which competitors already have AI-readable signals and which don't. Factually describe ${domain}'s position relative to them — ahead, behind, or similar. No speculation about what "could" or "will" happen. Just the current state of the field.

${isPaidUser
    ? `PARAGRAPH 3 — What to change
Specific actions the business owner should take. E.g. "Adding FAQPage schema to your 12 service pages and fixing the 3 pages with missing H1 tags moves the score from ${geoScorecard.overallScore} to ~${projectedScore}." Name exact page counts and specific fixes. Do NOT mention FlowBlinq. Do NOT add urgency, scarcity, or time pressure.`
    : `PARAGRAPH 3 — What FlowBlinq changes
Score moves from ${geoScorecard.overallScore} to ~${projectedScore}. Name the 1-2 changes that matter most. Do NOT add urgency, scarcity, or time pressure.`}
</paragraph_instructions>

<writing_rules>
1. Tone: factual, measured, neutral. Like an analyst's report — not a sales pitch. State what is, not what might be lost.

2. NEVER use these words or phrases:
additionally, crucial, delve, emphasize/emphasizing, enduring, enhance/enhancing,
foster/fostering, garner, highlight (as verb), intricate, key (as adjective before role/moment),
landscape (figurative), leverage, nestled, pivotal, profound, rich tapestry, seamlessly,
serves as, showcase/showcasing, stands as, tapestry, testament, transformative,
underscore, valuable, vibrant, in the heart of, it's important to note,
reflects broader, setting the stage, marking/shaping the, indelible mark,
deeply rooted, commitment to, diverse array, evolving landscape, holistic,
journey, empower/empowering, unlock/unlocking, game-changer, cutting-edge

3. NEVER use urgency, scarcity, or FOMO language. Banned patterns:
"before it's too late", "won't last", "window is closing", "race", "first mover",
"miss out", "left behind", "invisible", "never arrive", "never see you",
"cost isn't a lost click", "wide open", "won't stay that way",
"if [competitor] gets there first", "every day you wait", "the clock is ticking"
Do NOT imply that inaction leads to catastrophic outcomes. Just state the facts.

4. No technical jargon the owner wouldn't use: no "schema," "structured data markup," "llms.txt," "FAQPage," "API," "semantic HTML."

5. Bold 4-6 phrases that summarize the key facts: the score, what was found, what the fix is. Bold numbers and outcomes — not adjectives or company names.

6. Vary sentence length. Do not start consecutive sentences the same way.

7. No bullet points, no sub-headers, no em-dash pairs used for dramatic emphasis.

8. Open paragraph 2 with a concrete, specific statement — not a sweeping claim about "the industry" or "a shift."

9. Every sentence must be specific to this business and this market. Delete any sentence that could apply to any company in any industry.
</writing_rules>

<example>
A fictional coworking space audit — shows tone and style only, do not copy any sentences:

"WorkHaus scores **41 out of 100** on AI discoverability. We audited 15 pages. When someone asks ChatGPT for coworking spaces with podcast studios in Berlin, WorkHaus doesn't appear — even though it's one of three spaces in the city that has them. The site explains its offerings clearly for a human reader, but none of that information is structured in a way AI tools can parse. The biggest gap: **no machine-readable description** of what WorkHaus is, what it offers, or where it operates.

Of the five coworking brands we checked in Berlin, none have AI-readable signals set up yet. BerlinDesk and CoLab have similar gaps. WorkHaus is **on equal footing with its competitors** in this area — no one in the local market has an advantage.

FlowBlinq moves the score from **41 to roughly 65**. The two changes that matter most: adding structured signals to all 15 pages so AI can accurately describe what WorkHaus offers, and surfacing the people behind the space — founders, community managers — so their expertise carries weight in AI responses."
</example>

Now write the summary for ${domain} using the data above. Do not reuse any sentences from the example. Match the tone, specificity, and sentence variation. Three paragraphs, roughly 150 words total.`;

  const executiveSummary = await callClaude(summaryPrompt);

  return { executiveSummary, rankedRecommendations, projectedScore };
}

function getBoostEstimate(pillar: string): string {
  const boosts: Record<string, string> = {
    faq_coverage: "Pages with FAQ content average 4.9 AI citations vs 4.4 without",
    evidence_statistics: "Up to 40% boost in AI citations",
    entity_definitions: "32% more Perplexity citations",
    structured_data: "2x more citations with multi-schema stacking",
    content_freshness: "85% of AI Overview citations from last 2 years",
    metadata_freshness: "Significant recency boost in AI ranking",
    author_authority: "Improved E-E-A-T trust signals",
    content_structure: "Answer-first chunks in 200-500 words perform best",
    licensing_signals: "Opt-in signals encourage AI platform indexing",
    semantic_html: "Correct heading hierarchy helps AI parse content structure",
    internal_linking: "Topic clusters signal topical authority to AI",
    multi_format: "Multi-format content increases citation surface area",
  };
  return boosts[pillar] ?? "Improves overall AI discoverability score";
}
