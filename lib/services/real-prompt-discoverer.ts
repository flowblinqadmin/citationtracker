/**
 * ES-056 C12: Real Prompt Discovery via Perplexity Sonar
 *
 * Discovers real user questions from Google PAA, Reddit, Quora
 * for the top 3 category leaf nodes by pageCount.
 * Deduplicates (Jaccard >80%), filters domain/off-topic, caps at 15.
 * Falls back to empty array on any failure.
 */

import OpenAI from "openai";
import type { RealPromptDiscovery } from "@/lib/types/citation";

// ── Types ─────────────────────────────────────────────────────────────────────

type TreeNode = {
  id: string;
  name: string;
  pageCount?: number;
  children?: TreeNode[];
};

type CategoryTree = {
  root: TreeNode;
  leafCount: number;
};

// ── Stop words for Jaccard similarity ────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "is", "are", "for", "of", "to", "and", "or",
  "but", "if", "on", "at", "by", "as", "be", "do", "it", "its", "was",
  "are", "has", "had", "he", "she", "we", "you", "i", "my", "me", "so",
  "this", "that", "which", "what", "who", "how", "when", "where", "with",
  "from", "not", "no", "can", "will", "would", "could", "should", "may",
  "about", "than", "then", "also", "all", "more", "some", "any", "there",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function tokenize(text: string): Set<string> {
  // Split on non-alphanumeric chars; keep numeric tokens of any length, alphabetic tokens > 2 chars
  const words = text.toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 0 && !STOP_WORDS.has(w) && (/\d/.test(w) || w.length > 2));
  return new Set(words);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function deduplicateByJaccard(questions: RealPromptDiscovery[]): RealPromptDiscovery[] {
  const kept: RealPromptDiscovery[] = [];
  const keptTokens: Set<string>[] = [];

  // Inverted index: token → indices of kept token-sets containing it. Any pair with
  // Jaccard > 0.8 must share at least one token, so only kept sets sharing a token
  // with the candidate can be duplicates. This narrows the exact-Jaccard checks from
  // all-pairs (O(n²)) to a candidate set drawn from the inverted index — behaviour is
  // identical to the original full scan, only the comparison count shrinks.
  const tokenIndex = new Map<string, number[]>();
  // The empty-token case is special: jaccardSimilarity(∅, ∅) === 1 (> 0.8), so a second
  // empty-token query is a duplicate of an earlier kept one. Empty sets share no tokens,
  // so the inverted index can't surface them — track whether one was already kept.
  let keptEmpty = false;

  for (const q of questions) {
    const tokens = tokenize(q.query);

    let isDuplicate: boolean;
    if (tokens.size === 0) {
      isDuplicate = keptEmpty;
    } else {
      const candidateIdx = new Set<number>();
      for (const tok of tokens) {
        const postings = tokenIndex.get(tok);
        if (postings) for (const idx of postings) candidateIdx.add(idx);
      }
      isDuplicate = false;
      for (const idx of candidateIdx) {
        if (jaccardSimilarity(keptTokens[idx], tokens) > 0.8) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (!isDuplicate) {
      const newIdx = kept.length;
      kept.push(q);
      keptTokens.push(tokens);
      if (tokens.size === 0) {
        keptEmpty = true;
      } else {
        for (const tok of tokens) {
          const postings = tokenIndex.get(tok);
          if (postings) postings.push(newIdx);
          else tokenIndex.set(tok, [newIdx]);
        }
      }
    }
  }
  return kept;
}

function collectLeaves(node: TreeNode): TreeNode[] {
  if (!node.children || node.children.length === 0) return [node];
  return node.children.flatMap(child => collectLeaves(child));
}

function getTopCategories(tree: CategoryTree, n = 3): TreeNode[] {
  const leaves = collectLeaves(tree.root);
  return leaves
    .sort((a, b) => (b.pageCount ?? 0) - (a.pageCount ?? 0))
    .slice(0, n);
}

/**
 * Extract short keyword substrings from domain name for off-topic filtering.
 * E.g. "manipalhospitals.com" → substrings include "hospi" which matches "hospital".
 */
function domainKeywords(domain: string): Set<string> {
  const base = domain.replace(/\.[a-z]+$/i, "").replace(/[-_]/g, "").toLowerCase();
  const subs = new Set<string>();
  for (let i = 0; i < base.length; i++) {
    if (i + 4 <= base.length) subs.add(base.slice(i, i + 4));
    if (i + 5 <= base.length) subs.add(base.slice(i, i + 5));
  }
  return subs;
}

// ── Concurrency guard (FIX-7a): cache per domain to avoid hammering Perplexity ─

const recentCallCache = new Map<string, { result: RealPromptDiscovery[]; timestamp: number }>();
const CACHE_TTL_MS = 60_000; // 60 seconds

/** Clears the domain result cache. Intended for use in tests only. */
export function clearRealPromptCache(): void {
  recentCallCache.clear();
}

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Discover real user questions from PAA, Reddit, Quora via Perplexity.
 * Takes top 3 category leaf nodes and optional geo context.
 * Returns deduplicated, filtered questions (max 15).
 * Caches results per domain for 60s to avoid concurrent duplicate calls.
 */
export async function discoverRealPrompts(
  categoryTree: CategoryTree,
  geoContext?: { cityNames: string[] },
  domain?: string,
): Promise<RealPromptDiscovery[]> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return [];

  // FIX-7a: return cached result if same domain called within 60s
  const cacheKey = domain ?? "__unknown__";
  const cached = recentCallCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  // Need at least one leaf to query
  if (!categoryTree.root || categoryTree.leafCount === 0) return [];

  const topCategories = getTopCategories(categoryTree, 3);
  if (topCategories.length === 0) return [];

  const categoryNames = topCategories.map(c => c.name);
  const categoryKeywords = categoryNames.map(n => n.toLowerCase());

  try {
    const client = new OpenAI({
      apiKey,
      baseURL: "https://api.perplexity.ai",
    });

    let userContent = `What are the top 10-15 questions real users ask on Google (People Also Ask), Reddit, and Quora about the following topics:\n`;
    userContent += categoryNames.map(n => `- ${n}`).join("\n");

    if (geoContext && geoContext.cityNames.length > 0) {
      userContent += `\n\nspecifically in these locations: ${geoContext.cityNames.join(", ")}`;
    }

    userContent += `\n\nFor each question, provide:\n- source: "paa" | "reddit" | "quora"\n- query: the exact question\n- context: brief surrounding context (200 chars max)\n- url: source URL if available, empty string otherwise\n\nReturn JSON array only.`;

    const response = await Promise.race([
      client.chat.completions.create({
        model: "sonar",
        temperature: 0,
        max_completion_tokens: 2000,
        messages: [
          { role: "system", content: "You are a research assistant. Return only a JSON array of questions, no prose." },
          { role: "user", content: userContent },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Perplexity timeout")), 15_000)
      ),
    ]);

    const content = (response as any).choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") return [];

    // Parse JSON
    const cleanedContent = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleanedContent);
    } catch {
      console.warn(`[real-prompts] ${domain ?? "unknown"}: invalid JSON from Perplexity`);
      return [];
    }

    if (!Array.isArray(parsed)) return [];

    // Validate and normalize items
    const questions: RealPromptDiscovery[] = parsed
      .filter((item): item is Record<string, unknown> =>
        item !== null && typeof item === "object" &&
        typeof (item as any).query === "string" &&
        (item as any).query.length > 0
      )
      .map(item => ({
        source: (["paa", "reddit", "quora"].includes(String(item.source))
          ? item.source
          : "paa") as RealPromptDiscovery["source"],
        query: String(item.query).trim(),
        context: String(item.context ?? "").slice(0, 200),
        url: String(item.url ?? ""),
      }));

    // Filter: remove brand-specific questions (case-insensitive domain match)
    const domainLower = (domain ?? "").toLowerCase();
    const brandFiltered = domainLower
      ? questions.filter(q => !q.query.toLowerCase().includes(domainLower))
      : questions;

    // Filter: remove off-topic questions. A question is on-topic if its query contains:
    //   1. A 5-char prefix of any category keyword (e.g. "ortho" matches "orthopedic/s")
    //   2. A city name from geoContext
    //   3. A 4-5 char substring of the domain name (e.g. "hospi" from "manipalhospitals" matches "hospital")
    const categoryPrefixes = categoryKeywords.map(kw => kw.slice(0, Math.min(5, kw.length)));
    const cityKeywords = (geoContext?.cityNames ?? []).map(c => c.toLowerCase());
    const domainSubs = domainKeywords(domainLower || "");

    const topicFiltered = brandFiltered.filter(q => {
      const queryLower = q.query.toLowerCase();
      if (categoryPrefixes.some(prefix => queryLower.includes(prefix))) return true;
      if (cityKeywords.some(city => queryLower.includes(city))) return true;
      for (const sub of domainSubs) {
        if (queryLower.includes(sub)) return true;
      }
      return false;
    });

    // Deduplicate by Jaccard similarity (>80% overlap)
    const deduped = deduplicateByJaccard(topicFiltered);

    // Cap at 15
    const capped = deduped.slice(0, 15);

    // FIX-7b: warn if fewer than 5 questions returned
    if (capped.length < 5) {
      console.warn(`[real-prompts] ${domain ?? "unknown"}: only ${capped.length} questions returned (expected 10-15)`);
    }

    console.info(`[real-prompts.discovery.complete] ${domain ?? "unknown"}: questionsFound=${capped.length}`);

    // FIX-7a: cache result
    recentCallCache.set(cacheKey, { result: capped, timestamp: Date.now() });
    return capped;
  } catch (err) {
    console.warn(`[real-prompts.discovery.failed] ${domain ?? "unknown"}:`, (err as Error).message);
    return [];
  }
}
