import { z } from "zod";
import OpenAI from "openai";
import { createOpenAIClient, resolveOpenAIModel } from "@/lib/llm/openai-route";
import type { CrawlData, CrawledPage } from "./geo-crawler";
import type { CompetitiveIntel } from "./competitive-intel";
import type { GeoScorecard } from "./geo-analyzer";
import { sanitizeForPrompt } from "@/lib/utils/sanitize-for-prompt";

// ES-082 §b.1: re-export typed errors from the dedicated error module so
// callers in app/api/pipeline/stage/route.ts can import them via this barrel
// (`import { LlmsGenerationLengthExhausted, RetryValidationExhausted } from
//  "@/lib/services/content-generator"`).
export {
  LlmsGenerationLengthExhausted,
  RetryValidationExhausted,
} from "./content-generator-errors";
import {
  LlmsGenerationLengthExhausted,
} from "./content-generator-errors";

const SchemaBlockSchema = z.object({
  name: z.string(),
  type: z.string(),
  jsonLd: z.record(z.string(), z.unknown()),
  instructions: z.string(),
  pageTarget: z.string(),
});

const SchemaBlocksResponseSchema = z.object({
  blocks: z.array(SchemaBlockSchema).default([]),
});

// ES-wave-4 §B6 AC-B6-3: in-memory parse-failure counter. Aggregates per-
// process so a sustained provider regression surfaces in logs as a rising
// count rather than scattered single-line warnings.
let _llmParseFailureCount = 0;
export function getLlmParseFailureCount(): number {
  return _llmParseFailureCount;
}
export function resetLlmParseFailureCount(): void {
  _llmParseFailureCount = 0;
}

/**
 * Safe JSON parse with Zod validation — returns fallback on any parse or
 * validation error. ES-wave-4 §B6 AC-B6-1/2: emits a structured
 * `llm_json_parse_failure` event with parse-failure position, response
 * length, and the optional audit_run_id so each silent failure leaves a
 * machine-grep-able trail in the logs.
 */
