/**
 * Ingest local markdown knowledge files into pgvector.
 *
 * Usage:
 *   /opt/homebrew/bin/node --env-file=.env.local scripts/ingest-knowledge.ts
 *
 * Idempotent: deletes existing chunks for each source before re-inserting.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { knowledgeEmbeddings } from "../lib/db/schema";
import { eq, like } from "drizzle-orm";
import OpenAI from "openai";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, basename } from "path";
import { nanoid } from "nanoid";

// ── Config ──────────────────────────────────────────────────────────────────

const EMBEDDING_MODEL = "text-embedding-3-small";
const CHUNK_SIZE = 1500;      // ~500 tokens (3 chars ≈ 1 token)
const CHUNK_OVERLAP = 300;    // ~100 tokens overlap
const EMBED_BATCH_SIZE = 100;
const KNOWLEDGE_DIR = join(process.cwd(), "lib/knowledge");

// ── DB + OpenAI setup ───────────────────────────────────────────────────────

const dbUrl = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl) throw new Error("No DATABASE_URL set");

const client = postgres(dbUrl, { max: 3, prepare: false, idle_timeout: 20 });
const db = drizzle(client);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      // Overlap: keep the end of current as start of next
      const overlapText = current.slice(-overlap);
      current = overlapText + sep + part;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length >= 50); // Drop tiny fragments
}

// ── Embedding ───────────────────────────────────────────────────────────────

async function embedBatch(texts: string[]): Promise<number[][]> {
  const safeBatch = texts.map((t) => t.length > 20000 ? t.slice(0, 20000) : t);
  const result = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: safeBatch,
  });
  return result.data.map((d) => d.embedding);
}

// ── File discovery ──────────────────────────────────────────────────────────

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function categorize(filePath: string): { category: string; platform: string | null } {
  const rel = relative(KNOWLEDGE_DIR, filePath).toLowerCase();
  if (rel.startsWith("platform/") || rel.includes("/platform/")) {
    return { category: "platform", platform: basename(filePath, ".md") };
  }
  if (rel.startsWith("reference/") || rel.includes("/reference/")) {
    return { category: "reference", platform: null };
  }
  if (rel.includes("seo-") || rel.includes("google-search")) {
    return { category: "seo-reference", platform: null };
  }
  return { category: "geo-guide", platform: null };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const files = findMarkdownFiles(KNOWLEDGE_DIR);
  console.log(`Found ${files.length} markdown files in ${KNOWLEDGE_DIR}`);

  let totalChunks = 0;

  for (const filePath of files) {
    const rel = relative(KNOWLEDGE_DIR, filePath);
    const content = readFileSync(filePath, "utf-8");
    const chunks = chunkText(content);
    const { category, platform } = categorize(filePath);

    console.log(`  ${rel}: ${chunks.length} chunks (category=${category}, platform=${platform ?? "n/a"})`);

    // Delete existing chunks for this source
    const source = `local:${rel}`;
    await db.delete(knowledgeEmbeddings).where(eq(knowledgeEmbeddings.source, source));

    // Embed in batches
    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const embeddings = await embedBatch(batch);

      const rows = batch.map((text, j) => ({
        id: nanoid(),
        content: text,
        source,
        category,
        platform,
        embedding: embeddings[j],
      }));

      await db.insert(knowledgeEmbeddings).values(rows);
      totalChunks += rows.length;
    }
  }

  console.log(`\nDone. Inserted ${totalChunks} chunks total.`);
  await client.end();
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
