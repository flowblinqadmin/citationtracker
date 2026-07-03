import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { createOpenAIClient, resolveOpenAIModel } from "@/lib/llm/openai-route";
import { type GeoSite } from "@/lib/db/schema";
import { type GeoScorecard } from "@/lib/services/geo-analyzer";
import type {
  GeoTree, CategoryTree, GeoCategoryMapping,
  GeoNode, CategoryNode,
} from "@/lib/types/trees";
import type { CitationPrompt as CitationPromptFull, RealPromptDiscovery } from "@/lib/types/citation";
import { getGoogleGenAIKey } from "@/lib/google-genai-key";
import type { ExtractedCategories } from "@/lib/services/category-extractor";

// ── Re-export type (backward compat) ─────────────────────────────────────────

export type CitationPrompt = CitationPromptFull;

// ── Types (C4) ───────────────────────────────────────────────────────────────

export type AllocationCase = "A" | "B" | "C";

export type SamplingPlan = {
  case: AllocationCase;
  categoryOnly: number;
  geoOnly: number;
  geoCrossCategory: number;
  intentDiverse: number;
  mappingSamples: Array<{ geoId: string; categoryId: string }>;
};

// ── Site input type (union of legacy + tree-based fields) ────────────────────

type GeneratePromptsSite = {
  domain: string;
  siteType?: string | null;
  // Legacy fields
  geoScorecard?: unknown;
  executiveSummary?: string | null;
  crawlData?: unknown;
  // Tree-based fields (C4)
  geoTree?: GeoTree | null;
  categoryTree?: CategoryTree | null;
  geoCategoryMapping?: GeoCategoryMapping | null;
  generatedLlmsTxt?: string | null;
  generatedBusinessJson?: unknown;
  // ES-056 C12: real prompt hints from Perplexity discovery (injected by route)
  realPromptHints?: RealPromptDiscovery[];
  // ES-059: LLM-extracted categories + entity noun
  extractedCategories?: ExtractedCategories | null;
};

// ── Timeout constant ──────────────────────────────────────────────────────────

const PROMPT_GEN_TIMEOUT_MS = 60_000;

// ── Current year ──────────────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

// ── Legacy fallback (4 prompts: 2 indirect + 2 direct) ───────────────────────

const LEGACY_PROMPTS: CitationPrompt[] = [
  { type: "indirect", pillar: "competitive_positioning", prompt: "What are the best GEO optimization tools for SaaS companies in {year}?" },
  { type: "indirect", pillar: "author_authority",        prompt: "Who are the leading experts and companies in AI search optimization?" },
  { type: "direct",   pillar: null, prompt: "What is {domain} and what does it offer?" },
  { type: "direct",   pillar: null, prompt: "How does {domain} compare to alternatives for GEO optimization?" },
];