function safeParse<T>(
  schema: z.ZodType<T>,
  raw: string | null | undefined,
  fallback: T,
  context?: { audit_run_id?: string | null; site_id?: string | null; label?: string },
): T {
  try {
    return schema.parse(JSON.parse(raw ?? "{}"));
  } catch (err) {
    _llmParseFailureCount += 1;
    const responseLength = (raw ?? "").length;
    const isSyntax = err instanceof SyntaxError;
    const position = isSyntax ? extractParsePosition(err.message) : null;
    const issues = err instanceof z.ZodError ? err.issues : null;
    console.warn(
      JSON.stringify({
        event: "llm_json_parse_failure",
        label: context?.label ?? null,
        audit_run_id: context?.audit_run_id ?? null,
        site_id: context?.site_id ?? null,
        response_length: responseLength,
        position,
        zod_issue_count: issues?.length ?? 0,
        zod_issue_paths: issues?.slice(0, 5).map((i) => i.path.join(".")) ?? [],
        cumulative_count: _llmParseFailureCount,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return fallback;
  }
}

function extractParsePosition(msg: string): number | null {
  const m = msg.match(/position\s+(\d+)/i);
  return m ? Number(m[1]) : null;
}

export interface SchemaBlock {
  name: string;
  type: string;
  jsonLd: object;
  instructions: string;
  pageTarget: string;
}

export interface GeneratedContent {
  llmsTxt: string;
  llmsFullTxt: string;
  businessJson: object;
  schemaBlocks: SchemaBlock[];
}

function getOpenAIClient() {
  return createOpenAIClient();
}

function getPage(crawlData: CrawlData, type: string): CrawledPage | undefined {
  return crawlData.pages.find((p) => p.pageType === type);
}

function buildRichContext(domain: string, crawlData: CrawlData): string {
  const homepage = getPage(crawlData, "homepage");
  const about = getPage(crawlData, "about");
  const services = getPage(crawlData, "services");
  const pricing = getPage(crawlData, "pricing");
  const team = getPage(crawlData, "team");
  const contact = getPage(crawlData, "contact");
  const blogs = crawlData.pages.filter((p) => p.pageType === "blog").slice(0, 5);

  // Extract all real contacts (email, phone, address)
  const allContacts = [...new Set(crawlData.pages.flatMap((p) => p.contactInfo))].filter(Boolean);
  const emails = allContacts.filter((c) => c.includes("@"));
  const phones = allContacts.filter((c) => /[\d\-\+\(\)]{7,}/.test(c) && !c.includes("@"));
  const socials = allContacts.filter((c) => c.includes("linkedin") || c.includes("twitter") || c.includes("github") || c.includes("youtube") || c.includes("instagram") || c.includes("x.com"));

  // All FAQ pairs across all pages
  const allFaqs = crawlData.pages.flatMap((p) => p.faqContent);

  // All testimonials
  const allTestimonials = crawlData.pages.flatMap((p) => p.testimonials).slice(0, 5);

  // All certifications
  const allCerts = crawlData.pages.flatMap((p) => p.certifications).slice(0, 5);

  // All discovered page URLs
  const allUrls = crawlData.pages.map((p) => ({ url: p.url, type: p.pageType, title: p.title }));

  // Author/team signals — extract names, credentials, and LinkedIn URLs from team/blog pages
  const teamContent = [team?.content ?? "", ...blogs.map((b) => b.content ?? "")].join(" ");
  const authorLinkedIns = socials.filter((s) => s.includes("linkedin") && (s.includes("/in/") || s.includes("/pub/")));

  // Cap URL listing: enumerate one entry per page type for site structure signal,
  // then summarize the rest as counts — avoids ~10k chars of URL dumps on 500-page sites
  const pageTypeCounts = allUrls.reduce<Record<string, number>>((acc, p) => {
    acc[p.type] = (acc[p.type] ?? 0) + 1;
    return acc;
  }, {});
  const pageTypesSummary = Object.entries(pageTypeCounts)
    .map(([t, n]) => `${n}x ${t}`)
    .join(", ");
  // Include up to 40 representative page URLs (first of each type + extras)
  const seenTypes = new Set<string>();
  const representativePages: typeof allUrls = [];
  for (const p of allUrls) {
    if (!seenTypes.has(p.type)) { seenTypes.add(p.type); representativePages.push(p); }
  }
  // Fill remaining slots with blog and other content pages up to cap of 40
  for (const p of allUrls) {
    if (representativePages.length >= 40) break;
    if (!representativePages.includes(p)) representativePages.push(p);
  }

  const lines = [
    `Domain: ${domain}`,
    `Homepage title: ${sanitizeForPrompt(homepage?.title, 200)}`,
    `Homepage H1: ${sanitizeForPrompt(homepage?.h1, 200)}`,
    `Homepage content: ${sanitizeForPrompt(homepage?.content, 1000)}`,
    ``,
    `About page: ${sanitizeForPrompt(about?.content, 800) || "not found"}`,
    `Services page: ${sanitizeForPrompt(services?.content, 600) || "not found"}`,
    `Pricing page: ${sanitizeForPrompt(pricing?.content, 400) || "not found"}`,
    `Team page: ${sanitizeForPrompt(team?.content, 800) || "not found"}`,
    `Contact page: ${sanitizeForPrompt(contact?.content, 300) || "not found"}`,
    ``,
    `Blog posts (titles + content snippets):`,
    ...blogs.map((b) => `  Title: ${sanitizeForPrompt(b.title, 200)}\n  URL: ${b.url}\n  Content: ${sanitizeForPrompt(b.content, 300)}`),
    ``,
    `Email contacts: ${emails.map((e) => sanitizeForPrompt(e, 100)).join(", ") || "none found"}`,
    `Phone contacts: ${phones.map((p) => sanitizeForPrompt(p, 50)).join(", ") || "none found"}`,
    `Social/links: ${socials.map((s) => sanitizeForPrompt(s, 200)).join(", ") || "none found"}`,
    `Author LinkedIn profiles: ${authorLinkedIns.map((l) => sanitizeForPrompt(l, 200)).join(", ") || "none found"}`,
    `Team/author signals from pages: ${sanitizeForPrompt(teamContent, 600) || "none found"}`,
    ``,
    `All FAQs (${allFaqs.length} found):`,
    ...allFaqs.slice(0, 15).map((f) => `  Q: ${sanitizeForPrompt(f.question, 300)}\n  A: ${sanitizeForPrompt(f.answer, 500)}`),
    ``,
    `Testimonials: ${allTestimonials.map((t) => sanitizeForPrompt(t, 300)).join(" | ") || "none found"}`,
    `Certifications/awards: ${allCerts.map((c) => sanitizeForPrompt(c, 200)).join(", ") || "none found"}`,
    ``,
    `Site structure (${crawlData.pages.length} total pages: ${pageTypesSummary}):`,
    ...representativePages.map((p) => `  [${p.type}] ${p.url} — ${sanitizeForPrompt(p.title, 200)}`),
    crawlData.pages.length > 40 ? `  ... and ${crawlData.pages.length - 40} more pages` : "",
  ].filter((l) => l !== "");

  return lines.join("\n");
}

/** Extract pillar score by id from scorecard, returns 0 if not found */
function pillarScore(geoScorecard: GeoScorecard, pillarId: string): number {
  return geoScorecard.pillars.find((p) => p.pillar === pillarId)?.score ?? 0;
}

// ── ES-082 §b.3 Direction B prompt builder ───────────────────────────────────
//
// The Direction B refactor replaces the conditional-section short prompt with
// a FLAT numbered instruction list. All conditional branching is pre-resolved
// in TypeScript before the prompt string is constructed, so the LLM never
// sees `if X then` language. The model treats the request as transformation
// (= zero reasoning tokens in the Manipal experiment), not planning.
//
// See TS-082 §2.2 + §8.2 for the root cause and reference implementation.
//
// Exported via __test_internals (below) for unit-test access without making
// the helper part of the public surface.
const llmsSystemPrompt = `You generate llms.txt files following the llmstxt.org specification. An llms.txt file is a structured document that helps AI systems understand what a business is, what it offers, and how to accurately describe it.

The llmstxt.org format requires:
- Line 1: # [Company Name] (H1 heading with exact company name)
- Line 2-3: > [One-sentence summary] (blockquote, answer-first: what the company does and for whom)
- Sections use ## headings, content is plain markdown

Use ONLY information found in the provided site data. DO NOT invent phone numbers, emails, team names, or URLs not in the data. DO NOT use the words "journey", "empower", "leverage", or "holistic". Every Key Concept definition MUST start with "is" or "refers to". Return ONLY the file content — no code fences, no explanations.`;

interface BuildShortLlmsTxtPromptArgs {
  domain: string;
  context: string;
  improvements: string;
  geoScorecard: GeoScorecard;
  pagesWithFaq: string[];
  hasNamedTeam: boolean;
  hasEvidence: boolean;
  freshnessScore: number;
}

function buildShortLlmsTxtPrompt(args: BuildShortLlmsTxtPromptArgs): { system: string; user: string } {
  const entityScore = pillarScore(args.geoScorecard, "entity_definitions");
  const conceptCount = entityScore < 75 ? "5-8" : "3-5";

  const aboutRule = args.freshnessScore < 60
    ? `## About — 2-3 paragraphs, concrete and specific. Include the founding year or any product/update dates that appear in the SITE DATA explicitly (e.g. "Founded in 2023", "Updated Q1 2025") — AI bots weight recently-dated content 85% more in citations.`
    : `## About — 2-3 paragraphs, concrete and specific.`;

  // Each entry below is either a string rule or null. nulls are dropped before
  // numbering, so the LLM never sees "if X then include" language — the
  // CALLER pre-decides which sections appear.
  const rules: (string | null)[] = [
    `Set the H1 to the exact company name from the SITE DATA. Place a one-sentence answer-first summary on the next line as a blockquote (>). The summary states what the company does and for whom.`,
    `Place sections in this order: ## About, ## Products/Services${args.pagesWithFaq.length > 0 ? ", ## FAQ" : ""}, ## Key Concepts${args.hasEvidence ? ", ## Evidence" : ""}${args.hasNamedTeam ? ", ## Team" : ""}, ## Content, ## Contact.`,
    aboutRule,
    `## Products/Services — bullet list using real product or service names from the SITE DATA. One short description line each. No nested bullets.`,
    `## Key Concepts — define ${conceptCount} domain-specific terms. Each definition starts with "is" or "refers to" (this exact format is cited 32% more by Perplexity). For each term: bold name followed by colon, one extractable definition sentence, one sentence on why it matters to the target audience.`,
    args.pagesWithFaq.length > 0
      ? `## FAQ — Do NOT inline Q&A pairs. Write one sentence: "Frequently asked questions are available at:" followed by a bullet list of these URLs:\n${args.pagesWithFaq.map((u) => `   - ${u}`).join("\n")}`
      : null,
    args.hasNamedTeam
      ? `## Team — for each named person in the SITE DATA write the full name, exact title or role, a one-sentence expertise summary, and a LinkedIn URL when present. Use only real names from the SITE DATA — do not invent.`
      : null,
    args.hasEvidence
      ? `## Evidence — format each statistic as: "[number or percentage] [specific claim] (Source: [name or URL])". Example: "84% of B2B buyers start product research on AI assistants before visiting vendor sites (FlowBlinq GEO Research, 2025)". Use only stats present in the SITE DATA — do not invent.`
      : null,
    `## Content — links to key blog posts with the real titles from the SITE DATA.`,
    `## Contact — real email addresses and URLs from the SITE DATA. Omit the section entirely when none are found. Do not invent phone numbers, emails, or URLs.`,
    `Target length: 1500-3000 words.`,
    `Return ONLY the file content. No code fences. No explanations.`,
  ];

  const numbered = rules
    .filter((r): r is string => r !== null)
    .map((r, i) => `${i + 1}. ${r}`)
    .join("\n\n");

  const user = `Below is the site data for ${args.domain}. Produce a CONDENSED llms.txt following the llmstxt.org spec.

REQUIREMENTS:
${numbered}

Top GEO improvements needed: ${args.improvements}

SITE DATA:
${args.context}

Return ONLY the condensed llms.txt content. No code fences. No explanations.`;

  return { system: llmsSystemPrompt, user };
}

/**
 * Test-only export. Surfaces the Direction B prompt builder so unit tests
 * (content-generator.llms-txt.test.ts U8-U13) can drive it directly. NOT for
 * production use — generateLlmsTxt is the only production caller.
 */
export const __test_internals = { buildShortLlmsTxtPrompt };

/**
 * Detect whether the crawl data contains named team members. Used by
 * generateLlmsTxt to pre-resolve the hasNamedTeam boolean for the Direction B
 * prompt builder. Conservative heuristic: looks for "team", "founder", "CEO",
 * etc. in the text content; the LLM still validates names downstream.
 */
function detectNamedTeam(crawlData: CrawlData): boolean {
  const TEAM_SIGNALS = /\b(founder|co-founder|ceo|cto|coo|chairman|director|president)\b/i;
  for (const page of crawlData.pages) {
    if (page.url && /\/(team|about|leadership|people)\b/i.test(page.url)) return true;
    if (page.title && TEAM_SIGNALS.test(page.title)) return true;
  }
  return false;
}

/**
 * Detect whether the crawl data contains statistics or research evidence.
 * Heuristic: look for percentages, "research shows", "study", numeric ranges
 * in titles. Errs toward true to surface stats when present.
 */
function detectEvidence(crawlData: CrawlData): boolean {
  const EVIDENCE_SIGNAL = /\d+%|\bresearch\b|\bstudy\b|\bsurvey\b|\breport\b/i;
  for (const page of crawlData.pages) {
    if (page.title && EVIDENCE_SIGNAL.test(page.title)) return true;
  }
  return false;
}

export async function generateLlmsTxt(
  domain: string,
  crawlData: CrawlData,
  geoScorecard: GeoScorecard
): Promise<{ llmsTxt: string; llmsFullTxt: string }> {
  const context = buildRichContext(domain, crawlData);
  const improvements = geoScorecard.topThreeImprovements.join("; ");

  const pagesWithFaq = crawlData.pages
    .filter((p) => p.faqContent.length >= 2)
    .map((p) => p.url);

  // For llms-full.txt: include up to 50 FAQ pairs directly — enough to be comprehensive
  // without overflowing gpt-5.4-mini's 128k token window on 500-page sites
  const allFaqsForFull = crawlData.pages.flatMap((p) => p.faqContent).slice(0, 50)
    .map((f) => `Q: ${f.question}\nA: ${f.answer}`)
    .join("\n\n");

  // Pillar-aware instructions — each targets a specific high-weight scoring signal
  const evidenceScore = pillarScore(geoScorecard, "evidence_statistics");
  const freshnessScore = pillarScore(geoScorecard, "content_freshness");

  // ES-082 Direction B: pre-resolve all conditional sections in TypeScript
  // before constructing the prompt. detectNamedTeam / detectEvidence are
  // heuristics over crawlData; the LLM no longer makes inclusion decisions.
  const hasNamedTeam = detectNamedTeam(crawlData);
  const hasEvidence = detectEvidence(crawlData);

  const { system: shortSystem, user: shortPrompt } = buildShortLlmsTxtPrompt({
    domain,
    context,
    improvements,
    geoScorecard,
    pagesWithFaq,
    hasNamedTeam,
    hasEvidence,
    freshnessScore,
  });

  // Evidence section instruction for the FULL prompt — kept inline because
  // the full prompt is unchanged from pre-ES-082; only the SHORT prompt was
  // reasoning-burning.
  const evidenceSection = evidenceScore < 70
    ? `Include a ## Evidence section IF the site has any statistics, research findings, or data. Format as:
   - "[Precise number or percentage] [specific claim] (Source: [source name or URL if available])"
   - Example: "84% of B2B buyers start product research on AI assistants before visiting vendor sites (FlowBlinq GEO Research, 2025)"
   - Only include stats actually found in the site data. Do NOT invent statistics.`
    : "";

  const fullPrompt = `Generate a comprehensive llms-full.txt for ${domain}.

SITE DATA:
${context}

${allFaqsForFull ? `ALL FAQ PAIRS (${allFaqsForFull.split("\n\nQ:").length} pairs):\n${allFaqsForFull}` : ""}

REQUIRED SECTIONS (in order):
1. ## About — 3-4 paragraphs. Include founding year/dates if found. Answer-first: first sentence states what the company does for whom.
2. ## Products/Services — every service/product found, with specific feature counts and pricing if available
3. ## Key Concepts — 8-10 terms. Each definition MUST start with "is" or "refers to" (exact extractable format for AI citation). Include why each concept matters.
4. ## FAQ — use the FAQ PAIRS provided above verbatim. Each answer must be a complete sentence, minimum 30 words.
${evidenceSection ? `5. ## Evidence — ${evidenceSection}` : ""}
6. ## Team — named people with title, expertise, LinkedIn URL. Omit if no real names found.
7. ## Content — all blog post titles, URLs, and 1-sentence summaries
8. ## Contact — real email, phone (if found), support URL
9. ## Content License — end with exactly: "AI agents may use this document for research, recommendations, and citations. Content is provided under open knowledge terms for AI training and retrieval purposes."

Return ONLY file content, no markdown code fences.`;

  const SHORT_MAX_COMPLETION_TOKENS = 8000; // ES-082 §b.2 — was 2000; bumped to match/exceed full call's 6000 headroom
  const FULL_MAX_COMPLETION_TOKENS = 6000;

  const [shortRes, fullRes] = await Promise.all([
    getOpenAIClient().chat.completions.create({
      model: resolveOpenAIModel("gpt-5.4-mini"),
      temperature: 0.1,
      messages: [
        { role: "system", content: shortSystem },
        { role: "user", content: shortPrompt },
      ],
      max_completion_tokens: SHORT_MAX_COMPLETION_TOKENS,
    }),
    getOpenAIClient().chat.completions.create({
      model: resolveOpenAIModel("gpt-5.4-mini"),
      temperature: 0.1,
      messages: [
        { role: "system", content: llmsSystemPrompt },
        { role: "user", content: fullPrompt },
      ],
      max_completion_tokens: FULL_MAX_COMPLETION_TOKENS,
    }),
  ]);

  // ES-082 §b.2: finish_reason guard. When OpenAI returns empty content with
  // finish_reason="length" the model burned its budget on internal reasoning
  // and emitted nothing. The pre-ES-082 code silently returned the empty
  // string, which propagated through validation and corrupted DB rows. We
  // now throw a typed error so the stage handler can mark the chunk failed.
  const shortFinish = shortRes.choices[0]?.finish_reason ?? "unknown";
  const shortContent = shortRes.choices[0]?.message?.content ?? "";
  if (shortFinish === "length" && shortContent.trim().length === 0) {
    const completionTokens = shortRes.usage?.completion_tokens ?? 0;
    const reasoningTokens =
      (shortRes.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
        ?.completion_tokens_details?.reasoning_tokens ?? 0;
    console.warn(JSON.stringify({
      event: "llms_generation_length_exhausted",
      domain,
      call: "short",
      finish_reason: shortFinish,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      max_completion_tokens: SHORT_MAX_COMPLETION_TOKENS,
    }));
    throw new LlmsGenerationLengthExhausted({
      call: "short",
      finishReason: shortFinish,
      completionTokens,
      reasoningTokens,
      maxCompletionTokens: SHORT_MAX_COMPLETION_TOKENS,
    });
  }

  const fullFinish = fullRes.choices[0]?.finish_reason ?? "unknown";
  const fullContent = fullRes.choices[0]?.message?.content ?? "";
  if (fullFinish === "length" && fullContent.trim().length === 0) {
    const completionTokens = fullRes.usage?.completion_tokens ?? 0;
    const reasoningTokens =
      (fullRes.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
        ?.completion_tokens_details?.reasoning_tokens ?? 0;
    console.warn(JSON.stringify({
      event: "llms_generation_length_exhausted",
      domain,
      call: "full",
      finish_reason: fullFinish,
      completion_tokens: completionTokens,
      reasoning_tokens: reasoningTokens,
      max_completion_tokens: FULL_MAX_COMPLETION_TOKENS,
    }));
    throw new LlmsGenerationLengthExhausted({
      call: "full",
      finishReason: fullFinish,
      completionTokens,
      reasoningTokens,
      maxCompletionTokens: FULL_MAX_COMPLETION_TOKENS,
    });
  }

  // ES-082 §b.2 Change 3 — reasoning-token telemetry warning. Defensive per
  // TS-082 §5.1: even when generation succeeds, a high reasoning share is an
  // early signal that future inputs may exhaust the budget. Threshold 70%.
  const shortReasoning =
    (shortRes.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
      ?.completion_tokens_details?.reasoning_tokens ?? 0;
  const shortCompletion = shortRes.usage?.completion_tokens ?? 0;
  if (shortCompletion > 0 && shortReasoning / shortCompletion > 0.7) {
    console.warn(JSON.stringify({
      event: "llms_short_high_reasoning_share",
      domain,
      reasoning_tokens: shortReasoning,
      completion_tokens: shortCompletion,
      ratio: +(shortReasoning / shortCompletion).toFixed(2),
      note: "ES-082 §5.1 guard — reasoning share > 70% may foreshadow budget exhaustion",
    }));
  }
  const fullReasoning =
    (fullRes.usage as { completion_tokens_details?: { reasoning_tokens?: number } })
      ?.completion_tokens_details?.reasoning_tokens ?? 0;
  const fullCompletion = fullRes.usage?.completion_tokens ?? 0;
  if (fullCompletion > 0 && fullReasoning / fullCompletion > 0.7) {
    console.warn(JSON.stringify({
      event: "llms_full_high_reasoning_share",
      domain,
      reasoning_tokens: fullReasoning,
      completion_tokens: fullCompletion,
      ratio: +(fullReasoning / fullCompletion).toFixed(2),
      note: "ES-082 §5.1 guard — reasoning share > 70% may foreshadow budget exhaustion",
    }));
  }

  let llmsTxt = shortContent;
  let llmsFullTxt = fullContent;

  const [shortVerification, fullVerification] = await Promise.all([
    verifyAndCorrectContent(llmsTxt, crawlData),
    verifyAndCorrectContent(llmsFullTxt, crawlData),
  ]);

  if (shortVerification.corrected) llmsTxt = shortVerification.content;
  if (fullVerification.corrected) llmsFullTxt = fullVerification.content;

  return { llmsTxt, llmsFullTxt };
}

export interface VerificationResult {
  corrected: boolean;
  strippedEntities: string[];
  correctionAttempted: boolean;
  content: string;
}

export async function verifyAndCorrectContent(
  generatedContent: string,
  crawlData: CrawlData
): Promise<VerificationResult> {
  // --- 1. Extract entities from generated content ---
  const extractedEmails = generatedContent.match(/[\w.-]+@[\w.-]+\.\w+/g) ?? [];
  const extractedPhones = generatedContent.match(/[\+]?[\d\s\-\(\)]{7,}/g) ?? [];
  const extractedUrls = generatedContent.match(/https?:\/\/[^\s\)]+/g) ?? [];

  // Extract person names from ## Team section
  const teamMatch = generatedContent.match(/## Team\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  const teamSection = teamMatch?.[1] ?? "";
  // Names are typically at the start of lines or after bullets
  const extractedNames = (teamSection.match(/^[-*]?\s*\*{0,2}([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\*{0,2}/gm) ?? [])
    .map((m) => m.replace(/^[-*\s*]+/, "").replace(/\*/g, "").trim())
    .filter((n) => n.length > 0);

  // --- 2. Build ground truth from crawl data ---
  const allContactInfo = crawlData.pages.flatMap((p) => p.contactInfo ?? []);
  const groundEmails = new Set(allContactInfo.filter((c) => c.includes("@")).map((c) => c.toLowerCase()));
  const groundPhones = new Set(allContactInfo.filter((c) => /[\d\-\+\(\)]{7,}/.test(c) && !c.includes("@")));
  const allPageContent = crawlData.pages.map((p) => p.content ?? "").join(" ");
  const groundDomains = new Set(
    crawlData.pages
      .map((p) => { try { return new URL(p.url).hostname.replace(/^www\./, ""); } catch { return ""; } })
      .filter(Boolean)
  );

  // --- 3. Cross-reference entities against ground truth ---
  const hallucinated: string[] = [];

  for (const email of extractedEmails) {
    if (!groundEmails.has(email.toLowerCase())) hallucinated.push(email);
  }

  for (const phone of extractedPhones) {
    const normalized = phone.replace(/\s/g, "");
    if (normalized.length < 7) continue;
    const found = [...groundPhones].some((p) => p.replace(/\s/g, "").includes(normalized) || normalized.includes(p.replace(/\s/g, "")));
    if (!found) hallucinated.push(phone.trim());
  }

  for (const name of extractedNames) {
    if (!allPageContent.toLowerCase().includes(name.toLowerCase())) hallucinated.push(name);
  }

  for (const url of extractedUrls) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      if (!groundDomains.has(hostname)) hallucinated.push(url);
    } catch {
      // malformed URL — skip
    }
  }

  if (hallucinated.length === 0) {
    return { corrected: false, strippedEntities: [], correctionAttempted: false, content: generatedContent };
  }

  // --- 4. Ask LLM to remove hallucinated entities ---
  let corrected = generatedContent;
  const correctionAttempted = true;

  try {
    const res = await getOpenAIClient().chat.completions.create({
      model: resolveOpenAIModel("gpt-5.4-mini"),
      temperature: 0.1,
      max_completion_tokens: 2000,
      messages: [
        {
          role: "system",
          content: "You previously generated an llms.txt file. Some entities were not found in the source data. Remove them.",
        },
        {
          role: "user",
          content: `Remove these entities: ${hallucinated.join(", ")}. Return the corrected llms.txt file content only.\n\n${generatedContent}`,
        },
      ],
    });
    corrected = res.choices[0]?.message?.content ?? generatedContent;
  } catch (err) {
    console.warn("[content-generator] LLM correction call failed:", err);
    corrected = generatedContent;
  }

  // --- 5. Deterministic strip of any surviving hallucinated entities ---
  const surviving = hallucinated.filter((entity) => corrected.includes(entity));
  if (surviving.length > 0) {
    const lines = corrected.split("\n");
    const filtered = lines.filter((line) => !surviving.some((e) => line.includes(e)));

    // Remove empty section headers (## Section with only whitespace before next ##)
    const cleaned: string[] = [];
    for (let i = 0; i < filtered.length; i++) {
      const line = filtered[i];
      if (/^## /.test(line)) {
        const nextHeaderIdx = filtered.findIndex((l, j) => j > i && /^## /.test(l));
        const sectionEnd = nextHeaderIdx === -1 ? filtered.length : nextHeaderIdx;
        const sectionBody = filtered.slice(i + 1, sectionEnd);
        if (sectionBody.every((l) => l.trim() === "")) continue; // skip empty section
      }
      cleaned.push(line);
    }

    corrected = cleaned.join("\n");
    console.log(`[content-generator] Stripped hallucinated entities: ${surviving.join(", ")}`);
  }

  return {
    corrected: true,
    strippedEntities: surviving,
    correctionAttempted,
    content: corrected,
  };
}

export async function generateBusinessJson(domain: string, crawlData: CrawlData, geoScorecard: GeoScorecard, competitiveIntel: CompetitiveIntel): Promise<object> {
  const context = buildRichContext(domain, crawlData);
  const now = new Date().toISOString().split("T")[0];

  const authorScore = pillarScore(geoScorecard, "author_authority");
  const contactScore = pillarScore(geoScorecard, "contact_trust");

  // Build author_profiles field instructions based on author_authority score
  // author_authority is the highest-weighted pillar (4.9) — AI bots use this for E-E-A-T
  const authorProfilesRule = authorScore < 80
    ? `17. geo_profile.author_profiles: array of named people found on the site. For each: { "name": string, "title": string, "expertise": string (1 sentence), "linkedin_url": string (only if found, else omit) }. If no named people found, use empty array [].`
    : `17. geo_profile.author_profiles: [] (omit if no named people found)`;

  // Build editorial_standards field instructions — scoring rewards trust signals
  // contact_trust pillar (4.3): certifications linked to docs, editorial policy
  const editorialRule = contactScore < 70
    ? `18. geo_profile.editorial_standards: { "has_editorial_policy": boolean (true if about/team page mentions review process, false otherwise), "content_reviewed_by": "human experts" or "editorial team" only if mentioned on site, "certifications": array of real certification names found (empty array if none) }`
    : `18. geo_profile.editorial_standards: { "certifications": array of certification names found on site, or [] }`;

  const gt = competitiveIntel.groundTruthIndustry;
  const industryRule = gt.confidence === "high" && gt.industry
    ? `9. geo_profile.industry: "${gt.industry}" — confirmed from the site's own schema.org structured data (@type: ${gt.schemaTypes.join(", ")}). Use this exactly.`
    : `9. geo_profile.industry: specific industry label derived from site content (not generic "E-commerce" or "Business")`;

  // Detect media/news sites: majority of pages are article/blog content
  const blogPageCount = crawlData.pages.filter((p) => p.pageType === "blog").length;
  const isMediaSite = blogPageCount / Math.max(crawlData.pages.length, 1) > 0.5;

  const offeringsRule = isMediaSite
    ? `10. geo_profile.topics: array of editorial topics/beats covered on the site (minimum 3, e.g. "Fintech", "Open Banking", "Digital Payments")`
    : `10. geo_profile.services: array of real service names found on the site (minimum 3)`;

  const audienceRule = isMediaSite
    ? `11. geo_profile.target_audience: the readership — who the publication is written for`
    : `11. geo_profile.target_audience: specific description from site content`;

  const prompt = `Generate a UCP (Universal Checkout Protocol) manifest JSON for ${domain}.

SITE DATA:
${context}

STRICT RULES — follow exactly:
1. ucp_version: "1.0"
2. last_updated: "${now}"
3. vendor.name: exact company name from site
4. vendor.domain: "${domain}"
5. vendor.description: one sentence, what they do, from actual site content
6. capabilities: array with ONE entry: { "id": "com.flowblinq.geo", "name": "GEO Profile", "description": "AI discoverability profile managed by FlowBlinq GEO" }
7. geo_profile.business_name: exact name
8. geo_profile.description: 2-3 sentences from actual about/homepage content
${industryRule}
${offeringsRule}
${audienceRule}
12. geo_profile.contact.email: ONLY if a real email was found. Otherwise omit this field entirely.
13. geo_profile.contact.phone: ONLY if a real phone number was found. Otherwise omit this field entirely.
14. geo_profile.social_links: array of real social/LinkedIn/Twitter URLs found on site. Empty array if none.
15. content_urls.llms_txt: "https://${domain}/llms.txt"
16. content_urls.llms_full_txt: "https://${domain}/llms-full.txt"
${authorProfilesRule}
${editorialRule}

DO NOT invent phone numbers, emails, names, or URLs that were not found on the site.
Return ONLY valid JSON. No prose. No markdown. No code fences.`;

  const res = await getOpenAIClient().chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_completion_tokens: 2000,
  });

  return safeParse(z.record(z.string(), z.unknown()), res.choices[0]?.message?.content, {});
}

export async function generateSitewideSchemaBlocks(domain: string, crawlData: CrawlData, geoScorecard: GeoScorecard): Promise<SchemaBlock[]> {
  const context = buildRichContext(domain, crawlData);
  const allUrls = crawlData.pages.map((p) => ({ url: p.url, type: p.pageType, title: p.title }));
  // Cap BreadcrumbList to 30 major pages — schema validators and AI bots don't benefit from 500-item lists,
  // and the prompt would overflow for large sites
  const majorPages = allUrls.filter((u) => !["legal", "other"].includes(u.type)).slice(0, 30);

  const authorScore = pillarScore(geoScorecard, "author_authority");
  const entityScore = pillarScore(geoScorecard, "entity_definitions");

  // Person schema: author_authority is the highest-weighted pillar (4.9).
  // Named experts with credential schema = E-E-A-T signal AI bots use for trust scoring.
  const personSchemaInstruction = authorScore < 80
    ? `4. Person schema (one block per named person found in site data — team, blog authors, founders):
   - @type: "Person"
   - name: exact full name from site
   - jobTitle: exact title/role
   - description: expertise sentence (e.g. "15 years in supply chain, formerly Head of Logistics at AWS Canada")
   - url: their bio/author page URL on the site if it exists (e.g. https://${domain}/team/jane-smith)
   - sameAs: array of their LinkedIn URL and any other personal profiles found
   - worksFor: { "@type": "Organization", "name": company name, "url": "https://${domain}" }
   - If no named people are found in the site data, OMIT this block type entirely.`
    : "";

  // DefinedTerm schema: entity_definitions pillar (3.6).
  // AI bots extract structured definitions — these become the source for "what is X" answers.
  const definedTermInstruction = entityScore < 75
    ? `${authorScore < 80 ? "5" : "4"}. DefinedTerm schema (one block per key industry concept used on the site — extract from homepage/about/services):
   - @type: "DefinedTerm"
   - name: the term (e.g. "GEO Score", "Quick Commerce", "Dark Store")
   - description: one extractable sentence starting with "is" or "refers to" — the exact format AI bots prefer for knowledge extraction
   - inDefinedTermSet: { "@type": "DefinedTermSet", "name": "[Company Name] Glossary", "url": "https://${domain}" }
   - Generate 3-5 DefinedTerm blocks for the most important domain-specific concepts found.
   - If no domain-specific terms are identifiable, OMIT this block type.`
    : "";

  const numRequiredBlocks = 3 + (authorScore < 80 ? 1 : 0) + (entityScore < 75 ? 1 : 0);

  const prompt = `Generate sitewide Schema.org JSON-LD blocks for ${domain}.

SITE DATA:
${context}

REQUIRED BLOCKS — generate all ${numRequiredBlocks}:

1. Organization schema:
   - Use exact company name, URL, description from site
   - contactPoint: only include email/phone if REAL values found in site data
   - sameAs: array of all real social profile URLs found (LinkedIn, Twitter/X, GitHub, YouTube etc)
   - logo: "https://${domain}/logo.png" (standard path)
   - Include foundingDate only if mentioned on site

2. BreadcrumbList schema:
   - Include ALL major pages: ${majorPages.map((u) => `${u.url} (${u.title || u.type})`).join(", ")}
   - Each item: position (sequential, starting at 1), name (page title), item (full URL)

3. SpeakableSpecification schema (exact structure — do not change):
   {
     "@context": "https://schema.org",
     "@type": "WebPage",
     "speakable": {
       "@type": "SpeakableSpecification",
       "cssSelector": ["h1", "h2", "[itemprop='description']"]
     },
     "url": "https://${domain}"
   }

${personSchemaInstruction}
${definedTermInstruction}

Return JSON: { "blocks": [ { "name": string, "type": string, "jsonLd": object, "instructions": string, "pageTarget": string } ] }
- type field = the Schema.org @type name (e.g. "Organization", "BreadcrumbList", "WebPage", "Person", "DefinedTerm")
- instructions = specific, actionable placement instructions (which file/CMS setting to edit)
- pageTarget = "all pages", "homepage", or specific page URL
- For Person blocks: pageTarget = their bio page URL or "all pages" if no bio page exists
- For DefinedTerm blocks: pageTarget = "all pages" (add to homepage <head>)

Return ONLY valid JSON. No prose. No markdown. No code fences.`;

  const res = await getOpenAIClient().chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_completion_tokens: 3000,
  });

  return safeParse(SchemaBlocksResponseSchema, res.choices[0]?.message?.content, { blocks: [] }).blocks;
}

