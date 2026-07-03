/**
 * ES-045: Per-Page Fix Generator
 *
 * Generates suggested SEO/GEO fixes per page using gpt-5.4-mini.
 * Caps at 100 pages (highest-vulnerability first), batches 15 pages per LLM call,
 * runs up to 7 batches in parallel. Batch failures are non-fatal.
 */

import OpenAI from "openai";
import { matchesPageTarget } from "@/lib/serve-utils";
import type { CrawlData, CrawledPage } from "@/lib/services/geo-crawler";
import type { GeoScorecard } from "@/lib/services/geo-analyzer";
import type { PageZoneAudit, ZoneSuggestion, ContentZone, PageStrategyScores } from "@/lib/types/content-strategy";

// ── Types ──────────────────────────────────────────────────────────────────

export interface PerPageFix {
  url: string;
  pageType: string;
  currentTitle: string;
  suggestedTitle: string | null;
  suggestedMetaDescription: string | null;
  h1Fix: string | null;
  headingFixes: string | null;
  pillarFixes: Array<{
    pillar: string;
    pillarName: string;
    fix: string;
    fixScope: "site-side";
  }>;
  matchedSchemaBlocks: string[];
  zoneSuggestions: ZoneSuggestion[];  // ES-055 C9
}

// ── ES-055 C9: Zone evidence map ──────────────────────────────────────────

const ZONE_EVIDENCE: Record<ContentZone, string> = {
  direct_answer:    "44.2% of citations come from first 30% of content",
  expert_quote:     "+41% visibility (Princeton GEO)",
  data_evidence:    "+33% visibility (Princeton GEO)",
  faq_section:      "4.9 avg citations vs 4.4 without (SE Ranking)",
  quotable_block:   "Optimal for AI extraction (40-60 words, standalone)",
  comparison_table: "Highly extractable by AI for ranked list responses",
};

const ZONE_INSERT_AFTER: Record<ContentZone, string> = {
  direct_answer:    "page title",
  comparison_table: "introduction paragraph",
  data_evidence:    "first main section",
  expert_quote:     "first main section",
  faq_section:      "main content body",
  quotable_block:   "relevant paragraph",
};

// ── ES-055 C9: auditPageZones ─────────────────────────────────────────────

/**
 * Audit a page for the presence of content zones.
 * Pure function — no LLM.
 */
export function auditPageZones(
  page: CrawledPage,
  pageStrategyScores?: PageStrategyScores
): PageZoneAudit {
  const content = page.content ?? "";

  // Direct Answer: first 100 words contain a clear declarative statement
  // Heuristic: first sentence > 15 words, doesn't start with a question word
  const first100Words = content.trim().split(/\s+/).slice(0, 100).join(" ");
  const firstSentenceMatch = first100Words.match(/^[^.!?]+[.!?]/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0].trim() : first100Words;
  const QUESTION_WORDS = /^\s*(What|Who|Where|When|Why|How|Are|Is|Do|Does|Did|Can|Could|Should|Would|Will|Have|Has|Had)\b/i;
  const NAV_PATTERNS = /^(Browse|Menu|Home|Skip|Click|Select|Choose|Search|Login|Sign)\b/i;
  const hasDirectAnswer =
    firstSentence.split(/\s+/).length > 15 &&
    !QUESTION_WORDS.test(firstSentence) &&
    !NAV_PATTERNS.test(firstSentence.trim());

  // Comparison Table: <table> with >= 2 rows
  const tableMatches = content.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  const hasComparisonTable = tableMatches.some(table => {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    return rows.length >= 2;
  });

  // Data & Evidence: statistics.count >= 3 (requires pageStrategyScores)
  const hasDataEvidence = (pageStrategyScores?.statistics.count ?? 0) >= 3;

  // Expert Quote: quotations.count >= 1 && hasAttribution
  const hasExpertQuote =
    (pageStrategyScores?.quotations.count ?? 0) >= 1 &&
    (pageStrategyScores?.quotations.hasAttribution ?? false);

  // FAQ Section: faqContent.length > 0
  const hasFaqSection = (page.faqContent?.length ?? 0) > 0;

  // Quotable Block: paragraph (split by \n\n) that is 40-60 words, no pronouns, standalone
  const PRONOUNS = /\b(I|we|you|he|she|they|my|our|your|his|her|their)\b/i;
  const paragraphs = content.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const hasQuotableBlock = paragraphs.some(para => {
    const words = para.split(/\s+/).filter(w => w.length > 0);
    return words.length >= 40 && words.length <= 60 && !PRONOUNS.test(para);
  });

  // Build missingZones list
  const zoneChecks: Array<[ContentZone, boolean]> = [
    ["direct_answer",    hasDirectAnswer],
    ["comparison_table", hasComparisonTable],
    ["data_evidence",    hasDataEvidence],
    ["expert_quote",     hasExpertQuote],
    ["faq_section",      hasFaqSection],
    ["quotable_block",   hasQuotableBlock],
  ];
  const missingZones = zoneChecks.filter(([, present]) => !present).map(([zone]) => zone);

  console.debug(`[page-fix.zone-audit] ${page.url} missingZones=${missingZones.join(",")}`);

  return {
    url: page.url,
    hasDirectAnswer,
    hasComparisonTable,
    hasDataEvidence,
    hasExpertQuote,
    hasFaqSection,
    hasQuotableBlock,
    missingZones,
  };
}