function buildFallback(domain: string): CitationPrompt[] {
  const year = new Date().getFullYear().toString();
  return LEGACY_PROMPTS.map(({ type, pillar, prompt }) => ({
    type,
    pillar,
    prompt: prompt.replace(/\{domain\}/g, domain).replace(/\{year\}/g, year),
  }));
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidCitationPromptArray(data: unknown): data is CitationPrompt[] {
  if (!Array.isArray(data) || data.length < 20) return false;
  return data.every((item) => {
    if (typeof item !== "object" || item === null) return false;
    const { type, prompt } = item as Record<string, unknown>;
    return (type === "indirect" || type === "direct") && typeof prompt === "string";
  });
}

// ── Prompt cap (40 indirect + 8 direct = 48 max) ─────────────────────────────

function capPrompts(prompts: CitationPrompt[]): CitationPrompt[] {
  const pillarCounts: Record<string, number> = {};
  const indirect = prompts
    .filter(p => p.type === "indirect")
    .filter(p => {
      const key = p.pillar ?? "__none__";
      pillarCounts[key] = (pillarCounts[key] ?? 0) + 1;
      return pillarCounts[key] <= 2;
    })
    .slice(0, 40);
  const direct = prompts.filter(p => p.type === "direct").slice(0, 8);
  return [...indirect, ...direct];
}

// ── Domain leak filter ────────────────────────────────────────────────────────

function filterIndirectDomainLeaks(prompts: CitationPrompt[], domain: string): CitationPrompt[] {
  const domainStem = domain.replace(/\.(com|io|co|net|org|ai|app|dev).*$/i, "");
  const escapedStem   = domainStem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedDomain = domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b(${escapedDomain}|${escapedStem})\\b`, "i");

  return prompts.filter((p) => {
    if (p.type !== "indirect") return true;
    if (regex.test(p.prompt)) {
      console.warn(`[citation-prompts] stripped indirect prompt leaking domain: "${p.prompt}"`);
      return false;
    }
    return true;
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// C4: Tree-Based Prompt Generation (ES-053)
// ══════════════════════════════════════════════════════════════════════════════

// ── Allocation case ──────────────────────────────────────────────────────────

export function determineAllocationCase(
  geoTree: GeoTree,
  categoryTree: CategoryTree,
  mapping: GeoCategoryMapping
): AllocationCase {
  const mappingCount = mapping?.totalEntries ?? 0;
  const geoLeafCount = geoTree?.leafCount ?? 0;

  if (mappingCount > 10) return "A";
  if (geoLeafCount > 0) return "B";
  return "C";
}

// ── Sampling plan ────────────────────────────────────────────────────────────

export function buildSamplingPlan(
  geoTree: GeoTree,
  categoryTree: CategoryTree,
  mapping: GeoCategoryMapping
): SamplingPlan {
  const allocationCase = determineAllocationCase(geoTree, categoryTree, mapping);

  const allocations: Record<AllocationCase, { categoryOnly: number; geoOnly: number; geoCrossCategory: number; intentDiverse: number }> = {
    A: { categoryOnly: 8, geoOnly: 6, geoCrossCategory: 16, intentDiverse: 10 },
    B: { categoryOnly: 15, geoOnly: 0, geoCrossCategory: 10, intentDiverse: 15 },
    C: { categoryOnly: 20, geoOnly: 0, geoCrossCategory: 0, intentDiverse: 20 },
  };

  const alloc = allocations[allocationCase];

  // Select mapping samples for geo×category prompts
  const entries = [...(mapping?.entries ?? [])];
  // Sort by strength (strong > moderate > inferred), then pageCount desc
  const strengthOrder: Record<string, number> = { strong: 0, moderate: 1, inferred: 2 };
  entries.sort((a, b) => {
    const sDiff = (strengthOrder[a.strength] ?? 3) - (strengthOrder[b.strength] ?? 3);
    if (sDiff !== 0) return sDiff;
    return 0; // pageCount not directly available on entries
  });

  // Enforce 25% cap per geo node
  const maxPerGeo = Math.max(1, Math.ceil(alloc.geoCrossCategory * 0.25));
  const geoCounts: Record<string, number> = {};
  const maxPerCat = Math.max(1, Math.ceil(alloc.geoCrossCategory * 0.25));
  const catCounts: Record<string, number> = {};

  const mappingSamples: Array<{ geoId: string; categoryId: string }> = [];
  for (const entry of entries) {
    if (mappingSamples.length >= alloc.geoCrossCategory) break;
    const geoCount = geoCounts[entry.geoId] ?? 0;
    const catCount = catCounts[entry.categoryId] ?? 0;
    if (geoCount >= maxPerGeo || catCount >= maxPerCat) continue;
    geoCounts[entry.geoId] = geoCount + 1;
    catCounts[entry.categoryId] = catCount + 1;
    mappingSamples.push({ geoId: entry.geoId, categoryId: entry.categoryId });
  }

  return {
    case: allocationCase,
    ...alloc,
    mappingSamples,
  };
}

// ── Prune tree ───────────────────────────────────────────────────────────────

export function pruneTree<T extends { children: T[]; pageCount: number }>(
  root: T,
  maxNodes: number
): T {
  // Collect all nodes with their parent references
  const parentMap = new Map<T, T | null>();

  function collect(node: T, parent: T | null) {
    parentMap.set(node, parent);
    for (const child of node.children) {
      collect(child, node);
    }
  }
  collect(root, null);

  if (parentMap.size <= maxNodes) return root;

  // Sort by pageCount descending (keep highest), always keep root
  const sorted = [...parentMap.keys()]
    .filter(n => n !== root)
    .sort((a, b) => b.pageCount - a.pageCount);

  const keepSet = new Set<T>([root]);

  // Add top nodes by pageCount, plus all ancestors up to root
  for (const node of sorted) {
    if (keepSet.size >= maxNodes) break;
    // Add node + all ancestors to ensure path from root is preserved
    let current: T | null = node;
    while (current && !keepSet.has(current)) {
      keepSet.add(current);
      current = parentMap.get(current) ?? null;
    }
  }

  // Rebuild tree keeping only nodes in keepSet
  function rebuild(node: T): T {
    const keptChildren = node.children
      .filter(child => keepSet.has(child))
      .map(child => rebuild(child));
    return { ...node, children: keptChildren };
  }

  return rebuild(root);
}

// ── Tree-based system prompt ─────────────────────────────────────────────────

const TREE_SYSTEM_PROMPT = `# Role (Current year: ${CURRENT_YEAR})
You are a market query generator for AI citation measurement. Generate queries grounded in a business's geographic and service/product scope, distributed across GEO optimization pillars.

<task>
Generate exactly 48 queries (40 indirect + 8 direct) as a JSON array.
Return ONLY valid JSON. No prose. No markdown. No code fences.
</task>

<indirect_rules>
40 indirect queries — domain MUST NOT appear.

Each query must:
- Sound like a real buyer searching ChatGPT/Perplexity/Google AI
- Reference specific locations and/or services from the provided trees
- Vary sentence structure — no two queries may share the same template
- Include a "tier" tag: "buy" (purchase-intent), "solve" (problem-solving), or "learn" (research)
- Include a "pillar" tag from the GEO pillar set below

Distribute 2-3 queries per pillar group, grounded in the geo/category trees:

DISCOVERY (pillars: competitive_positioning, entity_definitions, offering_clarity)
  Buyer is learning what exists. Queries ask for lists, comparisons, definitions.
  Ground in specific locations/services from the trees.

EVALUATION (pillars: evidence_statistics, contact_trust, author_authority, faq_coverage)
  Buyer is comparing shortlisted options. Queries ask about proof, trust, credentials, track record.
  Example: "Which {category} providers in {city} have published case studies with measurable results?"

TECHNICAL FIT (pillars: structured_data, semantic_html, multi_format, internal_linking)
  Buyer is checking integration and technical quality.
  Example: "Which {category} platforms integrate natively with AI assistants?"

CURRENCY (pillars: content_freshness, metadata_freshness, content_structure)
  Buyer wants to know what's current and recently updated.
  Example: "Which {category} providers in {city} have shipped updates in the last 6 months?"

READINESS (pillars: licensing_signals, cta_structure)
  Buyer is ready to act. Queries ask about trials, pricing, getting started.
  Example: "Which {category} tools in {city} offer a free trial?"

IMPORTANT:
- Each of the 16 pillars must appear 2-3 times across the 40 indirect queries.
- CRITICAL: Queries must ask about COMPANIES and PLATFORMS — never individual people.
- Do NOT copy examples verbatim. They illustrate the angle, not a template.

Distribution per sampling plan:
- categoryOnly: queries about specific services/products (no location)
- geoOnly: queries about specific locations (no service)
- geoCrossCategory: queries combining location × service (e.g., "best oncology hospital in Bangalore")
- intentDiverse: general market/industry queries

Tier distribution within each bucket: ~20% buy, ~40% solve, ~40% learn.
</indirect_rules>

<direct_rules>
8 direct queries — domain MUST appear.
These measure brand knowledge. pillar: null, tier: null for all.
</direct_rules>

<output_format>
[
  { "type": "indirect", "pillar": "competitive_positioning", "prompt": "...", "geoId": "in-ka-blr", "categoryId": "hc-onc", "tier": "solve" },
  { "type": "direct", "pillar": null, "prompt": "What is example.com?", "geoId": null, "categoryId": null, "tier": null }
]
</output_format>`;

// ── Collect node IDs from trees ──────────────────────────────────────────────

function collectGeoNodeIds(node: GeoNode): Set<string> {
  const ids = new Set<string>();
  ids.add(node.id);
  for (const child of node.children ?? []) {
    for (const id of collectGeoNodeIds(child)) ids.add(id);
  }
  return ids;
}

function collectCategoryNodeIds(node: CategoryNode): Set<string> {
  const ids = new Set<string>();
  ids.add(node.id);
  for (const child of node.children ?? []) {
    for (const id of collectCategoryNodeIds(child)) ids.add(id);
  }
  return ids;
}

// ── Extract top city names from geoTree (for real prompt discovery) ──────────

export function extractTopCityNames(geoTree: GeoTree | null | undefined, n = 3): string[] {
  if (!geoTree?.root) return [];
  const leaves: GeoNode[] = [];
  function collect(node: GeoNode) {
    if (!node.children || node.children.length === 0) {
      leaves.push(node);
    } else {
      for (const child of node.children) collect(child);
    }
  }
  collect(geoTree.root);
  // FIX-6: sort by pageCount descending so most-referenced cities are used
  leaves.sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0));
  return leaves.slice(0, n).map(l => l.name);
}

// ── Tree-based user prompt ───────────────────────────────────────────────────

function buildTreeUserPrompt(site: GeneratePromptsSite, plan: SamplingPlan, realPrompts: RealPromptDiscovery[] = []): string {
  const geoTree = site.geoTree;
  const categoryTree = site.categoryTree;

  const prunedGeo = geoTree?.root ? pruneTree(geoTree.root, 50) : null;
  const prunedCat = categoryTree?.root ? pruneTree(categoryTree.root, 50) : null;

  let prompt = `<business_profile>\n`;
  prompt += `Domain: ${site.domain}\n`;
  prompt += `Industry: ${site.siteType ?? "Unknown"}\n`;
  if (site.generatedLlmsTxt) {
    prompt += `\nBusiness description:\n${(site.generatedLlmsTxt as string).slice(0, 800)}\n`;
  }
  prompt += `\nCRITICAL: The business description above defines what ${site.domain} ACTUALLY does. Generate prompts about THEIR specific services, target market, and differentiators — NOT generic industry queries. Every indirect prompt must be about something a real buyer of THIS company's services would search for.\n`;
  prompt += `</business_profile>\n\n`;

  if (prunedGeo) {
    prompt += `<geo_tree>\n${JSON.stringify(prunedGeo, null, 2)}\n</geo_tree>\n\n`;
  }
  if (prunedCat) {
    prompt += `<category_tree>\n${JSON.stringify(prunedCat, null, 2)}\n</category_tree>\n\n`;
  }

  prompt += `<sampling_plan>\n`;
  prompt += `Allocation case: ${plan.case}\n`;
  prompt += `categoryOnly: ${plan.categoryOnly} queries (service/product focused, no location)\n`;
  prompt += `geoOnly: ${plan.geoOnly} queries (location focused, no specific service)\n`;
  prompt += `geoCrossCategory: ${plan.geoCrossCategory} queries (location × service combinations)\n`;
  prompt += `intentDiverse: ${plan.intentDiverse} queries (general market/industry)\n`;
  if (plan.mappingSamples.length > 0) {
    prompt += `\nSuggested geo×category pairs:\n`;
    for (const sample of plan.mappingSamples) {
      prompt += `  - ${sample.geoId} × ${sample.categoryId}\n`;
    }
  }
  prompt += `</sampling_plan>\n\n`;

  if (realPrompts.length > 0) {
    prompt += `<real_user_questions>\n`;
    prompt += `Real questions users ask about this category (from Google PAA, Reddit, Quora):\n`;
    prompt += realPrompts.map(p => `- [${p.source}] ${p.query}`).join("\n");
    prompt += `\n\nUse these to inform the phrasing and intent of your generated queries.\nAdopt natural language patterns from these real questions.\n`;
    prompt += `</real_user_questions>\n\n`;
  }

  prompt += `Generate 48 queries (40 indirect + 8 direct) as a JSON array.\n`;
  prompt += `\n<rules>\n`;
  prompt += `- Indirect queries MUST NOT contain "${site.domain}" or any variation\n`;
  prompt += `- Direct queries MUST contain "${site.domain}"\n`;
  prompt += `- Set pillar: null for all prompts\n`;
  prompt += `- Tag each with geoId, categoryId (from the trees), tier, and queryType\n`;
  prompt += `- When queries reference a year, use ${CURRENT_YEAR}\n`;
  prompt += `</rules>`;

  return prompt;
}

// ── Tree-specific prompt cap (no per-pillar filter — pillar is null) ─────────

function capTreePrompts(prompts: CitationPrompt[]): CitationPrompt[] {
  const indirect = prompts.filter(p => p.type === "indirect").slice(0, 40);
  const direct = prompts.filter(p => p.type === "direct").slice(0, 8);
  return [...indirect, ...direct];
}

// ── Post-processing: validate geo/category tags ──────────────────────────────

function validateAndCleanTags(
  prompts: CitationPrompt[],
  geoTree: GeoTree | null | undefined,
  categoryTree: CategoryTree | null | undefined
): CitationPrompt[] {
  const validGeoIds = geoTree?.root ? collectGeoNodeIds(geoTree.root) : new Set<string>();
  const validCatIds = categoryTree?.root ? collectCategoryNodeIds(categoryTree.root) : new Set<string>();

  return prompts.map(p => {
    const cleaned = { ...p };
    if (cleaned.geoId && !validGeoIds.has(cleaned.geoId)) {
      cleaned.geoId = null;
    }
    if (cleaned.categoryId && !validCatIds.has(cleaned.categoryId)) {
      cleaned.categoryId = null;
    }
    // Validate pillar is from the known set; null out invalid ones
    const VALID_PILLARS = new Set([
      "competitive_positioning", "entity_definitions", "offering_clarity",
      "evidence_statistics", "contact_trust", "author_authority", "faq_coverage",
      "structured_data", "semantic_html", "multi_format", "internal_linking",
      "content_freshness", "metadata_freshness", "content_structure",
      "licensing_signals", "cta_structure",
    ]);
    if (cleaned.pillar) {
      // FIX-3: normalize case before lookup — LLM may output wrong case
      const normalized = cleaned.pillar.toLowerCase().replace(/\s+/g, "_");
      if (VALID_PILLARS.has(normalized)) {
        cleaned.pillar = normalized;
      } else {
        console.warn(`[citation-prompts] Invalid pillar "${cleaned.pillar}" → null`);
        cleaned.pillar = null;
      }
    }
    return cleaned;
  });
}

// ── Tree-based LLM calls ─────────────────────────────────────────────────────

async function callTreeSonnet(userPrompt: string): Promise<CitationPrompt[] | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const client = new Anthropic();
  const response = await Promise.race([
    client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      temperature: 0,
      system: TREE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), PROMPT_GEN_TIMEOUT_MS)
    ),
  ]);

  const text = (response as any).content?.[0]?.text;
  if (!text) return null;

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!isValidCitationPromptArray(parsed)) return null;
  return parsed as CitationPrompt[];
}