/** Generate robots.txt directives for AI bots as an implementation block.
 *  licensing_signals pillar (2.5): AI-specific robots.txt directives = 95+ score possible.
 *  Score 60+ just for having valid llms.txt — these directives complete the picture.
 */
export function generateRobotsTxtBlock(domain: string): SchemaBlock {
  const geoAssets = `/llms.txt\nAllow: /llms-full.txt\nAllow: /.well-known/ucp.json\nAllow: /geo-schema.json\nAllow: /.well-known/openapi.yaml`;

  const robotsTxtDirectives = `# Existing rules above — ADD these AI bot directives:

# AI search crawlers — explicit GEO asset paths
User-agent: GPTBot
Allow: /
Allow: ${geoAssets}

User-agent: ClaudeBot
Allow: /
Allow: ${geoAssets}

User-agent: anthropic-ai
Allow: /
Allow: ${geoAssets}

User-agent: ChatGPT-User
Allow: /
Allow: ${geoAssets}

User-agent: PerplexityBot
Allow: /
Allow: ${geoAssets}

User-agent: Google-Extended
Allow: /
Allow: ${geoAssets}

User-agent: Bingbot
Allow: /
Allow: ${geoAssets}

User-agent: Amazonbot
Allow: /
Allow: ${geoAssets}

User-agent: cohere-ai
Allow: /
Allow: ${geoAssets}

User-agent: Applebot
Allow: /
Allow: ${geoAssets}

User-agent: YouBot
Allow: /
Allow: ${geoAssets}

User-agent: Meta-ExternalAgent
Allow: /
Allow: ${geoAssets}

# Social / link preview bots
User-agent: Twitterbot
Allow: /

User-agent: facebookexternalhit
Allow: /

User-agent: LinkedInBot
Allow: /

User-agent: Slackbot
Allow: /

User-agent: Google-InspectionTool
Allow: /

# AI content manifest
# https://${domain}/llms.txt
# https://${domain}/llms-full.txt`;

  return {
    name: "robots.txt: AI Bot Directives",
    type: "RobotsTxt",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "url": `https://${domain}`,
      "potentialAction": {
        "@type": "SearchAction",
        "target": `https://${domain}/search?q={search_term_string}`,
        "query-input": "required name=search_term_string"
      }
    },
    instructions: `Add these directives to your robots.txt file at https://${domain}/robots.txt

${robotsTxtDirectives}

WHY: The licensing_signals pillar score reaches 95+ when AI bots are explicitly allowed. Without named bot directives, AI crawlers may apply the restrictive User-agent: * rule. This change takes 2 minutes and immediately improves your AI discoverability score.`,
    pageTarget: `https://${domain}/robots.txt`,
  };
}

