/**
 * ES-059 Part B — Category Extractor
 *
 * Single Haiku call to extract 5-7 real service categories + entity noun.
 * Replaces blog-derived tree categories.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { CategoryTree } from "@/lib/types/trees";

export type ExtractedCategories = {
  categories: string[];
  entityNoun: string;
  extractedAt: string;    // ISO-8601
  source: "haiku" | "topics" | "tree" | "fallback";
};

// ── Industry noun map ─────────────────────────────────────────────────────────

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

export function getIndustryNoun(siteType: string | null): string {
  const st = (siteType ?? "").toLowerCase();
  for (const [key, noun] of Object.entries(INDUSTRY_NOUN_MAP)) {
    if (st.includes(key)) return noun;
  }
  return "companies";
}

// ── Service URL filtering ─────────────────────────────────────────────────────

const SERVICE_PATTERNS = [
  /\/departments\//i,
  /\/services\//i,
  /\/specialties\//i,
  /\/solutions\//i,
  /\/products\//i,
  /\/practice-areas\//i,
  /\/treatments\//i,
  /\/procedures\//i,
  /\/offerings\//i,
];

const EXCLUDE_PATTERNS = [
  /\/blog\//i,
  /\/news\//i,
  /\/press\//i,
  /\/careers\//i,
  /\/events\//i,
  /\/category\//i,
  /\/tag\//i,
];

export function extractServiceUrls(crawlData: unknown): string[] {
  const pages =
    (crawlData as { pages?: Array<{ url?: string }> })?.pages ?? [];
  return pages
    .map(p => {
      try {
        return new URL(p.url ?? "").pathname;
      } catch {
        return "";
      }
    })
    .filter(path => path && SERVICE_PATTERNS.some(r => r.test(path)))
    .filter(path => !EXCLUDE_PATTERNS.some(r => r.test(path)))
    .slice(0, 30);
}

// ── Dedup substrings ──────────────────────────────────────────────────────────

function deduplicateSubstrings(cats: string[]): string[] {
  return cats.filter((c) => {
    const cl = c.toLowerCase();
    // Remove this entry if it begins with a shorter entry followed by a word boundary
    // e.g., "Oncology Department" is removed when "Oncology" exists.
    // Keeps both "Oncology" and "Pediatric Oncology" (shorter is not a word-start prefix).
    return !cats.some(
      (other) =>
        other !== c &&
        other.length < c.length &&
        cl.startsWith(other.toLowerCase() + " "),
    );
  });
}

// ── Collect leaf names from category tree ─────────────────────────────────────

function collectLeafNames(
  node: { name: string; pageCount: number; children?: typeof node[] },
): { name: string; pageCount: number }[] {
  if (!node.children || node.children.length === 0) {
    return [{ name: node.name, pageCount: node.pageCount }];
  }
  return node.children.flatMap(child => collectLeafNames(child));
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateCategories(
  raw: { categories?: unknown; entityNoun?: unknown },
  crawlData: unknown,
  categoryTree: CategoryTree | null,
): { categories: string[]; entityNoun: string; valid: boolean } {
  let cats = Array.isArray(raw.categories)
    ? raw.categories.filter((c): c is string => typeof c === "string")
    : [];

  // 1. Length check: 2-50 chars each
  cats = cats.filter(c => c.length >= 2 && c.length <= 50);

  // 2. Dedup: remove substrings
  cats = deduplicateSubstrings(cats);

  // 3. Cross-reference: check ≥2 appear in page URLs or tree node names
  const urlPaths = extractServiceUrls(crawlData);
  const treeNames = categoryTree
    ? collectLeafNames(categoryTree.root).map(n => n.name)
    : [];
  const allRef = [...urlPaths, ...treeNames].map(s => s.toLowerCase());
  const matched = cats.filter(c =>
    allRef.some(
      ref =>
        ref.includes(c.toLowerCase()) || c.toLowerCase().includes(ref),
    ),
  );

  // 4. entityNoun validation + sanitization
  const entityNoun =
    typeof raw.entityNoun === "string" && raw.entityNoun.length <= 30
      ? raw.entityNoun
          .toLowerCase()
          .replace(/[\n\r\t"'{}]/g, "")
          .replace(/[^a-z0-9 -]/g, "")
          .trim()
      : "";

  return {
    categories: cats,
    entityNoun,
    valid: cats.length >= 3 && matched.length >= 2,
  };
}

// ── Haiku prompt builder ──────────────────────────────────────────────────────

function buildUserPrompt(
  domain: string,
  industry: string | null,
  llmsTxt: string | null,
  homepageContent: string,
  serviceUrls: string[],
  treeLeafNames: string[],
): string {
  const parts: string[] = [];
  parts.push(`Domain: ${domain}`);
  if (industry) parts.push(`Industry: ${industry}`);
  if (llmsTxt) parts.push(`\nBusiness description:\n${llmsTxt.slice(0, 800)}`);
  if (homepageContent) parts.push(`\nHomepage:\n${homepageContent.slice(0, 300)}`);
  if (serviceUrls.length > 0)
    parts.push(
      `\nService/department pages found on the site:\n${serviceUrls.join("\n")}`,
    );
  if (treeLeafNames.length > 0)
    parts.push(
      `\nContent topics found during crawl (these may be blog topics, use as hints only):\n${treeLeafNames.join(", ")}`,
    );

  parts.push(`\nExamples:
- Hospital: {"categories": ["Oncology", "Cardiology", "Orthopedics"], "entityNoun": "hospitals"}
- Consultancy: {"categories": ["Digital Transformation", "Regulatory Compliance"], "entityNoun": "consultancies"}
- SaaS: {"categories": ["Project Management", "Team Collaboration"], "entityNoun": "platforms"}
- Any business: the main services or product lines the business offers`);

  return parts.join("\n");
}

function extractHomepageContent(crawlData: unknown): string {
  const pages =
    (crawlData as { pages?: Array<{ url?: string; content?: string }> })
      ?.pages ?? [];
  // Try to find homepage (root path or domain root)
  const homepage = pages.find(p => {
    try {
      return new URL(p.url ?? "").pathname === "/";
    } catch {
      return false;
    }
  });
  return homepage?.content?.slice(0, 300) ?? "";
}

// ── Parse response ────────────────────────────────────────────────────────────

function parseHaikuResponse(text: string): { categories?: unknown; entityNoun?: unknown } {
  // Strip markdown code fences
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in text
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        // ignore
      }
    }
    return {};
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Extract service categories via a single Haiku call.
 * Falls back to topics → tree → siteType if Haiku fails or returns <3 valid.
 */