/**
 * Build zone suggestions for missing zones.
 * Thin pages (< 300 words) get only direct_answer suggestion.
 */
function buildZoneSuggestions(
  audit: PageZoneAudit,
  wordCount: number,
  isPaidUser: boolean
): ZoneSuggestion[] {
  const relevantMissing = wordCount < 300
    ? audit.missingZones.filter(z => z === "direct_answer")
    : audit.missingZones;

  return relevantMissing.map(zone => ({
    zone,
    exists: false,
    suggestion: isPaidUser
      ? `Add a ${zone.replace(/_/g, " ")} block to this page to improve AI discoverability.`
      : `Add a ${zone.replace(/_/g, " ")} to this page.`,
    evidence: ZONE_EVIDENCE[zone],
    insertAfter: ZONE_INSERT_AFTER[zone],
  }));
}

// ── Constants ──────────────────────────────────────────────────────────────

const MAX_PAGES = 100;
const BATCH_SIZE = 15;

// ── Helpers ────────────────────────────────────────────────────────────────

interface SchemaBlock {
  "@type"?: string;
  pageTarget?: string;
  [key: string]: unknown;
}

interface ScorecardPillar {
  pillar: string;
  pillarName?: string;
  impactedPages?: string[];
}

function countVulnerabilities(page: CrawlData["pages"][number]): number {
  let count = 0;
  if (!page.title || page.title.trim() === "") count += 2;
  if (!page.headings || page.headings.length === 0) count += 1;
  if (!page.hasStructuredData) count += 1;
  if (!page.faqContent || page.faqContent.length === 0) count += 1;
  return count;
}

function getImpactedPillars(
  pageUrl: string,
  pillars: ScorecardPillar[]
): Array<{ pillar: string; pillarName: string }> {
  return pillars
    .filter((p) => p.impactedPages?.some((ip) => ip === pageUrl || pageUrl.includes(ip)))
    .map((p) => ({ pillar: p.pillar, pillarName: p.pillarName ?? p.pillar }));
}

function buildPageSummary(
  page: CrawlData["pages"][number],
  impactedPillars: Array<{ pillar: string; pillarName: string }>
): string {
  const h1 = page.headings?.[0]?.text ?? "(none)";
  const snippet = (page.content ?? "").slice(0, 200);
  const pillars = impactedPillars.map((p) => p.pillarName).join(", ") || "(none)";
  return `URL: ${page.url}
Current title: ${page.title || "(missing)"}
Current H1: ${h1}
Page type: ${page.pageType ?? "unknown"}
Content snippet: ${snippet}
Affected pillars: ${pillars}`;
}

const PAGE_FIX_SYSTEM_PROMPT = `You are a technical SEO and GEO consultant specializing in AI discoverability. Your job is to suggest specific, actionable fixes for each page to improve both traditional search ranking and how AI systems (ChatGPT, Perplexity, Gemini, Google AI Overviews) discover and cite the content.

<constraints>
- All fixes are site-side changes the business owner makes on their own website
- Do NOT mention FlowBlinq or any audit tool
- Every pillarFixes[].fixScope must be "site-side"
</constraints>

<output_format>
Return a JSON object with key "fixes" containing an array of objects, one per page, in the same order as input.

Each object:
{
  "url": "https://example.com/about",
  "suggestedTitle": "About Acme Corp — Organic Dog Food Since 2019" or null,
  "suggestedMetaDescription": "Acme Corp makes organic dog food in Portland, OR. Free-range ingredients, vet-approved recipes. Order online." or null,
  "h1Fix": "About Acme Corp: Organic Dog Food Made in Portland" or null,
  "headingFixes": "Change H4 FAQ headings to H2. Remove duplicate H1 at page bottom." or null,
  "pillarFixes": [
    {"pillar": "semantic_html", "pillarName": "Semantic HTML", "fix": "Replace H4 FAQ headings with H2 to maintain proper hierarchy.", "fixScope": "site-side"}
  ]
}

Rules for suggested copy:
- suggestedTitle: 50-60 characters, include brand name + primary keyword + location if local business
- suggestedMetaDescription: 120-155 characters, answer-first, include what/who/where
- h1Fix: should match the page's primary topic, be unique across the site, single H1 per page
- Return null for any field where the current value is already good
</output_format>`;

function buildPrompt(
  pageSummaries: string[],
  isPaidUser: boolean
): string {
  const toneInstruction = isPaidUser
    ? `Give exact values ready to paste in — not vague guidance.`
    : `Give general guidance describing what to improve, not exact copy.`;

  return `${toneInstruction}

Analyze these pages and suggest fixes:

${pageSummaries.join("\n\n---\n\n")}`;
}

// ── Main export ────────────────────────────────────────────────────────────