async function callTreeGpt4o(userPrompt: string): Promise<CitationPrompt[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const client = createOpenAIClient();
  const response = await Promise.race([
    client.chat.completions.create({
      model: resolveOpenAIModel("gpt-5.4"),
      max_completion_tokens: 4000,
      temperature: 0,
      messages: [
        { role: "system", content: TREE_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), PROMPT_GEN_TIMEOUT_MS)
    ),
  ]);

  const text = (response as any).choices?.[0]?.message?.content;
  if (!text) return null;

  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parsed = JSON.parse(cleaned);
  if (!isValidCitationPromptArray(parsed)) return null;
  return parsed as CitationPrompt[];
}

// ── Tree-based prompt generation ─────────────────────────────────────────────

async function generatePromptsTreeBased(site: GeneratePromptsSite): Promise<CitationPrompt[] | null> {
  const domain = site.domain;
  const plan = buildSamplingPlan(site.geoTree!, site.categoryTree!, site.geoCategoryMapping!);
  const userPrompt = buildTreeUserPrompt(site, plan, site.realPromptHints ?? []);

  // Try Sonnet
  try {
    const prompts = await callTreeSonnet(userPrompt);
    if (prompts) {
      const cleaned = validateAndCleanTags(prompts, site.geoTree, site.categoryTree);
      const filtered = capTreePrompts(filterIndirectDomainLeaks(cleaned, domain));
      console.info(`[citation-prompts] ${domain}: tree-based Sonnet succeeded — ${filtered.length} prompts (case ${plan.case})`);
      return filtered;
    }
  } catch (err) {
    console.warn(`[citation-prompts] ${domain}: tree-based Sonnet failed: ${(err as Error).message}`);
  }

  // Try GPT-4o
  try {
    const prompts = await callTreeGpt4o(userPrompt);
    if (prompts) {
      const cleaned = validateAndCleanTags(prompts, site.geoTree, site.categoryTree);
      const filtered = capTreePrompts(filterIndirectDomainLeaks(cleaned, domain));
      console.info(`[citation-prompts] ${domain}: tree-based GPT-4o succeeded — ${filtered.length} prompts`);
      return filtered;
    }
  } catch (err) {
    console.warn(`[citation-prompts] ${domain}: tree-based GPT-4o failed: ${(err as Error).message}`);
  }

  // Tree-based generation failed
  console.warn(`[citation-prompts] ${domain}: tree-based generation failed, falling back to legacy generator`);
  return null;
}

// ── Check if trees are available ─────────────────────────────────────────────

function hasUsableTrees(site: GeneratePromptsSite): boolean {
  const geoLeafCount = site.geoTree?.leafCount ?? 0;
  const catLeafCount = site.categoryTree?.leafCount ?? 0;
  return geoLeafCount > 0 || catLeafCount > 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// Legacy System Prompt & User Prompt (Haiku path)
// ══════════════════════════════════════════════════════════════════════════════

const SYSTEM_PROMPT = `# Role (Current year: ${CURRENT_YEAR})
You are a market query generator for AI citation measurement. Generate natural-language questions that real buyers and researchers type into ChatGPT, Perplexity, and Google AI when exploring a market or evaluating vendors.

<task>
Generate exactly 48 queries in two categories as a JSON array.
Return ONLY valid JSON. No prose. No markdown. No code fences.
</task>

<category_1_indirect>
INDIRECT QUERIES — 40 total, 2-3 per GEO pillar

Purpose: Measure whether the domain is organically cited when users ask market-level questions. The domain should appear spontaneously in AI responses if it is well-known.

CRITICAL RULE: Indirect queries MUST NOT contain the domain name or any variation of it.

Each query must sound like something a real buyer would type into ChatGPT or Perplexity — questions that naturally produce a ranked list of specific companies or tools. Avoid abstract or technical questions that AI models answer without naming anyone.

CRITICAL RULE: Queries must ask about COMPANIES and PLATFORMS — never about individual people, executives, or "experts". Questions like "who are the experts in X" return individual names, not companies. Rephrase as "which companies" or "which platforms".

Generate queries across these buyer-intent angles. Each pillar must appear 2-3 times, but vary the angle:

DISCOVERY (pillars: competitive_positioning, entity_definitions, offering_clarity)
  Buyer is learning what exists. Queries ask for lists, comparisons, or definitions.
  Example angle: "What are the best tools for [specific use case] in ${CURRENT_YEAR}?"

EVALUATION (pillars: evidence_statistics, contact_trust, author_authority, faq_coverage)
  Buyer is comparing shortlisted options. Queries ask about proof, trust, track record.
  Example angle: "Which [category] platforms have published case studies with measurable results?"

TECHNICAL FIT (pillars: structured_data, semantic_html, multi_format, internal_linking)
  Buyer is checking integration and technical quality. Queries ask about compatibility.
  Example angle: "Which [category] tools integrate natively with AI assistants and chatbots?"

CURRENCY (pillars: content_freshness, metadata_freshness, content_structure)
  Buyer wants to know what's current. Queries ask about recent updates.
  Example angle: "Which [category] platforms have shipped major updates in the last 6 months?"

READINESS (pillars: licensing_signals, cta_structure)
  Buyer is ready to act. Queries ask about getting started, trials, enterprise readiness.
  Example angle: "Which [category] tools offer a free trial I can start today?"

IMPORTANT:
- Do NOT copy the example angles verbatim. They illustrate the angle, not a template.
- Every query must use the specific category/market from the crawled homepage content provided.
- If two queries for the same pillar use the same sentence structure with only a word swapped, rewrite one.
</category_1_indirect>

<category_2_direct>
DIRECT QUERIES — 8 total, pillar: null

Purpose: Measure brand knowledge depth — what AI models know about the domain.

CRITICAL RULE: Direct queries MUST contain the domain name.

Generate these 8 queries (substitute {domain} with the actual domain):
1. "What is {domain} and what does it offer?"
2. "Is {domain} a good choice for [use case based on siteType]?"
3. "How does {domain} compare to its main competitors?"
4. "What are the key features of {domain}?"
5. "Is {domain} trustworthy and well-regarded in its industry?"
6. "What do customers and reviewers say about {domain}?"
7. "Who is the ideal user or buyer for {domain}?"
8. "How frequently does {domain} update its product or content?"
</category_2_direct>

<output_format>
Return ONLY valid JSON. No prose. No markdown. No code fences.

[
  {
    "type": "indirect",
    "pillar": "competitive_positioning",
    "prompt": "What are the top AI visibility tools for e-commerce in ${CURRENT_YEAR}?"
  },
  {
    "type": "direct",
    "pillar": null,
    "prompt": "What is example.com and what does it offer?"
  }
]
</output_format>`;

function buildLegacyUserPrompt(
  site: GeneratePromptsSite
): string {
  type CrawlPage = {
    pageType?: string;
    content?: string;
    url?: string;
    hasStructuredData?: boolean;
    existingSchema?: unknown[];
    faqContent?: unknown[];
    testimonials?: unknown[];
  };

  const crawlData = site.crawlData as { pages?: CrawlPage[] } | null;
  const pages = crawlData?.pages ?? [];
  const homepageContent = pages.find(p => p.pageType === "homepage")?.content?.slice(0, 400) ?? "";
  const aboutContent = pages.find(p => p.pageType === "about")?.content?.slice(0, 200) ?? "";
  const crawledDescription = (homepageContent + " " + aboutContent).trim().slice(0, 500);

  const hasFaq        = pages.some(p => p.pageType === "faq" || (Array.isArray(p.faqContent) && p.faqContent.length > 0));
  const hasTestimonials = pages.some(p => Array.isArray(p.testimonials) && p.testimonials.length > 0);
  const hasSchema     = pages.some(p => p.hasStructuredData || (Array.isArray(p.existingSchema) && p.existingSchema.length > 0));
  const hasPricing    = pages.some(p => p.pageType === "pricing" || (p.url ?? "").toLowerCase().includes("/pricing"));
  const hasBlog       = pages.some(p => p.pageType === "blog" || p.pageType === "article");
  const hasAbout      = pages.some(p => p.pageType === "about");

  const scorecard = site.geoScorecard as GeoScorecard | null;
  const licensingScore = scorecard?.pillars?.find(p => p.pillar === "licensing_signals")?.score ?? null;
  const hasLlmsTxt = licensingScore !== null ? licensingScore >= 60 : null;

  const gap = (present: boolean) => present ? "present" : "missing";

  return `<grounding>
Domain: ${site.domain}
Site type: ${site.siteType ?? "unknown"}

Crawled homepage content — this is your PRIMARY source of truth for determining the company's market, category, and use cases. Base ALL category references on this content. Do NOT infer the category from the domain name.

${crawledDescription || "not available"}

Executive summary:
${(site.executiveSummary as string | null)?.slice(0, 300) ?? "not available"}
</grounding>

<crawl_gaps>
The following are factual observations from the site crawl. Use them to ensure queries cover areas where the site has gaps — but distribute queries evenly across all 16 pillars regardless.

Missing elements (not found on site):
- FAQ page or section: ${gap(hasFaq)}
- Customer testimonials or case studies: ${gap(hasTestimonials)}
- Schema markup (JSON-LD): ${gap(hasSchema)}
- llms.txt file: ${hasLlmsTxt === null ? "unknown" : gap(hasLlmsTxt)}
- Pricing page: ${gap(hasPricing)}
- Blog or resource section: ${gap(hasBlog)}
- About/team page: ${gap(hasAbout)}

These gaps should inform query phrasing (e.g. if no case studies exist, include an evaluation query about proven results) but should NOT cause you to generate more than 3 queries for any single pillar.
</crawl_gaps>

Generate 48 queries (40 indirect + 8 direct) as a JSON array.

<rules>
- Base all market/category references on the crawled homepage content, NOT the domain name
- Indirect queries MUST NOT contain "${site.domain}" or any variation of it
- Direct queries MUST contain "${site.domain}"
- All 16 GEO pillars must be represented in indirect queries (2-3 per pillar, max 3)
- Every indirect query must naturally produce a ranked list of specific companies or tools
- Do not generate abstract questions that AI models answer without naming companies
- When queries reference a year, use ${CURRENT_YEAR}
- No two indirect queries may share the same sentence structure with only a keyword swapped
</rules>`;
}

// ── tryProvider helper (legacy) ──────────────────────────────────────────────

async function tryProvider(
  name: string,
  fn: () => Promise<string>,
  domain: string
): Promise<CitationPrompt[] | null> {
  const t0 = Date.now();
  try {
    const raw = await Promise.race([
      fn(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), PROMPT_GEN_TIMEOUT_MS)
      ),
    ]);
    const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(text) as unknown;
    if (!isValidCitationPromptArray(parsed)) {
      throw new Error(
        `validation failed: got ${Array.isArray(parsed) ? parsed.length : "non-array"}`
      );
    }
    const filtered = capPrompts(filterIndirectDomainLeaks(parsed as CitationPrompt[], domain));
    const elapsed = Date.now() - t0;
    console.info(
      `[citation-prompts] ${domain}: ${name} succeeded — ${filtered.length} prompts in ${elapsed}ms`
    );
    return filtered;
  } catch (err) {
    return null;
  }
}

