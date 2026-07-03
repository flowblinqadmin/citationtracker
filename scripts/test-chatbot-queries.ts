/**
 * Test chatbot RAG retrieval with sample queries.
 *
 * Usage:
 *   npx tsx scripts/test-chatbot-queries.ts
 *
 * Requires env vars: DATABASE_URL, OPENAI_API_KEY
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { knowledgeEmbeddings } from "../lib/db/schema";
import { cosineDistance, desc, sql, gt } from "drizzle-orm";
import OpenAI from "openai";

const dbUrl = process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
if (!dbUrl) throw new Error("No DATABASE_URL set");

const client = postgres(dbUrl, { max: 3, prepare: false, idle_timeout: 20 });
const db = drizzle(client);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TEST_QUERIES = [
  "How do I add structured data on WordPress?",
  "What does my GEO score mean?",
  "How do credits work?",
  "How do I edit robots.txt on Shopify?",
  "Where do I download my audit report?",
  "What is llms.txt?",
  "How do I improve my Schema.org pillar score?",
  "What are the pricing plans?",
  "How do I add JSON-LD to my Next.js site?",
  "Write me a poem about cats",  // should get low scores
];

async function testQuery(query: string) {
  const embResult = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: query,
  });
  const queryVector = embResult.data[0].embedding;

  const similarity = sql<number>`1 - (${cosineDistance(knowledgeEmbeddings.embedding, queryVector)})`;

  const results = await db
    .select({
      content: knowledgeEmbeddings.content,
      source: knowledgeEmbeddings.source,
      category: knowledgeEmbeddings.category,
      platform: knowledgeEmbeddings.platform,
      similarity,
    })
    .from(knowledgeEmbeddings)
    .where(gt(similarity, 0.3))
    .orderBy(desc(similarity))
    .limit(4);

  const topScore = results[0]?.similarity ?? 0;
  const tier = topScore >= 0.45 ? "FULL" : topScore >= 0.35 ? "HEDGED" : "REFUSED";

  console.log(`\n${"─".repeat(80)}`);
  console.log(`Q: "${query}"`);
  console.log(`Tier: ${tier} (top score: ${topScore.toFixed(3)})`);
  console.log(`Results: ${results.length} chunks`);

  for (const r of results) {
    console.log(`  [${r.similarity.toFixed(3)}] ${r.category}/${r.platform ?? "general"} — ${r.source.slice(0, 60)}`);
    console.log(`    "${r.content.slice(0, 120)}..."`);
  }
}

async function main() {
  // Show DB stats first
  const stats = await db
    .select({
      category: knowledgeEmbeddings.category,
      platform: knowledgeEmbeddings.platform,
      count: sql<number>`count(*)`,
    })
    .from(knowledgeEmbeddings)
    .groupBy(knowledgeEmbeddings.category, knowledgeEmbeddings.platform)
    .orderBy(desc(sql`count(*)`));

  console.log("Knowledge Base Stats:");
  for (const s of stats) {
    console.log(`  ${s.category}/${s.platform ?? "general"}: ${s.count} chunks`);
  }

  for (const q of TEST_QUERIES) {
    await testQuery(q);
  }

  console.log(`\n${"─".repeat(80)}\nDone.`);
  await client.end();
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