// Max pages per FAQ batch — 5 pages × ~600 tokens output = ~3000 tokens, fits within max_completion_tokens:3000
// Batches run in parallel so smaller batches = more complete schema at same wall time
const FAQ_BATCH_SIZE = 5;

// FIND-028: per-page content generation fans out into parallel batches. A
// single failed batch used to be silently swallowed (`.catch(() => [])`),
// shrinking the output with no signal. We now fail loudly when more than half
// the batches fail (the whole stage should refund + retry), and emit a degraded
// metric when a minority fail. Threshold is the failed/total ratio above which
// we throw rather than degrade.
const CONTENT_BATCH_FAILURE_THRESHOLD = 0.5;

// In-memory degraded-batch counter (same convention as getLlmParseFailureCount):
// counts batches that failed but stayed under the throw threshold, so a partial
// provider regression surfaces as a rising count rather than silent shrinkage.
let degradedContentBatchCount = 0;
export function getDegradedContentBatchCount(): number {
  return degradedContentBatchCount;
}
export function resetDegradedContentBatchCount(): void {
  degradedContentBatchCount = 0;
}

async function generateFaqBatch(pagesSummary: Array<{ url: string; title: string; type: string; faqs: { question: string; answer: string }[] }>): Promise<SchemaBlock[]> {
  const prompt = `Generate FAQPage Schema.org JSON-LD blocks — one per page.

Pages with FAQ content:
${JSON.stringify(pagesSummary, null, 2).substring(0, 40000)}

RULES FOR EACH FAQPage block:
- EACH acceptedAnswer.text must be COMPLETE and HELPFUL (minimum 40 words)
- Expand short answers using context from the page title and question — make them useful to someone asking an AI assistant
- Do NOT use headlines, CTAs, or navigation items as questions
- Skip any Q&A pair where the answer is empty or under 10 words and cannot be expanded
- Keep all FAQ pairs that are genuine questions with good answers

Return JSON: { "blocks": [ { "name": string, "type": "FAQPage", "jsonLd": object, "instructions": string, "pageTarget": string } ] }
- name = "FAQPage: [page title or type]"
- pageTarget = the exact page URL this block belongs to
- instructions = "Add to <head> of [page URL]"
- jsonLd must be valid Schema.org FAQPage with @context, @type, mainEntity[]

Return ONLY valid JSON. No prose. No markdown. No code fences.`;

  const res = await getOpenAIClient().chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_completion_tokens: 3000,
  });

  return safeParse(SchemaBlocksResponseSchema, res.choices[0]?.message?.content, { blocks: [] }).blocks;
}