// ── Legacy prompt generation (renamed from original generatePrompts) ─────────

async function generatePromptsLegacy(site: GeneratePromptsSite): Promise<CitationPrompt[]> {
  const domain = site.domain;

  const hasAnyKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.PERPLEXITY_API_KEY;

  if (!hasAnyKey) {
    return buildFallback(domain);
  }

  const t0 = Date.now();
  const userPrompt = buildLegacyUserPrompt(site);
  const attempted: string[] = [];

  const openAiFn = async (): Promise<string> => {
    const client = createOpenAIClient();
    const res = await client.chat.completions.create({
      model: resolveOpenAIModel("gpt-5.4-mini"),
      max_completion_tokens: 3000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  };

  const googleFn = async (): Promise<string> => {
    const client = new GoogleGenerativeAI(getGoogleGenAIKey());
    const model = client.getGenerativeModel({ model: "gemini-3.5-flash" });  // NEW-AI-07 + 2026-06-10 modernization: flash-lite hallucinates on unknown brands; 3.5-flash is current frontier flash
    const res = await model.generateContent(`${SYSTEM_PROMPT}\n\n${userPrompt}`);
    return res.response.text();
  };

  const perplexityFn = async (): Promise<string> => {
    const client = new OpenAI({
      apiKey: process.env.PERPLEXITY_API_KEY,
      baseURL: "https://api.perplexity.ai",
    });
    const res = await client.chat.completions.create({
      model: "sonar",
      max_completion_tokens: 3000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user",   content: userPrompt },
      ],
    });
    return res.choices[0]?.message?.content ?? "";
  };

  const FALLBACK_PROVIDERS: Array<{ name: string; envKey: string; fn: () => Promise<string> }> = [
    { name: "openai",     envKey: "OPENAI_API_KEY",               fn: openAiFn },
    { name: "google",     envKey: "GEMINI_API_KEY", fn: googleFn },
    { name: "perplexity", envKey: "PERPLEXITY_API_KEY",           fn: perplexityFn },
  ];

  if (process.env.ANTHROPIC_API_KEY) {
    attempted.push("haiku");
    try {
      const client = new Anthropic();
      const message = await Promise.race([
        client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 3000,
          temperature: 0,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), PROMPT_GEN_TIMEOUT_MS)
        ),
      ]);
      const raw = (message.content[0] as { type: "text"; text: string }).text;
      const text = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const parsed = JSON.parse(text) as unknown;
      if (!isValidCitationPromptArray(parsed)) {
        throw new Error(`validation failed: got ${Array.isArray(parsed) ? parsed.length : "non-array"}`);
      }
      const filtered = capPrompts(filterIndirectDomainLeaks(parsed as CitationPrompt[], domain));
      const elapsed = Date.now() - t0;
      console.info(
        `[citation-prompts] ${domain}: haiku succeeded — ${filtered.length} prompts in ${elapsed}ms`
      );
      return filtered;
    } catch (err) {
      const configuredFallbacks = FALLBACK_PROVIDERS.filter(p => process.env[p.envKey]);
      const nextName = configuredFallbacks[0]?.name ?? "none";
      if (nextName !== "none") {
        console.warn(`[citation-prompts] ${domain}: haiku failed, trying ${nextName}. Error: ${err}`);
      } else {
        console.warn(`[citation-prompts] ${domain}: haiku failed, no fallback providers configured. Error: ${err}`);
      }
    }
  }

  for (const provider of FALLBACK_PROVIDERS) {
    if (!process.env[provider.envKey]) continue;
    attempted.push(provider.name);
    const result = await tryProvider(provider.name, provider.fn, domain);
    if (result !== null) return result;

    const remainingIdx = FALLBACK_PROVIDERS.indexOf(provider) + 1;
    const nextConfigured = FALLBACK_PROVIDERS
      .slice(remainingIdx)
      .find(p => process.env[p.envKey]);
    if (nextConfigured) {
      console.warn(`[citation-prompts] ${domain}: ${provider.name} failed, trying ${nextConfigured.name}.`);
    } else {
      console.warn(`[citation-prompts] ${domain}: ${provider.name} failed.`);
    }
  }

  console.warn(
    `[citation-prompts] ${domain}: all providers failed [${attempted.join(", ")}] — using 4 legacy prompts`
  );
  return buildFallback(domain);
}

