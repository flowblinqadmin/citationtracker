/**
 * Crawl platform documentation sites via Firecrawl and ingest into pgvector.
 *
 * Usage:
 *   /opt/homebrew/bin/node --env-file=.env.local scripts/ingest-platform-docs.ts --platform wordpress
 *   /opt/homebrew/bin/node --env-file=.env.local scripts/ingest-platform-docs.ts --all
 *   /opt/homebrew/bin/node --env-file=.env.local scripts/ingest-platform-docs.ts --list
 *
 * Idempotent: deletes existing chunks for a platform before re-inserting.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { knowledgeEmbeddings } from "../lib/db/schema";
import { like } from "drizzle-orm";
import OpenAI from "openai";
import { nanoid } from "nanoid";

// ── Platform Documentation Sources ──────────────────────────────────────────

interface PlatformSource {
  name: string;
  docsUrl: string;
  mapLimit: number;          // max URLs to discover
  includePatterns: RegExp[];  // URL patterns to keep
  excludePatterns: RegExp[];  // URL patterns to drop
  tier: 1 | 2;
}

const PLATFORMS: PlatformSource[] = [
  // Tier 1 — must-have (~85% of sites)
  {
    name: "wordpress",
    docsUrl: "https://developer.wordpress.org",
    mapLimit: 500,
    includePatterns: [/\/docs\//, /\/reference\//, /\/plugins\//, /\/themes\//, /\/apis\//, /\/block-editor\//, /\/rest-api\//],
    excludePatterns: [/\/changelog/, /\/blog\//, /\/news\//, /\?/, /#/],
    tier: 1,
  },
  {
    name: "shopify",
    docsUrl: "https://shopify.dev",
    mapLimit: 500,
    includePatterns: [/\/docs\//, /\/tutorials\//, /\/api\//, /\/themes\//, /\/storefronts\//],
    excludePatterns: [/\/changelog/, /\/blog\//, /\?/, /#/],
    tier: 1,
  },
  {
    name: "wix",
    docsUrl: "https://dev.wix.com",
    mapLimit: 300,
    includePatterns: [/\/docs\//, /\/api\//, /\/articles\//, /\/velo\//],
    excludePatterns: [/\/changelog/, /\/blog\//, /\?/, /#/],
    tier: 1,
  },
  {
    name: "squarespace",
    docsUrl: "https://support.squarespace.com",
    mapLimit: 300,
    includePatterns: [/\/hc\//, /\/articles\//, /\/using-/, /\/adding-/, /\/customizing-/],
    excludePatterns: [/\/community\//, /\?/, /#/],
    tier: 1,
  },
  {
    name: "webflow",
    docsUrl: "https://university.webflow.com",
    mapLimit: 300,
    includePatterns: [/\/lessons\//, /\/courses\//, /\/articles\//],
    excludePatterns: [/\/blog\//, /\?/, /#/],
    tier: 1,
  },
  {
    name: "nextjs",
    docsUrl: "https://nextjs.org/docs",
    mapLimit: 300,
    includePatterns: [/\/docs\//],
    excludePatterns: [/\/blog\//, /\/showcase\//, /\?/, /#/],
    tier: 1,
  },
  // Tier 2 — nice-to-have
  {
    name: "drupal",
    docsUrl: "https://www.drupal.org/docs",
    mapLimit: 200,
    includePatterns: [/\/docs\//, /\/documentation\//],
    excludePatterns: [/\/forum\//, /\/project\//, /\?/, /#/],
    tier: 2,
  },
  {
    name: "ghost",
    docsUrl: "https://ghost.org/docs",
    mapLimit: 200,
    includePatterns: [/\/docs\//, /\/tutorials\//, /\/integrations\//],
    excludePatterns: [/\/changelog/, /\/blog\//, /\?/, /#/],
    tier: 2,
  },
  {
    name: "framer",
    docsUrl: "https://www.framer.com/developers",
    mapLimit: 200,
    includePatterns: [/\/developers\//, /\/docs\//, /\/learn\//],
    excludePatterns: [/\/blog\//, /\/templates\//, /\?/, /#/],
    tier: 2,
  },
];

// ── Config ──────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_SIZE = 1500;      // ~500 tokens
const CHUNK_OVERLAP = 300;    // ~100 tokens
const EMBED_BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000; // 20 min

// ── DB + OpenAI + Firecrawl setup ───────────────────────────────────────────

const dbUrl = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl) throw new Error("No DATABASE_URL set");
if (!process.env.FIRECRAWL_API_KEY) throw new Error("No FIRECRAWL_API_KEY set");
if (!process.env.OPENAI_API_KEY) throw new Error("No OPENAI_API_KEY set");

const client = postgres(dbUrl, { max: 3, prepare: false, idle_timeout: 20 });
const db = drizzle(client);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Dynamic import for Firecrawl (ESM/CJS compat)
async function getFirecrawl() {
  const { FirecrawlAppV1 } = await import("@mendable/firecrawl-js");
  return new FirecrawlAppV1({ apiKey: process.env.FIRECRAWL_API_KEY! });
}

// ── Chunking ────────────────────────────────────────────────────────────────

const SEPARATORS = ["\n\n", "\n", ". ", " "];

function chunkText(text: string): string[] {
  return recursiveSplit(text, SEPARATORS, CHUNK_SIZE, CHUNK_OVERLAP);
}

function recursiveSplit(text: string, separators: string[], maxLen: number, overlap: number): string[] {
  if (text.length <= maxLen) return [text.trim()].filter(Boolean);

  const sep = separators.find((s) => text.includes(s)) ?? separators[separators.length - 1];
  const parts = text.split(sep);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length > maxLen && current) {
      chunks.push(current.trim());
      const overlapText = current.slice(-overlap);
      current = overlapText + sep + part;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length >= 50);
}

// ── Embedding ───────────────────────────────────────────────────────────────

async function embedBatch(texts: string[]): Promise<number[][]> {
  // Filter out texts that are too long for the embedding model (8192 token limit ≈ 24K chars)
  const safeBatch = texts.map((t) => t.length > 20000 ? t.slice(0, 20000) : t);
  const result = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: safeBatch,
  });
  return result.data.map((d) => d.embedding);
}

// ── Content quality filter ──────────────────────────────────────────────────

const BOILERPLATE_PATTERNS = [
  "cookie policy", "terms of service", "copyright ©", "all rights reserved",
  "skip to content", "skip to main", "sign up for free", "log in to",
  "privacy policy", "accept cookies", "we use cookies",
];

function isUsableContent(text: string): boolean {
  if (text.length < 100) return false; // Too short
  const lower = text.toLowerCase();
  const boilerplateHits = BOILERPLATE_PATTERNS.filter((p) => lower.includes(p)).length;
  if (boilerplateHits >= 3) return false; // Too much boilerplate

  // Check information density — ratio of content words to stopwords
  const words = lower.split(/\s+/);
  const stopwords = new Set(["the", "a", "an", "is", "are", "was", "to", "of", "in", "for", "on", "with", "and", "or", "it", "this", "that", "be", "as"]);
  const contentWords = words.filter((w) => !stopwords.has(w)).length;
  if (contentWords / Math.max(words.length, 1) < 0.3) return false;

  return true;
}

// ── Firecrawl crawl + poll ──────────────────────────────────────────────────

async function crawlPlatformDocs(platform: PlatformSource): Promise<Array<{ url: string; markdown: string }>> {
  const fc = await getFirecrawl();

  // Step 1: Discover URLs
  console.log(`  [${platform.name}] Discovering URLs from ${platform.docsUrl}...`);
  const mapResult = await fc.mapUrl(platform.docsUrl, { limit: platform.mapLimit }) as { links?: string[] };
  let urls = mapResult.links ?? [];
  console.log(`  [${platform.name}] Discovered ${urls.length} URLs`);

  // Step 2: Filter URLs
  urls = urls.filter((url) => {
    const matchesInclude = platform.includePatterns.length === 0 || platform.includePatterns.some((p) => p.test(url));
    const matchesExclude = platform.excludePatterns.some((p) => p.test(url));
    return matchesInclude && !matchesExclude;
  });

  // Cap at 200 to control costs
  if (urls.length > 200) {
    console.log(`  [${platform.name}] Capping from ${urls.length} to 200 URLs`);
    urls = urls.slice(0, 200);
  }

  console.log(`  [${platform.name}] Filtered to ${urls.length} doc URLs`);

  if (urls.length === 0) {
    console.log(`  [${platform.name}] No URLs matched filters, skipping`);
    return [];
  }

  // Step 3: Batch scrape
  console.log(`  [${platform.name}] Submitting batch scrape...`);
  const batchResult = await fc.asyncBatchScrapeUrls(urls, {
    formats: ["markdown"],
  }) as { id: string };

  const jobId = batchResult.id;
  console.log(`  [${platform.name}] Batch job ${jobId} submitted, polling...`);

  // Step 4: Poll for completion
  const startTime = Date.now();
  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const status = await fc.checkBatchScrapeStatus(jobId) as {
      status: string;
      data?: Array<{ markdown?: string; metadata?: { url?: string; sourceURL?: string } }>;
      completed?: number;
      total?: number;
    };

    const pct = status.total ? Math.round(((status.completed ?? 0) / status.total) * 100) : 0;
    console.log(`  [${platform.name}] Status: ${status.status} (${pct}%)`);

    if (status.status === "completed") {
      const docs = (status.data ?? [])
        .filter((d) => d.markdown && d.markdown.length >= 100)
        .map((d) => ({
          url: d.metadata?.sourceURL ?? d.metadata?.url ?? "unknown",
          markdown: d.markdown!,
        }));

      console.log(`  [${platform.name}] Got ${docs.length} documents with content`);
      return docs;
    }

    if (status.status === "failed") {
      console.error(`  [${platform.name}] Batch job failed`);
      return [];
    }
  }

  console.error(`  [${platform.name}] Timed out after ${POLL_TIMEOUT_MS / 60000} minutes`);
  return [];
}

// ── Main ingestion ──────────────────────────────────────────────────────────

async function ingestPlatform(platform: PlatformSource) {
  console.log(`\n=== Ingesting: ${platform.name} (tier ${platform.tier}) ===`);

  // Crawl docs
  const docs = await crawlPlatformDocs(platform);
  if (docs.length === 0) {
    console.log(`  No documents to ingest for ${platform.name}`);
    return;
  }

  // Delete existing chunks for this platform
  const sourcePrefix = `${platform.name}-docs:`;
  console.log(`  Deleting existing chunks for ${sourcePrefix}...`);
  await db.delete(knowledgeEmbeddings).where(like(knowledgeEmbeddings.source, `${sourcePrefix}%`));

  // Chunk all documents
  let allChunks: Array<{ content: string; source: string }> = [];
  for (const doc of docs) {
    if (!isUsableContent(doc.markdown)) continue;

    const chunks = chunkText(doc.markdown);
    for (const chunk of chunks) {
      if (!isUsableContent(chunk)) continue;
      allChunks.push({
        content: chunk,
        source: `${sourcePrefix}${doc.url}`,
      });
    }
  }

  console.log(`  ${allChunks.length} chunks from ${docs.length} documents`);

  // Embed and insert in batches
  let inserted = 0;
  for (let i = 0; i < allChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = allChunks.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((c) => c.content);
    const embeddings = await embedBatch(texts);

    const rows = batch.map((chunk, j) => ({
      id: nanoid(),
      content: chunk.content,
      source: chunk.source,
      category: "platform" as const,
      platform: platform.name,
      embedding: embeddings[j],
    }));

    await db.insert(knowledgeEmbeddings).values(rows);
    inserted += rows.length;
    console.log(`  Embedded batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / EMBED_BATCH_SIZE)} (${inserted} total)`);
  }

  console.log(`  Done: ${inserted} chunks ingested for ${platform.name}`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--list")) {
    console.log("Available platforms:");
    for (const p of PLATFORMS) {
      console.log(`  ${p.name} (tier ${p.tier}) — ${p.docsUrl}`);
    }
    process.exit(0);
  }

  const doAll = args.includes("--all");
  const tier1Only = args.includes("--tier1");
  const platformArg = args.find((a) => a.startsWith("--platform="))?.split("=")[1]
    ?? (args.indexOf("--platform") >= 0 ? args[args.indexOf("--platform") + 1] : null);

  let targets: PlatformSource[];

  if (doAll) {
    targets = PLATFORMS;
  } else if (tier1Only) {
    targets = PLATFORMS.filter((p) => p.tier === 1);
  } else if (platformArg) {
    const found = PLATFORMS.find((p) => p.name === platformArg.toLowerCase());
    if (!found) {
      console.error(`Unknown platform: ${platformArg}. Use --list to see available platforms.`);
      process.exit(1);
    }
    targets = [found];
  } else {
    console.error("Usage: --platform <name> | --tier1 | --all | --list");
    process.exit(1);
  }

  console.log(`Ingesting ${targets.length} platform(s): ${targets.map((t) => t.name).join(", ")}`);

  for (const platform of targets) {
    await ingestPlatform(platform);
  }

  console.log("\nAll done.");
  await client.end();
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