export async function generatePerPageFixes(
  domain: string,
  crawlData: CrawlData,
  geoScorecard: GeoScorecard,
  schemaBlocks: SchemaBlock[],
  isPaidUser: boolean
): Promise<PerPageFix[]> {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Sort pages by vulnerability count descending, cap at 100
  const sortedPages = [...crawlData.pages]
    .sort((a, b) => countVulnerabilities(b) - countVulnerabilities(a))
    .slice(0, MAX_PAGES);

  if (sortedPages.length === 0) return [];

  // Split into batches of 15
  const batches: Array<typeof sortedPages> = [];
  for (let i = 0; i < sortedPages.length; i += BATCH_SIZE) {
    batches.push(sortedPages.slice(i, i + BATCH_SIZE));
  }

  const pillars = geoScorecard.pillars as ScorecardPillar[];

  // Run all batches in parallel (non-fatal on failure)
  const batchResults = await Promise.all(
    batches.map(async (batch, batchIndex) => {
      try {
        const pageSummaries = batch.map((page) => {
          const impactedPillars = getImpactedPillars(page.url, pillars);
          return buildPageSummary(page, impactedPillars);
        });

        const prompt = buildPrompt(pageSummaries, isPaidUser);

        const response = await openai.chat.completions.create({
          model: "gpt-5.4-mini",
          messages: [
            { role: "system", content: PAGE_FIX_SYSTEM_PROMPT },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
        });

        const raw = response.choices[0]?.message?.content ?? "[]";

        // OpenAI json_object wraps arrays — unwrap if needed
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          console.warn(JSON.stringify({ event: "page_fixes_batch_failed", siteId: domain, batchIndex, error: "JSON parse error" }));
          return [];
        }

        // Unwrap {fixes: [...]} or {pages: [...]} wrapping if present
        let fixesArray: unknown[];
        if (Array.isArray(parsed)) {
          fixesArray = parsed;
        } else if (parsed && typeof parsed === "object") {
          const obj = parsed as Record<string, unknown>;
          const candidate = obj.fixes ?? obj.pages ?? obj.results ?? Object.values(obj)[0];
          fixesArray = Array.isArray(candidate) ? candidate : [];
        } else {
          fixesArray = [];
        }

        // Only keep fixes for pages that were actually in this batch (LLM may return extras)
        const batchUrls = new Set(batch.map((p) => p.url));
        fixesArray = fixesArray.filter((item) => {
          const url = String((item as Record<string, unknown>).url ?? "");
          return batchUrls.has(url);
        });

        // Map each LLM fix to a PerPageFix, matching schema blocks
        return fixesArray.map((item): PerPageFix => {
          const fix = item as Record<string, unknown>;
          const pageUrl = String(fix.url ?? "");
          const pageData = batch.find((p) => p.url === pageUrl);
          const zoneAudit = pageData ? auditPageZones(pageData) : null;
          const wordCount = pageData?.content
            ? pageData.content.trim().split(/\s+/).filter(w => w.length > 0).length
            : 0;
          const zoneSuggestions = zoneAudit ? buildZoneSuggestions(zoneAudit, wordCount, isPaidUser) : [];

          // Match schema blocks to this page's URL path
          const matchedSchemaBlocks: string[] = schemaBlocks
            .filter((block) => {
              const target = String(block.pageTarget ?? "all pages");
              try {
                const urlPath = new URL(pageUrl).pathname;
                return matchesPageTarget(target, urlPath);
              } catch {
                return matchesPageTarget(target, pageUrl);
              }
            })
            .map((block) => String(block["@type"] ?? "Schema"));

          // Ensure all pillarFixes have fixScope: "site-side"
          const pillarFixes = (Array.isArray(fix.pillarFixes) ? fix.pillarFixes : []).map(
            (pf: unknown) => {
              const pfObj = pf as Record<string, unknown>;
              return {
                pillar: String(pfObj.pillar ?? ""),
                pillarName: String(pfObj.pillarName ?? ""),
                fix: String(pfObj.fix ?? ""),
                fixScope: "site-side" as const,
              };
            }
          );

          return {
            url: pageUrl,
            pageType: String(fix.pageType ?? pageData?.pageType ?? "unknown"),
            currentTitle: String(fix.currentTitle ?? pageData?.title ?? ""),
            suggestedTitle: fix.suggestedTitle != null ? String(fix.suggestedTitle) : null,
            suggestedMetaDescription: fix.suggestedMetaDescription != null ? String(fix.suggestedMetaDescription) : null,
            h1Fix: fix.h1Fix != null ? String(fix.h1Fix) : null,
            headingFixes: fix.headingFixes != null ? String(fix.headingFixes) : null,
            pillarFixes,
            matchedSchemaBlocks,
            zoneSuggestions,
          };
        });
      } catch (err) {
        console.warn(JSON.stringify({ event: "page_fixes_batch_failed", siteId: domain, batchIndex, error: String(err) }));
        return [];
      }
    })
  );

  const allFixes = batchResults.flat();

  console.warn(JSON.stringify({
    event: "page_fixes_generated",
    siteId: domain,
    pageCount: sortedPages.length,
    fixCount: allFixes.length,
    isPaid: isPaidUser,
  }));

  return allFixes;
}