// ══════════════════════════════════════════════════════════════════════════════
// TS-058 V2: Programmatic Seed Construction + Haiku Rephrasing
// ══════════════════════════════════════════════════════════════════════════════

// ── V2 Types ─────────────────────────────────────────────────────────────────

type GeoLevel = {
  level: "global" | "country" | "region" | "city";
  name: string | null;
  geoId: string | null;
};

type Angle = "discovery" | "evaluation" | "trust" | "clarity" | "readiness";

type Triple = {
  category: string;
  geoLevel: GeoLevel;
  angle: Angle;
};

type Seed = {
  text: string;
  geoId: string | null;
  categoryId: string | null;
  pillar: string;
  tier: "buy" | "solve" | "learn";
};

// ── Angle → pillar / tier (spec 1.3) ─────────────────────────────────────────

const ANGLES: Angle[] = ["discovery", "evaluation", "trust", "clarity", "readiness"];

// FIX-1: paired pillars for clarity and trust to cover all 7 buyer pillars
// trust     alternates: author_authority   (even index) ↔ contact_trust   (odd index)
// readiness alternates: licensing_signals (even index) ↔ cta_structure   (odd index)
const ANGLE_PILLAR: Record<Angle, string | [string, string]> = {
  discovery:  "competitive_positioning",
  evaluation: "evidence_statistics",
  trust:      ["author_authority", "contact_trust"],
  clarity:    "offering_clarity",
  readiness:  ["licensing_signals", "cta_structure"],
};