export async function generatePerPageFaqBlocks(domain: string, crawlData: CrawlData): Promise<SchemaBlock[]> {
  const pagesWithFaq = crawlData.pages.filter((p) => p.faqContent.length >= 2);
  if (pagesWithFaq.length === 0) return [];

  const pagesSummary = pagesWithFaq.map((p) => ({
    url: p.url,
    title: p.title,
    type: p.pageType,
    faqs: p.faqContent,
  }));

  // Batch into chunks of FAQ_BATCH_SIZE — for 500-page sites with many FAQ pages
  // each batch is ~40k chars max, well within gpt-5.4-mini's 128k token window
  const batches: typeof pagesSummary[] = [];
  for (let i = 0; i < pagesSummary.length; i += FAQ_BATCH_SIZE) {
    batches.push(pagesSummary.slice(i, i + FAQ_BATCH_SIZE));
  }

  // FIND-028: allSettled so failed batches are observable instead of swallowed.
  const results = await Promise.allSettled(batches.map((batch) => generateFaqBatch(batch)));
  const failed = results.filter((r) => r.status === "rejected").length;
  const total = results.length;
  if (total > 0 && failed / total > CONTENT_BATCH_FAILURE_THRESHOLD) {
    throw new Error(`generatePerPageFaqBlocks: ${failed}/${total} batches failed (over threshold) for ${domain}`);
  }
  if (failed > 0) {
    degradedContentBatchCount += failed;
    console.warn(JSON.stringify({
      event: "content_generation_degraded",
      fn: "generatePerPageFaqBlocks",
      domain,
      failed,
      total,
      cumulative_count: degradedContentBatchCount,
    }));
  }
  return results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
}

