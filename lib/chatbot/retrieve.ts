/**
 * RAG retrieval: embed user query → pgvector cosine similarity search → quality filter → confidence tier.
 */

import { db } from "@/lib/db";
import { knowledgeEmbeddings } from "@/lib/db/schema";
import { cosineDistance, desc, sql, gt } from "drizzle-orm";
import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ── Confidence tiers ────────────────────────────────────────────────────────

export type ConfidenceTier = "full" | "hedged" | "refused";

export interface RetrievedChunk {
  content: string;
  source: string;
  similarity: number;
  category: string;
  platform: string | null;
}

export interface RetrievalResult {
  tier: ConfidenceTier;
  chunks: RetrievedChunk[];
}

// ── Thresholds ──────────────────────────────────────────────────────────────

const FULL_CONFIDENCE_THRESHOLD = 0.45;
const HEDGED_CONFIDENCE_THRESHOLD = 0.35;
const MIN_CHUNK_LENGTH = 50;
const MAX_CHUNKS = 4;

// ── Boilerplate filter ──────────────────────────────────────────────────────

const BOILERPLATE = [
  "cookie policy", "terms of service", "copyright ©", "all rights reserved",
  "skip to content", "sign up for free", "privacy policy", "accept cookies",
];

function isQualityChunk(chunk: { content: string; similarity: number }): boolean {
  if (chunk.content.length < MIN_CHUNK_LENGTH) return false;

  const lower = chunk.content.toLowerCase();
  const boilerplateHits = BOILERPLATE.filter((p) => lower.includes(p)).length;
  if (boilerplateHits >= 2) return false;

  return true;
}

// ── Main retrieval function ─────────────────────────────────────────────────

export async function retrieveKnowledge(
  query: string,
  platformHint?: string | null,
  conversationContext?: string,
): Promise<RetrievalResult> {
  // Step 1: Embed the query, optionally with prior conversation context
  let queryVector: number[];
  try {
    // If conversationContext is provided, embed it together with the query
    // to capture multi-turn context in the embedding space
    const embeddingInput = conversationContext
      ? `${conversationContext}\n\n${query}`.slice(0, 6000)
      : query.slice(0, 6000);

    const embeddingResult = await getOpenAI().embeddings.create({
      model: EMBEDDING_MODEL,
      input: embeddingInput,
    });
    queryVector = embeddingResult.data[0].embedding;
  } catch (err) {
    console.error("[chatbot-retrieve] Embedding failed:", err);
    return { tier: "refused", chunks: [] };
  }

  // Step 2: Cosine similarity search
  const similarity = sql<number>`1 - (${cosineDistance(knowledgeEmbeddings.embedding, queryVector)})`;

  let candidates: Array<{ content: string; source: string; category: string; platform: string | null; similarity: number }>;
  try {
    candidates = await db
      .select({
        content: knowledgeEmbeddings.content,
        source: knowledgeEmbeddings.source,
        category: knowledgeEmbeddings.category,
        platform: knowledgeEmbeddings.platform,
        similarity,
      })
      .from(knowledgeEmbeddings)
      .where(gt(similarity, HEDGED_CONFIDENCE_THRESHOLD))
      .orderBy(desc(similarity))
      .limit(8);
  } catch (err) {
    console.error("[chatbot-retrieve] DB query failed:", err);
    return { tier: "refused" as ConfidenceTier, chunks: [] };
  }

  // Step 3: Quality filter
  const qualityFiltered = candidates
    .filter((c) => isQualityChunk({ content: c.content, similarity: c.similarity }));

  // Step 4: Sort with priority. Hand-authored platform docs that match the
  // user's platform are the most authoritative source — they win even over
  // higher-similarity generic chunks when within ±0.05.
  qualityFiltered.sort((a, b) => {
    // Tier 1 (top): hand-authored lib/knowledge/platform/*.md whose platform matches
    // the user. Identified by source prefix "local:" (set by scripts/ingest-knowledge.ts);
    // crawled third-party docs (scripts/ingest-platform-docs.ts) use "{platform}-docs:"
    // prefixes and don't qualify.
    if (platformHint) {
      const hint = platformHint.toLowerCase();
      const isHandAuthored = (c: { source: string; category: string; platform: string | null }) =>
        c.source.startsWith("local:") && c.category === "platform" && c.platform?.toLowerCase() === hint;
      const aPlatformMatch = isHandAuthored(a) ? 1 : 0;
      const bPlatformMatch = isHandAuthored(b) ? 1 : 0;
      if (aPlatformMatch !== bPlatformMatch) return bPlatformMatch - aPlatformMatch;
    }

    // Tier 2: hand-authored docs (geo-guide, seo-reference, reference). Hand-authored
    // platform docs that DON'T match this user's platform are NOT promoted — third-party
    // crawled docs (scripts/ingest-platform-docs.ts) also use category "platform" and
    // would otherwise rank Squarespace help-center docs above our geo-guide chunks for
    // unrelated queries.
    const aOurs = ["geo-guide", "seo-reference", "reference"].includes(a.category) ? 1 : 0;
    const bOurs = ["geo-guide", "seo-reference", "reference"].includes(b.category) ? 1 : 0;

    // Within same priority tier, check platform match for non-handwritten docs
    if (aOurs === bOurs && platformHint) {
      const hint = platformHint.toLowerCase();
      const aMatch = a.platform?.toLowerCase() === hint ? 1 : 0;
      const bMatch = b.platform?.toLowerCase() === hint ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
    }

    // Across tiers, prefer our docs if similarity difference is small (<0.1)
    if (aOurs !== bOurs && Math.abs(a.similarity - b.similarity) < 0.1) {
      return bOurs - aOurs;
    }

    // Otherwise sort by raw similarity
    return b.similarity - a.similarity;
  });

  const qualityChunks = qualityFiltered.slice(0, MAX_CHUNKS);

  // Step 5: Determine confidence tier
  const topSimilarity = qualityChunks[0]?.similarity ?? 0;

  let tier: ConfidenceTier;
  if (topSimilarity >= FULL_CONFIDENCE_THRESHOLD) {
    tier = "full";
  } else if (topSimilarity >= HEDGED_CONFIDENCE_THRESHOLD) {
    tier = "hedged";
  } else {
    tier = "refused";
  }

  return {
    tier,
    chunks: qualityChunks.map((c) => ({
      content: c.content,
      source: c.source,
      similarity: c.similarity,
      category: c.category,
      platform: c.platform,
    })),
  };
}