const ANGLE_TIER: Record<Angle, "buy" | "solve" | "learn"> = {
  discovery:  "learn",
  evaluation: "solve",
  trust:      "solve",
  clarity:    "learn",
  readiness:  "buy",
};

// ── 1.1 Category extraction ───────────────────────────────────────────────────

function collectCategoryLeaves(node: CategoryNode): CategoryNode[] {
  if (node.children.length === 0) return [node];
  return node.children.flatMap(child => collectCategoryLeaves(child));
}

// Sentinel names written by emptyCategoryTree() / emptyGeoTree() — not real categories
const SENTINEL_NAMES = new Set(["unknown", "root", "global", "other", "general", "miscellaneous"]);

export function extractCategories(site: GeneratePromptsSite): string[] {
  const domainStem = site.domain.replace(/\.[a-z]+$/i, "").toLowerCase();

  function isUsable(c: string): boolean {
    const lc = c.toLowerCase().trim();
    return lc.length > 1 && !lc.includes(domainStem) && !SENTINEL_NAMES.has(lc);
  }

  // 1. Persisted extracted categories (Haiku or fallback) — ES-059
  // HP-258: cutoff is `>= 1 usable` (post-filter), not `>= 2`. Symmetric with
  // path-4's `names.length >= 1` and avoids the silent drop where a Haiku
  // run that returns 3 categories but only 1 survives isUsable() falls
  // through to weaker fallback sources.
  if (site.extractedCategories?.categories && site.extractedCategories.categories.length >= 3) {
    const filtered = site.extractedCategories.categories.filter(isUsable);
    if (filtered.length >= 1) return filtered;
  }

  // 2. businessJson.geo_profile.topics
  const bj = site.generatedBusinessJson as { geo_profile?: { topics?: unknown[]; keywords?: unknown[] }; services?: unknown[] } | null;
  const topics = bj?.geo_profile?.topics;
  if (Array.isArray(topics) && topics.length > 0) {
    const cats = topics.filter((t): t is string => typeof t === "string").filter(isUsable);
    if (cats.length >= 1) return cats;
  }

  // 3. businessJson.services / keywords (richer signal when topics is sparse)
  const services = bj?.services;
  if (Array.isArray(services) && services.length > 0) {
    const names = services
      .map((s: unknown) => typeof s === "string" ? s : (s as { name?: string })?.name ?? "")
      .filter((n): n is string => typeof n === "string")
      .filter(isUsable);
    if (names.length >= 1) return names.slice(0, 6);
  }

  // 4. categoryTree leaves — only if tree extraction actually ran (leafCount > 0)
  const ct = site.categoryTree;
  if (ct && ct.leafCount > 0) {
    const leaves = collectCategoryLeaves(ct.root);
    const names = leaves
      .sort((a, b) => b.pageCount - a.pageCount)
      .slice(0, 5)
      .map(n => n.name)
      .filter(isUsable);
    if (names.length >= 1) return names;
  }

  // 5. executiveSummary heuristic: extract noun phrases after "specializes in",
  //    "provides", "offers", "platform for" etc. — last resort before giving up
  const summary = site.executiveSummary ?? "";
  if (summary.length > 40) {
    const matches = summary.match(
      /(?:specializes? in|provides?|offers?|platform for|solution for|tools? for|software for|service for)\s+([^.,;()\n]{4,40})/gi
    ) ?? [];
    const phrases = matches
      .map(m => m.replace(/^.*?(?:in|for)\s+/i, "").trim())
      .filter(isUsable);
    const deduped = [...new Set(phrases)].slice(0, 5);
    if (deduped.length >= 1) return deduped;
  }

  return [];
}

// ── Entity noun map + helper (ES-059 / B7.3) ─────────────────────────────────

const INDUSTRY_NOUN_MAP: Record<string, string> = {
  healthcare: "hospitals",
  hospital: "hospitals",
  dental: "dental clinics",
  consulting: "consultancies",
  software: "platforms",
  saas: "platforms",
  finance: "financial institutions",
  insurance: "insurers",
  legal: "law firms",
  education: "schools",
  retail: "stores",
  restaurant: "restaurants",
  manufacturing: "manufacturers",
  construction: "contractors",
  marketing: "agencies",
  "real estate": "agencies",
  travel: "tour operators",
  fitness: "studios",
};

export function getEntityNoun(site: GeneratePromptsSite): string {
  // 1. From extracted categories (Haiku)
  if (site.extractedCategories?.entityNoun) {
    return site.extractedCategories.entityNoun;
  }
  // 2. From industry-noun map (substring match on siteType)
  const st = (site.siteType ?? "").toLowerCase();
  for (const [key, noun] of Object.entries(INDUSTRY_NOUN_MAP)) {
    if (st.includes(key)) return noun;
  }
  // 3. Default
  return "companies";
}