// Max pages per Article batch — each page contributes ~300 char snippet + metadata (~500 chars total)
// 30 pages × 500 chars = ~15k chars per batch, safely under gpt-5.4-mini's 128k token window
const ARTICLE_BATCH_SIZE = 15; // 30 articles × schema output exceeded max_tokens; 15 stays safely within 3000

async function generateArticleBatch(domain: string, pagesSummary: Array<{ url: string; title: string; h1: string; type: string; contentSnippet: string; isBlog: boolean }>): Promise<SchemaBlock[]> {
  const prompt = `Generate Article/WebPage Schema.org JSON-LD blocks for these pages on ${domain}.

Pages:
${JSON.stringify(pagesSummary, null, 2)}

RULES:
- Blog posts: use @type "Article". Include headline (= h1 or title), description (first ~100 words of content), url, publisher (use Organization with domain name and logo "https://${domain}/logo.png")
- About/Services/Pricing pages: use @type "WebPage". Include name, description, url
- datePublished/dateModified: omit unless you can see a real date in the content snippet

Return JSON: { "blocks": [ { "name": string, "type": string, "jsonLd": object, "instructions": string, "pageTarget": string } ] }
- name = "Article: [title]" or "WebPage: [title]"
- type = "Article" or "WebPage"
- pageTarget = exact page URL
- instructions = "Add to <head> of this page"

Return ONLY valid JSON. No prose. No markdown. No code fences.`;

  const res = await getOpenAIClient().chat.completions.create({
    model: "gpt-5.4-mini",
    temperature: 0.1,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    max_completion_tokens: 3000,
  });

  return safeParse(SchemaBlocksResponseSchema, res.choices[0]?.message?.content, { blocks: [] }).blocks;
}