export async function extractCategoriesViaHaiku(
  domain: string,
  siteType: string | null,
  businessJson: Record<string, unknown> | null,
  llmsTxt: string | null,
  crawlData: unknown,
  categoryTree: CategoryTree | null,
): Promise<ExtractedCategories> {
  const homepageContent = extractHomepageContent(crawlData);
  const combinedLen = (llmsTxt ?? "").length + homepageContent.length;

  // Minimum input guard
  if (combinedLen < 200) {
    console.info(
      `[category-extractor] ${domain}: skipping Haiku (input ${combinedLen} chars < 200 minimum)`,
    );
    return fallbackChain(domain, siteType, businessJson, categoryTree);
  }

  const client = new Anthropic();
  const serviceUrls = extractServiceUrls(crawlData);
  const treeLeafNames = categoryTree
    ? collectLeafNames(categoryTree.root).map(n => n.name).slice(0, 20)
    : [];

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await client.messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 800,
        temperature: 0,
        system:
          "Extract 5-7 primary service or product categories for this business.\n" +
          "Think DEPARTMENTS or PRODUCT LINES — what would appear on the company's\n" +
          "main navigation menu. Not blog post topics or subcategories.\n\n" +
          "Also return the entity noun that describes what this type of business is\n" +
          'called (e.g., "hospitals", "agencies", "platforms", "stores").\n\n' +
          'Return only valid JSON:\n{ "categories": ["Category1", "Category2", ...], "entityNoun": "hospitals" }',
        messages: [
          {
            role: "user",
            content: buildUserPrompt(
              domain,
              siteType ?? null,
              llmsTxt,
              homepageContent,
              serviceUrls,
              treeLeafNames,
            ),
          },
        ],
      },
      { signal: controller.signal } as never,
    );
    clearTimeout(timeoutId);

    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    const raw = parseHaikuResponse(text);
    const { categories, entityNoun, valid } = validateCategories(
      raw,
      crawlData,
      categoryTree,
    );

    // Rich-input relaxation: when combinedLen >= 500 chars, Sonnet has enough
    // business context to be trusted without cross-reference validation.
    // Still require cats.length >= 3 to prevent degenerate responses.
    const richInput = combinedLen >= 500;
    const accept = richInput ? categories.length >= 3 : valid;

    if (accept) {
      return {
        categories,
        entityNoun, // may be "" if invalid; caller (getEntityNoun) handles fallback
        extractedAt: new Date().toISOString(),
        source: "haiku",
      };
    }

    console.warn(
      `[category-extractor] ${domain}: Sonnet returned <3 valid categories (got ${categories.length}) — falling back`,
    );
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(
      `[category-extractor] ${domain}: Haiku failed: ${(err as Error).message}`,
    );
  }

  return fallbackChain(domain, siteType, businessJson, categoryTree);
}

// ── Fallback chain ────────────────────────────────────────────────────────────

function fallbackChain(
  domain: string,
  siteType: string | null,
  businessJson: Record<string, unknown> | null,
  categoryTree: CategoryTree | null,
): ExtractedCategories {
  const domainStem = domain
    .replace(/^www\./, "")
    .replace(/\.(co|com|org|net|gov|edu|ac)\.[a-z]{2}$/i, "")
    .replace(/\.[a-z]+$/i, "")
    .toLowerCase();

  // 1. businessJson.geo_profile.topics
  const bj = businessJson as {
    geo_profile?: { topics?: unknown[] };
  } | null;
  const topics = bj?.geo_profile?.topics;
  if (Array.isArray(topics) && topics.length > 0) {
    const cats = topics
      .filter((t): t is string => typeof t === "string")
      .filter(c => !c.toLowerCase().includes(domainStem));
    if (cats.length >= 3) {
      return {
        categories: cats,
        entityNoun: getIndustryNoun(siteType),
        extractedAt: new Date().toISOString(),
        source: "topics",
      };
    }
  }

  // 2. categoryTree leaves
  if (categoryTree) {
    const leaves = collectLeafNames(categoryTree.root)
      .sort((a, b) => b.pageCount - a.pageCount)
      .slice(0, 5)
      .map(n => n.name)
      .filter(c => !c.toLowerCase().includes(domainStem));
    if (leaves.length >= 3) {
      return {
        categories: leaves,
        entityNoun: getIndustryNoun(siteType),
        extractedAt: new Date().toISOString(),
        source: "tree",
      };
    }
  }

  // 3. siteType or "general"
  const cat = siteType ?? "general";
  return {
    categories: [cat],
    entityNoun: getIndustryNoun(siteType),
    extractedAt: new Date().toISOString(),
    source: "fallback",
  };
}