// ── 1.2 Geo level extraction ──────────────────────────────────────────────────

function collectNodesByDepth(
  node: GeoNode,
  depth: number,
  result: Map<number, GeoNode[]>
): void {
  const existing = result.get(depth) ?? [];
  existing.push(node);
  result.set(depth, existing);
  for (const child of node.children) {
    collectNodesByDepth(child, depth + 1, result);
  }
}

export function extractGeoLevels(geoTree: GeoTree | null): GeoLevel[] {
  if (!geoTree || geoTree.leafCount === 0) {
    return [{ level: "global", name: null, geoId: null }];
  }

  const levels: GeoLevel[] = [{ level: "global", name: null, geoId: null }];
  const byDepth = new Map<number, GeoNode[]>();

  for (const child of geoTree.root.children) {
    collectNodesByDepth(child, 1, byDepth);
  }

  const depthToLevel: Record<number, "country" | "region" | "city"> = {
    1: "country",
    2: "region",
    3: "city",
  };

  for (const [depth, nodes] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    const levelName = depthToLevel[depth];
    if (!levelName) continue;
    const top2 = [...nodes]
      .sort((a, b) => b.pageCount - a.pageCount)
      .slice(0, 2);
    for (const node of top2) {
      levels.push({ level: levelName, name: node.name, geoId: node.id });
    }
  }

  return levels;
}

// ── 1.4 Pairwise covering array ───────────────────────────────────────────────

export function buildCoveringArray(
  categories: string[],
  geoLevels: GeoLevel[],
  budget: number
): Triple[] {
  // Generate full cross-product
  const allTriples: Triple[] = [];
  for (const category of categories) {
    for (const geoLevel of geoLevels) {
      for (const angle of ANGLES) {
        allTriples.push({ category, geoLevel, angle });
      }
    }
  }

  // If within budget, return all
  if (allTriples.length <= budget) return allTriples;

  // Track uncovered pairs
  const uncoveredCatGeo   = new Set<string>();
  const uncoveredCatAngle = new Set<string>();
  const uncoveredGeoAngle = new Set<string>();

  for (const cat of categories) {
    for (const geo of geoLevels) {
      uncoveredCatGeo.add(`${cat}|${geo.geoId ?? "global"}`);  // FIX-8: use geoId not name
    }
    for (const angle of ANGLES) {
      uncoveredCatAngle.add(`${cat}|${angle}`);
    }
  }
  for (const geo of geoLevels) {
    for (const angle of ANGLES) {
      uncoveredGeoAngle.add(`${geo.level}|${geo.name}|${angle}`);
    }
  }

  const selected: Triple[] = [];
  const selectedKeys = new Set<string>();

  function tripleKey(t: Triple): string {
    return `${t.category}|${t.geoLevel.level}|${t.geoLevel.name}|${t.angle}`;
  }

  function countNewPairs(t: Triple): number {
    let n = 0;
    if (uncoveredCatGeo.has(`${t.category}|${t.geoLevel.geoId ?? "global"}`))  n++;  // FIX-8
    if (uncoveredCatAngle.has(`${t.category}|${t.angle}`))                      n++;
    if (uncoveredGeoAngle.has(`${t.geoLevel.level}|${t.geoLevel.name}|${t.angle}`))   n++;
    return n;
  }

  function markCovered(t: Triple): void {
    uncoveredCatGeo.delete(`${t.category}|${t.geoLevel.geoId ?? "global"}`);  // FIX-8
    uncoveredCatAngle.delete(`${t.category}|${t.angle}`);
    uncoveredGeoAngle.delete(`${t.geoLevel.level}|${t.geoLevel.name}|${t.angle}`);
  }

  // Phase 1: Greedy pairwise covering
  while (
    selected.length < budget &&
    (uncoveredCatGeo.size > 0 || uncoveredCatAngle.size > 0 || uncoveredGeoAngle.size > 0)
  ) {
    let best: Triple | null = null;
    let bestScore = 0;

    for (const t of allTriples) {
      if (selectedKeys.has(tripleKey(t))) continue;
      const score = countNewPairs(t);
      if (
        score > bestScore ||
        (score === bestScore && score > 0 &&
          t.geoLevel.level === "city" &&
          best !== null && best.geoLevel.level !== "city")
      ) {
        bestScore = score;
        best = t;
      }
    }

    if (!best || bestScore === 0) break;

    selectedKeys.add(tripleKey(best));
    selected.push(best);
    markCovered(best);
  }

  // Phase 2: Ensure ≥3 per non-null geoId (ES-054 C11)
  if (selected.length < budget) {
    const geoCounts = new Map<string, number>();
    for (const t of selected) {
      if (t.geoLevel.geoId !== null) {
        geoCounts.set(t.geoLevel.geoId, (geoCounts.get(t.geoLevel.geoId) ?? 0) + 1);
      }
    }

    // Bucket allTriples by geoId once (O(|allTriples|)) so each geo's padding pulls
    // from its own list with a forward cursor, instead of re-scanning the whole
    // cross-product on every padding step (was O(geoLevels² · categories)). Buckets
    // preserve allTriples order, and the cursor skips already-selected keys, so each
    // pull matches the original `allTriples.find()` first-unselected semantics.
    const byGeo = new Map<string, Triple[]>();
    for (const t of allTriples) {
      if (t.geoLevel.geoId === null) continue;
      const bucket = byGeo.get(t.geoLevel.geoId);
      if (bucket) bucket.push(t);
      else byGeo.set(t.geoLevel.geoId, [t]);
    }
    const geoCursors = new Map<string, number>();

    for (const geo of geoLevels) {
      if (geo.geoId === null) continue;
      const bucket = byGeo.get(geo.geoId) ?? [];
      let cursor = geoCursors.get(geo.geoId) ?? 0;
      while ((geoCounts.get(geo.geoId) ?? 0) < 3 && selected.length < budget) {
        // Advance past triples already selected (e.g. in Phase 1) to find the next candidate.
        while (cursor < bucket.length && selectedKeys.has(tripleKey(bucket[cursor]))) cursor++;
        if (cursor >= bucket.length) break;
        const candidate = bucket[cursor];
        selectedKeys.add(tripleKey(candidate));
        selected.push(candidate);
        geoCounts.set(geo.geoId, (geoCounts.get(geo.geoId) ?? 0) + 1);
        cursor++;
      }
      geoCursors.set(geo.geoId, cursor);
    }
  }

  // Phase 3: Fill remaining budget (city-level first, then any order)
  if (selected.length < budget) {
    const cityFirst = [
      ...allTriples.filter(t => t.geoLevel.level === "city"),
      ...allTriples.filter(t => t.geoLevel.level !== "city"),
    ];
    for (const t of cityFirst) {
      if (selected.length >= budget) break;
      if (!selectedKeys.has(tripleKey(t))) {
        selectedKeys.add(tripleKey(t));
        selected.push(t);
      }
    }
  }

  return selected;
}