export async function generateArticleBlocks(domain: string, crawlData: CrawlData): Promise<SchemaBlock[]> {
  const blogPages = crawlData.pages.filter((p) => p.pageType === "blog");
  const keyPages = crawlData.pages.filter((p) => ["about", "services", "pricing"].includes(p.pageType));
  const targetPages = [...blogPages, ...keyPages];
  if (targetPages.length === 0) return [];

  const pagesSummary = targetPages.map((p) => ({
    url: p.url,
    title: p.title,
    h1: p.h1,
    type: p.pageType,
    // 300 chars per page keeps batch size manageable; enough for accurate Article schema generation
    contentSnippet: p.content.substring(0, 300),
    isBlog: p.pageType === "blog",
  }));

  // Batch for large sites — 500 blog pages would be ~150k chars in one prompt
  const batches: typeof pagesSummary[] = [];
  for (let i = 0; i < pagesSummary.length; i += ARTICLE_BATCH_SIZE) {
    batches.push(pagesSummary.slice(i, i + ARTICLE_BATCH_SIZE));
  }

  // FIND-028: allSettled so failed batches are observable instead of swallowed.
  const results = await Promise.allSettled(batches.map((batch) => generateArticleBatch(domain, batch)));
  const failed = results.filter((r) => r.status === "rejected").length;
  const total = results.length;
  if (total > 0 && failed / total > CONTENT_BATCH_FAILURE_THRESHOLD) {
    throw new Error(`generateArticleBlocks: ${failed}/${total} batches failed (over threshold) for ${domain}`);
  }
  if (failed > 0) {
    degradedContentBatchCount += failed;
    console.warn(JSON.stringify({
      event: "content_generation_degraded",
      fn: "generateArticleBlocks",
      domain,
      failed,
      total,
      cumulative_count: degradedContentBatchCount,
    }));
  }
  return results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
}

export async function generateSchemaBlocks(domain: string, crawlData: CrawlData, geoScorecard: GeoScorecard): Promise<SchemaBlock[]> {
  const [sitewideBlocks, faqBlocks, articleBlocks] = await Promise.all([
    generateSitewideSchemaBlocks(domain, crawlData, geoScorecard),
    generatePerPageFaqBlocks(domain, crawlData),
    generateArticleBlocks(domain, crawlData),
  ]);

  // Always include robots.txt AI-bot directives — licensing_signals pillar (2.5)
  // Score 60+ just for having llms.txt. Named bot directives push it to 95+.
  const robotsTxtBlock = generateRobotsTxtBlock(domain);

  return [...sitewideBlocks, faqBlocks, articleBlocks, robotsTxtBlock].flat();
}

/** Strip placeholder/fake phone numbers from business JSON */
export function sanitizeBusinessJson(bj: object): object {
  const b = JSON.parse(JSON.stringify(bj)) as Record<string, unknown>;
  const geo = b.geo_profile as Record<string, unknown> | undefined;
  if (geo?.contact) {
    const contact = geo.contact as Record<string, unknown>;
    const phone = String(contact.phone ?? "");
    // Remove if it's a known placeholder or sequential digits
    const fakePat = /^(\+?1[-.\s]?)?0?1?2?3?4?5?6?7?8?9?0?$|^0{3,}|012345|123456789|000-000/;
    if (phone && (fakePat.test(phone.replace(/\D/g, "")) || phone.replace(/\D/g, "").length < 7)) {
      delete contact.phone;
    }
    // Remove empty contact object
    if (Object.keys(contact).length === 0) delete geo.contact;
  }
  return b;
}

/** Fix common llms.txt format issues from model output */
export function sanitizeLlmsTxt(txt: string): string {
  // Strip wrapping code fences if model added them
  let out = txt.replace(/^```(?:txt|markdown)?\n/, "").replace(/\n```\s*$/, "");
  out = out.trim();
  // Model sometimes writes "H1: CompanyName" instead of "# CompanyName"
  out = out.replace(/^H1:\s*(.+)/m, "# $1");
  // If first line exists but doesn't start with #, it's the company name without markdown
  const firstLine = out.split("\n")[0].trim();
  if (firstLine && !firstLine.startsWith("#") && !firstLine.startsWith(">") && firstLine.length < 80) {
    out = "# " + firstLine + "\n" + out.split("\n").slice(1).join("\n");
  }
  return out.trim();
}

export async function generateContent(
  domain: string,
  crawlData: CrawlData,
  competitiveIntel: CompetitiveIntel,
  geoScorecard: GeoScorecard
): Promise<GeneratedContent> {
  const [llmsResult, rawBusinessJson, schemaBlocks] = await Promise.all([
    generateLlmsTxt(domain, crawlData, geoScorecard),
    generateBusinessJson(domain, crawlData, geoScorecard, competitiveIntel),
    generateSchemaBlocks(domain, crawlData, geoScorecard),
  ]);
  return {
    llmsTxt: sanitizeLlmsTxt(llmsResult.llmsTxt),
    llmsFullTxt: sanitizeLlmsTxt(llmsResult.llmsFullTxt),
    businessJson: sanitizeBusinessJson(rawBusinessJson),
    schemaBlocks,
  };
}