// ── 1.5 Seed construction ─────────────────────────────────────────────────────

export function buildSeeds(triples: Triple[], _domain: string, entityNoun: string = "companies"): Seed[] {
  const angleCounts = new Map<Angle, number>();
  return triples.map(({ category, geoLevel, angle }, i) => {
    const geoSuffix = geoLevel.name ? ` in ${geoLevel.name}` : "";

    const text: Record<Angle, string> = {
      discovery:  `What are the best ${category} ${entityNoun}${geoSuffix}?`,
      evaluation: `Which ${category} ${entityNoun}${geoSuffix} have published case studies with measurable results?`,
      trust:      `Who are the most trusted ${entityNoun} for ${category}${geoSuffix}?`,
      clarity:    `Which ${entityNoun} should I consider for ${category}${geoSuffix}?`,
      readiness:  `Which ${entityNoun} for ${category}${geoSuffix} offer free trials or consultations?`,
    };

    // FIX-1: paired pillars alternate by per-angle count (not global index)
    const pillarDef = ANGLE_PILLAR[angle];
    if (!angleCounts.has(angle)) angleCounts.set(angle, 0);
    const angleIdx = angleCounts.get(angle)!;
    angleCounts.set(angle, angleIdx + 1);
    const pillar = Array.isArray(pillarDef) ? pillarDef[angleIdx % 2] : pillarDef;

    return {
      text:       text[angle],
      geoId:      geoLevel.geoId,
      categoryId: category.toLowerCase().replace(/\s+/g, "-"),
      pillar,
      tier:       ANGLE_TIER[angle],
    };
  });
}

// ── 2. Haiku rephrasing ───────────────────────────────────────────────────────

const REPHRASE_SYSTEM_PROMPT =
  `You are a search query rephraser. For each numbered query below, rephrase it as a natural question a real person would type into ChatGPT or Perplexity. Vary the structure: some as "which/what" questions, some as "who" questions, some as imperative ("list the top...", "compare..."), some as "how do I find...". Keep the same meaning, service category, and geography. Return one rephrased query per line, numbered to match.`;

export async function rephraseSeeds(seeds: Seed[]): Promise<string[]> {
  const rawTexts = seeds.map(s => s.text);
  const numberedList = rawTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");

  let rephrasedMap = new Map<number, string>();

  try {
    const client = new Anthropic();
    const response = await Promise.race([
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        temperature: 0.7,
        system: REPHRASE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: numberedList }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), 15_000)
      ),
    ]);

    const text = (response.content[0] as { type: "text"; text: string }).text;
    // FIX-2: parse line numbers into a sparse map to handle Haiku skipping lines
    const parsed = text.split("\n")
      .filter(line => /^\d+\.\s/.test(line.trim()))
      .map(line => {
        const match = line.match(/^(\d+)\.\s+(.*)/);
        return match ? { index: parseInt(match[1]) - 1, text: match[2].trim() } : null;
      })
      .filter((x): x is { index: number; text: string } => x !== null);
    rephrasedMap = new Map(parsed.map(p => [p.index, p.text]));

    // FIX-7: warn when Haiku returns fewer lines than seeds
    if (rephrasedMap.size < seeds.length) {
      console.warn(`[citation-prompts] Haiku returned ${rephrasedMap.size}/${seeds.length} lines — ${seeds.length - rephrasedMap.size} using raw seeds`);
    }
  } catch (err) {
    console.warn(`[citation-prompts] Haiku rephrasing failed: ${(err as Error).message} — using raw seeds`);
    return rawTexts;
  }

  return seeds.map((seed, i) => {
    const rephrased = rephrasedMap.get(i);
    if (!rephrased) return rawTexts[i];

    // FIX-5: normalize hyphens before category keyword validation
    const categoryKeyword = seed.categoryId?.replace(/-/g, " ") ?? "";
    const normalizedRephrased = rephrased.toLowerCase().replace(/-/g, " ");
    if (categoryKeyword && !normalizedRephrased.includes(categoryKeyword.toLowerCase())) {
      return rawTexts[i];
    }

    // Geo name validation (if geoId is set, geo name should appear)
    if (seed.geoId !== null) {
      const geoMatch = rawTexts[i].match(/ in ([^?]+?)(?:\?|$)/i);
      const geoName = geoMatch?.[1]?.trim();
      if (geoName && !rephrased.toLowerCase().includes(geoName.toLowerCase())) {
        return rawTexts[i];
      }
    }

    return rephrased;
  });
}

// ── Direct prompts (deterministic, 8 total) ───────────────────────────────────

function buildDirectPromptsV2(domain: string): CitationPrompt[] {
  return [
    `What is ${domain} and what does it offer?`,
    `Is ${domain} a reputable choice in its industry?`,
    `How does ${domain} compare to its main competitors?`,
    `What are the key features of ${domain}?`,
    `Is ${domain} trustworthy and well-regarded in its industry?`,
    `What do customers and reviewers say about ${domain}?`,
    `Who is the ideal user or buyer for ${domain}?`,
    `How frequently does ${domain} update its product or content?`,
  ].map(prompt => ({ type: "direct" as const, pillar: null, prompt }));
}

// ── generatePromptsV2: orchestrate V2 pipeline ────────────────────────────────

export async function generatePromptsV2(
  site: GeneratePromptsSite
): Promise<CitationPrompt[]> {
  const categories = extractCategories(site);
  const geoLevels  = extractGeoLevels(site.geoTree ?? null);
  const triples    = buildCoveringArray(categories, geoLevels, 36);
  const entityNoun = getEntityNoun(site);
  const seeds      = buildSeeds(triples, site.domain, entityNoun);

  const rephrasedTexts = await rephraseSeeds(seeds);

  const indirect: CitationPrompt[] = seeds.map((seed, i) => ({
    type:       "indirect" as const,
    prompt:     rephrasedTexts[i],
    pillar:     seed.pillar,
    tier:       seed.tier,
    geoId:      seed.geoId,
    categoryId: seed.categoryId,
  }));

  // FIX-3: domain leak prevention moved to extractCategories — no post-filter needed
  return [...indirect, ...buildDirectPromptsV2(site.domain)];
}

// ══════════════════════════════════════════════════════════════════════════════
// Main export — routes to V2 (programmatic) or legacy based on available data
// ══════════════════════════════════════════════════════════════════════════════

export async function generatePrompts(
  site: GeneratePromptsSite
): Promise<CitationPrompt[]> {
  // V2: categories extractable → programmatic seed + Haiku rephrasing
  const categories = extractCategories(site);
  if (categories.length > 0) {
    return generatePromptsV2(site);
  }

  // Legacy path (no structured business data available)
  return generatePromptsLegacy(site);
}
